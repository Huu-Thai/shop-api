/**
 * Every named FK / unique constraint in the schema (PLAN.md §3.3), mapped to a
 * client-safe message. The migration e2e test asserts this list matches the
 * database exactly, so a new constraint can't ship without a message.
 */
export const FOREIGN_KEYS: Record<string, string> = {
  fk_role_permissions_role_id: 'Role does not exist',
  fk_admin_user_roles_admin_user_id: 'Admin user does not exist',
  fk_admin_user_roles_role_id:
    'Role does not exist, or is still assigned to users',
  fk_refresh_tokens_admin_user_id: 'Admin user does not exist',
  fk_refresh_tokens_replaced_by_id: 'Refresh token does not exist',
  fk_api_keys_created_by_id: 'Admin user does not exist',
  // Phase 1 — stores, catalog, media, URLs
  fk_locales_fallback_code: 'Fallback locale does not exist',
  fk_websites_base_currency_code:
    'Currency does not exist, or is still the base currency of a website',
  fk_websites_default_store_id: 'Default store does not exist',
  fk_stores_website_id: 'Website does not exist, or still has stores',
  fk_stores_default_locale_code:
    'Locale does not exist, or is still the default locale of a store',
  fk_stores_default_currency_code:
    'Currency does not exist, or is still the default currency of a store',
  fk_store_locales_store_id: 'Store does not exist',
  fk_store_locales_locale_code:
    'Locale does not exist, or is enabled in a store',
  fk_store_currencies_store_id: 'Store does not exist',
  fk_store_currencies_currency_code:
    'Currency does not exist, or is enabled in a store',
  fk_attribute_translations_attribute_id: 'Attribute does not exist',
  fk_attribute_translations_locale_code: 'Locale does not exist, or is in use',
  fk_attribute_options_attribute_id: 'Attribute does not exist',
  fk_attribute_option_translations_option_id: 'Attribute option does not exist',
  fk_attribute_option_translations_locale_code:
    'Locale does not exist, or is in use',
  fk_attribute_set_attributes_attribute_set_id: 'Attribute set does not exist',
  fk_attribute_set_attributes_attribute_id: 'Attribute does not exist',
  fk_categories_parent_id:
    'Parent category does not exist, or the category still has children',
  fk_category_translations_category_id: 'Category does not exist',
  fk_category_translations_locale_code: 'Locale does not exist, or is in use',
  fk_category_websites_category_id: 'Category does not exist',
  fk_category_websites_website_id: 'Website does not exist',
  fk_products_attribute_set_id:
    'Attribute set does not exist, or is still used by products',
  fk_product_translations_product_id: 'Product does not exist',
  fk_product_translations_locale_code: 'Locale does not exist, or is in use',
  fk_product_websites_product_id: 'Product does not exist',
  fk_product_websites_website_id: 'Website does not exist',
  fk_product_store_overrides_product_id: 'Product does not exist',
  fk_product_store_overrides_store_id: 'Store does not exist',
  fk_product_variants_product_id: 'Product does not exist',
  fk_configurable_attributes_product_id: 'Product does not exist',
  fk_configurable_attributes_attribute_id:
    'Attribute does not exist, or configures product variants',
  fk_product_categories_product_id: 'Product does not exist',
  fk_product_categories_category_id: 'Category does not exist',
  fk_product_relations_product_id: 'Product does not exist',
  fk_product_relations_related_product_id: 'Related product does not exist',
  fk_bundle_options_product_id: 'Product does not exist',
  fk_bundle_option_translations_option_id: 'Bundle option does not exist',
  fk_bundle_option_translations_locale_code:
    'Locale does not exist, or is in use',
  fk_bundle_selections_option_id: 'Bundle option does not exist',
  fk_bundle_selections_variant_id:
    'Variant does not exist, or is sold inside a bundle',
  fk_images_created_by_id: 'Admin user does not exist',
  fk_image_translations_image_id: 'Image does not exist',
  fk_image_translations_locale_code: 'Locale does not exist, or is in use',
  fk_image_links_image_id: 'Image does not exist',
  fk_url_rewrites_store_id: 'Store does not exist',
  fk_url_rewrites_locale_code: 'Locale does not exist, or is in use',
  // Phase 2 — tax, pricing, inventory
  fk_products_tax_class_id:
    'Tax class does not exist, or is still used by products',
  fk_customer_groups_tax_class_id:
    'Tax class does not exist, or is still used by customer groups',
  fk_tax_zone_regions_zone_id: 'Tax zone does not exist',
  fk_tax_rates_zone_id: 'Tax zone does not exist',
  fk_tax_rates_product_tax_class_id:
    'Product tax class does not exist, or is still used by tax rates',
  fk_tax_rates_customer_tax_class_id:
    'Customer tax class does not exist, or is still used by tax rates',
  fk_price_books_currency_code:
    'Currency does not exist, or is still used by price books',
  fk_price_books_website_id: 'Website does not exist',
  fk_price_books_store_id: 'Store does not exist',
  fk_price_books_customer_group_id: 'Customer group does not exist',
  fk_price_book_entries_price_book_id: 'Price book does not exist',
  fk_price_book_entries_variant_id: 'Variant does not exist',
  fk_price_index_variant_id: 'Variant does not exist',
  fk_price_index_store_id: 'Store does not exist',
  fk_price_index_customer_group_id: 'Customer group does not exist',
  fk_price_index_currency_code: 'Currency does not exist',
  fk_price_index_price_book_id: 'Price book does not exist',
  fk_exchange_rates_base_currency_code: 'Base currency does not exist',
  fk_exchange_rates_quote_currency_code: 'Quote currency does not exist',
  fk_website_inventory_sources_website_id: 'Website does not exist',
  fk_website_inventory_sources_source_id: 'Inventory source does not exist',
  fk_inventories_source_id:
    'Inventory source does not exist, or still holds stock (deactivate it instead)',
  fk_inventories_variant_id: 'Variant does not exist',
  fk_inventory_reservations_variant_id: 'Variant does not exist',
  fk_inventory_reservations_source_id: 'Inventory source does not exist',
  fk_inventory_movements_source_id:
    'Inventory source does not exist, or has stock history (deactivate it instead)',
  fk_inventory_movements_variant_id:
    'Variant does not exist, or has stock history (disable it instead)',
  // Phase 3 — search
  fk_search_settings_website_id: 'Website does not exist',
  fk_search_documents_store_id: 'Store does not exist',
  fk_search_documents_locale_code: 'Locale does not exist',
  // Phase 4 — CMS, navigation, merchandising, scheduler
  fk_pages_store_id: 'Store does not exist',
  fk_pages_created_by_id: 'Admin user does not exist',
  fk_page_translations_page_id: 'Page does not exist',
  fk_page_translations_locale_code: 'Locale does not exist, or is in use',
  fk_posts_store_id: 'Store does not exist',
  fk_posts_author_id: 'Admin user does not exist',
  fk_posts_featured_image_id: 'Image does not exist',
  fk_post_translations_post_id: 'Post does not exist',
  fk_post_translations_locale_code: 'Locale does not exist, or is in use',
  fk_tag_translations_tag_id: 'Tag does not exist',
  fk_tag_translations_locale_code: 'Locale does not exist, or is in use',
  fk_post_tags_post_id: 'Post does not exist',
  fk_post_tags_tag_id: 'Tag does not exist',
  fk_blocks_store_id: 'Store does not exist',
  fk_block_translations_block_id: 'Block does not exist',
  fk_block_translations_locale_code: 'Locale does not exist, or is in use',
  fk_block_placements_block_id: 'Block does not exist',
  fk_menus_store_id: 'Store does not exist',
  fk_menu_items_menu_id: 'Menu does not exist',
  fk_menu_items_parent_id: 'Parent menu item does not exist',
  fk_menu_item_translations_item_id: 'Menu item does not exist',
  fk_menu_item_translations_locale_code: 'Locale does not exist, or is in use',
  fk_banners_store_id: 'Store does not exist',
  fk_banners_image_id: 'Image does not exist',
  fk_banner_translations_banner_id: 'Banner does not exist',
  fk_banner_translations_locale_code: 'Locale does not exist, or is in use',
  fk_banner_translations_image_id: 'Image does not exist',
  fk_sliders_store_id: 'Store does not exist',
  fk_slides_slider_id: 'Slider does not exist',
  fk_slides_image_id: 'Image does not exist',
  fk_slide_translations_slide_id: 'Slide does not exist',
  fk_slide_translations_locale_code: 'Locale does not exist, or is in use',
  fk_schedules_created_by_id: 'Admin user does not exist',
  // Phase 5 — customers, marketing, loyalty
  fk_customers_website_id:
    'Website does not exist, or still has customer accounts',
  fk_customers_customer_group_id:
    'Customer group does not exist, or still has customers',
  fk_customers_locale_code: 'Locale does not exist',
  fk_customer_addresses_customer_id: 'Customer does not exist',
  fk_customer_sessions_customer_id: 'Customer does not exist',
  fk_customer_sessions_replaced_by_id: 'Session does not exist',
  fk_campaigns_budget_currency_code:
    'Currency does not exist, or is used by a campaign budget',
  fk_promotions_campaign_id: 'Campaign does not exist',
  fk_promotion_websites_promotion_id: 'Promotion does not exist',
  fk_promotion_websites_website_id: 'Website does not exist',
  fk_promotion_translations_promotion_id: 'Promotion does not exist',
  fk_promotion_translations_locale_code: 'Locale does not exist, or is in use',
  fk_coupons_promotion_id: 'Promotion does not exist',
  fk_promotion_usages_promotion_id:
    'Promotion does not exist, or has been used by orders (archive it instead)',
  fk_promotion_usages_coupon_id:
    'Coupon does not exist, or has been used by orders (deactivate it instead)',
  fk_promotion_usages_customer_id: 'Customer does not exist',
  fk_loyalty_programs_website_id: 'Website does not exist',
  fk_loyalty_programs_currency_code:
    'Currency does not exist, or is used by a loyalty program',
  fk_loyalty_tiers_program_id: 'Loyalty program does not exist',
  fk_loyalty_accounts_program_id: 'Loyalty program does not exist',
  fk_loyalty_accounts_customer_id: 'Customer does not exist',
  fk_loyalty_accounts_tier_id: 'Loyalty tier does not exist',
  fk_loyalty_transactions_account_id: 'Loyalty account does not exist',
  fk_loyalty_allocations_debit_id: 'Loyalty transaction does not exist',
  fk_loyalty_allocations_credit_id: 'Loyalty transaction does not exist',
  // Phase 6 — checkout
  fk_shipping_methods_website_id: 'Website does not exist',
  fk_shipping_methods_tax_class_id:
    'Tax class does not exist, or is used by a shipping method',
  fk_shipping_method_translations_method_id: 'Shipping method does not exist',
  fk_shipping_method_translations_locale_code:
    'Locale does not exist, or is in use',
  fk_carts_store_id: 'Store does not exist',
  fk_carts_customer_id: 'Customer does not exist',
  fk_carts_shipping_method_id: 'Shipping method does not exist',
  fk_cart_items_cart_id: 'Cart does not exist',
  fk_cart_items_variant_id: 'Product variant does not exist',
  fk_orders_store_id: 'Store does not exist, or has orders',
  fk_orders_website_id: 'Website does not exist, or has orders',
  fk_orders_customer_id: 'Customer does not exist',
  fk_orders_currency_code: 'Currency does not exist, or is used by orders',
  fk_order_items_order_id: 'Order does not exist',
  fk_order_items_parent_item_id: 'Order item does not exist',
  fk_order_items_product_id: 'Product does not exist',
  fk_order_items_variant_id: 'Product variant does not exist',
  fk_order_addresses_order_id: 'Order does not exist',
  fk_order_history_order_id: 'Order does not exist',
  fk_store_payment_methods_store_id: 'Store does not exist',
  fk_store_payment_methods_provider_id:
    'Payment provider does not exist, or is offered by a store',
  fk_store_payment_method_translations_method_id:
    'Payment method does not exist',
  fk_store_payment_method_translations_locale_code:
    'Locale does not exist, or is in use',
  fk_payments_order_id: 'Order does not exist, or has payments',
  fk_payments_method_id: 'Payment method does not exist',
  fk_payments_provider_id: 'Payment provider does not exist, or has payments',
  fk_payment_transactions_payment_id: 'Payment does not exist',
  fk_payment_webhook_events_provider_id: 'Payment provider does not exist',
  fk_refunds_order_id: 'Order does not exist, or has refunds',
  fk_refunds_payment_id: 'Payment does not exist, or has refunds',
  fk_refunds_created_by_id: 'Admin user does not exist',
  fk_shipments_order_id: 'Order does not exist, or has shipments',
  fk_shipment_items_shipment_id: 'Shipment does not exist',
  fk_shipment_items_order_item_id:
    'Order item does not exist, or has been shipped',
  fk_invoices_order_id: 'Order does not exist, or has an invoice',
  fk_credit_memos_order_id: 'Order does not exist, or has credit memos',
  fk_credit_memos_refund_id: 'Refund does not exist, or has a credit memo',
  // Phase 7 — jobs, outgoing webhooks
  fk_jobs_created_by_id: 'Admin user does not exist',
  fk_job_executions_job_id: 'Job does not exist',
  fk_webhooks_created_by_id: 'Admin user does not exist',
  fk_webhook_deliveries_webhook_id: 'Webhook does not exist',
};

