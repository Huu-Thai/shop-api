import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import { diff } from '../../common/events/audited.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ProductsQuery } from '../products/products.query.js';
import type {
  CreateExchangeRateDto,
  CreatePriceBookDto,
  ExchangeRateDto,
  ListPriceEntriesQueryDto,
  PriceBookDto,
  PriceEntryDto,
  SetPriceEntriesDto,
  UpdatePriceBookDto,
} from './dto/pricing.dto.js';
import {
  EXCHANGE_RATE_EVENTS,
  PRICE_BOOK_EVENTS,
  type PriceBookEventData,
} from './pricing.events.js';

const SELECT = {
  id: true,
  code: true,
  name: true,
  currencyCode: true,
  websiteId: true,
  storeId: true,
  customerGroupId: true,
  includesTax: true,
  priority: true,
  validFrom: true,
  validTo: true,
  isActive: true,
  _count: { select: { entries: true } },
} as const satisfies Prisma.PriceBookSelect;
type Row = Prisma.PriceBookGetPayload<{ select: typeof SELECT }>;
const toDto = ({ _count, ...b }: Row): PriceBookDto => ({
  ...b,
  entryCount: _count.entries,
});
const when = (v: string | null | undefined) =>
  v === undefined ? undefined : v === null ? null : new Date(v);

function checkScope(b: {
  websiteId?: string | null;
  storeId?: string | null;
  validFrom?: Date | null;
  validTo?: Date | null;
}) {
  if (b.websiteId && b.storeId)
    throw new BadRequestException(
      'A price book is scoped to a website or a store, not both',
    );
  if (b.validFrom && b.validTo && b.validTo <= b.validFrom)
    throw new BadRequestException('validTo must be after validFrom');
}

