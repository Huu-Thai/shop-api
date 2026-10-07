import {
  breakingChanges,
  contractProblems,
  schemaRefs,
  sortKeys,
  storefrontContract,
} from './storefront-contract.js';

const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const doc = {
  openapi: '3.0.0',
  paths: {
    '/api/v1/store/products/{id}': {
      get: {
        operationId: 'getProduct',
        responses: {
          '200': {
            content: { 'application/json': { schema: ref('Product') } },
          },
        },
      },
    },
    '/api/v1/admin/products': {
      get: {
        responses: {
          '200': {
            content: { 'application/json': { schema: ref('AdminProduct') } },
          },
        },
      },
    },
    '/api/v1/store-ish': { get: {} },
  },
  components: {
    schemas: {
      Product: {
        type: 'object',
        properties: {
          image: ref('Image'),
          cards: { type: 'array', items: ref('Card') },
        },
      },
      Image: { type: 'object' },
      Card: { type: 'object', properties: { image: ref('Image') } },
      AdminProduct: { type: 'object' },
    },
  },
};

describe('storefront contract', () => {
  it('keeps storefront paths and the transitive closure of their schemas', () => {
    const c = storefrontContract(doc) as {
      paths: object;
      components: { schemas: object };
    };
    expect(Object.keys(c.paths)).toEqual(['/api/v1/store/products/{id}']);
    expect(Object.keys(c.components.schemas)).toEqual([
      'Card',
      'Image',
      'Product',
    ]);
  });

  it('finds refs and sorts keys deterministically', () => {
    expect([
      ...schemaRefs({ a: [ref('X'), { b: ref('Y') }], $ref: '#/other/Z' }),
    ]).toEqual(['X', 'Y']);
    expect(
      JSON.stringify(sortKeys({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 0 } })),
    ).toBe('{"a":{"c":0,"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('flags operations without ids or typed responses', () => {
    expect(
      contractProblems({ paths: { '/x': { get: { responses: {} } } } }),
    ).toEqual([
      'GET /x has no operationId',
      'GET /x has no typed 200 response',
    ]);
    expect(contractProblems(storefrontContract(doc))).toEqual([]);
  });

  it('detects breaking changes but allows additions', () => {
    const base = {
      paths: {
        '/a': {
          get: {
            parameters: [
              { in: 'query', name: 'page' },
              { in: 'query', name: 'q' },
            ],
          },
        },
        '/b': { get: {} },
      },
      components: {
        schemas: {
          P: { properties: { id: { type: 'string' }, n: { type: 'number' } } },
          Gone: {},
        },
      },
    };
    const next = {
      paths: {
        '/a': {
          get: {
            parameters: [
              { in: 'query', name: 'page', required: true },
              { in: 'query', name: 'new' },
            ],
          },
        },
        '/c': { get: {} },
      },
      components: {
        schemas: {
          P: {
            properties: {
              id: { type: 'string' },
              n: { type: 'string' },
              extra: { type: 'boolean' },
            },
          },
          New: {},
        },
      },
    };
    expect(breakingChanges(base, next as never)).toEqual([
      'GET /a: parameter page is now required',
      'GET /a: parameter query:q was removed',
      'GET /b was removed',
      'P.n changed type',
      'schema Gone was removed',
    ]);
    expect(breakingChanges(base, base)).toEqual([]);
  });
});
