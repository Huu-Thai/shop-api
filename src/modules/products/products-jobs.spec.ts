import { BadRequestException } from '@nestjs/common';
import { type AnyFn, fakePrisma } from '../../testing/fake-prisma.js';
import { jobContext, outputText } from '../../testing/jobs.js';
import { fakeStores, storeSnap } from '../../testing/stores.js';
import { JobCanceledError } from '../jobs/job-handler.js';
import { ExportProductsJob, ImportProductsJob } from './products.jobs.js';

const W1 = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';
const SET_DEFAULT = '00000000-0000-4000-8000-0000000000b1';
const SET_APPAREL = '00000000-0000-4000-8000-0000000000b2';

const stores = () => {
  const s = fakeStores(
    storeSnap({ websiteId: W1 }),
    storeSnap({
      id: 's2',
      code: 'vn-vi',
      websiteId: W2,
      websiteCode: 'vn',
      localeCodes: ['vi-VN'],
      defaultLocaleCode: 'vi-VN',
    }),
  );
  return s;
};
const attributes = {
  setCodes: vi.fn(
    async () =>
      new Map([
        [SET_DEFAULT, 'default'],
        [SET_APPAREL, 'apparel'],
      ]),
  ),
};

describe('ExportProductsJob', () => {
  it('writes one row per product with texts per locale, page by page', async () => {
    const prisma = fakePrisma();
    const product = (id: string, extra = {}) => ({
      id,
      sku: `SKU-${id}`,
      type: 'SIMPLE',
      status: 'ENABLED',
      visibility: 'CATALOG_SEARCH',
      attributeSetId: SET_APPAREL,
      weightGrams: 120,
      websites: [{ websiteId: W2 }, { websiteId: W1 }],
      translations: [
        {
          localeCode: 'en-US',
          name: 'Tee',
          shortDescription: '=cmd',
          description: null,
          metaTitle: null,
          metaDescription: null,
        },
      ],
      ...extra,
    });
    prisma.product.count.mockResolvedValue(2);
    prisma.product.findMany
      .mockResolvedValueOnce([
        product('p1'),
        product('p2', {
          weightGrams: null,
          websites: [],
          attributeSetId: 'gone',
        }),
      ])
      .mockResolvedValueOnce([]);
    const job = new ExportProductsJob(
      prisma as never,
      attributes as never,
      stores() as never,
    );
    expect(await job.validate({})).toEqual({});
    await expect(job.validate({ x: 1 })).rejects.toThrow('takes none');
    const ctx = jobContext();
    const out = await job.run(ctx);
    expect(out.stats).toEqual({ rows: 2 });
    const lines = outputText(out).trim().split('\n');
    expect(lines[0]).toBe(
      'sku,type,status,visibility,attribute_set,weight_grams,websites,name[en-US],short_description[en-US],description[en-US],meta_title[en-US],meta_description[en-US],name[vi-VN],short_description[vi-VN],description[vi-VN],meta_title[vi-VN],meta_description[vi-VN]',
    );
    expect(lines[1]).toBe(
      "SKU-p1,SIMPLE,ENABLED,CATALOG_SEARCH,apparel,120,us|vn,Tee,'=cmd,,,,,,,,",
    );
    expect(lines[2]).toBe(
      "SKU-p2,SIMPLE,ENABLED,CATALOG_SEARCH,,,,Tee,'=cmd,,,,,,,,",
    );
    expect(prisma.product.findMany.mock.calls[1][0]).toMatchObject({
      skip: 1,
      cursor: { id: 'p2' },
    });
    expect(out.output!.name).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('stops when cancelled', async () => {
    const prisma = fakePrisma();
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1', sku: 'A', websites: [], translations: [] },
    ]);
    const job = new ExportProductsJob(
      prisma as never,
      attributes as never,
      stores() as never,
    );
    await expect(
      job.run(jobContext('', { cancelRequested: vi.fn(async () => true) })),
    ).rejects.toBeInstanceOf(JobCanceledError);
  });
});

