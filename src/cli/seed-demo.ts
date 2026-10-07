/**
 * Demo catalog for theme development: two websites (US/English, Vietnam/Vietnamese+English) sharing
 * one catalog with every product type. Runs through the normal services (validation, events, URL
 * rewrites, audit log). Idempotent: does nothing when the `us` website already exists.
 *   npm run build && npm run seed:demo
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Principal } from '../common/auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { InventoryService } from '../modules/inventory/inventory.service.js';
import { PriceBooksService } from '../modules/pricing/price-books.service.js';
import { TaxService } from '../modules/tax/tax.service.js';
import { AttributesService } from '../modules/catalog/attributes.service.js';
import { CategoriesService } from '../modules/catalog/categories.service.js';
import { ProductsService } from '../modules/products/products.service.js';
import { ReferenceDataService } from '../modules/stores/reference-data.service.js';
import { StoresService } from '../modules/stores/stores.service.js';
import { WebsitesService } from '../modules/stores/websites.service.js';
import { BlocksService } from '../modules/cms/blocks.service.js';
import { PagesService } from '../modules/cms/pages.service.js';
import { PostsService } from '../modules/cms/posts.service.js';
import { TagsService } from '../modules/cms/tags.service.js';
import { BannersService } from '../modules/merchandising/banners.service.js';
import { SlidersService } from '../modules/merchandising/sliders.service.js';
import { MenusService } from '../modules/navigation/menus.service.js';
import { LoyaltyProgramsService } from '../modules/loyalty/loyalty-programs.service.js';
import { CampaignsService } from '../modules/marketing/campaigns.service.js';
import { CouponsService } from '../modules/marketing/coupons.service.js';
import { PromotionsService } from '../modules/marketing/promotions.service.js';
import { JobsService } from '../modules/jobs/jobs.service.js';
import { PaymentConfigService } from '../modules/payments/payment-config.service.js';
import { ShippingMethodsService } from '../modules/shipping/shipping-methods.service.js';
import { SeedModule } from './seed.module.js';

try {
  process.loadEnvFile();
} catch {
  // environment from the shell / container
}

/** Recorded as the actor in the audit log. */
const SEED: Principal = {
  type: 'api-key',
  id: '00000000-0000-4000-8000-000000000005',
  label: 'seed-demo',
  permissions: ['*'],
};
const log = new Logger('seed-demo');
const labels = (en: string, vi: string) => [
  { localeCode: 'en-US', label: en },
  { localeCode: 'vi-VN', label: vi },
];
const names = (en: string, vi: string) => [
  { localeCode: 'en-US', name: en },
  { localeCode: 'vi-VN', name: vi },
];

