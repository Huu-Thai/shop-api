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
import {
  ATTRIBUTE_EVENTS,
  ATTRIBUTE_SET_EVENTS,
  type AttributeWriteInput,
} from './catalog.events.js';
import type {
  AttributeDto,
  AttributeOptionInputDto,
  AttributeSetDto,
  CreateAttributeDto,
  CreateAttributeSetDto,
  LabelDto,
  UpdateAttributeDto,
  UpdateAttributeSetDto,
} from './dto/attribute.dto.js';

const SELECT = {
  id: true,
  code: true,
  type: true,
  isRequired: true,
  isFilterable: true,
  isSearchable: true,
  isLocalizable: true,
  isVisible: true,
  position: true,
  translations: {
    select: { localeCode: true, label: true },
    orderBy: { localeCode: 'asc' },
  },
  options: {
    select: {
      code: true,
      swatch: true,
      position: true,
      translations: {
        select: { localeCode: true, label: true },
        orderBy: { localeCode: 'asc' },
      },
    },
    orderBy: [{ position: 'asc' }, { code: 'asc' }],
  },
} as const satisfies Prisma.AttributeSelect;
type Row = Prisma.AttributeGetPayload<{ select: typeof SELECT }>;
const toDto = ({ translations, options, ...a }: Row): AttributeDto => ({
  ...a,
  labels: translations,
  options: options.map(({ translations: labels, ...o }) => ({ ...o, labels })),
});

const SET_SELECT = {
  id: true,
  code: true,
  name: true,
  attributes: {
    select: {
      groupName: true,
      position: true,
      attribute: { select: { code: true } },
    },
    orderBy: { position: 'asc' },
  },
} as const satisfies Prisma.AttributeSetSelect;
type SetRow = Prisma.AttributeSetGetPayload<{ select: typeof SET_SELECT }>;
const setToDto = ({ attributes, ...s }: SetRow): AttributeSetDto => ({
  ...s,
  attributes: attributes.map((a) => ({
    code: a.attribute.code,
    groupName: a.groupName,
    position: a.position,
  })),
});

const OPTION_TYPES = new Set(['SELECT', 'MULTISELECT']);

function uniqueLocales(
  labels: readonly { localeCode: string }[],
  what: string,
): void {
  const seen = new Set<string>();
  for (const l of labels) {
    if (seen.has(l.localeCode))
      throw new BadRequestException(
        `${what}: duplicate locale ${l.localeCode}`,
      );
    seen.add(l.localeCode);
  }
}

function checkOptions(
  type: string,
  options: AttributeOptionInputDto[] | undefined,
): void {
  if (!OPTION_TYPES.has(type)) {
    if (options?.length)
      throw new BadRequestException(
        `Only SELECT and MULTISELECT attributes have options`,
      );
    return;
  }
  const codes = new Set<string>();
  for (const o of options ?? []) {
    if (codes.has(o.code))
      throw new BadRequestException(`Duplicate option code ${o.code}`);
    codes.add(o.code);
    uniqueLocales(o.labels, `options[${o.code}].labels`);
  }
}

const labelRows = (labels: LabelDto[]) =>
  labels.map(({ localeCode, label }) => ({ localeCode, label }));

