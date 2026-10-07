import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ActorRef } from '../../common/auth/principal.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import { CUSTOMER_ADDRESS_EVENTS } from './customers.events.js';
import type {
  AddressDto,
  CreateAddressDto,
  UpdateAddressDto,
} from './dto/address.dto.js';

export const MAX_ADDRESSES = 20;

const SELECT = {
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

/**
 * Address book of a customer (used by the shopper and the back office). At most one default
 * shipping and one default billing address; setting a new default clears the old one.
 */
@Injectable()
export class AddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  list(customerId: string): Promise<AddressDto[]> {
    return this.prisma.customerAddress.findMany({
      where: { customerId },
      select: SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  create(
    customerId: string,
    dto: CreateAddressDto,
    actor: ActorRef,
  ): Promise<AddressDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_ADDRESS_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actor,
        { customerId },
      ),
      work: async (tx, after) => {
        if (
          !(await tx.customer.findUnique({
            where: { id: customerId },
            select: { id: true },
          }))
        )
          throw new NotFoundException(`Customer ${customerId} not found`);
        const count = await tx.customerAddress.count({ where: { customerId } });
        if (count >= MAX_ADDRESSES)
          throw new BadRequestException(
            `An address book holds at most ${MAX_ADDRESSES} addresses`,
          );
        // The first address becomes the default for both.
        const shipping = dto.isDefaultShipping ?? count === 0;
        const billing = dto.isDefaultBilling ?? count === 0;
        await clearDefaults(tx, customerId, shipping, billing);
        const a = await tx.customerAddress.create({
          data: {
            customerId,
            ...normalize(dto),
            firstName: dto.firstName,
            lastName: dto.lastName,
            countryCode: dto.countryCode,
            city: dto.city,
            line1: dto.line1,
            isDefaultShipping: shipping,
            isDefaultBilling: billing,
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            CUSTOMER_ADDRESS_EVENTS.CREATED,
            actor,
            'customer_address',
            a.id,
            { customerId, countryCode: a.countryCode },
          ),
        );
        return a;
      },
    });
  }

  update(
    customerId: string,
    id: string,
    dto: UpdateAddressDto,
    actor: ActorRef,
  ): Promise<AddressDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_ADDRESS_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actor,
        { customerId },
      ),
      work: async (tx, after) => {
        await own(tx, customerId, id);
        await clearDefaults(
          tx,
          customerId,
          dto.isDefaultShipping === true,
          dto.isDefaultBilling === true,
          id,
        );
        const a = await tx.customerAddress.update({
          where: { id },
          data: {
            ...normalize(dto),
            isDefaultShipping: dto.isDefaultShipping,
            isDefaultBilling: dto.isDefaultBilling,
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            CUSTOMER_ADDRESS_EVENTS.UPDATED,
            actor,
            'customer_address',
            id,
            { customerId, fields: Object.keys(dto) },
          ),
        );
        return a;
      },
    });
  }

  async remove(customerId: string, id: string, actor: ActorRef): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_ADDRESS_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actor,
        { customerId },
      ),
      work: async (tx, after) => {
        await own(tx, customerId, id);
        await tx.customerAddress.delete({ where: { id } });
        after.add(
          new EntityEvent(
            CUSTOMER_ADDRESS_EVENTS.DELETED,
            actor,
            'customer_address',
            id,
            { customerId },
          ),
        );
      },
    });
  }
}

/** Only the customer's own addresses (another customer's id is "not found"). */
async function own(
  tx: PrismaTransaction,
  customerId: string,
  id: string,
): Promise<void> {
  const a = await tx.customerAddress.findFirst({
    where: { id, customerId },
    select: { id: true },
  });
  if (!a) throw new NotFoundException(`Address ${id} not found`);
}

async function clearDefaults(
  tx: PrismaTransaction,
  customerId: string,
  shipping: boolean,
  billing: boolean,
  exceptId?: string,
): Promise<void> {
  const not = exceptId ? { id: { not: exceptId } } : {};
  if (shipping)
    await tx.customerAddress.updateMany({
      where: { customerId, isDefaultShipping: true, ...not },
      data: { isDefaultShipping: false },
    });
  if (billing)
    await tx.customerAddress.updateMany({
      where: { customerId, isDefaultBilling: true, ...not },
      data: { isDefaultBilling: false },
    });
}

function normalize(dto: UpdateAddressDto) {
  const blankToNull = (v: string | undefined) =>
    v === undefined ? undefined : v || null;
  return {
    firstName: dto.firstName,
    lastName: dto.lastName,
    company: blankToNull(dto.company),
    phone: blankToNull(dto.phone),
    countryCode: dto.countryCode,
    regionCode: blankToNull(dto.regionCode),
    city: dto.city,
    postcode: blankToNull(dto.postcode),
    line1: dto.line1,
    line2: blankToNull(dto.line2),
  };
}
