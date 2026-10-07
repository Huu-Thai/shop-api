import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { SecretsService } from '../../common/crypto/secrets.service.js';
import { assertUniqueLocales } from '../../common/dto/translation.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { AppConfig } from '../../config/configuration.js';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { assertAmounts } from '../shipping/shipping-methods.service.js';
import type {
  CreateProviderDto,
  CreateStoreMethodDto,
  PaymentMethodDto,
  ProviderDto,
  StoreMethodDto,
  UpdateProviderDto,
  UpdateStoreMethodDto,
} from './dto/payments.dto.js';
import { PaymentAdapters } from './providers/registry.js';

const PROVIDER_EVENTS = {
  BEFORE_WRITE: 'payment-provider.before-write',
  CREATED: 'payment-provider.created',
  UPDATED: 'payment-provider.updated',
  DELETED: 'payment-provider.deleted',
};
const METHOD_EVENTS = {
  BEFORE_WRITE: 'payment-method.before-write',
  CREATED: 'payment-method.created',
  UPDATED: 'payment-method.updated',
  DELETED: 'payment-method.deleted',
};

const METHOD_SELECT = {
  id: true,
  storeId: true,
  providerId: true,
  code: true,
  position: true,
  minAmounts: true,
  maxAmounts: true,
  countryCodes: true,
  currencyCodes: true,
  isActive: true,
  translations: {
    select: { localeCode: true, title: true, description: true },
    orderBy: { localeCode: 'asc' },
  },
} as const satisfies Prisma.StorePaymentMethodSelect;

type MethodRow = Prisma.StorePaymentMethodGetPayload<{
  select: typeof METHOD_SELECT;
}>;

const methodDto = (m: MethodRow): StoreMethodDto => ({
  ...m,
  minAmounts: (m.minAmounts as Record<string, number> | null) ?? null,
  maxAmounts: (m.maxAmounts as Record<string, number> | null) ?? null,
  titles: m.translations.map((t) => ({
    ...t,
    description: t.description ?? undefined,
  })),
});

/** Whether a store method may take an order (currency, billing country, amount limits). */
export function eligible(
  m: {
    currencyCodes: readonly string[];
    countryCodes: readonly string[];
    minAmounts: unknown;
    maxAmounts: unknown;
  },
  input: { currencyCode: string; countryCode: string | null; amount: bigint },
): boolean {
  if (m.currencyCodes.length && !m.currencyCodes.includes(input.currencyCode))
    return false;
  if (
    m.countryCodes.length &&
    input.countryCode &&
    !m.countryCodes.includes(input.countryCode)
  )
    return false;
  const min = (m.minAmounts as Record<string, number> | null)?.[
    input.currencyCode
  ];
  const max = (m.maxAmounts as Record<string, number> | null)?.[
    input.currencyCode
  ];
  if (min !== undefined && input.amount < BigInt(min)) return false;
  if (max !== undefined && input.amount > BigInt(max)) return false;
  return true;
}

/** Endpoint overrides (sandboxes, emulators) are only allowed over https for LIVE providers. */
function assertLiveUrls(creds: Record<string, string>): void {
  for (const k of ['apiBase', 'payUrl', 'apiUrl'])
    if (creds[k] && !creds[k].startsWith('https://'))
      throw new BadRequestException(`${k} must be https in LIVE mode`);
}

