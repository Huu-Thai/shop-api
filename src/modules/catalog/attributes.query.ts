import { Injectable } from '@nestjs/common';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AttributeDef } from './attribute-values.js';

const DEF_SELECT = {
  id: true,
  code: true,
  type: true,
  isRequired: true,
  isLocalizable: true,
  isFilterable: true,
  isSearchable: true,
  isVisible: true,
  position: true,
  options: {
    select: { code: true, swatch: true, position: true },
    orderBy: { position: 'asc' },
  },
} as const;

export interface LocalizedAttribute {
  def: AttributeDef;
  label: string;
  options: Map<
    string,
    { label: string; swatch: string | null; position: number }
  >;
}

/** Read-only attribute definitions for other modules (validation, storefront labels). */
@Injectable()
export class AttributesQuery {
  constructor(private readonly prisma: PrismaService) {}

  /** Definitions of an attribute set, keyed by code; undefined when the set doesn't exist. */
  async setDefinitions(
    attributeSetId: string,
  ): Promise<Map<string, AttributeDef> | undefined> {
    const set = await this.prisma.attributeSet.findUnique({
      where: { id: attributeSetId },
      select: {
        attributes: {
          select: { attribute: { select: DEF_SELECT } },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!set) return undefined;
    return new Map(
      set.attributes.map(({ attribute }) => [attribute.code, attribute]),
    );
  }

  /** Attribute set id ↔ code (imports and exports name sets by code). */
  async setCodes(): Promise<Map<string, string>> {
    const rows = await this.prisma.attributeSet.findMany({
      select: { id: true, code: true },
    });
    return new Map(rows.map((r) => [r.id, r.code]));
  }

  async byCodes(codes: readonly string[]): Promise<Map<string, AttributeDef>> {
    const rows = await this.prisma.attribute.findMany({
      where: { code: { in: [...codes] } },
      select: DEF_SELECT,
    });
    return new Map(rows.map((a) => [a.code, a]));
  }

  async byIds(ids: readonly string[]): Promise<Map<string, AttributeDef>> {
    const rows = await this.prisma.attribute.findMany({
      where: { id: { in: [...ids] } },
      select: DEF_SELECT,
    });
    return new Map(rows.map((a) => [a.id, a]));
  }

  /** Codes of attributes that feed search: facets (filterable) and full text (searchable). */
  async searchCodes(): Promise<{ filterable: string[]; searchable: string[] }> {
    const rows = await this.prisma.attribute.findMany({
      where: { OR: [{ isFilterable: true }, { isSearchable: true }] },
      select: { code: true, isFilterable: true, isSearchable: true },
      orderBy: [{ position: 'asc' }, { code: 'asc' }],
    });
    return {
      filterable: rows.filter((r) => r.isFilterable).map((r) => r.code),
      searchable: rows.filter((r) => r.isSearchable).map((r) => r.code),
    };
  }

  /** Definitions with labels resolved along the locale chain (falls back to the code). */
  async localized(
    codes: readonly string[],
    chain: readonly string[],
  ): Promise<Map<string, LocalizedAttribute>> {
    if (!codes.length) return new Map();
    const rows = await this.prisma.attribute.findMany({
      where: { code: { in: [...codes] } },
      select: {
        ...DEF_SELECT,
        translations: {
          where: { localeCode: { in: [...chain] } },
          select: { localeCode: true, label: true },
        },
        options: {
          select: {
            code: true,
            swatch: true,
            position: true,
            translations: {
              where: { localeCode: { in: [...chain] } },
              select: { localeCode: true, label: true },
            },
          },
          orderBy: { position: 'asc' },
        },
      },
    });
    return new Map(
      rows.map(({ translations, options, ...a }) => [
        a.code,
        {
          def: {
            ...a,
            options: options.map(({ translations: _t, ...o }) => o),
          },
          label: pickTranslation(translations, chain)?.label ?? a.code,
          options: new Map(
            options.map((o) => [
              o.code,
              {
                label: pickTranslation(o.translations, chain)?.label ?? o.code,
                swatch: o.swatch,
                position: o.position,
              },
            ]),
          ),
        },
      ]),
    );
  }
}
