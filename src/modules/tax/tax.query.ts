import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VersionedSnapshot } from '../../common/cache/versioned-snapshot.js';
import { PrismaService } from '../../database/prisma.service.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import type { CalculateTaxDto, TaxResultDto } from './dto/tax.dto.js';
import {
  calculateTax,
  type Destination,
  type TaxRateDef,
  type TaxResult,
  type TaxZoneDef,
} from './tax-engine.js';

export const TAX_VERSION_KEY = 'tax:config-version';
export const DEFAULT_PRODUCT_TAX_CLASS = 'standard';
export const DEFAULT_CUSTOMER_TAX_CLASS = 'retail';

export interface TaxDefinitions {
  zones: TaxZoneDef[];
  rates: TaxRateDef[];
  /** class code → id */
  classIds: Map<string, string>;
}

/** Cached tax configuration and the calculation entry point for other modules. */
@Injectable()
export class TaxQuery {
  private readonly snapshot: VersionedSnapshot<TaxDefinitions>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    this.snapshot = new VersionedSnapshot(redis, TAX_VERSION_KEY, () =>
      this.load(),
    );
  }

  /** `fresh` for background work (see VersionedSnapshot.get). */
  definitions(fresh = false): Promise<TaxDefinitions> {
    return this.snapshot.get(fresh);
  }

  invalidate(): Promise<void> {
    return this.snapshot.invalidate();
  }

  /** Resolves a class id (NULL means the default class of that kind). */
  async classId(
    id: string | null | undefined,
    kind: 'PRODUCT' | 'CUSTOMER',
  ): Promise<string> {
    if (id) return id;
    const code =
      kind === 'PRODUCT'
        ? DEFAULT_PRODUCT_TAX_CLASS
        : DEFAULT_CUSTOMER_TAX_CLASS;
    const found = (await this.definitions()).classIds.get(code);
    if (!found) throw new Error(`Default tax class "${code}" is missing`);
    return found;
  }

  async calculate(req: Parameters<typeof calculateTax>[0]): Promise<TaxResult> {
    const d = await this.definitions();
    return calculateTax(req, d.zones, d.rates);
  }

  /** Rates that would apply to one class pair at a destination (used by the price index). */
  async ratesFor(
    destination: Destination,
    productTaxClassId: string,
    customerTaxClassId: string,
    date = new Date(),
  ) {
    const r = await this.calculate({
      lines: [{ key: 'probe', amount: 1_000_000n, productTaxClassId }],
      destination,
      customerTaxClassId,
      pricesIncludeTax: false,
      date,
    });
    return r;
  }

  /** Admin endpoint: class codes instead of ids, numbers instead of bigints. */
  async calculateDto(dto: CalculateTaxDto): Promise<TaxResultDto> {
    const d = await this.definitions();
    const id = (code: string) => {
      const found = d.classIds.get(code);
      if (!found) throw new BadRequestException(`Unknown tax class ${code}`);
      return found;
    };
    const r = calculateTax(
      {
        lines: dto.lines.map((l) => ({
          key: l.key,
          amount: BigInt(l.amount),
          productTaxClassId: id(l.productTaxClass ?? DEFAULT_PRODUCT_TAX_CLASS),
        })),
        destination: dto.destination,
        customerTaxClassId: id(
          dto.customerTaxClass ?? DEFAULT_CUSTOMER_TAX_CLASS,
        ),
        pricesIncludeTax: dto.pricesIncludeTax,
        date: dto.date ? new Date(dto.date) : new Date(),
      },
      d.zones,
      d.rates,
    );
    return toTaxResultDto(r);
  }

  private async load(): Promise<TaxDefinitions> {
    const [zones, rates, classes] = await Promise.all([
      this.prisma.taxZone.findMany({
        select: {
          id: true,
          code: true,
          rounding: true,
          regions: {
            select: {
              countryCode: true,
              regionCode: true,
              postcodePattern: true,
            },
          },
        },
      }),
      this.prisma.taxRate.findMany(),
      this.prisma.taxClass.findMany({ select: { id: true, code: true } }),
    ]);
    return {
      zones: zones.map((z) => ({
        ...z,
        rounding: z.rounding === 'TOTAL' ? 'TOTAL' : 'LINE',
      })),
      rates: rates.map((r) => ({ ...r, rate: r.rate.toString() })),
      classIds: new Map(classes.map((c) => [c.code, c.id])),
    };
  }
}

export function toTaxResultDto(r: TaxResult): TaxResultDto {
  const taxes = (ts: TaxResult['taxes']) =>
    ts.map((t) => ({ ...t, amount: Number(t.amount) }));
  return {
    lines: r.lines.map((l) => ({
      key: l.key,
      net: Number(l.net),
      tax: Number(l.tax),
      gross: Number(l.gross),
      taxes: taxes(l.taxes),
    })),
    totals: {
      net: Number(r.totals.net),
      tax: Number(r.totals.tax),
      gross: Number(r.totals.gross),
    },
    taxes: taxes(r.taxes),
    zones: r.zones,
    rounding: r.rounding,
  };
}