export const UNIQUE_CONSTRAINTS: Record<string, string> = {
  uq_admin_users_email: 'An admin user with this e-mail already exists',
  uq_roles_code: 'A role with this code already exists',
  uq_role_permissions_role_id_permission:
    'The role already has this permission',
  uq_admin_user_roles_admin_user_id_role_id: 'The user already has this role',
  uq_refresh_tokens_token_hash: 'Token collision',
  uq_api_keys_prefix: 'API key prefix collision — try again',
  uq_api_keys_key_hash: 'API key collision — try again',
  // Phase 1
  uq_locales_code: 'A locale with this code already exists',
  uq_currencies_code: 'A currency with this code already exists',
  uq_websites_code: 'A website with this code already exists',
  uq_stores_code: 'A store with this code already exists',
  uq_stores_base_url: 'Another store already uses this base URL',
  uq_store_locales_store_id_locale_code: 'The locale is already enabled',
  uq_store_currencies_store_id_currency_code: 'The currency is already enabled',
  uq_attributes_code: 'An attribute with this code already exists',
  uq_attribute_translations_attribute_id_locale_code:
    'Duplicate attribute label for a locale',
  uq_attribute_options_attribute_id_code: 'Duplicate option code',
  uq_attribute_option_translations_option_id_locale_code:
    'Duplicate option label for a locale',
  uq_attribute_sets_code: 'An attribute set with this code already exists',
  uq_attribute_set_attributes_attribute_set_id_attribute_id:
    'The attribute is already in the set',
  uq_category_translations_category_id_locale_code:
    'Duplicate category translation for a locale',
  uq_category_websites_category_id_website_id:
    'The category is already assigned to this website',
  uq_products_sku: 'A product with this SKU already exists',
  uq_product_translations_product_id_locale_code:
    'Duplicate product translation for a locale',
  uq_product_translations_locale_code_slug:
    'Another product already uses this URL key (slug) in this locale',
  uq_product_websites_product_id_website_id:
    'The product is already assigned to this website',
  uq_product_store_overrides_product_id_store_id:
    'The product already has an override for this store',
  uq_product_variants_sku: 'A variant with this SKU already exists',
  uq_product_variants_product_id_option_signature:
    'A variant with these options already exists',
  uq_product_variants_default: 'The product already has a default variant',
  uq_configurable_attributes_product_id_attribute_id:
    'Duplicate configurable attribute',
  uq_product_categories_product_id_category_id:
    'The product is already in this category',
  uq_product_relations_product_id_related_product_id_type:
    'Duplicate product relation',
  uq_bundle_options_product_id_code: 'Duplicate bundle option code',
  uq_bundle_option_translations_option_id_locale_code:
    'Duplicate bundle option title for a locale',
  uq_bundle_selections_option_id_variant_id:
    'The variant is already a selection of this option',
  uq_images_storage_key: 'Image already stored',
  uq_images_checksum: 'This image was already uploaded',
  uq_image_translations_image_id_locale_code: 'Duplicate alt text for a locale',
  uq_image_links_image_id_owner_type_owner_id_role:
    'The image is already linked with this role',
  uq_url_rewrites_store_id_locale_code_request_path:
    'This URL path is already used in the store',
  // Phase 2
  uq_tax_classes_code: 'A tax class with this code already exists',
  uq_customer_groups_code: 'A customer group with this code already exists',
  uq_tax_zones_code: 'A tax zone with this code already exists',
  uq_price_books_code: 'A price book with this code already exists',
  uq_price_book_entries_price_book_id_variant_id_min_qty:
    'The price book already has a price for this variant and quantity',
  uq_price_index_variant_store_group_currency_qty:
    'Price index row already exists',
  uq_exchange_rates_base_quote_valid_from:
    'An exchange rate for this pair and time already exists',
  uq_inventory_sources_code:
    'An inventory source with this code already exists',
  uq_website_inventory_sources_website_id_source_id:
    'The source already supplies this website',
  uq_inventories_source_id_variant_id:
    'The variant already has stock at this source',
  // Phase 3
  uq_search_settings_website_id: 'The website already has search settings',
  uq_search_documents_store_locale_entity: 'Search document already exists',
  // Phase 4
  uq_page_translations_page_id_locale_code:
    'The page already has content for this locale',
  uq_post_translations_post_id_locale_code:
    'The post already has content for this locale',
  uq_tags_code: 'A tag with this code already exists',
  uq_tag_translations_tag_id_locale_code:
    'The tag already has a name for this locale',
  uq_post_tags_post_id_tag_id: 'The post already has this tag',
  uq_blocks_identifier_global:
    'A global block with this identifier already exists',
  uq_blocks_identifier_store_id:
    'The store already has a block with this identifier',
  uq_block_translations_block_id_locale_code:
    'The block already has content for this locale',
  uq_block_placements_block_target_region:
    'The block is already placed in this region',
  uq_menus_code_global: 'A global menu with this code already exists',
  uq_menus_code_store_id: 'The store already has a menu with this code',
  uq_menu_item_translations_item_id_locale_code:
    'The menu item already has a label for this locale',
  uq_banner_translations_banner_id_locale_code:
    'The banner already has content for this locale',
  uq_sliders_code_global: 'A global slider with this code already exists',
  uq_sliders_code_store_id: 'The store already has a slider with this code',
  uq_slide_translations_slide_id_locale_code:
    'The slide already has content for this locale',
  uq_schedules_pending_target_action: 'This change is already scheduled',
  // Phase 5
  uq_customers_website_id_email:
    'An account with this e-mail already exists on this website',
  uq_customer_addresses_default_shipping:
    'The customer already has a default shipping address',
  uq_customer_addresses_default_billing:
    'The customer already has a default billing address',
  uq_customer_sessions_token_hash: 'Session token already exists',
  uq_campaigns_code: 'A campaign with this code already exists',
  uq_promotion_websites_promotion_id_website_id:
    'The promotion is already assigned to this website',
  uq_promotion_translations_promotion_id_locale_code:
    'The promotion already has a label for this locale',
  uq_coupons_code: 'A coupon with this code already exists',
  uq_promotion_usages_promotion_id_order_ref:
    'The promotion is already applied to this order',
  uq_loyalty_programs_website_id: 'The website already has a loyalty program',
  uq_loyalty_tiers_program_id_code:
    'The program already has a tier with this code',
  uq_loyalty_tiers_program_id_threshold_points:
    'The program already has a tier at this threshold',
  uq_loyalty_accounts_customer_id: 'The customer already has a loyalty account',
  uq_loyalty_transactions_order_once:
    'Points were already earned or redeemed for this order',
  uq_loyalty_allocations_debit_id_credit_id: 'Allocation already exists',
  // Phase 6
  uq_shipping_methods_website_id_code:
    'The website already has a shipping method with this code',
  uq_shipping_method_translations_method_id_locale_code:
    'The shipping method already has a name for this locale',
  uq_carts_token_hash: 'Cart token already exists',
  uq_carts_active_customer:
    'The customer already has an active cart in this store',
  uq_cart_items_cart_id_variant_id_signature: 'The item is already in the cart',
  uq_document_sequences_scope: 'Sequence already exists',
  uq_orders_number: 'An order with this number already exists',
  uq_orders_cart_id: 'An order was already placed from this cart',
  uq_orders_store_id_idempotency_key:
    'An order was already placed with this Idempotency-Key',
  uq_order_addresses_order_id_type: 'The order already has this address',
  uq_store_payment_methods_store_id_code:
    'The store already offers a payment method with this code',
  uq_store_payment_method_translations_method_id_locale_code:
    'The payment method already has a title for this locale',
  uq_payments_open_per_order: 'The order already has a payment in progress',
  uq_payment_webhook_events_provider_event: 'Webhook event already received',
  uq_refunds_order_id_idempotency_key:
    'A refund was already made with this Idempotency-Key',
  uq_shipments_number: 'A shipment with this number already exists',
  uq_shipment_items_shipment_id_order_item_id:
    'The item is already in this shipment',
  uq_invoices_number: 'An invoice with this number already exists',
  uq_invoices_order_id: 'The order already has an invoice',
  uq_credit_memos_number: 'A credit memo with this number already exists',
  uq_credit_memos_refund_id: 'The refund already has a credit memo',
  // Phase 7
  uq_audit_logs_event_id: 'The event is already in the audit log',
  uq_jobs_code: 'A job with this code already exists',
  uq_job_executions_open_per_job:
    'The job is already queued or running; wait for it to finish',
  uq_webhook_deliveries_webhook_id_event_id:
    'The event was already delivered to this webhook',
};

/** Extracts the violated constraint name from a Prisma 7 known-request error's `meta`. */
export function constraintFromMeta(meta: unknown): string | undefined {
  const m = meta as
    | {
        constraint?: unknown;
        target?: unknown;
        driverAdapterError?: {
          cause?: { constraint?: { index?: string } | string };
        };
      }
    | undefined;
  const cause = m?.driverAdapterError?.cause?.constraint;
  if (typeof cause === 'string') return cause;
  if (cause?.index) return cause.index;
  if (typeof m?.constraint === 'string') return m.constraint;
  return undefined;
}
