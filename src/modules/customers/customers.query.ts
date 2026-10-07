import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

export interface GroupInfo {
  id: string;
  code: string;
  taxClassId: string | null;
}

/** Read-only customer group lookups for pricing. */
@Injectable()
export class CustomersQuery {
  constructor(private readonly prisma: PrismaService) {}

  groups(): Promise<GroupInfo[]> {
    return this.prisma.customerGroup.findMany({
      select: { id: true, code: true, taxClassId: true },
      orderBy: { code: 'asc' },
    });
  }

  async groupByCode(code: string): Promise<GroupInfo> {
    const g = await this.prisma.customerGroup.findUnique({
      where: { code },
      select: { id: true, code: true, taxClassId: true },
    });
    if (!g) throw new NotFoundException(`Customer group ${code} not found`);
    return g;
  }

  /** The group code of a customer, or undefined for an unknown id. */
  async groupOfCustomer(customerId: string): Promise<string | undefined> {
    const c = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { customerGroup: { select: { code: true } } },
    });
    return c?.customerGroup.code;
  }

  /** One of the customer's saved addresses (checkout copies it onto the cart), or null. */
  address(customerId: string, addressId: string) {
    return this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
      select: {
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
      },
    });
  }
}
