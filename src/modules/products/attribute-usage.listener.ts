import { ConflictException, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { BeforeWriteEvent } from '../../common/events/entity.events.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  ATTRIBUTE_EVENTS,
  type AttributeWriteInput,
} from '../catalog/catalog.events.js';

/**
 * Before-listener (may veto): the catalog module owns attributes, but only the products module
 * knows whether values are in use. Deleting an attribute, or removing options, that products still
 * use is rejected with 409 instead of leaving dangling values.
 */
@Injectable()
export class AttributeUsageListener {
  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(ATTRIBUTE_EVENTS.BEFORE_WRITE, { suppressErrors: false })
  async onAttributeWrite(
    event: BeforeWriteEvent<AttributeWriteInput>,
  ): Promise<void> {
    const input = event.input;
    if (!input || event.action === 'create') return;
    if (event.action === 'delete') {
      const n = await this.countUsing(input.code);
      if (n)
        throw new ConflictException(
          `Attribute ${input.code} is used by ${n} product(s)`,
        );
      return;
    }
    if (!input.removedOptionCodes.length) return;
    const n = await this.countUsingOptions(
      input.code,
      input.removedOptionCodes,
    );
    if (n)
      throw new ConflictException(
        `Options ${input.removedOptionCodes.join(', ')} of ${input.code} are used by ${n} product(s)`,
      );
  }

  private async countUsing(code: string): Promise<number> {
    const [{ n }] = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM products p
       WHERE p.attributes ? ${code}
          OR EXISTS (SELECT 1 FROM product_translations t WHERE t.product_id = p.id AND t.attributes ? ${code})
          OR EXISTS (SELECT 1 FROM product_store_overrides o WHERE o.product_id = p.id AND o.attributes ? ${code})
          OR EXISTS (SELECT 1 FROM configurable_attributes c JOIN attributes a ON a.id = c.attribute_id
                      WHERE c.product_id = p.id AND a.code = ${code})`;
    return n;
  }

  private async countUsingOptions(
    code: string,
    options: string[],
  ): Promise<number> {
    const single = options.map((o) => JSON.stringify({ [code]: o }));
    const multi = options.map((o) => JSON.stringify({ [code]: [o] }));
    const [{ n }] = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM products p
       WHERE p.attributes @> ANY (${single}::jsonb[]) OR p.attributes @> ANY (${multi}::jsonb[])
          OR EXISTS (SELECT 1 FROM product_store_overrides o WHERE o.product_id = p.id
                      AND (o.attributes @> ANY (${single}::jsonb[]) OR o.attributes @> ANY (${multi}::jsonb[])))
          OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.option_values @> ANY (${single}::jsonb[]))`;
    return n;
  }
}
