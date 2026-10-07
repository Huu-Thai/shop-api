import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { diff } from '../../common/events/audited.event.js';
import { assertUniqueLocales } from '../../common/dto/translation.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  CreateShippingMethodDto,
  ShippingMethodDto,
  UpdateShippingMethodDto,
} from './dto/shipping.dto.js';
import { SHIPPING_METHOD_EVENTS } from './shipping.events.js';

const SELECT = {
  id: true,
  websiteId: true,
  code: true,
  carrier: true,
  rateType: true,
  amounts: true,
  freeOver: true,
  countryCodes: true,
  taxClassId: true,
  position: true,
  isActive: true,
  translations: {
    select: { localeCode: true, name: true, description: true },
    orderBy: { localeCode: 'asc' },
  },
} as const satisfies Prisma.ShippingMethodSelect;

type Row = Prisma.ShippingMethodGetPayload<{ select: typeof SELECT }>;

const toDto = (r: Row): ShippingMethodDto => ({
  ...r,
  amounts: r.amounts as Record<string, number>,
  freeOver: (r.freeOver as Record<string, number> | null) ?? null,
  translations: r.translations.map((t) => ({
    ...t,
    description: t.description ?? undefined,
  })),
});

/** `{ "USD": 799 }`: currency codes → non-negative integer minor units. */
export function assertAmounts(value: unknown, field: string): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.keys(value).length ||
    !Object.entries(value).every(
      ([c, a]) =>
        /^[A-Z]{3}$/.test(c) && Number.isInteger(a) && (a as number) >= 0,
    )
  )
    throw new BadRequestException(
      `${field} must map currency codes to amounts in minor units`,
    );
}

/** Shipping methods per website (back office). */
@Injectable()
export class ShippingMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  async list(websiteId?: string): Promise<ShippingMethodDto[]> {
    const rows = await this.prisma.shippingMethod.findMany({
      where: { websiteId },
      select: SELECT,
      orderBy: [{ position: 'asc' }, { code: 'asc' }],
    });
    return rows.map(toDto);
  }

  async create(
    dto: CreateShippingMethodDto,
    actor: Principal,
  ): Promise<ShippingMethodDto> {
    assertAmounts(dto.amounts, 'amounts');
    if (dto.freeOver) assertAmounts(dto.freeOver, 'freeOver');
    assertUniqueLocales(dto.translations);
    return this.bus.write({
      before: new BeforeWriteEvent(
        SHIPPING_METHOD_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const r = await tx.shippingMethod.create({
          data: {
            websiteId: dto.websiteId,
            code: dto.code,
            carrier: dto.carrier,
            rateType: dto.rateType ?? 'FLAT',
            amounts: dto.amounts,
            freeOver: dto.freeOver ?? undefined,
            countryCodes: dto.countryCodes ?? [],
            taxClassId: dto.taxClassId ?? null,
            position: dto.position ?? 0,
            isActive: dto.isActive ?? true,
            translations: { create: dto.translations },
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            SHIPPING_METHOD_EVENTS.CREATED,
            actorOf(actor),
            'shipping_method',
            r.id,
            {
              code: r.code,
              websiteId: r.websiteId,
            },
          ),
        );
        return toDto(r);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateShippingMethodDto,
    actor: Principal,
  ): Promise<ShippingMethodDto> {
    if (dto.amounts) assertAmounts(dto.amounts, 'amounts');
    if (dto.freeOver) assertAmounts(dto.freeOver, 'freeOver');
    if (dto.translations) assertUniqueLocales(dto.translations);
    return this.bus.write({
      before: new BeforeWriteEvent(
        SHIPPING_METHOD_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.shippingMethod.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before)
          throw new NotFoundException(`Shipping method ${id} not found`);
        for (const t of dto.translations ?? [])
          await tx.shippingMethodTranslation.upsert({
            where: {
              methodId_localeCode: { methodId: id, localeCode: t.localeCode },
            },
            create: { methodId: id, ...t },
            update: { name: t.name, description: t.description ?? null },
          });
        const r = await tx.shippingMethod.update({
          where: { id },
          data: {
            carrier: dto.carrier,
            rateType: dto.rateType,
            amounts: dto.amounts,
            freeOver: dto.freeOver === null ? Prisma.DbNull : dto.freeOver,
            countryCodes: dto.countryCodes,
            taxClassId: dto.taxClassId,
            position: dto.position,
            isActive: dto.isActive,
            updatedAt: new Date(),
          },
          select: SELECT,
        });
        const changes = diff({ ...toDto(before) }, { ...toDto(r) }, [
          'carrier',
          'rateType',
          'amounts',
          'freeOver',
          'countryCodes',
          'taxClassId',
          'position',
          'isActive',
          'translations',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              SHIPPING_METHOD_EVENTS.UPDATED,
              actorOf(actor),
              'shipping_method',
              id,
              changes,
            ),
          );
        return toDto(r);
      },
    });
  }

  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        SHIPPING_METHOD_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.shippingMethod.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!r) throw new NotFoundException(`Shipping method ${id} not found`);
        await tx.shippingMethod.delete({ where: { id } });
        after.add(
          new EntityEvent(
            SHIPPING_METHOD_EVENTS.DELETED,
            actorOf(actor),
            'shipping_method',
            id,
            r,
          ),
        );
      },
    });
  }
}
