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
import { PrismaService } from '../../database/prisma.service.js';
import type {
  CreateTaxClassDto,
  CreateTaxRateDto,
  CreateTaxZoneDto,
  TaxClassDto,
  TaxRateDto,
  TaxZoneDto,
  UpdateTaxClassDto,
  UpdateTaxRateDto,
  UpdateTaxZoneDto,
} from './dto/tax.dto.js';
import {
  TAX_CLASS_EVENTS,
  TAX_RATE_EVENTS,
  TAX_ZONE_EVENTS,
} from './tax.events.js';

const CLASS = { id: true, code: true, name: true, type: true } as const;
const ZONE = {
  id: true,
  code: true,
  name: true,
  rounding: true,
  regions: {
    select: { countryCode: true, regionCode: true, postcodePattern: true },
  },
} as const;
const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
type RateRow = Prisma.TaxRateGetPayload<object>;
const rateDto = (r: RateRow): TaxRateDto => ({
  id: r.id,
  zoneId: r.zoneId,
  productTaxClassId: r.productTaxClassId,
  customerTaxClassId: r.customerTaxClassId,
  name: r.name,
  rate: r.rate.toFixed(4),
  priority: r.priority,
  isCompound: r.isCompound,
  validFrom: date(r.validFrom)!,
  validTo: date(r.validTo),
});
const regions = (rs: CreateTaxZoneDto['regions']) =>
  rs.map((r) => ({
    countryCode: r.countryCode,
    regionCode: r.regionCode ?? null,
    postcodePattern: r.postcodePattern ?? null,
  }));

