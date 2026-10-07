/**
 * Provider contract suite (PLAN.md §10): every external SearchProvider must behave the same for
 * indexing, text, filters, facets, sorting, suggestions and removal. Meilisearch always runs;
 * set SEARCH_PROVIDERS=opensearch,elasticsearch to include those (heavier; nightly in CI).
 */
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { ElasticLikeProvider } from '../src/modules/search/providers/elastic.provider.js';
import { MeiliProvider } from '../src/modules/search/providers/meili.provider.js';
import type {
  EngineQuery,
  IndexTarget,
  SearchDocumentBody,
  SearchProvider,
} from '../src/modules/search/search.types.js';

const doc = (
  id: string,
  o: Partial<SearchDocumentBody>,
): SearchDocumentBody => ({
  id,
  type: 'SIMPLE',
  name: id,
  nameSort: id.toLowerCase(),
  sku: id.toUpperCase(),
  skus: [id.toUpperCase()],
  shortDescription: '',
  description: '',
  attributesText: '',
  categoryIds: [],
  facets: {},
  price: null,
  inStock: true,
  visibility: 'CATALOG_SEARCH',
  createdAt: 0,
  ...o,
});
const DOCS = [
  doc('00000000-0000-4000-8000-000000000001', {
    name: 'Classic Tee',
    nameSort: 'classic tee',
    skus: ['TEE-RED'],
    facets: { color: ['red', 'blue'] },
    categoryIds: ['men', 'tees'],
    price: 2500,
    createdAt: 3,
  }),
  doc('00000000-0000-4000-8000-000000000002', {
    name: 'Polo Shirt',
    nameSort: 'polo shirt',
    facets: { color: ['blue'] },
    categoryIds: ['men', 'tees'],
    price: 3500,
    inStock: false,
    createdAt: 2,
  }),
  doc('00000000-0000-4000-8000-000000000003', {
    name: 'Wool Socks',
    nameSort: 'wool socks',
    attributesText: 'Merino wool',
    facets: { color: ['red'] },
    categoryIds: ['acc'],
    price: 1200,
    createdAt: 1,
  }),
  doc('00000000-0000-4000-8000-000000000004', {
    name: 'Gift wrap',
    nameSort: 'gift wrap',
    visibility: 'CATALOG',
    price: 300,
  }),
];
const [TEE, POLO, SOCKS] = DOCS.map((d) => d.id);
const q = (o: Partial<EngineQuery>): EngineQuery => ({
  text: '',
  filters: { facets: {}, visibility: ['CATALOG_SEARCH', 'SEARCH'] },
  sort: 'relevance',
  offset: 0,
  limit: 10,
  facetCodes: ['color'],
  categoryFacet: true,
  priceStats: true,
  ...o,
});

interface Engine {
  name: string;
  start(): Promise<{
    container: StartedTestContainer;
    provider: SearchProvider;
  }>;
}

const ENGINES: Engine[] = [
  {
    name: 'meilisearch',
    async start() {
      const container = await new GenericContainer('getmeili/meilisearch:v1.13')
        .withEnvironment({
          MEILI_MASTER_KEY: 'contract-master-key-0123456789',
          MEILI_NO_ANALYTICS: 'true',
        })
        .withExposedPorts(7700)
        .withWaitStrategy(Wait.forHttp('/health', 7700))
        .start();
      return {
        container,
        provider: new MeiliProvider({
          url: `http://${container.getHost()}:${container.getMappedPort(7700)}`,
          apiKey: 'contract-master-key-0123456789',
        }),
      };
    },
  },
  {
    name: 'opensearch',
    async start() {
      const container = await new GenericContainer(
        'opensearchproject/opensearch:2.19.1',
      )
        .withEnvironment({
          'discovery.type': 'single-node',
          DISABLE_SECURITY_PLUGIN: 'true',
          DISABLE_INSTALL_DEMO_CONFIG: 'true',
          OPENSEARCH_JAVA_OPTS: '-Xms512m -Xmx512m',
        })
        .withExposedPorts(9200)
        .withWaitStrategy(
          Wait.forHttp('/_cluster/health', 9200).withStartupTimeout(180_000),
        )
        .start();
      return {
        container,
        provider: new ElasticLikeProvider('OPENSEARCH', {
          url: `http://${container.getHost()}:${container.getMappedPort(9200)}`,
        }),
      };
    },
  },
  {
    name: 'elasticsearch',
    async start() {
      const container = await new GenericContainer(
        'docker.elastic.co/elasticsearch/elasticsearch:8.17.4',
      )
        .withEnvironment({
          'discovery.type': 'single-node',
          'xpack.security.enabled': 'false',
          ES_JAVA_OPTS: '-Xms512m -Xmx512m',
        })
        .withExposedPorts(9200)
        .withWaitStrategy(
          Wait.forHttp('/_cluster/health', 9200).withStartupTimeout(180_000),
        )
        .start();
      return {
        container,
        provider: new ElasticLikeProvider('ELASTICSEARCH', {
          url: `http://${container.getHost()}:${container.getMappedPort(9200)}`,
        }),
      };
    },
  },
];

