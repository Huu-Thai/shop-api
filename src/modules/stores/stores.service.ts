import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { diff } from '../../common/events/audited.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import type {
  CreateStoreDto,
  StoreDto,
  UpdateStoreDto,
} from './dto/website-store.dto.js';
import { STORE_EVENTS, type StoreEventData } from './stores.events.js';

const SELECT = {
  id: true,
  websiteId: true,
  code: true,
  name: true,
  baseUrl: true,
  defaultLocaleCode: true,
  defaultCurrencyCode: true,
  countryCode: true,
  pricesIncludeTax: true,
  position: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  locales: { select: { localeCode: true }, orderBy: { position: 'asc' } },
  currencies: {
    select: { currencyCode: true },
    orderBy: { currencyCode: 'asc' },
  },
} as const satisfies Prisma.StoreSelect;
type Row = Prisma.StoreGetPayload<{ select: typeof SELECT }>;
const toDto = ({ locales, currencies, ...s }: Row): StoreDto => ({
  ...s,
  localeCodes: locales.map((l) => l.localeCode),
  currencyCodes: currencies.map((c) => c.currencyCode),
});

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** Default first, then the extras in the given order, without duplicates. */
export const withDefault = (def: string, extra: readonly string[] = []) => [
  ...new Set([def, ...extra]),
];

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  async list(websiteId?: string): Promise<StoreDto[]> {
    const rows = await this.prisma.store.findMany({
      where: websiteId ? { websiteId } : {},
      select: SELECT,
      orderBy: [{ position: 'asc' }, { code: 'asc' }],
    });
    return rows.map(toDto);
  }

  async get(id: string): Promise<StoreDto> {
    const s = await this.prisma.store.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!s) throw new NotFoundException(`Store ${id} not found`);
    return toDto(s);
  }

  async create(dto: CreateStoreDto, actor: Principal): Promise<StoreDto> {
    const localeCodes = withDefault(dto.defaultLocaleCode, dto.localeCodes);
    const currencyCodes = withDefault(
      dto.defaultCurrencyCode,
      dto.currencyCodes,
    );
    return this.bus.write({
      before: new BeforeWriteEvent(
        STORE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const website = await tx.website.findUnique({
          where: { id: dto.websiteId },
          select: { defaultStoreId: true },
        });
        if (!website)
          throw new BadRequestException(
            `Website ${dto.websiteId} does not exist`,
          );
        await assertActive(tx, localeCodes, currencyCodes);
        const s = await tx.store.create({
          data: {
            websiteId: dto.websiteId,
            code: dto.code,
            name: dto.name,
            baseUrl: dto.baseUrl ?? null,
            defaultLocaleCode: dto.defaultLocaleCode,
            defaultCurrencyCode: dto.defaultCurrencyCode,
            countryCode: dto.countryCode,
            pricesIncludeTax: dto.pricesIncludeTax ?? false,
            position: dto.position ?? 0,
            isActive: dto.isActive ?? true,
            locales: {
              create: localeCodes.map((localeCode, position) => ({
                localeCode,
                position,
              })),
            },
            currencies: {
              create: currencyCodes.map((currencyCode) => ({ currencyCode })),
            },
          },
          select: SELECT,
        });
        // The first store of a website becomes its default.
        if (!website.defaultStoreId)
          await tx.website.update({
            where: { id: dto.websiteId },
            data: { defaultStoreId: s.id },
          });
        after.add(
          new EntityEvent<StoreEventData>(
            STORE_EVENTS.CREATED,
            actorOf(actor),
            'store',
            s.id,
            { code: s.code, localeCodes, currencyCodes },
            {
              storeId: s.id,
              websiteId: s.websiteId,
              localeCodes,
              localesChanged: true,
            },
          ),
        );
        return toDto(s);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateStoreDto,
    actor: Principal,
  ): Promise<StoreDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        STORE_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const row = await tx.store.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!row) throw new NotFoundException(`Store ${id} not found`);
        const before = toDto(row);
        const defaultLocale = dto.defaultLocaleCode ?? before.defaultLocaleCode;
        const defaultCurrency =
          dto.defaultCurrencyCode ?? before.defaultCurrencyCode;
        const localeCodes = withDefault(
          defaultLocale,
          dto.localeCodes ?? before.localeCodes,
        );
        const currencyCodes = withDefault(
          defaultCurrency,
          dto.currencyCodes ?? before.currencyCodes,
        );
        await assertActive(tx, localeCodes, currencyCodes);
        const localesChanged = localeCodes.join() !== before.localeCodes.join();
        const currenciesChanged = !sameSet(currencyCodes, before.currencyCodes);
        const s = await tx.store.update({
          where: { id },
          data: {
            name: dto.name,
            baseUrl: dto.baseUrl,
            defaultLocaleCode: dto.defaultLocaleCode,
            defaultCurrencyCode: dto.defaultCurrencyCode,
            countryCode: dto.countryCode,
            pricesIncludeTax: dto.pricesIncludeTax,
            position: dto.position,
            isActive: dto.isActive,
            ...(localesChanged
              ? {
                  locales: {
                    deleteMany: {},
                    create: localeCodes.map((localeCode, position) => ({
                      localeCode,
                      position,
                    })),
                  },
                }
              : {}),
            ...(currenciesChanged
              ? {
                  currencies: {
                    deleteMany: {},
                    create: currencyCodes.map((currencyCode) => ({
                      currencyCode,
                    })),
                  },
                }
              : {}),
          },
          select: SELECT,
        });
        const after_ = toDto(s);
        const changes = diff(before as never, after_ as never, [
          'name',
          'baseUrl',
          'defaultLocaleCode',
          'localeCodes',
          'defaultCurrencyCode',
          'currencyCodes',
          'countryCode',
          'pricesIncludeTax',
          'position',
          'isActive',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent<StoreEventData>(
              STORE_EVENTS.UPDATED,
              actorOf(actor),
              'store',
              id,
              changes,
              {
                storeId: id,
                websiteId: s.websiteId,
                localeCodes: after_.localeCodes,
                localesChanged:
                  'localeCodes' in changes || 'defaultLocaleCode' in changes,
              },
            ),
          );
        return after_;
      },
    });
  }

  /** Store-scoped data (overrides, URL rewrites, locale/currency links) is deleted with the store. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        STORE_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const s = await tx.store.findUnique({
          where: { id },
          select: { code: true, websiteId: true },
        });
        if (!s) throw new NotFoundException(`Store ${id} not found`);
        await tx.store.delete({ where: { id } });
        after.add(
          new EntityEvent(
            STORE_EVENTS.DELETED,
            actorOf(actor),
            'store',
            id,
            { code: s.code },
            { storeId: id, websiteId: s.websiteId },
          ),
        );
      },
    });
  }
}

async function assertActive(
  tx: PrismaTransaction,
  localeCodes: string[],
  currencyCodes: string[],
): Promise<void> {
  const [locales, currencies] = await Promise.all([
    tx.locale.findMany({
      where: { code: { in: localeCodes }, isActive: true },
      select: { code: true },
    }),
    tx.currency.findMany({
      where: { code: { in: currencyCodes }, isActive: true },
      select: { code: true },
    }),
  ]);
  const missingL = localeCodes.filter(
    (c) => !locales.some((l) => l.code === c),
  );
  const missingC = currencyCodes.filter(
    (c) => !currencies.some((x) => x.code === c),
  );
  const problems = [
    ...(missingL.length
      ? [`Locales not found or inactive: ${missingL.join(', ')}`]
      : []),
    ...(missingC.length
      ? [`Currencies not found or inactive: ${missingC.join(', ')}`]
      : []),
  ];
  if (problems.length) throw new BadRequestException(problems);
}
