/**
 * Migration verification (PLAN.md §3.3): applies the committed migrations to an
 * empty PostgreSQL 16 and asserts primary keys, foreign keys (with referential
 * actions), FK indexes and behaviour. Fails CI if a migration and schema.prisma drift.
 */
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  FOREIGN_KEYS,
  UNIQUE_CONSTRAINTS,
} from '../src/database/constraints.js';
import { prisma } from './support/migrate.js';

const TABLES = [
  'admin_user_roles',
  'admin_users',
  'api_keys',
  'attribute_option_translations',
  'attribute_options',
  'attribute_set_attributes',
  'attribute_sets',
  'attribute_translations',
  'attributes',
  'audit_logs',
  'banner_translations',
  'banners',
  'block_placements',
  'block_translations',
  'blocks',
  'bundle_option_translations',
  'bundle_options',
  'bundle_selections',
  'campaigns',
  'cart_items',
  'carts',
  'categories',
  'category_translations',
  'category_websites',
  'configurable_attributes',
  'coupons',
  'credit_memos',
  'currencies',
  'customer_addresses',
  'customer_groups',
  'customer_sessions',
  'customers',
  'document_sequences',
  'exchange_rates',
  'image_links',
  'image_translations',
  'images',
  'inventories',
  'inventory_movements',
  'inventory_reservations',
  'inventory_sources',
  'invoices',
  'job_executions',
  'jobs',
  'locales',
  'loyalty_accounts',
  'loyalty_allocations',
  'loyalty_programs',
  'loyalty_tiers',
  'loyalty_transactions',
  'menu_item_translations',
  'menu_items',
  'menus',
  'order_addresses',
  'order_history',
  'order_items',
  'orders',
  'outbox_events',
  'page_translations',
  'pages',
  'payment_providers',
  'payment_transactions',
  'payment_webhook_events',
  'payments',
  'post_tags',
  'post_translations',
  'posts',
  'price_book_entries',
  'price_books',
  'price_index',
  'product_categories',
  'product_relations',
  'product_store_overrides',
  'product_translations',
  'product_variants',
  'product_websites',
  'products',
  'promotion_translations',
  'promotion_usages',
  'promotion_websites',
  'promotions',
  'refresh_tokens',
  'refunds',
  'role_permissions',
  'roles',
  'schedules',
  'search_documents',
  'search_settings',
  'shipment_items',
  'shipments',
  'shipping_method_translations',
  'shipping_methods',
  'slide_translations',
  'sliders',
  'slides',
  'store_currencies',
  'store_locales',
  'store_payment_method_translations',
  'store_payment_methods',
  'stores',
  'tag_translations',
  'tags',
  'tax_classes',
  'tax_rates',
  'tax_zone_regions',
  'tax_zones',
  'url_rewrites',
  'webhook_deliveries',
  'webhooks',
  'website_inventory_sources',
  'websites',
];

