import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { hashPassword, passwordProblems } from '../../common/auth/password.js';
import { diff } from '../../common/events/audited.event.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { StorefrontCustomer } from '../stores/context/store-context.js';
import { CustomerSessionService } from './auth/customer-session.service.js';
import { CustomersQuery } from './customers.query.js';
import {
  CUSTOMER_EVENTS,
  type CustomerEventData,
  customerActor,
  DEFAULT_CUSTOMER_GROUP,
} from './customers.events.js';
import type { ProfileDto, UpdateProfileDto } from './dto/account.dto.js';
import type {
  CreateCustomerDto,
  CustomerDetailDto,
  CustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto.js';

const SELECT = {
  id: true,
  websiteId: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  localeCode: true,
  status: true,
  acceptsMarketing: true,
  lastLoginAt: true,
  lockedUntil: true,
  createdAt: true,
  updatedAt: true,
  customerGroupId: true,
  customerGroup: { select: { code: true } },
} as const satisfies Prisma.CustomerSelect;

type Row = Prisma.CustomerGetPayload<{ select: typeof SELECT }>;

const toDto = ({
  customerGroup,
  customerGroupId: _g,
  ...c
}: Row): CustomerDto => ({
  ...c,
  groupCode: customerGroup.code,
});

const ADDRESS_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  company: true,
  phone: true,
  countryCode: true,
  regionCode: true,
  city: true,
  postcode: true,
  line1: true,
  line2: true,
  isDefaultShipping: true,
  isDefaultBilling: true,
} as const;

const AUDITED = [
  'firstName',
  'lastName',
  'phone',
  'localeCode',
  'acceptsMarketing',
  'customerGroupId',
  'status',
];