describe('ImportProductsJob', () => {
  function setup() {
    const prisma = fakePrisma();
    prisma.product.findMany.mockResolvedValue([
      {
        id: 'p1',
        sku: 'TEE',
        translations: [{ localeCode: 'en-US', name: 'Tee' }],
      },
    ]);
    prisma.productVariant.findMany.mockResolvedValue([{ sku: 'TEE-RED-M' }]);
    const products = {
      update: vi.fn<AnyFn>(async () => ({})),
      create: vi.fn<AnyFn>(async () => ({ id: 'new' })),
    };
    const job = new ImportProductsJob(
      prisma as never,
      products as never,
      attributes as never,
      stores() as never,
    );
    return { prisma, products, job };
  }

  it('updates known SKUs with the filled cells and creates simple/virtual products', async () => {
    const { job, products } = setup();
    const csv = [
      'sku,type,status,visibility,attribute_set,weight_grams,websites,name[en-US],short_description[en-US],name[vi-VN]',
      'TEE,,disabled,catalog,,150,us|vn,,New short,Áo',
      'MUG,virtual,,,apparel,,us,Mug,,',
    ].join('\n');
    const ctx = jobContext(csv);
    const result = await job.run(ctx);
    expect(ctx.errors).toEqual([]);
    expect(result).toEqual({
      stats: { rows: 2, created: 1, updated: 1, failed: 0 },
    });
    expect(ctx.errors).toEqual([]);
    const [id, update, principal] = products.update.mock.calls[0];
    expect(id).toBe('p1');
    expect(update).toMatchObject({
      status: 'DISABLED',
      visibility: 'CATALOG',
      weightGrams: 150,
      websiteIds: [W1, W2],
      translations: [
        { localeCode: 'en-US', shortDescription: 'New short', name: 'Tee' },
        { localeCode: 'vi-VN', name: 'Áo' },
      ],
    });
    expect(principal).toMatchObject({
      type: 'admin',
      permissions: ['catalog:write'],
    });
    expect(products.create.mock.calls[0][0]).toMatchObject({
      sku: 'MUG',
      type: 'VIRTUAL',
      attributeSetId: SET_APPAREL,
      websiteIds: [W1],
      translations: [{ localeCode: 'en-US', name: 'Mug' }],
    });
  });

  it('reports problem rows and applies the others', async () => {
    const { job, products } = setup();
    products.update.mockRejectedValueOnce(
      new BadRequestException(['slug taken', 'name too long']),
    );
    const csv = [
      'sku,type,status,visibility,attribute_set,weight_grams,websites,name[en-US]',
      'TEE,,,,,,,Renamed',
      ',,,,,,,X',
      'TEE,,,,,,,Again',
      'TEE-RED-M,,,,,,,Variant',
      'NEW1,bundle,,,,,,Set',
      'NEW2,,,,,,,',
      'NEW3,,maybe,,,,,N',
      'NEW4,,,hidden,,,,N',
      'NEW5,,,,,heavy,,N',
      'NEW6,,,,,,mars,N',
      'NEW7,,,,nope,,,N',
      'NEW8,,,,,,,' + 'x'.repeat(300),
    ].join('\n');
    const ctx = jobContext(csv);
    const r = await job.run(ctx);
    expect(r.stats).toEqual({ rows: 12, created: 0, updated: 0, failed: 12 });
    expect(ctx.errors.map((e) => `${e.row}: ${e.message}`)).toEqual([
      '2: slug taken; name too long',
      '3: sku is empty',
      '4: TEE appears more than once in the file',
      "5: TEE-RED-M is a variant; import its product's SKU",
      "6: New BUNDLE products can't be created from CSV (simple or virtual only); create it in the admin, then import its texts",
      '7: A new product needs at least one name[locale]',
      '8: status must be ENABLED or DISABLED',
      '9: visibility must be one of CATALOG_SEARCH, CATALOG, SEARCH, NOT_VISIBLE',
      '10: weight_grams must be a whole number',
      '11: Unknown website(s): mars',
      '12: Unknown attribute set nope',
      '13: translations.0.name must be shorter than or equal to 255 characters',
    ]);
  });

  it('a translation without a name needs an existing one', async () => {
    const { job } = setup();
    const ctx = jobContext('sku,short_description[fr-FR]\nTEE,Court\n');
    await job.run(ctx);
    expect(ctx.errors).toEqual([
      { row: 2, message: 'name[fr-FR] is required' },
    ]);
  });

  it('refuses bad files and scheduled runs', async () => {
    const { job } = setup();
    await expect(job.run(jobContext('sku,colour\nA,red\n'))).rejects.toThrow(
      'Unknown columns: colour',
    );
    await expect(
      job.run(
        jobContext('sku\nA\n', {
          actor: { type: 'system', id: null, label: 'scheduler' },
        }),
      ),
    ).rejects.toThrow('started by an admin');
    expect(await job.validate({})).toEqual({});
  });
});