// constraint → [table, column, referenced table, on delete, on update]
// (c = CASCADE, n = SET NULL, r = RESTRICT)
const EXPECTED_FKS: Record<string, [string, string, string, string, string]> = {
  fk_admin_user_roles_admin_user_id: [
    'admin_user_roles',
    'admin_user_id',
    'admin_users',
    'c',
    'c',
  ],
  fk_admin_user_roles_role_id: [
    'admin_user_roles',
    'role_id',
    'roles',
    'r',
    'c',
  ],
  fk_api_keys_created_by_id: [
    'api_keys',
    'created_by_id',
    'admin_users',
    'n',
    'c',
  ],
  fk_attribute_option_translations_locale_code: [
    'attribute_option_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_attribute_option_translations_option_id: [
    'attribute_option_translations',
    'option_id',
    'attribute_options',
    'c',
    'c',
  ],
  fk_attribute_options_attribute_id: [
    'attribute_options',
    'attribute_id',
    'attributes',
    'c',
    'c',
  ],
  fk_attribute_set_attributes_attribute_id: [
    'attribute_set_attributes',
    'attribute_id',
    'attributes',
    'c',
    'c',
  ],
  fk_attribute_set_attributes_attribute_set_id: [
    'attribute_set_attributes',
    'attribute_set_id',
    'attribute_sets',
    'c',
    'c',
  ],
  fk_attribute_translations_attribute_id: [
    'attribute_translations',
    'attribute_id',
    'attributes',
    'c',
    'c',
  ],
  fk_attribute_translations_locale_code: [
    'attribute_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_banner_translations_banner_id: [
    'banner_translations',
    'banner_id',
    'banners',
    'c',
    'c',
  ],
  fk_banner_translations_image_id: [
    'banner_translations',
    'image_id',
    'images',
    'n',
    'c',
  ],
  fk_banner_translations_locale_code: [
    'banner_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_banners_image_id: ['banners', 'image_id', 'images', 'n', 'c'],
  fk_banners_store_id: ['banners', 'store_id', 'stores', 'c', 'c'],
  fk_block_placements_block_id: [
    'block_placements',
    'block_id',
    'blocks',
    'c',
    'c',
  ],
  fk_block_translations_block_id: [
    'block_translations',
    'block_id',
    'blocks',
    'c',
    'c',
  ],
  fk_block_translations_locale_code: [
    'block_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_blocks_store_id: ['blocks', 'store_id', 'stores', 'c', 'c'],
  fk_bundle_option_translations_locale_code: [
    'bundle_option_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_bundle_option_translations_option_id: [
    'bundle_option_translations',
    'option_id',
    'bundle_options',
    'c',
    'c',
  ],
  fk_bundle_options_product_id: [
    'bundle_options',
    'product_id',
    'products',
    'c',
    'c',
  ],
  fk_bundle_selections_option_id: [
    'bundle_selections',
    'option_id',
    'bundle_options',
    'c',
    'c',
  ],
  fk_bundle_selections_variant_id: [
    'bundle_selections',
    'variant_id',
    'product_variants',
    'r',
    'c',
  ],
  fk_campaigns_budget_currency_code: [
    'campaigns',
    'budget_currency_code',
    'currencies',
    'r',
    'c',
  ],
  fk_cart_items_cart_id: ['cart_items', 'cart_id', 'carts', 'c', 'c'],
  fk_cart_items_variant_id: [
    'cart_items',
    'variant_id',
    'product_variants',
    'c',
    'c',
  ],
  fk_carts_customer_id: ['carts', 'customer_id', 'customers', 'c', 'c'],
  fk_carts_shipping_method_id: [
    'carts',
    'shipping_method_id',
    'shipping_methods',
    'n',
    'c',
  ],
  fk_carts_store_id: ['carts', 'store_id', 'stores', 'c', 'c'],
  fk_categories_parent_id: ['categories', 'parent_id', 'categories', 'r', 'c'],
  fk_category_translations_category_id: [
    'category_translations',
    'category_id',
    'categories',
    'c',
    'c',
  ],
  fk_category_translations_locale_code: [
    'category_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_category_websites_category_id: [
    'category_websites',
    'category_id',
    'categories',
    'c',
    'c',
  ],
  fk_category_websites_website_id: [
    'category_websites',
    'website_id',
    'websites',
    'c',
    'c',
  ],
  fk_configurable_attributes_attribute_id: [
    'configurable_attributes',
    'attribute_id',
    'attributes',
    'r',
    'c',
  ],
  fk_configurable_attributes_product_id: [
    'configurable_attributes',
    'product_id',
    'products',
    'c',
    'c',
  ],
  fk_coupons_promotion_id: ['coupons', 'promotion_id', 'promotions', 'c', 'c'],
  fk_credit_memos_order_id: ['credit_memos', 'order_id', 'orders', 'r', 'c'],
  fk_credit_memos_refund_id: ['credit_memos', 'refund_id', 'refunds', 'r', 'c'],
  fk_customer_addresses_customer_id: [
    'customer_addresses',
    'customer_id',
    'customers',
    'c',
    'c',
  ],
  fk_customer_groups_tax_class_id: [
    'customer_groups',
    'tax_class_id',
    'tax_classes',
    'r',
    'c',
  ],
  fk_customer_sessions_customer_id: [
    'customer_sessions',
    'customer_id',
    'customers',
    'c',
    'c',
  ],
  fk_customer_sessions_replaced_by_id: [
    'customer_sessions',
    'replaced_by_id',
    'customer_sessions',
    'n',
    'c',
  ],
  fk_customers_customer_group_id: [
    'customers',
    'customer_group_id',
    'customer_groups',
    'r',
    'c',
  ],
  fk_customers_locale_code: ['customers', 'locale_code', 'locales', 'n', 'c'],
  fk_customers_website_id: ['customers', 'website_id', 'websites', 'r', 'c'],
  fk_exchange_rates_base_currency_code: [
    'exchange_rates',
    'base_currency_code',
    'currencies',
    'c',
    'c',
  ],
  fk_exchange_rates_quote_currency_code: [
    'exchange_rates',
    'quote_currency_code',
    'currencies',
    'c',
    'c',
  ],
  fk_image_links_image_id: ['image_links', 'image_id', 'images', 'c', 'c'],
  fk_image_translations_image_id: [
    'image_translations',
    'image_id',
    'images',
    'c',
    'c',
  ],
  fk_image_translations_locale_code: [
    'image_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_images_created_by_id: ['images', 'created_by_id', 'admin_users', 'n', 'c'],
  fk_inventories_source_id: [
    'inventories',
    'source_id',
    'inventory_sources',
    'r',
    'c',
  ],
  fk_inventories_variant_id: [
    'inventories',
    'variant_id',
    'product_variants',
    'c',
    'c',
  ],
  fk_inventory_movements_source_id: [
    'inventory_movements',
    'source_id',
    'inventory_sources',
    'r',
    'c',
  ],
  fk_inventory_movements_variant_id: [
    'inventory_movements',
    'variant_id',
    'product_variants',
    'r',
    'c',
  ],
  fk_inventory_reservations_source_id: [
    'inventory_reservations',
    'source_id',
    'inventory_sources',
    'c',
    'c',
  ],
  fk_inventory_reservations_variant_id: [
    'inventory_reservations',
    'variant_id',
    'product_variants',
    'c',
    'c',
  ],
  fk_invoices_order_id: ['invoices', 'order_id', 'orders', 'r', 'c'],
  fk_job_executions_job_id: ['job_executions', 'job_id', 'jobs', 'n', 'c'],
  fk_jobs_created_by_id: ['jobs', 'created_by_id', 'admin_users', 'n', 'c'],
  fk_locales_fallback_code: ['locales', 'fallback_code', 'locales', 'n', 'c'],
  fk_loyalty_accounts_customer_id: [
    'loyalty_accounts',
    'customer_id',
    'customers',
    'c',
    'c',
  ],
  fk_loyalty_accounts_program_id: [
    'loyalty_accounts',
    'program_id',
    'loyalty_programs',
    'c',
    'c',
  ],
  fk_loyalty_accounts_tier_id: [
    'loyalty_accounts',
    'tier_id',
    'loyalty_tiers',
    'n',
    'c',
  ],
  fk_loyalty_allocations_credit_id: [
    'loyalty_allocations',
    'credit_id',
    'loyalty_transactions',
    'c',
    'c',
  ],
  fk_loyalty_allocations_debit_id: [
    'loyalty_allocations',
    'debit_id',
    'loyalty_transactions',
    'c',
    'c',
  ],
  fk_loyalty_programs_currency_code: [
    'loyalty_programs',
    'currency_code',
    'currencies',
    'r',
    'c',
  ],
  fk_loyalty_programs_website_id: [
    'loyalty_programs',
    'website_id',
    'websites',
    'c',
    'c',
  ],
  fk_loyalty_tiers_program_id: [
    'loyalty_tiers',
    'program_id',
    'loyalty_programs',
    'c',
    'c',
  ],
  fk_loyalty_transactions_account_id: [
    'loyalty_transactions',
    'account_id',
    'loyalty_accounts',
    'c',
    'c',
  ],
  fk_menu_item_translations_item_id: [
    'menu_item_translations',
    'item_id',
    'menu_items',
    'c',
    'c',
  ],
  fk_menu_item_translations_locale_code: [
    'menu_item_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_menu_items_menu_id: ['menu_items', 'menu_id', 'menus', 'c', 'c'],
  fk_menu_items_parent_id: ['menu_items', 'parent_id', 'menu_items', 'c', 'c'],
  fk_menus_store_id: ['menus', 'store_id', 'stores', 'c', 'c'],
  fk_order_addresses_order_id: [
    'order_addresses',
    'order_id',
    'orders',
    'c',
    'c',
  ],
  fk_order_history_order_id: ['order_history', 'order_id', 'orders', 'c', 'c'],
  fk_order_items_order_id: ['order_items', 'order_id', 'orders', 'c', 'c'],
  fk_order_items_parent_item_id: [
    'order_items',
    'parent_item_id',
    'order_items',
    'c',
    'c',
  ],
  fk_order_items_product_id: [
    'order_items',
    'product_id',
    'products',
    'n',
    'c',
  ],
  fk_order_items_variant_id: [
    'order_items',
    'variant_id',
    'product_variants',
    'n',
    'c',
  ],
  fk_orders_currency_code: ['orders', 'currency_code', 'currencies', 'r', 'c'],
  fk_orders_customer_id: ['orders', 'customer_id', 'customers', 'n', 'c'],
  fk_orders_store_id: ['orders', 'store_id', 'stores', 'r', 'c'],
  fk_orders_website_id: ['orders', 'website_id', 'websites', 'r', 'c'],
  fk_page_translations_locale_code: [
    'page_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_page_translations_page_id: [
    'page_translations',
    'page_id',
    'pages',
    'c',
    'c',
  ],
  fk_pages_created_by_id: ['pages', 'created_by_id', 'admin_users', 'n', 'c'],
  fk_pages_store_id: ['pages', 'store_id', 'stores', 'c', 'c'],
  fk_payment_transactions_payment_id: [
    'payment_transactions',
    'payment_id',
    'payments',
    'c',
    'c',
  ],
  fk_payment_webhook_events_provider_id: [
    'payment_webhook_events',
    'provider_id',
    'payment_providers',
    'c',
    'c',
  ],
  fk_payments_method_id: [
    'payments',
    'method_id',
    'store_payment_methods',
    'n',
    'c',
  ],
  fk_payments_order_id: ['payments', 'order_id', 'orders', 'r', 'c'],
  fk_payments_provider_id: [
    'payments',
    'provider_id',
    'payment_providers',
    'r',
    'c',
  ],
  fk_post_tags_post_id: ['post_tags', 'post_id', 'posts', 'c', 'c'],
  fk_post_tags_tag_id: ['post_tags', 'tag_id', 'tags', 'c', 'c'],
  fk_post_translations_locale_code: [
    'post_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_post_translations_post_id: [
    'post_translations',
    'post_id',
    'posts',
    'c',
    'c',
  ],
  fk_posts_author_id: ['posts', 'author_id', 'admin_users', 'n', 'c'],
  fk_posts_featured_image_id: [
    'posts',
    'featured_image_id',
    'images',
    'n',
    'c',
  ],
  fk_posts_store_id: ['posts', 'store_id', 'stores', 'c', 'c'],
  fk_price_book_entries_price_book_id: [
    'price_book_entries',
    'price_book_id',
    'price_books',
    'c',
    'c',
  ],
  fk_price_book_entries_variant_id: [
    'price_book_entries',
    'variant_id',
    'product_variants',
    'c',
    'c',
  ],
  fk_price_books_currency_code: [
    'price_books',
    'currency_code',
    'currencies',
    'r',
    'c',
  ],
  fk_price_books_customer_group_id: [
    'price_books',
    'customer_group_id',
    'customer_groups',
    'c',
    'c',
  ],
  fk_price_books_store_id: ['price_books', 'store_id', 'stores', 'c', 'c'],
  fk_price_books_website_id: [
    'price_books',
    'website_id',
    'websites',
    'c',
    'c',
  ],
  fk_price_index_currency_code: [
    'price_index',
    'currency_code',
    'currencies',
    'c',
    'c',
  ],
  fk_price_index_customer_group_id: [
    'price_index',
    'customer_group_id',
    'customer_groups',
    'c',
    'c',
  ],
  fk_price_index_price_book_id: [
    'price_index',
    'price_book_id',
    'price_books',
    'c',
    'c',
  ],
  fk_price_index_store_id: ['price_index', 'store_id', 'stores', 'c', 'c'],
  fk_price_index_variant_id: [
    'price_index',
    'variant_id',
    'product_variants',
    'c',
    'c',
  ],
  fk_product_categories_category_id: [
    'product_categories',
    'category_id',
    'categories',
    'c',
    'c',
  ],
  fk_product_categories_product_id: [
    'product_categories',
    'product_id',
    'products',
    'c',
    'c',
  ],
  fk_product_relations_product_id: [
    'product_relations',
    'product_id',
    'products',
    'c',
    'c',
  ],
  fk_product_relations_related_product_id: [
    'product_relations',
    'related_product_id',
    'products',
    'c',
    'c',
  ],
  fk_product_store_overrides_product_id: [
    'product_store_overrides',
    'product_id',
    'products',
    'c',
    'c',
  ],
  fk_product_store_overrides_store_id: [
    'product_store_overrides',
    'store_id',
    'stores',
    'c',
    'c',
  ],
  fk_product_translations_locale_code: [
    'product_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_product_translations_product_id: [
    'product_translations',
    'product_id',
    'products',
    'c',
    'c',
  ],
  fk_product_variants_product_id: [
    'product_variants',
    'product_id',
    'products',
    'c',
    'c',
  ],
  fk_product_websites_product_id: [
    'product_websites',
    'product_id',
    'products',
    'c',
    'c',
  ],
  fk_product_websites_website_id: [
    'product_websites',
    'website_id',
    'websites',
    'c',
    'c',
  ],
  fk_products_attribute_set_id: [
    'products',
    'attribute_set_id',
    'attribute_sets',
    'r',
    'c',
  ],
  fk_products_tax_class_id: [
    'products',
    'tax_class_id',
    'tax_classes',
    'r',
    'c',
  ],
  fk_promotion_translations_locale_code: [
    'promotion_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_promotion_translations_promotion_id: [
    'promotion_translations',
    'promotion_id',
    'promotions',
    'c',
    'c',
  ],
  fk_promotion_usages_coupon_id: [
    'promotion_usages',
    'coupon_id',
    'coupons',
    'r',
    'c',
  ],
  fk_promotion_usages_customer_id: [
    'promotion_usages',
    'customer_id',
    'customers',
    'n',
    'c',
  ],
  fk_promotion_usages_promotion_id: [
    'promotion_usages',
    'promotion_id',
    'promotions',
    'r',
    'c',
  ],
  fk_promotion_websites_promotion_id: [
    'promotion_websites',
    'promotion_id',
    'promotions',
    'c',
    'c',
  ],
  fk_promotion_websites_website_id: [
    'promotion_websites',
    'website_id',
    'websites',
    'c',
    'c',
  ],
  fk_promotions_campaign_id: [
    'promotions',
    'campaign_id',
    'campaigns',
    'n',
    'c',
  ],
  fk_refresh_tokens_admin_user_id: [
    'refresh_tokens',
    'admin_user_id',
    'admin_users',
    'c',
    'c',
  ],
  fk_refresh_tokens_replaced_by_id: [
    'refresh_tokens',
    'replaced_by_id',
    'refresh_tokens',
    'n',
    'c',
  ],
  fk_refunds_created_by_id: [
    'refunds',
    'created_by_id',
    'admin_users',
    'n',
    'c',
  ],
  fk_refunds_order_id: ['refunds', 'order_id', 'orders', 'r', 'c'],
  fk_refunds_payment_id: ['refunds', 'payment_id', 'payments', 'r', 'c'],
  fk_role_permissions_role_id: [
    'role_permissions',
    'role_id',
    'roles',
    'c',
    'c',
  ],
  fk_schedules_created_by_id: [
    'schedules',
    'created_by_id',
    'admin_users',
    'n',
    'c',
  ],
  fk_search_documents_locale_code: [
    'search_documents',
    'locale_code',
    'locales',
    'c',
    'c',
  ],
  fk_search_documents_store_id: [
    'search_documents',
    'store_id',
    'stores',
    'c',
    'c',
  ],
  fk_search_settings_website_id: [
    'search_settings',
    'website_id',
    'websites',
    'c',
    'c',
  ],
  fk_shipment_items_order_item_id: [
    'shipment_items',
    'order_item_id',
    'order_items',
    'r',
    'c',
  ],
  fk_shipment_items_shipment_id: [
    'shipment_items',
    'shipment_id',
    'shipments',
    'c',
    'c',
  ],
  fk_shipments_order_id: ['shipments', 'order_id', 'orders', 'r', 'c'],
  fk_shipping_method_translations_locale_code: [
    'shipping_method_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_shipping_method_translations_method_id: [
    'shipping_method_translations',
    'method_id',
    'shipping_methods',
    'c',
    'c',
  ],
  fk_shipping_methods_tax_class_id: [
    'shipping_methods',
    'tax_class_id',
    'tax_classes',
    'r',
    'c',
  ],
  fk_shipping_methods_website_id: [
    'shipping_methods',
    'website_id',
    'websites',
    'c',
    'c',
  ],
  fk_slide_translations_locale_code: [
    'slide_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_slide_translations_slide_id: [
    'slide_translations',
    'slide_id',
    'slides',
    'c',
    'c',
  ],
  fk_sliders_store_id: ['sliders', 'store_id', 'stores', 'c', 'c'],
  fk_slides_image_id: ['slides', 'image_id', 'images', 'n', 'c'],
  fk_slides_slider_id: ['slides', 'slider_id', 'sliders', 'c', 'c'],
  fk_store_currencies_currency_code: [
    'store_currencies',
    'currency_code',
    'currencies',
    'r',
    'c',
  ],
  fk_store_currencies_store_id: [
    'store_currencies',
    'store_id',
    'stores',
    'c',
    'c',
  ],
  fk_store_locales_locale_code: [
    'store_locales',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_store_locales_store_id: ['store_locales', 'store_id', 'stores', 'c', 'c'],
  fk_store_payment_method_translations_locale_code: [
    'store_payment_method_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_store_payment_method_translations_method_id: [
    'store_payment_method_translations',
    'method_id',
    'store_payment_methods',
    'c',
    'c',
  ],
  fk_store_payment_methods_provider_id: [
    'store_payment_methods',
    'provider_id',
    'payment_providers',
    'r',
    'c',
  ],
  fk_store_payment_methods_store_id: [
    'store_payment_methods',
    'store_id',
    'stores',
    'c',
    'c',
  ],
  fk_stores_default_currency_code: [
    'stores',
    'default_currency_code',
    'currencies',
    'r',
    'c',
  ],
  fk_stores_default_locale_code: [
    'stores',
    'default_locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_stores_website_id: ['stores', 'website_id', 'websites', 'r', 'c'],
  fk_tag_translations_locale_code: [
    'tag_translations',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_tag_translations_tag_id: ['tag_translations', 'tag_id', 'tags', 'c', 'c'],
  fk_tax_rates_customer_tax_class_id: [
    'tax_rates',
    'customer_tax_class_id',
    'tax_classes',
    'r',
    'c',
  ],
  fk_tax_rates_product_tax_class_id: [
    'tax_rates',
    'product_tax_class_id',
    'tax_classes',
    'r',
    'c',
  ],
  fk_tax_rates_zone_id: ['tax_rates', 'zone_id', 'tax_zones', 'c', 'c'],
  fk_tax_zone_regions_zone_id: [
    'tax_zone_regions',
    'zone_id',
    'tax_zones',
    'c',
    'c',
  ],
  fk_url_rewrites_locale_code: [
    'url_rewrites',
    'locale_code',
    'locales',
    'r',
    'c',
  ],
  fk_url_rewrites_store_id: ['url_rewrites', 'store_id', 'stores', 'c', 'c'],
  fk_webhook_deliveries_webhook_id: [
    'webhook_deliveries',
    'webhook_id',
    'webhooks',
    'c',
    'c',
  ],
  fk_webhooks_created_by_id: [
    'webhooks',
    'created_by_id',
    'admin_users',
    'n',
    'c',
  ],
  fk_website_inventory_sources_source_id: [
    'website_inventory_sources',
    'source_id',
    'inventory_sources',
    'c',
    'c',
  ],
  fk_website_inventory_sources_website_id: [
    'website_inventory_sources',
    'website_id',
    'websites',
    'c',
    'c',
  ],
  fk_websites_base_currency_code: [
    'websites',
    'base_currency_code',
    'currencies',
    'r',
    'c',
  ],
  fk_websites_default_store_id: [
    'websites',
    'default_store_id',
    'stores',
    'n',
    'c',
  ],
};

describe('database migrations', () => {
  let container: StartedPostgreSqlContainer;
  let db: pg.Client;
  let url: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    url = container.getConnectionUri();
    prisma(['migrate', 'deploy'], url);
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('has no drift between migrations and schema.prisma', () => {
    // --exit-code: 0 = no difference, 2 = drift (execFileSync throws on non-zero).
    expect(() =>
      prisma(
        [
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'src/database/prisma/schema.prisma',
          '--exit-code',
        ],
        url,
      ),
    ).not.toThrow();
  });

  it('gives every table a UUID primary key named pk_<table>, defaulting to gen_random_uuid()', async () => {
    const { rows } = await db.query<{
      table_name: string;
      constraint_name: string;
      data_type: string;
      column_default: string;
    }>(`
      SELECT tc.table_name, tc.constraint_name, c.data_type, c.column_default
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage k
        ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
      JOIN information_schema.columns c
        ON c.table_name = tc.table_name AND c.column_name = k.column_name AND c.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name <> '_prisma_migrations'
      ORDER BY tc.table_name`);
    expect(rows.map((r) => r.table_name)).toEqual(TABLES);
    for (const row of rows) {
      expect(row.constraint_name).toBe(`pk_${row.table_name}`);
      expect(row.data_type).toBe('uuid');
      expect(row.column_default).toBe('gen_random_uuid()');
    }
  });

  it('has exactly the planned foreign keys with their referential actions', async () => {
    const { rows } = await db.query<{
      conname: string;
      tbl: string;
      col: string;
      ref: string;
      confdeltype: string;
      confupdtype: string;
      convalidated: boolean;
    }>(`
      SELECT c.conname, t.relname AS tbl, a.attname AS col, r.relname AS ref,
             c.confdeltype, c.confupdtype, c.convalidated
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class r ON r.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'
      ORDER BY c.conname`);
    const actual = Object.fromEntries(
      rows.map((r) => [
        r.conname,
        [r.tbl, r.col, r.ref, r.confdeltype, r.confupdtype],
      ]),
    );
    expect(actual).toEqual(EXPECTED_FKS);
    expect(rows.every((r) => r.convalidated)).toBe(true);
    // Every FK has a client-safe error message in the API's constraint map.
    expect(Object.keys(FOREIGN_KEYS).sort()).toEqual(
      Object.keys(EXPECTED_FKS).sort(),
    );
  });

  it('indexes every foreign-key column (as the leading index column)', async () => {
    const { rows } = await db.query<{ conname: string; indexed: boolean }>(`
      SELECT c.conname,
             EXISTS (
               SELECT 1 FROM pg_index i
               WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
             ) AS indexed
      FROM pg_constraint c WHERE c.contype = 'f'`);
    expect(rows.filter((r) => !r.indexed).map((r) => r.conname)).toEqual([]);
  });

  it('names every unique constraint as documented', async () => {
    const { rows } = await db.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexname NOT LIKE 'pk_%'
        AND tablename <> '_prisma_migrations'`);
    expect(rows.map((r) => r.indexname).sort()).toEqual(
      Object.keys(UNIQUE_CONSTRAINTS).sort(),
    );
  });

  it('seeds the immutable super-admin role with the wildcard permission', async () => {
    const { rows } = await db.query<{
      code: string;
      is_system: boolean;
      permission: string;
    }>(`
      SELECT r.code, r.is_system, p.permission
      FROM roles r JOIN role_permissions p ON p.role_id = r.id`);
    expect(rows).toEqual([
      { code: 'super-admin', is_system: true, permission: '*' },
    ]);
  });

  it('ships ISO reference data: currencies, locales with fallbacks, a default attribute set', async () => {
    const c = await db.query<{ code: string; minor_units: number }>(
      `SELECT code, minor_units FROM currencies WHERE code IN ('USD','VND','KWD') ORDER BY code`,
    );
    expect(c.rows).toEqual([
      { code: 'KWD', minor_units: 3 },
      { code: 'USD', minor_units: 2 },
      { code: 'VND', minor_units: 0 },
    ]);
    const l = await db.query(
      `SELECT fallback_code FROM locales WHERE code = 'vi-VN'`,
    );
    expect(l.rows).toEqual([{ fallback_code: 'en-US' }]);
    expect(
      (await db.query(`SELECT 1 FROM attribute_sets WHERE code = 'default'`))
        .rowCount,
    ).toBe(1);
  });

  it('search helpers: accent-insensitive, per-locale configurations', async () => {
    const { rows } = await db.query(
      `SELECT shop_unaccent('Áo thun Đỏ') AS u, shop_search_config('de-DE')::text AS de, shop_search_config('vi-VN')::text AS vi`,
    );
    expect(rows).toEqual([{ u: 'Ao thun Do', de: 'german', vi: 'simple' }]);
  });

  describe('pricing, tax and inventory integrity', () => {
    async function stockRow() {
      const sku = `INV-${Math.random().toString(36).slice(2, 10)}`;
      const p = await db.query<{ id: string }>(
        `INSERT INTO products (sku, type, attribute_set_id, updated_at) SELECT $1, 'SIMPLE', id, now() FROM attribute_sets WHERE code = 'default' RETURNING id`,
        [sku],
      );
      const v = await db.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, sku, is_default, updated_at) VALUES ($1, $2, true, now()) RETURNING id`,
        [p.rows[0].id, sku],
      );
      const s = await db.query<{ id: string }>(
        `INSERT INTO inventory_sources (code, name, country_code, updated_at) VALUES ($1, 'WH', 'US', now()) RETURNING id`,
        [sku.toLowerCase()],
      );
      const i = await db.query<{ id: string }>(
        `INSERT INTO inventories (source_id, variant_id, quantity, updated_at) VALUES ($1, $2, 5, now()) RETURNING id`,
        [s.rows[0].id, v.rows[0].id],
      );
      return {
        variantId: v.rows[0].id,
        sourceId: s.rows[0].id,
        inventoryId: i.rows[0].id,
      };
    }

    it('ships tax classes and customer groups mapped to customer tax classes', async () => {
      const { rows } = await db.query(
        `SELECT g.code, c.code AS class FROM customer_groups g JOIN tax_classes c ON c.id = g.tax_class_id ORDER BY g.code`,
      );
      expect(rows).toEqual([
        { code: 'general', class: 'retail' },
        { code: 'guest', class: 'retail' },
        { code: 'wholesale', class: 'business' },
      ]);
    });

    it('never lets reservations exceed physical stock (the oversell guard)', async () => {
      const { inventoryId } = await stockRow();
      await db.query(`UPDATE inventories SET reserved = 5 WHERE id = $1`, [
        inventoryId,
      ]);
      await expect(
        db.query(`UPDATE inventories SET reserved = 6 WHERE id = $1`, [
          inventoryId,
        ]),
      ).rejects.toMatchObject({ constraint: 'ck_inventories_quantities' });
      await expect(
        db.query(`UPDATE inventories SET quantity = 4 WHERE id = $1`, [
          inventoryId,
        ]),
      ).rejects.toMatchObject({ constraint: 'ck_inventories_quantities' });
    });

    it('keeps stock history: a source or variant with movements cannot be deleted', async () => {
      const { variantId, sourceId } = await stockRow();
      await db.query(
        `INSERT INTO inventory_movements (source_id, variant_id, delta, quantity_after, reason, actor_label) VALUES ($1, $2, 5, 5, 'RECEIPT', 'ci')`,
        [sourceId, variantId],
      );
      await expect(
        db.query(`DELETE FROM inventory_sources WHERE id = $1`, [sourceId]),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        db.query(`DELETE FROM product_variants WHERE id = $1`, [variantId]),
      ).rejects.toMatchObject({
        constraint: 'fk_inventory_movements_variant_id',
      });
    });

    it('validates price books, entries, rates and exchange rates', async () => {
      const w = await db.query<{ id: string }>(
        `INSERT INTO websites (code, name, base_currency_code, updated_at) VALUES ('pbw', 'x', 'USD', now()) RETURNING id`,
      );
      const s = await db.query<{ id: string }>(
        `INSERT INTO stores (website_id, code, name, default_locale_code, default_currency_code, country_code, updated_at) VALUES ($1, 'pbs', 'x', 'en-US', 'USD', 'US', now()) RETURNING id`,
        [w.rows[0].id],
      );
      await expect(
        db.query(
          `INSERT INTO price_books (code, name, currency_code, website_id, store_id, updated_at) VALUES ('both', 'x', 'USD', $1, $2, now())`,
          [w.rows[0].id, s.rows[0].id],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_price_books_scope' });
      const b = await db.query<{ id: string }>(
        `INSERT INTO price_books (code, name, currency_code, updated_at) VALUES ('pb', 'x', 'USD', now()) RETURNING id`,
      );
      const { variantId } = await stockRow();
      await expect(
        db.query(
          `INSERT INTO price_book_entries (price_book_id, variant_id, min_qty, amount, updated_at) VALUES ($1, $2, 0, 100, now())`,
          [b.rows[0].id, variantId],
        ),
      ).rejects.toMatchObject({
        constraint: 'ck_price_book_entries_min_qty',
      });
      await expect(
        db.query(
          `INSERT INTO exchange_rates (base_currency_code, quote_currency_code, rate) VALUES ('USD', 'USD', 1)`,
        ),
      ).rejects.toMatchObject({ constraint: 'ck_exchange_rates_pair' });
      await expect(
        db.query(
          `INSERT INTO tax_zones (code, name, rounding, updated_at) VALUES ('z', 'z', 'ROW', now())`,
        ),
      ).rejects.toMatchObject({ constraint: 'ck_tax_zones_rounding' });
    });
  });

  describe('catalog integrity', () => {
    async function website() {
      const code = `w${Math.random().toString(36).slice(2, 10)}`;
      const w = await db.query<{ id: string }>(
        `INSERT INTO websites (code, name, base_currency_code, updated_at) VALUES ($1, $1, 'USD', now()) RETURNING id`,
        [code],
      );
      const s = await db.query<{ id: string }>(
        `INSERT INTO stores (website_id, code, name, default_locale_code, default_currency_code, country_code, updated_at)
         VALUES ($1, $2, $2, 'en-US', 'USD', 'US', now()) RETURNING id`,
        [w.rows[0].id, `${code}-en`],
      );
      return { websiteId: w.rows[0].id, storeId: s.rows[0].id };
    }
    async function product(type = 'SIMPLE') {
      const sku = `SKU-${Math.random().toString(36).slice(2, 10)}`;
      const p = await db.query<{ id: string }>(
        `INSERT INTO products (sku, type, attribute_set_id, updated_at) SELECT $1, $2::"ProductType", id, now() FROM attribute_sets WHERE code = 'default' RETURNING id`,
        [sku, type],
      );
      return { id: p.rows[0].id, sku };
    }

    it('rejects malformed codes and impossible values (CHECK constraints)', async () => {
      await expect(
        db.query(
          `INSERT INTO currencies (code, name, symbol, minor_units, updated_at) VALUES ('usd', 'x', '$', 2, now())`,
        ),
      ).rejects.toMatchObject({
        constraint: 'ck_currencies_code',
      });
      await expect(
        db.query(
          `INSERT INTO locales (code, name, updated_at) VALUES ('english', 'x', now())`,
        ),
      ).rejects.toMatchObject({ constraint: 'ck_locales_code' });
      await expect(
        db.query(
          `UPDATE locales SET fallback_code = code WHERE code = 'en-GB'`,
        ),
      ).rejects.toMatchObject({ constraint: 'ck_locales_no_self_fallback' });
      const p = await product();
      await expect(
        db.query(`UPDATE products SET weight_grams = -1 WHERE id = $1`, [p.id]),
      ).rejects.toMatchObject({ constraint: 'ck_products_weight' });
      await expect(
        db.query(
          `INSERT INTO product_relations (product_id, related_product_id, type) VALUES ($1, $1, 'RELATED')`,
          [p.id],
        ),
      ).rejects.toMatchObject({
        constraint: 'ck_product_relations_not_self',
      });
    });

    it('allows one default variant per product', async () => {
      const p = await product();
      await db.query(
        `INSERT INTO product_variants (product_id, sku, is_default, updated_at) VALUES ($1, $2, true, now())`,
        [p.id, p.sku],
      );
      await expect(
        db.query(
          `INSERT INTO product_variants (product_id, sku, is_default, option_signature, updated_at) VALUES ($1, $2, true, 'x', now())`,
          [p.id, `${p.sku}-2`],
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'uq_product_variants_default',
      });
    });

    it('a variant sold in a bundle cannot be deleted (RESTRICT)', async () => {
      const child = await product();
      const v = await db.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, sku, is_default, updated_at) VALUES ($1, $2, true, now()) RETURNING id`,
        [child.id, child.sku],
      );
      const bundle = await product('BUNDLE');
      const o = await db.query<{ id: string }>(
        `INSERT INTO bundle_options (product_id, code, input_type) VALUES ($1, 'top', 'RADIO') RETURNING id`,
        [bundle.id],
      );
      await db.query(
        `INSERT INTO bundle_selections (option_id, variant_id) VALUES ($1, $2)`,
        [o.rows[0].id, v.rows[0].id],
      );
      await expect(
        db.query(`DELETE FROM product_variants WHERE id = $1`, [v.rows[0].id]),
      ).rejects.toMatchObject({
        constraint: 'fk_bundle_selections_variant_id',
      });
      // Deleting the bundle releases it.
      await db.query(`DELETE FROM products WHERE id = $1`, [bundle.id]);
      await db.query(`DELETE FROM product_variants WHERE id = $1`, [
        v.rows[0].id,
      ]);
    });

    it('deleting a store removes its overrides and URLs; a website with stores cannot be deleted', async () => {
      const { websiteId, storeId } = await website();
      const p = await product();
      await db.query(
        `INSERT INTO product_store_overrides (product_id, store_id, status, updated_at) VALUES ($1, $2, 'DISABLED', now())`,
        [p.id, storeId],
      );
      await db.query(
        `INSERT INTO url_rewrites (store_id, locale_code, request_path, target_type, target_id, updated_at) VALUES ($1, 'en-US', $2, 'PRODUCT', $3, now())`,
        [storeId, p.sku.toLowerCase(), p.id],
      );
      await expect(
        db.query(`DELETE FROM websites WHERE id = $1`, [websiteId]),
      ).rejects.toMatchObject({ constraint: 'fk_stores_website_id' });
      await db.query(`DELETE FROM stores WHERE id = $1`, [storeId]);
      expect(
        (
          await db.query(
            `SELECT 1 FROM product_store_overrides WHERE product_id = $1`,
            [p.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query(`SELECT 1 FROM url_rewrites WHERE target_id = $1`, [
            p.id,
          ])
        ).rowCount,
      ).toBe(0);
      await db.query(`DELETE FROM websites WHERE id = $1`, [websiteId]);
    });

    it('URL rewrites: unique per store+locale+path; custom rows need a target path and redirect', async () => {
      const { storeId } = await website();
      const p = await product();
      const insert = (path: string) =>
        db.query(
          `INSERT INTO url_rewrites (store_id, locale_code, request_path, target_type, target_id, updated_at) VALUES ($1, 'en-US', $2, 'PRODUCT', $3, now())`,
          [storeId, path, p.id],
        );
      await insert('tee');
      await expect(insert('tee')).rejects.toMatchObject({
        constraint: 'uq_url_rewrites_store_id_locale_code_request_path',
      });
      await expect(
        db.query(
          `INSERT INTO url_rewrites (store_id, locale_code, request_path, target_type, updated_at) VALUES ($1, 'en-US', 'sale', 'CUSTOM', now())`,
          [storeId],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_url_rewrites_target' });
    });

    it('a locale in use cannot be deleted', async () => {
      await website();
      await expect(
        db.query(`DELETE FROM locales WHERE code = 'en-US'`),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('CMS and scheduler integrity', () => {
    it('rejects malformed slugs, codes, publish windows and menu links (CHECK constraints)', async () => {
      const page = await db.query<{ id: string }>(
        `INSERT INTO pages (updated_at) VALUES (now()) RETURNING id`,
      );
      const pageId = page.rows[0].id;
      await expect(
        db.query(
          `INSERT INTO page_translations (page_id, locale_code, title, slug) VALUES ($1, 'en-US', 'x', 'Not A Slug')`,
          [pageId],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_page_translations_slug' });
      await db.query(
        `INSERT INTO page_translations (page_id, locale_code, title, slug) VALUES ($1, 'en-US', 'x', 'help/shipping')`,
        [pageId],
      );
      await expect(
        db.query(
          `UPDATE pages SET published_at = now(), unpublished_at = now() - interval '1 day' WHERE id = $1`,
          [pageId],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_pages_publish_window' });
      await expect(
        db.query(
          `INSERT INTO blocks (identifier, updated_at) VALUES ('Bad Id', now())`,
        ),
      ).rejects.toMatchObject({ constraint: 'ck_blocks_identifier' });

      const menu = await db.query<{ id: string }>(
        `INSERT INTO menus (code, name, updated_at) VALUES ('mig-menu', 'x', now()) RETURNING id`,
      );
      const menuId = menu.rows[0].id;
      await expect(
        db.query(
          `INSERT INTO menu_items (menu_id, link_type) VALUES ($1, 'URL')`,
          [menuId],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_menu_items_link' });
      await expect(
        db.query(
          `INSERT INTO menu_items (menu_id, link_type, url, target_id) VALUES ($1, 'PAGE', '/x', $2)`,
          [menuId, pageId],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_menu_items_link' });
      await db.query(
        `INSERT INTO menu_items (menu_id, link_type, target_id) VALUES ($1, 'PAGE', $2)`,
        [menuId, pageId],
      );
    });

    it('scopes identifiers: one global block per identifier, one per store', async () => {
      await db.query(
        `INSERT INTO blocks (identifier, updated_at) VALUES ('mig-footer', now())`,
      );
      await expect(
        db.query(
          `INSERT INTO blocks (identifier, updated_at) VALUES ('mig-footer', now())`,
        ),
      ).rejects.toMatchObject({ constraint: 'uq_blocks_identifier_global' });
      const store = await db.query<{ id: string }>(
        `SELECT id FROM stores LIMIT 1`,
      );
      if (store.rows[0]) {
        await db.query(
          `INSERT INTO blocks (identifier, store_id, updated_at) VALUES ('mig-footer', $1, now())`,
          [store.rows[0].id],
        );
        await expect(
          db.query(
            `INSERT INTO blocks (identifier, store_id, updated_at) VALUES ('mig-footer', $1, now())`,
            [store.rows[0].id],
          ),
        ).rejects.toMatchObject({
          constraint: 'uq_blocks_identifier_store_id',
        });
      }
    });

    it('keeps one pending schedule per target and action; history rows are unrestricted', async () => {
      const target = '00000000-0000-4000-8000-0000000000aa';
      const insert = () =>
        db.query(
          `INSERT INTO schedules (target_type, target_id, action, run_at, updated_at) VALUES ('PAGE', $1, 'PUBLISH', now() + interval '1 hour', now())`,
          [target],
        );
      await insert();
      await expect(insert()).rejects.toMatchObject({
        constraint: 'uq_schedules_pending_target_action',
      });
      await db.query(
        `UPDATE schedules SET status = 'DONE', executed_at = now() WHERE target_id = $1`,
        [target],
      );
      await insert();
      await expect(
        db.query(
          `UPDATE schedules SET status = 'DONE' WHERE target_id = $1 AND status = 'PENDING'`,
          [target],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_schedules_executed' });
    });
  });

  describe('customers, marketing and loyalty integrity', () => {
    async function customer(email: string) {
      const w = await db.query<{ id: string }>(
        `INSERT INTO websites (code, name, base_currency_code, updated_at) VALUES ($1, $1, 'USD', now()) RETURNING id`,
        [`w${Math.random().toString(36).slice(2, 8)}`],
      );
      const c = await db.query<{ id: string }>(
        `INSERT INTO customers (website_id, email, password_hash, first_name, last_name, customer_group_id, updated_at)
         SELECT $1, $2, 'x', 'A', 'B', id, now() FROM customer_groups WHERE code = 'general' RETURNING id`,
        [w.rows[0].id, email],
      );
      return { websiteId: w.rows[0].id, customerId: c.rows[0].id };
    }

    it('one account per e-mail and website (case-insensitive); one default address of each kind', async () => {
      const { websiteId, customerId } = await customer('Ann@Example.com');
      await expect(
        db.query(
          `INSERT INTO customers (website_id, email, password_hash, first_name, last_name, customer_group_id, updated_at)
           SELECT $1, 'ann@example.COM', 'x', 'A', 'B', id, now() FROM customer_groups WHERE code = 'general'`,
          [websiteId],
        ),
      ).rejects.toMatchObject({ constraint: 'uq_customers_website_id_email' });
      const addr = (def: boolean) =>
        db.query(
          `INSERT INTO customer_addresses (customer_id, first_name, last_name, country_code, city, line1, is_default_shipping, updated_at)
           VALUES ($1, 'A', 'B', 'US', 'LA', '1 Main St', $2, now())`,
          [customerId, def],
        );
      await addr(true);
      await addr(false);
      await expect(addr(true)).rejects.toMatchObject({
        constraint: 'uq_customer_addresses_default_shipping',
      });
      // A customer group with customers cannot be deleted.
      await expect(
        db.query(`DELETE FROM customer_groups WHERE code = 'general'`),
      ).rejects.toMatchObject({ constraint: 'fk_customers_customer_group_id' });
    });

    it('usage limits and coupon codes are guarded', async () => {
      const p = await db.query<{ id: string }>(
        `INSERT INTO promotions (name, usage_limit, updated_at) VALUES ('P', 1, now()) RETURNING id`,
      );
      await db.query(`UPDATE promotions SET times_used = 1 WHERE id = $1`, [
        p.rows[0].id,
      ]);
      await expect(
        db.query(`UPDATE promotions SET times_used = 2 WHERE id = $1`, [
          p.rows[0].id,
        ]),
      ).rejects.toMatchObject({ constraint: 'ck_promotions_usage' });
      await db.query(
        `INSERT INTO coupons (promotion_id, code, updated_at) VALUES ($1, 'SAVE10', now())`,
        [p.rows[0].id],
      );
      await expect(
        db.query(
          `INSERT INTO coupons (promotion_id, code, updated_at) VALUES ($1, 'save10', now())`,
          [p.rows[0].id],
        ),
      ).rejects.toMatchObject({ constraint: 'uq_coupons_code' });
      await expect(
        db.query(
          `INSERT INTO coupons (promotion_id, code, updated_at) VALUES ($1, 'a b', now())`,
          [p.rows[0].id],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_coupons_code' });
      await expect(
        db.query(`UPDATE promotions SET conditions = '{}' WHERE id = $1`, [
          p.rows[0].id,
        ]),
      ).rejects.toMatchObject({ constraint: 'ck_promotions_rules' });
    });

    it('the points ledger: signs, no negative balance, earn/redeem once per order', async () => {
      const { websiteId, customerId } = await customer('pts@example.com');
      const prog = await db.query<{ id: string }>(
        `INSERT INTO loyalty_programs (website_id, name, currency_code, spend_per_point, point_value, updated_at)
         VALUES ($1, 'Points', 'USD', 100, 1, now()) RETURNING id`,
        [websiteId],
      );
      const acc = await db.query<{ id: string }>(
        `INSERT INTO loyalty_accounts (program_id, customer_id, updated_at) VALUES ($1, $2, now()) RETURNING id`,
        [prog.rows[0].id, customerId],
      );
      const tx = (
        type: string,
        points: number,
        remaining = 0,
        order: string | null = null,
      ) =>
        db.query(
          `INSERT INTO loyalty_transactions (account_id, type, points, remaining, order_ref) VALUES ($1, $2, $3, $4, $5)`,
          [acc.rows[0].id, type, points, remaining, order],
        );
      await tx('EARN', 10, 10, 'o1');
      await expect(tx('EARN', 5, 5, 'o1')).rejects.toMatchObject({
        constraint: 'uq_loyalty_transactions_order_once',
      });
      await tx('ADJUST', 5, 5, 'o1'); // other types may repeat an order reference
      await expect(tx('EARN', -1)).rejects.toMatchObject({
        constraint: 'ck_loyalty_transactions_sign',
      });
      await expect(tx('REDEEM', 5)).rejects.toMatchObject({
        constraint: 'ck_loyalty_transactions_sign',
      });
      await expect(tx('EARN', 5, 6)).rejects.toMatchObject({
        constraint: 'ck_loyalty_transactions_sign',
      });
      await expect(
        db.query(`UPDATE loyalty_accounts SET balance = -1 WHERE id = $1`, [
          acc.rows[0].id,
        ]),
      ).rejects.toMatchObject({ constraint: 'ck_loyalty_accounts_balance' });
    });
  });

  describe('ops integrity', () => {
    it('one open run per job; finished runs carry their end time', async () => {
      const j = await db.query<{ id: string }>(
        `INSERT INTO jobs (code, name, type, updated_at) VALUES ('nightly.export', 'x', 'export.orders', now()) RETURNING id`,
      );
      const jobId = j.rows[0].id;
      await db.query(
        `INSERT INTO job_executions (job_id, type, trigger, actor_type, actor_label) VALUES ($1, 'export.orders', 'SCHEDULE', 'system', 'system')`,
        [jobId],
      );
      await expect(
        db.query(
          `INSERT INTO job_executions (job_id, type, trigger, actor_type, actor_label) VALUES ($1, 'export.orders', 'MANUAL', 'admin', 'a')`,
          [jobId],
        ),
      ).rejects.toMatchObject({ constraint: 'uq_job_executions_open_per_job' });
      await expect(
        db.query(
          `UPDATE job_executions SET status = 'SUCCEEDED' WHERE job_id = $1`,
          [jobId],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_job_executions_finished' });
      await db.query(
        `UPDATE job_executions SET status = 'SUCCEEDED', finished_at = now(), progress = 100 WHERE job_id = $1`,
        [jobId],
      );
      // Finished: a new run may start; deleting the job keeps its history.
      await db.query(
        `INSERT INTO job_executions (job_id, type, trigger, actor_type, actor_label) VALUES ($1, 'export.orders', 'MANUAL', 'admin', 'a')`,
        [jobId],
      );
      await expect(
        db.query(`UPDATE job_executions SET progress = 101 WHERE job_id = $1`, [
          jobId,
        ]),
      ).rejects.toMatchObject({ constraint: 'ck_job_executions_progress' });
      await expect(
        db.query(
          `INSERT INTO jobs (code, name, type, updated_at) VALUES ('Bad Code', 'x', 't', now())`,
        ),
      ).rejects.toMatchObject({ constraint: 'ck_jobs_code' });
      await db.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
      const left = await db.query(
        `SELECT count(*)::int AS n FROM job_executions WHERE type = 'export.orders' AND job_id IS NULL`,
      );
      expect(left.rows[0].n).toBe(2);
    });

    it('webhooks: http(s) URLs, at least one event, each event delivered once', async () => {
      await expect(
        db.query(
          `INSERT INTO webhooks (name, url, events, secret, updated_at) VALUES ('x', 'ftp://x', '{order.placed}', 's', now())`,
        ),
      ).rejects.toMatchObject({ constraint: 'ck_webhooks_url' });
      await expect(
        db.query(
          `INSERT INTO webhooks (name, url, secret, updated_at) VALUES ('x', 'https://x', 's', now())`,
        ),
      ).rejects.toMatchObject({ constraint: 'ck_webhooks_events' });
      const w = await db.query<{ id: string }>(
        `INSERT INTO webhooks (name, url, events, secret, updated_at) VALUES ('x', 'https://erp.example/hook', '{order.*}', 's', now()) RETURNING id`,
      );
      const insert = () =>
        db.query(
          `INSERT INTO webhook_deliveries (webhook_id, event_id, event_name, payload, updated_at)
           VALUES ($1, '00000000-0000-4000-8000-0000000000aa', 'order.placed', '{}', now())`,
          [w.rows[0].id],
        );
      await insert();
      await expect(insert()).rejects.toMatchObject({
        constraint: 'uq_webhook_deliveries_webhook_id_event_id',
      });
      await db.query(`DELETE FROM webhooks WHERE id = $1`, [w.rows[0].id]);
      const left = await db.query(
        `SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1`,
        [w.rows[0].id],
      );
      expect(left.rows[0].n).toBe(0);
    });

    it('an event is audited once', async () => {
      const insert = () =>
        db.query(
          `INSERT INTO audit_logs (actor_type, actor_label, action, entity_type, event_id)
           VALUES ('system', 'system', 'x.updated', 'x', '00000000-0000-4000-8000-0000000000bb')`,
        );
      await insert();
      await expect(insert()).rejects.toMatchObject({
        constraint: 'uq_audit_logs_event_id',
      });
    });
  });

  describe('checkout integrity', () => {
    async function order() {
      const w = await db.query<{ id: string }>(
        `INSERT INTO websites (code, name, base_currency_code, updated_at) VALUES ($1, $1, 'USD', now()) RETURNING id`,
        [`o${Math.random().toString(36).slice(2, 8)}`],
      );
      const s = await db.query<{ id: string }>(
        `INSERT INTO stores (website_id, code, name, default_locale_code, default_currency_code, country_code, updated_at)
         VALUES ($1, $2, 'x', 'en-US', 'USD', 'US', now()) RETURNING id`,
        [w.rows[0].id, `s${Math.random().toString(36).slice(2, 8)}`],
      );
      const id =
        '00000000-0000-4000-8000-' +
        Math.random().toString(16).slice(2, 14).padEnd(12, '0');
      await db.query(
        `INSERT INTO orders (id, number, store_id, website_id, idempotency_key, access_token_hash, email, customer_group_code,
           locale_code, currency_code, prices_include_tax, subtotal, grand_total, amount_due, updated_at)
         VALUES ($1, $2, $3, $4, 'k', repeat('a', 64), 'a@b.co', 'guest', 'en-US', 'USD', false, 1000, 1000, 1000, now())`,
        [id, `N${id.slice(-8)}`, s.rows[0].id, w.rows[0].id],
      );
      return { id, storeId: s.rows[0].id, websiteId: w.rows[0].id };
    }

    it('keeps order money consistent and one order per idempotency key', async () => {
      const o = await order();
      await expect(
        db.query(`UPDATE orders SET amount_due = 1 WHERE id = $1`, [o.id]),
      ).rejects.toMatchObject({ constraint: 'ck_orders_amounts' });
      await expect(
        db.query(`UPDATE orders SET amount_refunded = 10 WHERE id = $1`, [
          o.id,
        ]),
      ).rejects.toMatchObject({ constraint: 'ck_orders_amounts' });
      await expect(
        db.query(
          `INSERT INTO orders (id, number, store_id, website_id, idempotency_key, access_token_hash, email, customer_group_code,
             locale_code, currency_code, prices_include_tax, subtotal, grand_total, amount_due, updated_at)
           VALUES (gen_random_uuid(), 'OTHER-1', $1, $2, 'k', repeat('a', 64), 'a@b.co', 'guest', 'en-US', 'USD', false, 1, 1, 1, now())`,
          [o.storeId, o.websiteId],
        ),
      ).rejects.toMatchObject({
        constraint: 'uq_orders_store_id_idempotency_key',
      });
      // A store or website with orders can't be deleted.
      await expect(
        db.query(`DELETE FROM stores WHERE id = $1`, [o.storeId]),
      ).rejects.toMatchObject({ constraint: 'fk_orders_store_id' });
    });

    it('allows one open payment per order and processes a webhook once', async () => {
      const o = await order();
      const p = await db.query<{ id: string }>(
        `INSERT INTO payment_providers (code, name, updated_at) VALUES ('COD', 'Cash', now()) RETURNING id`,
      );
      const pay = (status: string) =>
        db.query(
          `INSERT INTO payments (order_id, provider_id, provider_code, status, amount, currency_code, updated_at)
           VALUES ($1, $2, 'COD', $3, 1000, 'USD', now())`,
          [o.id, p.rows[0].id, status],
        );
      await pay('FAILED');
      await pay('PENDING');
      await expect(pay('CAPTURED')).rejects.toMatchObject({
        constraint: 'uq_payments_open_per_order',
      });
      const hook = () =>
        db.query(
          `INSERT INTO payment_webhook_events (provider_id, provider_event_id, event_type, payload, status)
           VALUES ($1, 'evt_1', 'x', '{}', 'PROCESSED')`,
          [p.rows[0].id],
        );
      await hook();
      await expect(hook()).rejects.toMatchObject({
        constraint: 'uq_payment_webhook_events_provider_event',
      });
    });

    it('a guest cart needs a token; quantities stay in range', async () => {
      const o = await order();
      await expect(
        db.query(
          `INSERT INTO carts (store_id, currency_code, updated_at) VALUES ($1, 'USD', now())`,
          [o.storeId],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_carts_owner' });
      await expect(
        db.query(
          `INSERT INTO order_items (order_id, sku, name, product_type, quantity, unit_price, row_total, discount)
           VALUES ($1, 'X', 'X', 'SIMPLE', 1, 100, 100, 200)`,
          [o.id],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_order_items_quantities' });
    });
  });

  describe('referential behaviour', () => {
    async function seedUser() {
      const email = `u-${Math.random().toString(36).slice(2)}@shop.test`;
      const u = await db.query<{ id: string }>(
        `INSERT INTO admin_users (email, password_hash, updated_at) VALUES ($1, 'scrypt$x', now()) RETURNING id`,
        [email],
      );
      return { id: u.rows[0].id, email };
    }
    const superAdminRole = async () =>
      (
        await db.query<{ id: string }>(
          `SELECT id FROM roles WHERE code = 'super-admin'`,
        )
      ).rows[0].id;

    it('treats e-mails case-insensitively (citext unique)', async () => {
      const { email } = await seedUser();
      await expect(
        db.query(
          `INSERT INTO admin_users (email, password_hash, updated_at) VALUES ($1, 'x', now())`,
          [email.toUpperCase()],
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'uq_admin_users_email',
      });
    });

    it('refuses to delete a role that is still assigned (RESTRICT)', async () => {
      const { id } = await seedUser();
      const role = await db.query<{ id: string }>(
        `INSERT INTO roles (code, name, updated_at) VALUES ($1, 'Temp', now()) RETURNING id`,
        [`temp-${id.slice(0, 8)}`],
      );
      await db.query(
        'INSERT INTO admin_user_roles (admin_user_id, role_id) VALUES ($1, $2)',
        [id, role.rows[0].id],
      );
      await expect(
        db.query('DELETE FROM roles WHERE id = $1', [role.rows[0].id]),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_admin_user_roles_role_id',
      });
    });

    it('deleting a user cascades to roles and sessions, and keeps API keys they created', async () => {
      const { id } = await seedUser();
      await db.query(
        'INSERT INTO admin_user_roles (admin_user_id, role_id) VALUES ($1, $2)',
        [id, await superAdminRole()],
      );
      const first = await db.query<{ id: string }>(
        `INSERT INTO refresh_tokens (admin_user_id, family_id, token_hash, expires_at)
         VALUES ($1, gen_random_uuid(), repeat('a', 63) || substr(md5(random()::text), 1, 1), now() + interval '1 day') RETURNING id`,
        [id],
      );
      const key = await db.query<{ id: string }>(
        `INSERT INTO api_keys (name, prefix, key_hash, created_by_id, updated_at)
         VALUES ('erp', substr(md5(random()::text), 1, 8), md5(random()::text) || md5(random()::text), $1, now()) RETURNING id`,
        [id],
      );
      await db.query('DELETE FROM admin_users WHERE id = $1', [id]);
      expect(
        (
          await db.query(
            'SELECT 1 FROM admin_user_roles WHERE admin_user_id = $1',
            [id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query('SELECT 1 FROM refresh_tokens WHERE id = $1', [
            first.rows[0].id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query('SELECT created_by_id FROM api_keys WHERE id = $1', [
            key.rows[0].id,
          ])
        ).rows,
      ).toEqual([{ created_by_id: null }]);
    });

    it('rejects a child row pointing at a missing parent (23503)', async () => {
      await expect(
        db.query(
          `INSERT INTO refresh_tokens (admin_user_id, family_id, token_hash, expires_at)
           VALUES (gen_random_uuid(), gen_random_uuid(), repeat('b', 64), now())`,
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_refresh_tokens_admin_user_id',
      });
    });
  });
});