@Injectable()
export class AttributesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  async list(): Promise<AttributeDto[]> {
    return (
      await this.prisma.attribute.findMany({
        select: SELECT,
        orderBy: [{ position: 'asc' }, { code: 'asc' }],
      })
    ).map(toDto);
  }

  async get(id: string): Promise<AttributeDto> {
    const a = await this.prisma.attribute.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!a) throw new NotFoundException(`Attribute ${id} not found`);
    return toDto(a);
  }

  async create(
    dto: CreateAttributeDto,
    actor: Principal,
  ): Promise<AttributeDto> {
    uniqueLocales(dto.labels, 'labels');
    checkOptions(dto.type, dto.options);
    if (dto.isLocalizable && OPTION_TYPES.has(dto.type))
      throw new BadRequestException(
        'Option attributes are not localizable (their labels are)',
      );
    return this.bus.write({
      before: new BeforeWriteEvent<AttributeWriteInput>(
        ATTRIBUTE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        {
          code: dto.code,
          removedOptionCodes: [],
        },
      ),
      work: async (tx, after) => {
        const { labels, options, ...fields } = dto;
        const a = await tx.attribute.create({
          data: {
            ...fields,
            translations: { create: labelRows(labels) },
            options: {
              create: (options ?? []).map((o, i) => ({
                code: o.code,
                swatch: o.swatch ?? null,
                position: o.position ?? i,
                translations: { create: labelRows(o.labels) },
              })),
            },
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            ATTRIBUTE_EVENTS.CREATED,
            actorOf(actor),
            'attribute',
            a.id,
            { code: a.code, type: a.type },
          ),
        );
        return toDto(a);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateAttributeDto,
    actor: Principal,
  ): Promise<AttributeDto> {
    if (dto.labels) uniqueLocales(dto.labels, 'labels');
    const current = await this.prisma.attribute.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!current) throw new NotFoundException(`Attribute ${id} not found`);
    checkOptions(current.type, dto.options);
    const removed = dto.options
      ? current.options
          .map((o) => o.code)
          .filter((c) => !dto.options!.some((o) => o.code === c))
      : [];
    return this.bus.write({
      before: new BeforeWriteEvent<AttributeWriteInput>(
        ATTRIBUTE_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        {
          code: current.code,
          removedOptionCodes: removed,
        },
      ),
      work: async (tx, after) => {
        const { labels, options, ...flags } = dto;
        await tx.attribute.update({
          where: { id },
          data: {
            ...flags,
            ...(labels
              ? { translations: { deleteMany: {}, create: labelRows(labels) } }
              : {}),
          },
        });
        if (options) await this.syncOptions(tx, id, options);
        const a = await tx.attribute.findUniqueOrThrow({
          where: { id },
          select: SELECT,
        });
        const [before, now] = [toDto(current), toDto(a)];
        const changes = diff(before as never, now as never, [
          'isRequired',
          'isFilterable',
          'isSearchable',
          'isVisible',
          'position',
          'labels',
          'options',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              ATTRIBUTE_EVENTS.UPDATED,
              actorOf(actor),
              'attribute',
              id,
              changes,
              { code: a.code },
            ),
          );
        return now;
      },
    });
  }

  /** Options matched by code: kept rows keep their id (and therefore existing references). */
  private async syncOptions(
    tx: PrismaTransaction,
    attributeId: string,
    options: AttributeOptionInputDto[],
  ): Promise<void> {
    await tx.attributeOption.deleteMany({
      where: { attributeId, code: { notIn: options.map((o) => o.code) } },
    });
    for (const [i, o] of options.entries()) {
      const row = await tx.attributeOption.upsert({
        where: { attributeId_code: { attributeId, code: o.code } },
        create: {
          attributeId,
          code: o.code,
          swatch: o.swatch ?? null,
          position: o.position ?? i,
        },
        update: { swatch: o.swatch ?? null, position: o.position ?? i },
        select: { id: true },
      });
      await tx.attributeOptionTranslation.deleteMany({
        where: { optionId: row.id },
      });
      await tx.attributeOptionTranslation.createMany({
        data: o.labels.map((l) => ({ optionId: row.id, ...l })),
      });
    }
  }

  /** Vetoed by the products module while any product uses the attribute. */
  async remove(id: string, actor: Principal): Promise<void> {
    const a = await this.prisma.attribute.findUnique({
      where: { id },
      select: { code: true, options: { select: { code: true } } },
    });
    if (!a) throw new NotFoundException(`Attribute ${id} not found`);
    await this.bus.write({
      before: new BeforeWriteEvent<AttributeWriteInput>(
        ATTRIBUTE_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
        {
          code: a.code,
          removedOptionCodes: a.options.map((o) => o.code),
        },
      ),
      work: async (tx, after) => {
        await tx.attribute.delete({ where: { id } });
        after.add(
          new EntityEvent(
            ATTRIBUTE_EVENTS.DELETED,
            actorOf(actor),
            'attribute',
            id,
            { code: a.code },
          ),
        );
      },
    });
  }

  // ─── attribute sets ───

  async listSets(): Promise<AttributeSetDto[]> {
    return (
      await this.prisma.attributeSet.findMany({
        select: SET_SELECT,
        orderBy: { code: 'asc' },
      })
    ).map(setToDto);
  }

  async getSet(id: string): Promise<AttributeSetDto> {
    const s = await this.prisma.attributeSet.findUnique({
      where: { id },
      select: SET_SELECT,
    });
    if (!s) throw new NotFoundException(`Attribute set ${id} not found`);
    return setToDto(s);
  }

  private async members(
    tx: PrismaTransaction,
    members: CreateAttributeSetDto['attributes'],
  ) {
    const codes = members.map((m) => m.code);
    if (new Set(codes).size !== codes.length)
      throw new BadRequestException('Duplicate attribute in set');
    const found = await tx.attribute.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    const missing = codes.filter((c) => !found.some((f) => f.code === c));
    if (missing.length)
      throw new BadRequestException(
        `Unknown attributes: ${missing.join(', ')}`,
      );
    return members.map((m, i) => ({
      attributeId: found.find((f) => f.code === m.code)!.id,
      groupName: m.groupName ?? 'General',
      position: m.position ?? i,
    }));
  }

  async createSet(
    dto: CreateAttributeSetDto,
    actor: Principal,
  ): Promise<AttributeSetDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        ATTRIBUTE_SET_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const s = await tx.attributeSet.create({
          data: {
            code: dto.code,
            name: dto.name,
            attributes: { create: await this.members(tx, dto.attributes) },
          },
          select: SET_SELECT,
        });
        after.add(
          new EntityEvent(
            ATTRIBUTE_SET_EVENTS.CREATED,
            actorOf(actor),
            'attribute_set',
            s.id,
            { code: s.code, attributes: dto.attributes.map((a) => a.code) },
          ),
        );
        return setToDto(s);
      },
    });
  }

  async updateSet(
    id: string,
    dto: UpdateAttributeSetDto,
    actor: Principal,
  ): Promise<AttributeSetDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        ATTRIBUTE_SET_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.attributeSet.findUnique({
          where: { id },
          select: SET_SELECT,
        });
        if (!before)
          throw new NotFoundException(`Attribute set ${id} not found`);
        const s = await tx.attributeSet.update({
          where: { id },
          data: {
            name: dto.name,
            ...(dto.attributes
              ? {
                  attributes: {
                    deleteMany: {},
                    create: await this.members(tx, dto.attributes),
                  },
                }
              : {}),
          },
          select: SET_SELECT,
        });
        const changes = diff(setToDto(before) as never, setToDto(s) as never, [
          'name',
          'attributes',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              ATTRIBUTE_SET_EVENTS.UPDATED,
              actorOf(actor),
              'attribute_set',
              id,
              changes,
            ),
          );
        return setToDto(s);
      },
    });
  }

  /** Fails (400, fk_products_attribute_set_id) while products use the set. */
  async removeSet(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        ATTRIBUTE_SET_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const s = await tx.attributeSet.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!s) throw new NotFoundException(`Attribute set ${id} not found`);
        await tx.attributeSet.delete({ where: { id } });
        after.add(
          new EntityEvent(
            ATTRIBUTE_SET_EVENTS.DELETED,
            actorOf(actor),
            'attribute_set',
            id,
            { code: s.code },
          ),
        );
      },
    });
  }
}