/** Price books, their entries and exchange rates (admin). Changes feed the price index. */
@Injectable()
export class PriceBooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly products: ProductsQuery,
  ) {}

  async list(): Promise<PriceBookDto[]> {
    return (
      await this.prisma.priceBook.findMany({
        select: SELECT,
        orderBy: [{ priority: 'asc' }, { code: 'asc' }],
      })
    ).map(toDto);
  }

  async get(id: string): Promise<PriceBookDto> {
    const b = await this.prisma.priceBook.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!b) throw new NotFoundException(`Price book ${id} not found`);
    return toDto(b);
  }

  async create(
    dto: CreatePriceBookDto,
    actor: Principal,
  ): Promise<PriceBookDto> {
    const data = {
      ...dto,
      validFrom: when(dto.validFrom),
      validTo: when(dto.validTo),
    };
    checkScope(data);
    return this.bus.write({
      before: new BeforeWriteEvent(
        PRICE_BOOK_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const b = await tx.priceBook.create({ data, select: SELECT });
        after.add(
          new EntityEvent<PriceBookEventData>(
            PRICE_BOOK_EVENTS.CREATED,
            actorOf(actor),
            'price_book',
            b.id,
            { ...dto },
            { priceBookId: b.id },
          ),
        );
        return toDto(b);
      },
    });
  }

  async update(
    id: string,
    dto: UpdatePriceBookDto,
    actor: Principal,
  ): Promise<PriceBookDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        PRICE_BOOK_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.priceBook.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Price book ${id} not found`);
        const data = {
          ...dto,
          validFrom: when(dto.validFrom),
          validTo: when(dto.validTo),
        };
        checkScope({
          websiteId:
            data.websiteId === undefined ? before.websiteId : data.websiteId,
          storeId: data.storeId === undefined ? before.storeId : data.storeId,
          validFrom:
            data.validFrom === undefined ? before.validFrom : data.validFrom,
          validTo: data.validTo === undefined ? before.validTo : data.validTo,
        });
        const b = await tx.priceBook.update({
          where: { id },
          data,
          select: SELECT,
        });
        const changes = diff(before, b, [
          'name',
          'websiteId',
          'storeId',
          'customerGroupId',
          'priority',
          'validFrom',
          'validTo',
          'isActive',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent<PriceBookEventData>(
              PRICE_BOOK_EVENTS.UPDATED,
              actorOf(actor),
              'price_book',
              id,
              changes,
              { priceBookId: id },
            ),
          );
        return toDto(b);
      },
    });
  }

  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        PRICE_BOOK_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const b = await tx.priceBook.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!b) throw new NotFoundException(`Price book ${id} not found`);
        await tx.priceBook.delete({ where: { id } });
        after.add(
          new EntityEvent<PriceBookEventData>(
            PRICE_BOOK_EVENTS.DELETED,
            actorOf(actor),
            'price_book',
            id,
            { code: b.code },
            { priceBookId: id },
          ),
        );
      },
    });
  }

  async entries(
    id: string,
    q: ListPriceEntriesQueryDto,
  ): Promise<Paginated<PriceEntryDto>> {
    const where: Prisma.PriceBookEntryWhereInput = {
      priceBookId: id,
      variantId: q.variantId,
      ...(q.productId || q.search
        ? {
            variant: {
              productId: q.productId,
              ...(q.search
                ? { sku: { contains: q.search, mode: 'insensitive' as const } }
                : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.priceBookEntry.findMany({
        where,
        select: {
          id: true,
          variantId: true,
          minQty: true,
          amount: true,
          compareAtAmount: true,
          variant: { select: { sku: true } },
        },
        orderBy: [{ variant: { sku: 'asc' } }, { minQty: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.priceBookEntry.count({ where }),
    ]);
    return paginated(
      rows.map(({ variant, amount, compareAtAmount, ...e }) => ({
        ...e,
        sku: variant.sku,
        amount: Number(amount),
        compareAtAmount:
          compareAtAmount === null ? null : Number(compareAtAmount),
      })),
      total,
      q,
    );
  }

  /** Upserts entries by (variant, minQty); SKUs are accepted for imports. */
  async setEntries(
    id: string,
    dto: SetPriceEntriesDto,
    actor: Principal,
  ): Promise<{ upserted: number }> {
    const bySku = await this.products.variantIdsBySku(
      dto.entries.filter((e) => !e.variantId && e.sku).map((e) => e.sku!),
    );
    const errors: string[] = [];
    const rows = dto.entries.map((e, i) => {
      const variantId = e.variantId ?? (e.sku ? bySku.get(e.sku) : undefined);
      if (!variantId)
        errors.push(
          `entries[${i}]: ${e.sku ? `unknown SKU ${e.sku}` : 'variantId or sku is required'}`,
        );
      if (e.compareAtAmount != null && e.compareAtAmount <= e.amount)
        errors.push(
          `entries[${i}]: compareAtAmount must be higher than amount`,
        );
      return {
        variantId: variantId!,
        minQty: e.minQty ?? 1,
        amount: BigInt(e.amount),
        compareAtAmount:
          e.compareAtAmount == null ? null : BigInt(e.compareAtAmount),
      };
    });
    const keys = rows.map((r) => `${r.variantId}/${r.minQty}`);
    if (new Set(keys).size !== keys.length)
      errors.push('An entry (variant, minQty) appears twice');
    if (errors.length) throw new BadRequestException(errors);
    const variantIds = [...new Set(rows.map((r) => r.variantId))];
    await this.bus.write({
      before: new BeforeWriteEvent(
        PRICE_BOOK_EVENTS.BEFORE_WRITE,
        'entries',
        id,
        actorOf(actor),
        { variantIds },
      ),
      work: async (tx, after) => {
        if (!(await tx.priceBook.count({ where: { id } })))
          throw new NotFoundException(`Price book ${id} not found`);
        for (const r of rows)
          await tx.priceBookEntry.upsert({
            where: {
              priceBookId_variantId_minQty: {
                priceBookId: id,
                variantId: r.variantId,
                minQty: r.minQty,
              },
            },
            create: { priceBookId: id, ...r },
            update: { amount: r.amount, compareAtAmount: r.compareAtAmount },
          });
        after.add(
          new EntityEvent<PriceBookEventData>(
            PRICE_BOOK_EVENTS.ENTRIES_CHANGED,
            actorOf(actor),
            'price_book',
            id,
            { upserted: rows.length, variants: variantIds.length },
            { priceBookId: id, variantIds },
          ),
        );
      },
      timeoutMs: 60_000,
    });
    return { upserted: rows.length };
  }

  async removeEntry(
    id: string,
    entryId: string,
    actor: Principal,
  ): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        PRICE_BOOK_EVENTS.BEFORE_WRITE,
        'entries',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const e = await tx.priceBookEntry.findFirst({
          where: { id: entryId, priceBookId: id },
          select: { variantId: true, minQty: true },
        });
        if (!e) throw new NotFoundException(`Entry ${entryId} not found`);
        await tx.priceBookEntry.delete({ where: { id: entryId } });
        after.add(
          new EntityEvent<PriceBookEventData>(
            PRICE_BOOK_EVENTS.ENTRIES_CHANGED,
            actorOf(actor),
            'price_book',
            id,
            { removed: e },
            { priceBookId: id, variantIds: [e.variantId] },
          ),
        );
      },
    });
  }

  /** Latest rate per pair. */
  async exchangeRates(): Promise<ExchangeRateDto[]> {
    const rows = await this.prisma.exchangeRate.findMany({
      distinct: ['baseCurrencyCode', 'quoteCurrencyCode'],
      orderBy: [
        { baseCurrencyCode: 'asc' },
        { quoteCurrencyCode: 'asc' },
        { validFrom: 'desc' },
      ],
      where: { validFrom: { lte: new Date() } },
    });
    return rows.map((r) => ({
      baseCurrencyCode: r.baseCurrencyCode,
      quoteCurrencyCode: r.quoteCurrencyCode,
      rate: r.rate.toFixed(8),
      validFrom: r.validFrom,
    }));
  }

  /** Rates are appended (history kept); the latest valid one is used. */
  async addExchangeRate(
    dto: CreateExchangeRateDto,
    actor: Principal,
  ): Promise<ExchangeRateDto> {
    if (dto.baseCurrencyCode === dto.quoteCurrencyCode)
      throw new BadRequestException('Base and quote currency must differ');
    return this.bus.write({
      before: new BeforeWriteEvent(
        EXCHANGE_RATE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const r = await tx.exchangeRate.create({
          data: {
            ...dto,
            validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
          },
        });
        after.add(
          new EntityEvent(
            EXCHANGE_RATE_EVENTS.CREATED,
            actorOf(actor),
            'exchange_rate',
            r.id,
            { ...dto },
          ),
        );
        return {
          baseCurrencyCode: r.baseCurrencyCode,
          quoteCurrencyCode: r.quoteCurrencyCode,
          rate: r.rate.toFixed(8),
          validFrom: r.validFrom,
        };
      },
    });
  }
}