/** Tax classes, zones and effective-dated rates (admin). */
@Injectable()
export class TaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  classes(): Promise<TaxClassDto[]> {
    return this.prisma.taxClass.findMany({
      select: CLASS,
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
    });
  }

  createClass(dto: CreateTaxClassDto, actor: Principal): Promise<TaxClassDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        TAX_CLASS_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const c = await tx.taxClass.create({ data: dto, select: CLASS });
        after.add(
          new EntityEvent(
            TAX_CLASS_EVENTS.CREATED,
            actorOf(actor),
            'tax_class',
            c.id,
            { ...dto },
          ),
        );
        return c;
      },
    });
  }

  updateClass(
    id: string,
    dto: UpdateTaxClassDto,
    actor: Principal,
  ): Promise<TaxClassDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        TAX_CLASS_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.taxClass.findUnique({
          where: { id },
          select: CLASS,
        });
        if (!before) throw new NotFoundException(`Tax class ${id} not found`);
        const c = await tx.taxClass.update({
          where: { id },
          data: { name: dto.name },
          select: CLASS,
        });
        after.add(
          new EntityEvent(
            TAX_CLASS_EVENTS.UPDATED,
            actorOf(actor),
            'tax_class',
            id,
            diff(before, c, ['name']),
          ),
        );
        return c;
      },
    });
  }

  /** Fails (400) while products, customer groups or rates use the class. */
  async removeClass(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        TAX_CLASS_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const c = await tx.taxClass.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!c) throw new NotFoundException(`Tax class ${id} not found`);
        if (c.code === 'standard' || c.code === 'retail')
          throw new BadRequestException(
            `${c.code} is the default class and cannot be deleted`,
          );
        await tx.taxClass.delete({ where: { id } });
        after.add(
          new EntityEvent(
            TAX_CLASS_EVENTS.DELETED,
            actorOf(actor),
            'tax_class',
            id,
            { code: c.code },
          ),
        );
      },
    });
  }

  zones(): Promise<TaxZoneDto[]> {
    return this.prisma.taxZone.findMany({
      select: ZONE,
      orderBy: { code: 'asc' },
    });
  }

  createZone(dto: CreateTaxZoneDto, actor: Principal): Promise<TaxZoneDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        TAX_ZONE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const z = await tx.taxZone.create({
          data: {
            code: dto.code,
            name: dto.name,
            rounding: dto.rounding ?? 'LINE',
            regions: { create: regions(dto.regions) },
          },
          select: ZONE,
        });
        after.add(
          new EntityEvent(
            TAX_ZONE_EVENTS.CREATED,
            actorOf(actor),
            'tax_zone',
            z.id,
            { code: z.code, regions: z.regions },
          ),
        );
        return z;
      },
    });
  }

  updateZone(
    id: string,
    dto: UpdateTaxZoneDto,
    actor: Principal,
  ): Promise<TaxZoneDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        TAX_ZONE_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.taxZone.findUnique({
          where: { id },
          select: ZONE,
        });
        if (!before) throw new NotFoundException(`Tax zone ${id} not found`);
        const z = await tx.taxZone.update({
          where: { id },
          data: {
            name: dto.name,
            rounding: dto.rounding,
            ...(dto.regions
              ? { regions: { deleteMany: {}, create: regions(dto.regions) } }
              : {}),
          },
          select: ZONE,
        });
        after.add(
          new EntityEvent(
            TAX_ZONE_EVENTS.UPDATED,
            actorOf(actor),
            'tax_zone',
            id,
            diff(before, z, ['name', 'rounding', 'regions']),
          ),
        );
        return z;
      },
    });
  }

  async removeZone(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        TAX_ZONE_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const z = await tx.taxZone.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!z) throw new NotFoundException(`Tax zone ${id} not found`);
        await tx.taxZone.delete({ where: { id } });
        after.add(
          new EntityEvent(
            TAX_ZONE_EVENTS.DELETED,
            actorOf(actor),
            'tax_zone',
            id,
            { code: z.code },
          ),
        );
      },
    });
  }

  async rates(zoneId?: string): Promise<TaxRateDto[]> {
    const rows = await this.prisma.taxRate.findMany({
      where: zoneId ? { zoneId } : {},
      orderBy: [{ zoneId: 'asc' }, { priority: 'asc' }, { validFrom: 'asc' }],
    });
    return rows.map(rateDto);
  }

  async createRate(
    dto: CreateTaxRateDto,
    actor: Principal,
  ): Promise<TaxRateDto> {
    const validFrom = new Date(dto.validFrom ?? '1970-01-01');
    const validTo = dto.validTo ? new Date(dto.validTo) : null;
    if (validTo && validTo <= validFrom)
      throw new BadRequestException('validTo must be after validFrom');
    return this.bus.write({
      before: new BeforeWriteEvent(
        TAX_RATE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const classes = await tx.taxClass.findMany({
          where: {
            id: {
              in: [
                dto.productTaxClassId,
                ...(dto.customerTaxClassId ? [dto.customerTaxClassId] : []),
              ],
            },
          },
        });
        const kind = (id: string) => classes.find((c) => c.id === id)?.type;
        if (kind(dto.productTaxClassId) !== 'PRODUCT')
          throw new BadRequestException(
            'productTaxClassId must be a PRODUCT tax class',
          );
        if (
          dto.customerTaxClassId &&
          kind(dto.customerTaxClassId) !== 'CUSTOMER'
        )
          throw new BadRequestException(
            'customerTaxClassId must be a CUSTOMER tax class',
          );
        const r = await tx.taxRate.create({
          data: {
            zoneId: dto.zoneId,
            productTaxClassId: dto.productTaxClassId,
            customerTaxClassId: dto.customerTaxClassId ?? null,
            name: dto.name,
            rate: dto.rate,
            priority: dto.priority ?? 0,
            isCompound: dto.isCompound ?? false,
            validFrom,
            validTo,
          },
        });
        after.add(
          new EntityEvent(
            TAX_RATE_EVENTS.CREATED,
            actorOf(actor),
            'tax_rate',
            r.id,
            { name: r.name, rate: dto.rate, zoneId: r.zoneId },
          ),
        );
        return rateDto(r);
      },
    });
  }

  async updateRate(
    id: string,
    dto: UpdateTaxRateDto,
    actor: Principal,
  ): Promise<TaxRateDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        TAX_RATE_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.taxRate.findUnique({ where: { id } });
        if (!before) throw new NotFoundException(`Tax rate ${id} not found`);
        const validTo =
          dto.validTo === undefined
            ? before.validTo
            : dto.validTo
              ? new Date(dto.validTo)
              : null;
        if (validTo && validTo <= before.validFrom)
          throw new BadRequestException('validTo must be after validFrom');
        const r = await tx.taxRate.update({
          where: { id },
          data: { name: dto.name, priority: dto.priority, validTo },
        });
        after.add(
          new EntityEvent(
            TAX_RATE_EVENTS.UPDATED,
            actorOf(actor),
            'tax_rate',
            id,
            diff(rateDto(before) as never, rateDto(r) as never, [
              'name',
              'priority',
              'validTo',
            ]),
          ),
        );
        return rateDto(r);
      },
    });
  }

  async removeRate(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        TAX_RATE_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.taxRate.findUnique({
          where: { id },
          select: { name: true },
        });
        if (!r) throw new NotFoundException(`Tax rate ${id} not found`);
        await tx.taxRate.delete({ where: { id } });
        after.add(
          new EntityEvent(
            TAX_RATE_EVENTS.DELETED,
            actorOf(actor),
            'tax_rate',
            id,
            { name: r.name },
          ),
        );
      },
    });
  }
}
