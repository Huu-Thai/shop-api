import { BadRequestException, NotFoundException } from '@nestjs/common';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import { CustomerGroupsController } from './customers.controller.js';
import { CustomersQuery } from './customers.query.js';

describe('customer groups', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    return {
      svc: new CustomerGroupsService(prisma as never, fb.bus),
      prisma,
      ...fb,
    };
  }
  const group = {
    id: 'g',
    code: 'vip',
    name: 'VIP',
    taxClassId: null,
    isSystem: false,
  };

  it('create / update / delete with the tax class announced for the veto', async () => {
    const { svc, prisma, before, afterNames } = setup();
    prisma.customerGroup.create.mockResolvedValue(group);
    await svc.create({ code: 'vip', name: 'VIP', taxClassId: 'tc' }, ROOT);
    expect(before[0]).toMatchObject({
      name: 'customer-group.before-write',
      input: { taxClassId: 'tc' },
    });
    prisma.customerGroup.findUnique.mockResolvedValue(group);
    prisma.customerGroup.update
      .mockResolvedValueOnce(group)
      .mockResolvedValueOnce({ ...group, name: 'Very' });
    await svc.update('g', { name: 'VIP' }, ROOT);
    await svc.update('g', { name: 'Very' }, ROOT);
    await svc.remove('g', ROOT);
    expect(afterNames()).toEqual([
      'customer-group.created',
      'customer-group.updated',
      'customer-group.deleted',
    ]);
  });

  it('protects system groups and reports missing ones', async () => {
    const { svc, prisma } = setup();
    prisma.customerGroup.findUnique.mockResolvedValue({
      ...group,
      isSystem: true,
      code: 'guest',
    });
    await expect(svc.remove('g', ROOT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.customerGroup.findUnique.mockResolvedValue(null);
    await expect(svc.remove('g', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.update('g', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await svc.list();
  });

  it('query and controller', async () => {
    const prisma = fakePrisma();
    const q = new CustomersQuery(prisma as never);
    await expect(q.groupByCode('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.customerGroup.findUnique.mockResolvedValue({
      id: 'g',
      code: 'guest',
      taxClassId: null,
    });
    expect((await q.groupByCode('guest')).id).toBe('g');
    expect(await q.groups()).toEqual([]);
    await q.address('cu', 'a1');
    expect(prisma.customerAddress.findFirst.mock.calls[0][0].where).toEqual({
      id: 'a1',
      customerId: 'cu',
    });
    const svc = {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };
    const c = new CustomerGroupsController(svc as never);
    c.list();
    c.create({} as never, ROOT);
    c.update('g', {}, ROOT);
    c.remove('g', ROOT);
    for (const fn of Object.values(svc)) expect(fn).toHaveBeenCalled();
  });
});