/** Customer accounts: back office (`/admin/customers`) and the shopper's own profile. */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly groups: CustomersQuery,
    private readonly sessions: CustomerSessionService,
  ) {}

  async list(q: ListCustomersQueryDto): Promise<Paginated<CustomerDto>> {
    const where: Prisma.CustomerWhereInput = {
      websiteId: q.websiteId,
      status: q.status,
      ...(q.groupCode ? { customerGroup: { code: q.groupCode } } : {}),
      ...(q.search
        ? {
            OR: [
              { email: { contains: q.search, mode: 'insensitive' } },
              { firstName: { contains: q.search, mode: 'insensitive' } },
              { lastName: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        select: SELECT,
        orderBy: [{ createdAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.customer.count({ where }),
    ]);
    return paginated(rows.map(toDto), total, q);
  }

  async get(id: string): Promise<CustomerDetailDto> {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        ...SELECT,
        addresses: { select: ADDRESS_SELECT, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!c) throw new NotFoundException(`Customer ${id} not found`);
    const { addresses, ...rest } = c;
    return { ...toDto(rest), addresses };
  }

  async create(dto: CreateCustomerDto, actor: Principal): Promise<CustomerDto> {
    const problems = passwordProblems(dto.password, dto.email);
    if (problems.length)
      throw new BadRequestException(problems.map((p) => `password ${p}`));
    const group = await this.groups.groupByCode(
      dto.groupCode ?? DEFAULT_CUSTOMER_GROUP,
    );
    const passwordHash = await hashPassword(dto.password);
    return this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { websiteId: dto.websiteId, customerGroupId: group.id },
      ),
      work: async (tx, after) => {
        const c = await tx.customer.create({
          data: {
            websiteId: dto.websiteId,
            email: dto.email,
            passwordHash,
            passwordChangedAt: new Date(),
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone ?? null,
            localeCode: dto.localeCode ?? null,
            acceptsMarketing: dto.acceptsMarketing ?? false,
            customerGroupId: group.id,
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent<CustomerEventData>(
            CUSTOMER_EVENTS.CREATED,
            actorOf(actor),
            'customer',
            c.id,
            { websiteId: c.websiteId, groupCode: group.code },
            {
              customerId: c.id,
              websiteId: c.websiteId,
              customerGroupId: group.id,
            },
          ),
        );
        return toDto(c);
      },
    });
  }

  /** Back-office edit; disabling an account ends its sessions. */
  async update(
    id: string,
    dto: UpdateCustomerDto,
    actor: Principal,
  ): Promise<CustomerDto> {
    const group = dto.groupCode
      ? await this.groups.groupByCode(dto.groupCode)
      : undefined;
    const { result, families } = await this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        { customerGroupId: group?.id },
      ),
      work: async (tx, after) => {
        const before = await tx.customer.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Customer ${id} not found`);
        const c = await tx.customer.update({
          where: { id },
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone,
            localeCode: dto.localeCode,
            acceptsMarketing: dto.acceptsMarketing,
            customerGroupId: group?.id,
            status: dto.status,
            // Re-enabling also lifts a lockout.
            ...(dto.status === 'ACTIVE'
              ? { failedLogins: 0, lockedUntil: null }
              : {}),
          },
          select: SELECT,
        });
        const families =
          dto.status === 'DISABLED' && before.status !== 'DISABLED'
            ? await this.sessions.revokeFamilies(tx, { customerId: id })
            : [];
        const changes = diff(before, c, AUDITED);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent<CustomerEventData>(
              CUSTOMER_EVENTS.UPDATED,
              actorOf(actor),
              'customer',
              id,
              changes,
              {
                customerId: id,
                websiteId: c.websiteId,
                customerGroupId: c.customerGroupId,
              },
            ),
          );
        return { result: toDto(c), families };
      },
    });
    await this.sessions.markRevoked(families);
    return result;
  }

  /** Deletes the account with its addresses, sessions and points (GDPR erasure). */
  async remove(id: string, actor: Principal): Promise<void> {
    const families = await this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const c = await tx.customer.findUnique({
          where: { id },
          select: { websiteId: true, customerGroupId: true },
        });
        if (!c) throw new NotFoundException(`Customer ${id} not found`);
        const f = await this.sessions.revokeFamilies(tx, { customerId: id });
        await tx.customer.delete({ where: { id } });
        after.add(
          new EntityEvent<CustomerEventData>(
            CUSTOMER_EVENTS.DELETED,
            actorOf(actor),
            'customer',
            id,
            {},
            { customerId: id, ...c },
          ),
        );
        return f;
      },
    });
    await this.sessions.markRevoked(families);
  }

  /** Ends every session of a customer (e.g. a reported stolen device). */
  async logoutEverywhere(id: string, actor: Principal): Promise<void> {
    const families = await this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_SESSION_WRITE,
        'logout',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        if (
          !(await tx.customer.findUnique({
            where: { id },
            select: { id: true },
          }))
        )
          throw new NotFoundException(`Customer ${id} not found`);
        const f = await this.sessions.revokeFamilies(tx, { customerId: id });
        after.add(
          new EntityEvent(
            CUSTOMER_EVENTS.LOGGED_OUT,
            actorOf(actor),
            'customer',
            id,
            {
              everywhere: true,
            },
          ),
        );
        return f;
      },
    });
    await this.sessions.markRevoked(families);
  }

  async profile(customer: StorefrontCustomer): Promise<ProfileDto> {
    const c = await this.prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
      select: SELECT,
    });
    return profileOf(c);
  }

  async updateProfile(
    customer: StorefrontCustomer,
    dto: UpdateProfileDto,
  ): Promise<ProfileDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_WRITE,
        'update-profile',
        customer.id,
        customerActor(customer),
        {},
      ),
      work: async (tx, after) => {
        const before = await tx.customer.findUniqueOrThrow({
          where: { id: customer.id },
          select: SELECT,
        });
        const c = await tx.customer.update({
          where: { id: customer.id },
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone,
            localeCode: dto.localeCode,
            acceptsMarketing: dto.acceptsMarketing,
          },
          select: SELECT,
        });
        const changes = diff(before, c, AUDITED);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent<CustomerEventData>(
              CUSTOMER_EVENTS.UPDATED,
              customerActor(customer),
              'customer',
              customer.id,
              changes,
              {
                customerId: c.id,
                websiteId: c.websiteId,
                customerGroupId: c.customerGroupId,
              },
            ),
          );
        return profileOf(c);
      },
    });
  }
}

function profileOf(c: Row): ProfileDto {
  return {
    id: c.id,
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    localeCode: c.localeCode,
    acceptsMarketing: c.acceptsMarketing,
    group: c.customerGroup.code,
    createdAt: c.createdAt,
  };
}
