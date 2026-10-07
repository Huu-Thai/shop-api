import { Injectable } from '@nestjs/common';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type Amounts, shippingCharge } from './shipping-rates.js';

export interface ShippingOption {
  id: string;
  code: string;
  carrier: string;
  name: string;
  description: string | null;
  amount: bigint;
  taxClassId: string | null;
}

/** Shipping methods that serve a cart, with their charge. */
@Injectable()
export class ShippingQuery {
  constructor(private readonly prisma: PrismaService) {}

  async options(input: {
    websiteId: string;
    currencyCode: string;
    countryCode: string | null;
    units: number;
    discountedSubtotal: bigint;
    localeChain: readonly string[];
  }): Promise<ShippingOption[]> {
    const rows = await this.prisma.shippingMethod.findMany({
      where: { websiteId: input.websiteId, isActive: true },
      orderBy: [{ position: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        carrier: true,
        rateType: true,
        amounts: true,
        freeOver: true,
        countryCodes: true,
        taxClassId: true,
        translations: {
          where: { localeCode: { in: [...input.localeChain] } },
          select: { localeCode: true, name: true, description: true },
        },
      },
    });
    return rows.flatMap((r) => {
      const amount = shippingCharge(
        {
          rateType: r.rateType,
          amounts: r.amounts as Amounts,
          freeOver: (r.freeOver as Amounts | null) ?? null,
          countryCodes: r.countryCodes,
        },
        input,
      );
      if (amount === undefined) return [];
      const t = pickTranslation(r.translations, input.localeChain);
      return [
        {
          id: r.id,
          code: r.code,
          carrier: r.carrier,
          name: t?.name ?? r.code,
          description: t?.description ?? null,
          amount,
          taxClassId: r.taxClassId,
        },
      ];
    });
  }
}
