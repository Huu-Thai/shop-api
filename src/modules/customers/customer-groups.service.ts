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
import { PrismaService } from '../../database/prisma.service.js';
import {
  CUSTOMER_GROUP_EVENTS,
  type CustomerGroupWriteInput,
} from './customers.events.js';
import type {
  CreateCustomerGroupDto,
  CustomerGroupDto,
  UpdateCustomerGroupDto,
} from './dto/customer-group.dto.js';

const SELECT = {
  id: true,
  code: true,
  name: true,
  taxClassId: true,
  isSystem: true,
} as const;

/** Customer groups drive price books and the customer tax class. */
@Injectable()
export class CustomerGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  list(): Promise<CustomerGroupDto[]> {
    return this.prisma.customerGroup.findMany({
      select: SELECT,
      orderBy: { code: 'asc' },
    });
  }

  create(
    dto: CreateCustomerGroupDto,
    actor: Principal,
  ): Promise<CustomerGroupDto> {
    return this.bus.write({
      before: new BeforeWriteEvent<CustomerGroupWriteInput>(
        CUSTOMER_GROUP_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { taxClassId: dto.taxClassId },
      ),
      work: async (tx, after) => {
        const g = await tx.customerGroup.create({
          data: {
            code: dto.code,
            name: dto.name,
            taxClassId: dto.taxClassId ?? null,
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            CUSTOMER_GROUP_EVENTS.CREATED,
            actorOf(actor),
            'customer_group',
            g.id,
            { code: g.code, taxClassId: g.taxClassId },
          ),
        );
        return g;
      },
    });
  }

  update(
    id: string,
    dto: UpdateCustomerGroupDto,
    actor: Principal,
  ): Promise<CustomerGroupDto> {
    return this.bus.write({
      before: new BeforeWriteEvent<CustomerGroupWriteInput>(
        CUSTOMER_GROUP_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        { taxClassId: dto.taxClassId },
      ),
      work: async (tx, after) => {
        const before = await tx.customerGroup.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before)
          throw new NotFoundException(`Customer group ${id} not found`);
        const g = await tx.customerGroup.update({
          where: { id },
          data: { name: dto.name, taxClassId: dto.taxClassId },
          select: SELECT,
        });
        const changes = diff(before, g, ['name', 'taxClassId']);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              CUSTOMER_GROUP_EVENTS.UPDATED,
              actorOf(actor),
              'customer_group',
              id,
              changes,
            ),
          );
        return g;
      },
    });
  }

  /** System groups (guest, general) stay; group-specific price books go with the group. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent<CustomerGroupWriteInput>(
        CUSTOMER_GROUP_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
        {},
      ),
      work: async (tx, after) => {
        const g = await tx.customerGroup.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!g) throw new NotFoundException(`Customer group ${id} not found`);
        if (g.isSystem)
          throw new BadRequestException(
            `${g.code} is a system group and cannot be deleted`,
          );
        await tx.customerGroup.delete({ where: { id } });
        after.add(
          new EntityEvent(
            CUSTOMER_GROUP_EVENTS.DELETED,
            actorOf(actor),
            'customer_group',
            id,
            { code: g.code },
          ),
        );
      },
    });
  }
}