/** Payment providers (sealed credentials) and what each store offers. */
@Injectable()
export class PaymentConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly secrets: SecretsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private providerDto(p: {
    id: string;
    code: ProviderDto['code'];
    name: string;
    mode: ProviderDto['mode'];
    isActive: boolean;
    credentials: string | null;
  }): ProviderDto {
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      mode: p.mode,
      isActive: p.isActive,
      configured: !!p.credentials || p.code === 'COD',
      webhookUrl: `${this.config.get('publicUrl', { infer: true })}/api/v1/webhooks/payments/${p.id}`,
    };
  }

  private seal(
    code: CreateProviderDto['code'],
    mode: string,
    creds: Record<string, string> | undefined,
  ): string | null {
    if (code === 'COD') return null;
    if (!creds) throw new BadRequestException(`${code} needs credentials`);
    PaymentAdapters.validate(code, creds);
    if (mode === 'LIVE') assertLiveUrls(creds);
    return this.secrets.seal(creds);
  }

  async providers(): Promise<ProviderDto[]> {
    const rows = await this.prisma.paymentProvider.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.providerDto(r));
  }

  async createProvider(
    dto: CreateProviderDto,
    actor: Principal,
  ): Promise<ProviderDto> {
    const mode = dto.mode ?? 'TEST';
    const credentials = this.seal(dto.code, mode, dto.credentials);
    return this.bus.write({
      before: new BeforeWriteEvent(
        PROVIDER_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { code: dto.code },
      ),
      work: async (tx, after) => {
        const p = await tx.paymentProvider.create({
          data: {
            code: dto.code,
            name: dto.name,
            mode,
            credentials,
            isActive: dto.isActive ?? true,
          },
        });
        after.add(
          new EntityEvent(
            PROVIDER_EVENTS.CREATED,
            actorOf(actor),
            'payment_provider',
            p.id,
            { code: p.code, mode },
          ),
        );
        return this.providerDto(p);
      },
    });
  }

  async updateProvider(
    id: string,
    dto: UpdateProviderDto,
    actor: Principal,
  ): Promise<ProviderDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        PROVIDER_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        { mode: dto.mode },
      ),
      work: async (tx, after) => {
        const before = await tx.paymentProvider.findUnique({ where: { id } });
        if (!before)
          throw new NotFoundException(`Payment provider ${id} not found`);
        const mode = dto.mode ?? before.mode;
        const credentials = dto.credentials
          ? this.seal(before.code, mode, dto.credentials)
          : undefined;
        // Going live with the stored credentials: their endpoint overrides must be https too.
        if (!credentials && mode === 'LIVE' && before.credentials)
          assertLiveUrls(
            this.secrets.open<Record<string, string>>(before.credentials),
          );
        const p = await tx.paymentProvider.update({
          where: { id },
          data: {
            name: dto.name,
            mode: dto.mode,
            isActive: dto.isActive,
            credentials,
          },
        });
        after.add(
          new EntityEvent(
            PROVIDER_EVENTS.UPDATED,
            actorOf(actor),
            'payment_provider',
            id,
            {
              ...(dto.name ? { name: dto.name } : {}),
              ...(dto.mode ? { mode: dto.mode } : {}),
              ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
              ...(dto.credentials ? { credentials: 'replaced' } : {}),
            },
          ),
        );
        return this.providerDto(p);
      },
    });
  }

  async removeProvider(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        PROVIDER_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const p = await tx.paymentProvider.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!p) throw new NotFoundException(`Payment provider ${id} not found`);
        await tx.paymentProvider.delete({ where: { id } });
        after.add(
          new EntityEvent(
            PROVIDER_EVENTS.DELETED,
            actorOf(actor),
            'payment_provider',
            id,
            p,
          ),
        );
      },
    });
  }

  async methods(storeId?: string): Promise<StoreMethodDto[]> {
    const rows = await this.prisma.storePaymentMethod.findMany({
      where: { storeId },
      select: METHOD_SELECT,
      orderBy: [{ storeId: 'asc' }, { position: 'asc' }, { code: 'asc' }],
    });
    return rows.map(methodDto);
  }

  async createMethod(
    dto: CreateStoreMethodDto,
    actor: Principal,
  ): Promise<StoreMethodDto> {
    if (dto.minAmounts) assertAmounts(dto.minAmounts, 'minAmounts');
    if (dto.maxAmounts) assertAmounts(dto.maxAmounts, 'maxAmounts');
    assertUniqueLocales(dto.titles);
    return this.bus.write({
      before: new BeforeWriteEvent(
        METHOD_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const m = await tx.storePaymentMethod.create({
          data: {
            storeId: dto.storeId,
            providerId: dto.providerId,
            code: dto.code,
            position: dto.position ?? 0,
            minAmounts: dto.minAmounts ?? undefined,
            maxAmounts: dto.maxAmounts ?? undefined,
            countryCodes: dto.countryCodes ?? [],
            currencyCodes: dto.currencyCodes ?? [],
            isActive: dto.isActive ?? true,
            translations: { create: dto.titles },
          },
          select: METHOD_SELECT,
        });
        after.add(
          new EntityEvent(
            METHOD_EVENTS.CREATED,
            actorOf(actor),
            'payment_method',
            m.id,
            { code: m.code, storeId: m.storeId },
          ),
        );
        return methodDto(m);
      },
    });
  }

  async updateMethod(
    id: string,
    dto: UpdateStoreMethodDto,
    actor: Principal,
  ): Promise<StoreMethodDto> {
    if (dto.minAmounts) assertAmounts(dto.minAmounts, 'minAmounts');
    if (dto.maxAmounts) assertAmounts(dto.maxAmounts, 'maxAmounts');
    if (dto.titles) assertUniqueLocales(dto.titles);
    return this.bus.write({
      before: new BeforeWriteEvent(
        METHOD_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        if (
          !(await tx.storePaymentMethod.findUnique({
            where: { id },
            select: { id: true },
          }))
        )
          throw new NotFoundException(`Payment method ${id} not found`);
        if (dto.titles) {
          await tx.storePaymentMethodTranslation.deleteMany({
            where: { methodId: id },
          });
          await tx.storePaymentMethodTranslation.createMany({
            data: dto.titles.map((t) => ({ methodId: id, ...t })),
          });
        }
        const m = await tx.storePaymentMethod.update({
          where: { id },
          data: {
            position: dto.position,
            minAmounts:
              dto.minAmounts === null ? Prisma.DbNull : dto.minAmounts,
            maxAmounts:
              dto.maxAmounts === null ? Prisma.DbNull : dto.maxAmounts,
            countryCodes: dto.countryCodes,
            currencyCodes: dto.currencyCodes,
            isActive: dto.isActive,
            updatedAt: new Date(),
          },
          select: METHOD_SELECT,
        });
        after.add(
          new EntityEvent(
            METHOD_EVENTS.UPDATED,
            actorOf(actor),
            'payment_method',
            id,
            { fields: Object.keys(dto) },
          ),
        );
        return methodDto(m);
      },
    });
  }

  async removeMethod(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        METHOD_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const m = await tx.storePaymentMethod.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!m) throw new NotFoundException(`Payment method ${id} not found`);
        await tx.storePaymentMethod.delete({ where: { id } });
        after.add(
          new EntityEvent(
            METHOD_EVENTS.DELETED,
            actorOf(actor),
            'payment_method',
            id,
            m,
          ),
        );
      },
    });
  }

  /** Methods a store offers for an amount, currency and billing country, in order. */
  async eligibleMethods(input: {
    storeId: string;
    currencyCode: string;
    countryCode: string | null;
    amount: bigint;
    localeChain: readonly string[];
  }): Promise<(PaymentMethodDto & { id: string; providerId: string })[]> {
    const rows = await this.prisma.storePaymentMethod.findMany({
      where: {
        storeId: input.storeId,
        isActive: true,
        provider: { isActive: true },
      },
      orderBy: [{ position: 'asc' }, { code: 'asc' }],
      select: {
        ...METHOD_SELECT,
        provider: { select: { code: true } },
        translations: {
          where: { localeCode: { in: [...input.localeChain] } },
          select: { localeCode: true, title: true, description: true },
        },
      },
    });
    return rows
      .filter((m) => eligible(m, input))
      .map((m) => {
        const t = pickTranslation(m.translations, input.localeChain);
        return {
          id: m.id,
          providerId: m.providerId,
          code: m.code,
          title: t?.title ?? m.code,
          description: t?.description ?? null,
          provider: m.provider.code,
        };
      });
  }
}
