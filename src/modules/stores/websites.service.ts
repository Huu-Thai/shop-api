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
  CreateWebsiteDto,
  UpdateWebsiteDto,
  WebsiteDto,
} from './dto/website-store.dto.js';
import { WEBSITE_EVENTS } from './stores.events.js';

const SELECT = {
  id: true,
  code: true,
  name: true,
  baseCurrencyCode: true,
  defaultStoreId: true,
  position: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  stores: { select: { code: true }, orderBy: { position: 'asc' } },
} as const satisfies Prisma.WebsiteSelect;
type Row = Prisma.WebsiteGetPayload<{ select: typeof SELECT }>;
const toDto = (w: Row): WebsiteDto => ({
  ...w,
  stores: w.stores.map((s) => s.code),
});

@Injectable()
export class WebsitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  async list(): Promise<WebsiteDto[]> {
    return (
      await this.prisma.website.findMany({
        select: SELECT,
        orderBy: [{ position: 'asc' }, { code: 'asc' }],
      })
    ).map(toDto);
  }

  async get(id: string): Promise<WebsiteDto> {
    const w = await this.prisma.website.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!w) throw new NotFoundException(`Website ${id} not found`);
    return toDto(w);
  }

  async create(dto: CreateWebsiteDto, actor: Principal): Promise<WebsiteDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        WEBSITE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        await assertActiveCurrency(tx, dto.baseCurrencyCode);
        const w = await tx.website.create({ data: dto, select: SELECT });
        after.add(
          new EntityEvent(
            WEBSITE_EVENTS.CREATED,
            actorOf(actor),
            'website',
            w.id,
            { code: w.code, baseCurrencyCode: w.baseCurrencyCode },
          ),
        );
        return toDto(w);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateWebsiteDto,
    actor: Principal,
  ): Promise<WebsiteDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        WEBSITE_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.website.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Website ${id} not found`);
        if (dto.baseCurrencyCode)
          await assertActiveCurrency(tx, dto.baseCurrencyCode);
        if (dto.defaultStoreId) {
          const s = await tx.store.findUnique({
            where: { id: dto.defaultStoreId },
            select: { websiteId: true },
          });
          if (s?.websiteId !== id)
            throw new BadRequestException(
              'defaultStoreId must be a store of this website',
            );
        }
        const w = await tx.website.update({
          where: { id },
          data: dto,
          select: SELECT,
        });
        const changes = diff(before, w, [
          'name',
          'baseCurrencyCode',
          'defaultStoreId',
          'position',
          'isActive',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              WEBSITE_EVENTS.UPDATED,
              actorOf(actor),
              'website',
              id,
              changes,
            ),
          );
        return toDto(w);
      },
    });
  }

  /** Only empty websites can be deleted (stores RESTRICT); catalog assignments cascade. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        WEBSITE_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const w = await tx.website.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!w) throw new NotFoundException(`Website ${id} not found`);
        await tx.website.delete({ where: { id } });
        after.add(
          new EntityEvent(
            WEBSITE_EVENTS.DELETED,
            actorOf(actor),
            'website',
            id,
            { code: w.code },
          ),
        );
      },
    });
  }
}

export async function assertActiveCurrency(
  tx: PrismaTransaction,
  code: string,
): Promise<void> {
  const c = await tx.currency.findUnique({
    where: { code },
    select: { isActive: true },
  });
  if (!c?.isActive)
    throw new BadRequestException(
      `Currency ${code} does not exist or is not active`,
    );
}