const app = await NestFactory.createApplicationContext(SeedModule, {
  logger: ['error', 'warn', 'log'],
});
try {
  const prisma = app.get(PrismaService);
  if (await prisma.website.findUnique({ where: { code: 'us' } })) {
    log.log('Demo data already present (website "us"); nothing to do');
  } else {
    const ref = app.get(ReferenceDataService);
    const websites = app.get(WebsitesService);
    const stores = app.get(StoresService);
    const attributes = app.get(AttributesService);
    const categories = app.get(CategoriesService);
    const products = app.get(ProductsService);

    await ref.updateLocale('vi-VN', { isActive: true }, SEED);
    await ref.updateCurrency('VND', { isActive: true }, SEED);
    const us = await websites.create(
      { code: 'us', name: 'Shop US', baseCurrencyCode: 'USD' },
      SEED,
    );
    const vn = await websites.create(
      { code: 'vn', name: 'Shop Việt Nam', baseCurrencyCode: 'VND' },
      SEED,
    );
    const usStore = await stores.create(
      {
        websiteId: us.id,
        code: 'us-en',
        name: 'United States',
        defaultLocaleCode: 'en-US',
        defaultCurrencyCode: 'USD',
        countryCode: 'US',
      },
      SEED,
    );
    const vnStore = await stores.create(
      {
        websiteId: vn.id,
        code: 'vn-vi',
        name: 'Việt Nam',
        defaultLocaleCode: 'vi-VN',
        localeCodes: ['en-US'],
        defaultCurrencyCode: 'VND',
        currencyCodes: ['USD'],
        countryCode: 'VN',
        pricesIncludeTax: true,
      },
      SEED,
    );

    const option = (code: string, en: string, vi: string, swatch?: string) => ({
      code,
      swatch,
      labels: labels(en, vi),
    });
    await attributes.create(
      {
        code: 'color',
        type: 'SELECT',
        isFilterable: true,
        labels: labels('Colour', 'Màu sắc'),
        options: [
          option('black', 'Black', 'Đen', '#212121'),
          option('white', 'White', 'Trắng', '#fafafa'),
          option('red', 'Red', 'Đỏ', '#d32f2f'),
        ],
      },
      SEED,
    );
    await attributes.create(
      {
        code: 'size',
        type: 'SELECT',
        isFilterable: true,
        labels: labels('Size', 'Cỡ'),
        options: ['s', 'm', 'l'].map((c) =>
          option(c, c.toUpperCase(), c.toUpperCase()),
        ),
      },
      SEED,
    );
    await attributes.create(
      {
        code: 'material',
        type: 'TEXT',
        labels: labels('Material', 'Chất liệu'),
      },
      SEED,
    );
    await attributes.create(
      {
        code: 'care',
        type: 'TEXTAREA',
        isLocalizable: true,
        labels: labels('Care', 'Bảo quản'),
      },
      SEED,
    );
    const apparel = await attributes.createSet(
      {
        code: 'apparel',
        name: 'Apparel',
        attributes: ['color', 'size', 'material', 'care'].map((code) => ({
          code,
        })),
      },
      SEED,
    );

    const both = [us.id, vn.id];
    const men = await categories.create(
      { translations: names('Men', 'Nam'), websiteIds: both },
      SEED,
    );
    const tees = await categories.create(
      {
        parentId: men.id,
        translations: names('T-Shirts', 'Áo thun'),
        websiteIds: both,
      },
      SEED,
    );
    const accessories = await categories.create(
      { translations: names('Accessories', 'Phụ kiện'), websiteIds: both },
      SEED,
    );

    const tee = await products.create(
      {
        sku: 'TEE-CLASSIC',
        type: 'CONFIGURABLE',
        attributeSetId: apparel.id,
        attributes: { material: '100% organic cotton' },
        translations: [
          {
            localeCode: 'en-US',
            name: 'Classic Tee',
            shortDescription: 'Heavyweight everyday tee.',
            attributes: { care: 'Machine wash cold, tumble dry low.' },
          },
          {
            localeCode: 'vi-VN',
            name: 'Áo thun cổ điển',
            shortDescription: 'Áo thun dày dặn mặc hằng ngày.',
            attributes: { care: 'Giặt máy nước lạnh, sấy nhẹ.' },
          },
        ],
        websiteIds: both,
        categories: [{ categoryId: tees.id }],
        configurableAttributes: ['color', 'size'],
        variants: ['black', 'white', 'red'].flatMap((color) =>
          ['s', 'm', 'l'].map((size) => ({
            sku: `TEE-CLASSIC-${color}-${size}`.toUpperCase(),
            options: { color, size },
          })),
        ),
      },
      SEED,
    );
    const socks = await products.create(
      {
        sku: 'SOCKS-3PK',
        type: 'SIMPLE',
        attributeSetId: apparel.id,
        attributes: { color: 'black', size: 'm', material: 'Cotton blend' },
        weightGrams: 120,
        translations: names('Everyday Socks (3-pack)', 'Tất hằng ngày (3 đôi)'),
        websiteIds: both,
        categories: [{ categoryId: accessories.id }],
      },
      SEED,
    );
    await products.create(
      {
        sku: 'GIFT-WRAP',
        type: 'VIRTUAL',
        translations: [{ localeCode: 'en-US', name: 'Gift wrapping' }],
        websiteIds: [us.id],
      },
      SEED,
    );
    await products.create(
      {
        sku: 'WEEKEND-SET',
        type: 'BUNDLE',
        typeOptions: { priceType: 'DYNAMIC' },
        translations: names('Weekend Set', 'Bộ cuối tuần'),
        websiteIds: both,
        categories: [{ categoryId: men.id }],
        bundleOptions: [
          {
            code: 'tee',
            inputType: 'RADIO',
            titles: [
              { localeCode: 'en-US', title: 'Choose your tee' },
              { localeCode: 'vi-VN', title: 'Chọn áo' },
            ],
            selections: tee.variants
              .filter((v) => v.optionValues.size === 'm')
              .map((v, i) => ({ variantId: v.id, isDefault: i === 0 })),
          },
          {
            code: 'socks',
            inputType: 'CHECKBOX',
            isRequired: false,
            titles: [
              { localeCode: 'en-US', title: 'Add socks' },
              { localeCode: 'vi-VN', title: 'Thêm tất' },
            ],
            selections: [
              { variantId: socks.variants[0].id, qty: 1, canChangeQty: true },
            ],
          },
        ],
      },
      SEED,
    );
    await products.create(
      {
        sku: 'GIFT-CARD',
        type: 'GIFT_CARD',
        typeOptions: {
          amounts: [
            { currency: 'USD', amount: 2500 },
            { currency: 'USD', amount: 5000 },
            { currency: 'VND', amount: 500000 },
            { currency: 'VND', amount: 1000000 },
          ],
          lifetimeDays: 365,
        },
        translations: names('Gift Card', 'Thẻ quà tặng'),
        websiteIds: both,
      },
      SEED,
    );

    // ── Tax: California (+ Los Angeles County) and Vietnam VAT.
    const tax = app.get(TaxService);
    const classes = await tax.classes();
    const cls = (code: string) => classes.find((c) => c.code === code)!.id;
    const ca = await tax.createZone(
      {
        code: 'us-ca',
        name: 'California',
        regions: [{ countryCode: 'US', regionCode: 'CA' }],
      },
      SEED,
    );
    const la = await tax.createZone(
      {
        code: 'us-ca-la',
        name: 'Los Angeles County',
        regions: [
          { countryCode: 'US', regionCode: 'CA', postcodePattern: '900*' },
        ],
      },
      SEED,
    );
    const vnZone = await tax.createZone(
      { code: 'vn', name: 'Vietnam', regions: [{ countryCode: 'VN' }] },
      SEED,
    );
    await tax.createRate(
      {
        zoneId: ca.id,
        productTaxClassId: cls('standard'),
        name: 'CA state tax',
        rate: '7.25',
      },
      SEED,
    );
    await tax.createRate(
      {
        zoneId: la.id,
        productTaxClassId: cls('standard'),
        name: 'LA County tax',
        rate: '2.25',
      },
      SEED,
    );
    await tax.createRate(
      {
        zoneId: vnZone.id,
        productTaxClassId: cls('standard'),
        name: 'VAT',
        rate: '10',
      },
      SEED,
    );

    // ── Prices: US list (net) with a quantity tier and a "was" price; VN list (VND, tax-inclusive).
    const pricing = app.get(PriceBooksService);
    const usBook = await pricing.create(
      {
        code: 'us-list',
        name: 'US list',
        currencyCode: 'USD',
        websiteId: us.id,
      },
      SEED,
    );
    const vnBook = await pricing.create(
      {
        code: 'vn-list',
        name: 'VN list',
        currencyCode: 'VND',
        websiteId: vn.id,
        includesTax: true,
      },
      SEED,
    );
    const teeSkus = tee.variants.map((v) => v.sku);
    await pricing.setEntries(
      usBook.id,
      {
        entries: [
          ...teeSkus.map((sku) => ({
            sku,
            amount: 2500,
            compareAtAmount: 3000,
          })),
          ...teeSkus.map((sku) => ({ sku, minQty: 5, amount: 2200 })),
          { sku: 'SOCKS-3PK', amount: 1200 },
          { sku: 'GIFT-WRAP', amount: 500 },
        ],
      },
      SEED,
    );
    await pricing.setEntries(
      vnBook.id,
      {
        entries: [
          ...teeSkus.map((sku) => ({ sku, amount: 399000 })),
          { sku: 'SOCKS-3PK', amount: 150000 },
        ],
      },
      SEED,
    );
    await pricing.addExchangeRate(
      { baseCurrencyCode: 'USD', quoteCurrencyCode: 'VND', rate: '25400' },
      SEED,
    );

    // ── Stock: one warehouse per website. Every third SKU has no stock in Vietnam ("out of stock").
    const inventory = app.get(InventoryService);
    const usWh = await inventory.createSource(
      { code: 'us-la', name: 'Los Angeles warehouse', countryCode: 'US' },
      SEED,
    );
    const vnWh = await inventory.createSource(
      { code: 'vn-hcm', name: 'Ho Chi Minh City warehouse', countryCode: 'VN' },
      SEED,
    );
    await inventory.setWebsiteSources(
      us.id,
      { sources: [{ sourceId: usWh.id }] },
      SEED,
    );
    await inventory.setWebsiteSources(
      vn.id,
      { sources: [{ sourceId: vnWh.id }] },
      SEED,
    );
    for (const [i, sku] of [...teeSkus, 'SOCKS-3PK'].entries()) {
      await inventory.adjust(
        {
          sourceId: usWh.id,
          sku,
          delta: 20 + i,
          reason: 'RECEIPT',
          note: 'Demo stock',
        },
        SEED,
      );
      if (i % 3)
        await inventory.adjust(
          {
            sourceId: vnWh.id,
            sku,
            delta: 10,
            reason: 'RECEIPT',
            note: 'Demo stock',
          },
          SEED,
        );
    }

    // ── Content: a shared block, pages and a post using it, a menu, a hero banner and a slider.
    const pages = app.get(PagesService);
    const posts = app.get(PostsService);
    const blocks = app.get(BlocksService);
    const tags = app.get(TagsService);
    const menus = app.get(MenusService);
    const banners = app.get(BannersService);
    const sliders = app.get(SlidersService);
    const shipping = await blocks.create(
      {
        identifier: 'free-shipping',
        translations: [
          {
            localeCode: 'en-US',
            title: 'Free shipping',
            content: '<p>Free shipping on orders over $50.</p>',
          },
          {
            localeCode: 'vi-VN',
            title: 'Miễn phí vận chuyển',
            content: '<p>Miễn phí vận chuyển cho đơn từ 1.000.000 ₫.</p>',
          },
        ],
      },
      SEED,
    );
    await blocks.publish(shipping.id, 'publish', undefined, SEED);
    const about = await pages.create(
      {
        translations: [
          {
            localeCode: 'en-US',
            title: 'About us',
            slug: 'about',
            content: '<h1>About us</h1><p>Basics, made well.</p>',
          },
          {
            localeCode: 'vi-VN',
            title: 'Về chúng tôi',
            slug: 've-chung-toi',
            content: '<h1>Về chúng tôi</h1><p>Đồ cơ bản, làm thật tốt.</p>',
          },
        ],
      },
      SEED,
    );
    const help = await pages.create(
      {
        translations: [
          {
            localeCode: 'en-US',
            title: 'Shipping',
            slug: 'help/shipping',
            content: '<h1>Shipping</h1>{{block id="free-shipping"}}',
          },
          {
            localeCode: 'vi-VN',
            title: 'Giao hàng',
            slug: 'tro-giup/giao-hang',
            content: '<h1>Giao hàng</h1>{{block id="free-shipping"}}',
          },
        ],
      },
      SEED,
    );
    for (const p of [about, help])
      await pages.publish(p.id, 'publish', undefined, SEED);
    await blocks.addPlacement(
      shipping.id,
      { targetType: 'CATEGORY', targetId: tees.id, region: 'top' },
      SEED,
    );
    const news = await tags.create(
      { code: 'news', translations: names('News', 'Tin tức') },
      SEED,
    );
    const welcome = await posts.create(
      {
        tagIds: [news.id],
        translations: [
          {
            localeCode: 'en-US',
            title: 'Welcome to the shop',
            excerpt: 'What we make and why.',
            content: '<p>Hello!</p>{{block id="free-shipping"}}',
          },
          {
            localeCode: 'vi-VN',
            title: 'Chào mừng đến cửa hàng',
            excerpt: 'Chúng tôi làm gì và vì sao.',
            content: '<p>Xin chào!</p>{{block id="free-shipping"}}',
          },
        ],
      },
      SEED,
    );
    await posts.publish(welcome.id, 'publish', undefined, SEED);
    const main = await menus.create(
      { code: 'main', name: 'Main navigation' },
      SEED,
    );
    for (const [position, item] of [
      { linkType: 'CATEGORY', targetId: men.id },
      { linkType: 'CATEGORY', targetId: accessories.id },
      {
        linkType: 'POST',
        targetId: welcome.id,
        labels: labels('Blog', 'Blog'),
      },
      { linkType: 'PAGE', targetId: about.id },
    ].entries())
      await menus.addItem(
        main.id,
        { ...(item as Parameters<MenusService['addItem']>[1]), position },
        SEED,
      );
    const footer = await menus.create({ code: 'footer', name: 'Footer' }, SEED);
    await menus.addItem(
      footer.id,
      { linkType: 'PAGE', targetId: help.id },
      SEED,
    );
    const hero = await banners.create(
      {
        placement: 'home.hero',
        name: 'Autumn basics',
        linkUrl: '/men',
        translations: [
          { localeCode: 'en-US', title: 'Autumn basics', ctaLabel: 'Shop men' },
          {
            localeCode: 'vi-VN',
            title: 'Đồ cơ bản mùa thu',
            ctaLabel: 'Mua ngay',
          },
        ],
      },
      SEED,
    );
    await banners.publish(hero.id, 'publish', undefined, SEED);
    const slider = await sliders.create(
      { code: 'home', name: 'Home carousel', autoplayMs: 6000 },
      SEED,
    );
    for (const [position, title] of [
      'New arrivals',
      'Organic cotton',
    ].entries())
      await sliders.addSlide(
        slider.id,
        {
          position,
          linkUrl: '/men',
          translations: [{ localeCode: 'en-US', title }],
        },
        SEED,
      );
    await sliders.publish(slider.id, 'publish', undefined, SEED);

    // ── Marketing and loyalty: a running campaign with a coupon promotion; points on both websites.
    const campaigns = app.get(CampaignsService);
    const promotions = app.get(PromotionsService);
    const coupons = app.get(CouponsService);
    const programs = app.get(LoyaltyProgramsService);
    const welcomeCampaign = await campaigns.create(
      { code: 'welcome', name: 'Welcome offer' },
      SEED,
    );
    const welcomePromo = await promotions.create(
      {
        name: '10% off the first order with WELCOME10',
        campaignId: welcomeCampaign.id,
        // After item deals, on what is left.
        priority: 10,
        websiteIds: [us.id, vn.id],
        requiresCoupon: true,
        usesPerCustomer: 1,
        conditions: [
          { type: 'subtotal_at_least', amounts: { USD: 3000, VND: 500000 } },
        ],
        actions: [{ type: 'percent_off_cart', percent: 10 }],
        labels: [
          { localeCode: 'en-US', label: 'Welcome: 10% off' },
          { localeCode: 'vi-VN', label: 'Chào mừng: giảm 10%' },
        ],
      },
      SEED,
    );
    await coupons.create(welcomePromo.id, { code: 'WELCOME10' }, SEED);
    const teesPromo = await promotions.create(
      {
        name: 'Buy 2 tees, get the third half price',
        campaignId: welcomeCampaign.id,
        websiteIds: [us.id, vn.id],
        conditions: [],
        actions: [
          {
            type: 'buy_x_get_y',
            buy: 2,
            get: 1,
            percent: 50,
            filter: { categoryIds: [tees.id] },
          },
        ],
        labels: [{ localeCode: 'en-US', label: '3rd tee half price' }],
      },
      SEED,
    );
    for (const p of [welcomePromo, teesPromo])
      await promotions.publish(p.id, 'publish', undefined, SEED);
    await campaigns.publish(welcomeCampaign.id, 'publish', undefined, SEED);
    for (const [website, currencyCode, spendPerPoint] of [
      [us, 'USD', 100],
      [vn, 'VND', 10000],
    ] as const) {
      await programs.upsert(
        website.id,
        {
          name: 'Shop Rewards',
          currencyCode,
          spendPerPoint,
          pointValue: currencyCode === 'USD' ? 1 : 100,
          minRedeemPoints: 100,
          maxRedeemPercent: 50,
          expiryDays: 365,
        },
        SEED,
      );
      await programs.addTier(
        website.id,
        {
          code: 'silver',
          name: 'Silver',
          thresholdPoints: 500,
          multiplierBp: 12500,
        },
        SEED,
      );
      await programs.addTier(
        website.id,
        {
          code: 'gold',
          name: 'Gold',
          thresholdPoints: 2000,
          multiplierBp: 15000,
        },
        SEED,
      );
    }

    // ── Checkout: shipping per website and cash on delivery. Card and wallet providers need sandbox
    // keys, so they are added through POST /admin/payment-providers (see README → Checkout).
    const shippingMethods = app.get(ShippingMethodsService);
    await shippingMethods.create(
      {
        websiteId: us.id,
        code: 'standard',
        carrier: 'ups',
        amounts: { USD: 799 },
        freeOver: { USD: 5000 },
        countryCodes: ['US'],
        translations: [
          {
            localeCode: 'en-US',
            name: 'Standard',
            description: '3–5 business days; free over $50',
          },
        ],
      },
      SEED,
    );
    await shippingMethods.create(
      {
        websiteId: us.id,
        code: 'express',
        carrier: 'ups',
        amounts: { USD: 1999 },
        countryCodes: ['US'],
        position: 1,
        translations: [
          {
            localeCode: 'en-US',
            name: 'Express',
            description: 'Next business day',
          },
        ],
      },
      SEED,
    );
    await shippingMethods.create(
      {
        websiteId: vn.id,
        code: 'giao-hang-nhanh',
        carrier: 'ghn',
        amounts: { VND: 30000, USD: 150 },
        freeOver: { VND: 500000 },
        countryCodes: ['VN'],
        translations: [
          {
            localeCode: 'vi-VN',
            name: 'Giao hàng nhanh',
            description: '1–3 ngày',
          },
          {
            localeCode: 'en-US',
            name: 'Fast delivery',
            description: '1–3 days',
          },
        ],
      },
      SEED,
    );
    const paymentConfig = app.get(PaymentConfigService);
    const cod = await paymentConfig.createProvider(
      { code: 'COD', name: 'Cash on delivery' },
      SEED,
    );
    for (const [store, amounts] of [
      [usStore, { USD: 50000 }],
      [vnStore, { VND: 10000000 }],
    ] as const)
      await paymentConfig.createMethod(
        {
          storeId: store.id,
          providerId: cod.id,
          code: 'cod',
          position: 10,
          maxAmounts: amounts,
          titles: [
            {
              localeCode: 'en-US',
              title: 'Cash on delivery',
              description: 'Pay the courier when your order arrives',
            },
            {
              localeCode: 'vi-VN',
              title: 'Thanh toán khi nhận hàng',
              description: 'Trả tiền mặt cho người giao hàng',
            },
          ],
        },
        SEED,
      );

    // ── Operations: a nightly orders export (downloadable from the job's executions).
    await app.get(JobsService).create(
      {
        code: 'nightly-orders-export',
        name: 'Nightly orders export (last 24 h)',
        type: 'export.orders',
        params: { sinceHours: 24 },
        cron: '0 2 * * *',
        timezone: 'UTC',
      },
      SEED,
    );

    log.log(
      'Demo catalog created: websites us/vn, stores us-en/vn-vi, 3 categories, 5 products (9 tee variants), tax zones, price books and stock (the worker indexes prices); content: 2 pages, 1 post, 1 block, menus main/footer, a home.hero banner and the home slider; marketing: the "welcome" campaign (coupon WELCOME10, 3rd tee half price); loyalty programs with Silver/Gold tiers on both websites; checkout: shipping methods (US standard/express, VN fast delivery) and cash on delivery in both stores; jobs: a nightly orders export',
    );
  }
} finally {
  await app.close();
}
