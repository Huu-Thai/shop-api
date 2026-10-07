import {
  BadRequestException,
  ConflictException,
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
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import type {
  CreateCurrencyDto,
  CreateLocaleDto,
  CurrencyDto,
  LocaleDto,
  UpdateCurrencyDto,
  UpdateLocaleDto,
} from './dto/locale-currency.dto.js';
import { CURRENCY_EVENTS, LOCALE_EVENTS } from './stores.events.js';

const LOCALE = {
  code: true,
  name: true,
  isActive: true,
  fallbackCode: true,
} as const;
const CURRENCY = {
  code: true,
  name: true,
  symbol: true,
  minorUnits: true,
  isActive: true,
} as const;

/** Locales and currencies: ISO reference data that admins activate and extend. */
@Injectable()
export class ReferenceDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  locales(activeOnly = false): Promise<LocaleDto[]> {
    return this.prisma.locale.findMany({
      where: activeOnly ? { isActive: true } : {},
      select: LOCALE,
      orderBy: { code: 'asc' },
    });
  }

  currencies(activeOnly = false): Promise<CurrencyDto[]> {
    return this.prisma.currency.findMany({
      where: activeOnly ? { isActive: true } : {},
      select: CURRENCY,
      orderBy: { code: 'asc' },
    });
  }

  async createLocale(
    dto: CreateLocaleDto,
    actor: Principal,
  ): Promise<LocaleDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        LOCALE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        if (dto.fallbackCode)
          await assertFallback(tx, dto.code, dto.fallbackCode);
        const l = await tx.locale.create({
          data: {
            code: dto.code,
            name: dto.name,
            isActive: dto.isActive ?? false,
            fallbackCode: dto.fallbackCode ?? null,
          },
          select: { id: true, ...LOCALE },
        });
        after.add(
          new EntityEvent(
            LOCALE_EVENTS.CREATED,
            actorOf(actor),
            'locale',
            l.id,
            { code: l.code, isActive: l.isActive },
          ),
        );
        return strip(l);
      },
    });
  }

  async updateLocale(
    code: string,
    dto: UpdateLocaleDto,
    actor: Principal,
  ): Promise<LocaleDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        LOCALE_EVENTS.BEFORE_WRITE,
        'update',
        code,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.locale.findUnique({
          where: { code },
          select: { id: true, ...LOCALE },
        });
        if (!before) throw new NotFoundException(`Locale ${code} not found`);
        if (dto.fallbackCode) await assertFallback(tx, code, dto.fallbackCode);
        if (dto.isActive === false && before.isActive) {
          const used = await tx.store.count({
            where: {
              OR: [
                { defaultLocaleCode: code },
                { locales: { some: { localeCode: code } } },
              ],
            },
          });
          if (used)
            throw new ConflictException(
              `Locale ${code} is enabled in ${used} store(s); remove it there first`,
            );
        }
        const l = await tx.locale.update({
          where: { code },
          data: {
            name: dto.name,
            isActive: dto.isActive,
            fallbackCode: dto.fallbackCode,
          },
          select: { id: true, ...LOCALE },
        });
        const changes = diff(before, l, ['name', 'isActive', 'fallbackCode']);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              LOCALE_EVENTS.UPDATED,
              actorOf(actor),
              'locale',
              l.id,
              changes,
            ),
          );
        return strip(l);
      },
    });
  }

  async createCurrency(
    dto: CreateCurrencyDto,
    actor: Principal,
  ): Promise<CurrencyDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        CURRENCY_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const c = await tx.currency.create({
          data: { ...dto, isActive: dto.isActive ?? false },
          select: { id: true, ...CURRENCY },
        });
        after.add(
          new EntityEvent(
            CURRENCY_EVENTS.CREATED,
            actorOf(actor),
            'currency',
            c.id,
            { code: c.code, minorUnits: c.minorUnits },
          ),
        );
        return strip(c);
      },
    });
  }

  async updateCurrency(
    code: string,
    dto: UpdateCurrencyDto,
    actor: Principal,
  ): Promise<CurrencyDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        CURRENCY_EVENTS.BEFORE_WRITE,
        'update',
        code,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.currency.findUnique({
          where: { code },
          select: { id: true, ...CURRENCY },
        });
        if (!before) throw new NotFoundException(`Currency ${code} not found`);
        if (dto.isActive === false && before.isActive) {
          const used =
            (await tx.website.count({ where: { baseCurrencyCode: code } })) +
            (await tx.store.count({
              where: {
                OR: [
                  { defaultCurrencyCode: code },
                  { currencies: { some: { currencyCode: code } } },
                ],
              },
            }));
          if (used)
            throw new ConflictException(
              `Currency ${code} is used by ${used} website(s)/store(s)`,
            );
        }
        const c = await tx.currency.update({
          where: { code },
          data: dto,
          select: { id: true, ...CURRENCY },
        });
        const changes = diff(before, c, ['name', 'symbol', 'isActive']);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              CURRENCY_EVENTS.UPDATED,
              actorOf(actor),
              'currency',
              c.id,
              changes,
            ),
          );
        return strip(c);
      },
    });
  }
}

const strip = <T extends { id: string }>({
  id: _id,
  ...rest
}: T): Omit<T, 'id'> => rest;

/** The fallback must exist and must not lead back to `code` (no cycles). */
async function assertFallback(
  tx: PrismaTransaction,
  code: string,
  fallbackCode: string,
): Promise<void> {
  const all = await tx.locale.findMany({
    select: { code: true, fallbackCode: true },
  });
  const map = new Map(all.map((l) => [l.code, l.fallbackCode]));
  if (!map.has(fallbackCode))
    throw new BadRequestException(
      `Fallback locale ${fallbackCode} does not exist`,
    );
  const seen = new Set<string>([code]);
  for (let c: string | null | undefined = fallbackCode; c; c = map.get(c)) {
    if (seen.has(c))
      throw new BadRequestException(
        `Fallback ${fallbackCode} would create a cycle back to ${code}`,
      );
    seen.add(c);
  }
}