const enabled = new Set([
  'meilisearch',
  ...(process.env.SEARCH_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]);

for (const engine of ENGINES.filter((e) => enabled.has(e.name)))
  describe(`SearchProvider contract: ${engine.name}`, () => {
    let container: StartedTestContainer;
    let p: SearchProvider;
    const t: IndexTarget = {
      storeId: 's',
      storeCode: 'main',
      localeCode: 'en-US',
      index: 'contract_g1_main_en-us',
    };

    beforeAll(async () => {
      ({ container, provider: p } = await engine.start());
      await p.health();
      await p.createIndex(t, {
        localeCode: 'en-US',
        synonyms: [['tee', 'singlet']],
        stopwords: [],
      });
      await p.index(t, DOCS, true);
    }, 300_000);

    afterAll(async () => {
      await container?.stop();
    });

    it('text: ranking, prefix, attributes, SKU, synonyms; visibility filter', async () => {
      expect((await p.query(t, q({ text: 'tee' }))).ids[0]).toBe(TEE);
      expect((await p.query(t, q({ text: 'cla' }))).ids).toEqual([TEE]);
      expect((await p.query(t, q({ text: 'merino' }))).ids).toEqual([SOCKS]);
      expect((await p.query(t, q({ text: 'TEE-RED' }))).ids).toContain(TEE);
      expect((await p.query(t, q({ text: 'singlet' }))).ids).toContain(TEE);
      expect((await p.query(t, q({ text: 'gift' }))).ids).toEqual([]);
    });

    it('filters, facets, category counts, price stats', async () => {
      const r = await p.query(
        t,
        q({
          filters: {
            facets: { color: ['red'] },
            visibility: ['CATALOG_SEARCH'],
          },
          sort: 'name',
        }),
      );
      expect(r.ids).toEqual([TEE, SOCKS]);
      expect(r.total).toBe(2);
      expect(r.facets.color).toEqual({ red: 2, blue: 1 });
      expect(r.facets.category).toEqual({ men: 1, tees: 1, acc: 1 });
      expect(r.priceRange).toEqual({ min: 1200, max: 2500 });
      const all = await p.query(
        t,
        q({
          filters: {
            categoryId: 'men',
            facets: {},
            priceMin: 3000,
            inStock: false,
            visibility: ['CATALOG_SEARCH'],
          },
        }),
      );
      expect(all.ids).toEqual([POLO]);
    });

    it('sorting and paging', async () => {
      const filters = { facets: {}, visibility: ['CATALOG_SEARCH' as const] };
      expect((await p.query(t, q({ filters, sort: 'price_asc' }))).ids).toEqual(
        [SOCKS, TEE, POLO],
      );
      expect(
        (await p.query(t, q({ filters, sort: 'price_desc' }))).ids,
      ).toEqual([POLO, TEE, SOCKS]);
      expect((await p.query(t, q({ filters, sort: 'newest' }))).ids).toEqual([
        TEE,
        POLO,
        SOCKS,
      ]);
      const page = await p.query(
        t,
        q({ filters, sort: 'name', offset: 1, limit: 1 }),
      );
      expect(page).toMatchObject({ ids: [POLO], total: 3 });
      expect((await p.query(t, q({ filters, limit: 0 }))).total).toBe(3);
    });

    it('suggestions, updates and removal', async () => {
      expect(
        (await p.suggest(t, 'pol', ['CATALOG_SEARCH'], 5)).map((s) => s.name),
      ).toEqual(['Polo Shirt']);
      await p.index(
        t,
        [{ ...DOCS[1], name: 'Polo Classic', nameSort: 'polo classic' }],
        true,
      );
      await p.remove(t, [SOCKS]);
      await new Promise((r) => setTimeout(r, 1500)); // removal is asynchronous on some engines
      const r = await p.query(t, q({ text: 'classic' }));
      expect(r.ids.sort()).toEqual([TEE, POLO].sort());
      expect((await p.query(t, q({ text: 'wool' }))).ids).toEqual([]);
      await p.dropIndex(t);
      await p.dropIndex(t); // idempotent
    });
  });
