-- 0003 — Phase 1: websites/stores, locales, currencies, attributes, categories, products (all types),
-- media and URL rewrites (PLAN.md §3.2–3.3). One global catalog; websites decide where things are
-- sold, stores add locale/currency/overrides. Locales and currencies are referenced by their codes.
-- CreateEnum
CREATE TYPE "AttributeType" AS ENUM ('TEXT', 'TEXTAREA', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'SELECT', 'MULTISELECT');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('SIMPLE', 'CONFIGURABLE', 'BUNDLE', 'VIRTUAL', 'GIFT_CARD');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProductVisibility" AS ENUM ('CATALOG_SEARCH', 'CATALOG', 'SEARCH', 'NOT_VISIBLE');

-- CreateEnum
CREATE TYPE "ProductRelationType" AS ENUM ('RELATED', 'UPSELL', 'CROSSSELL');

-- CreateEnum
CREATE TYPE "BundleInputType" AS ENUM ('SELECT', 'RADIO', 'CHECKBOX', 'MULTI');

-- CreateEnum
CREATE TYPE "ImageOwnerType" AS ENUM ('PRODUCT', 'VARIANT', 'CATEGORY');

-- CreateEnum
CREATE TYPE "ImageRole" AS ENUM ('BASE', 'SMALL', 'THUMBNAIL', 'GALLERY', 'SWATCH');

-- CreateEnum
CREATE TYPE "UrlTargetType" AS ENUM ('PRODUCT', 'CATEGORY', 'CUSTOM');

-- CreateTable
CREATE TABLE "locales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "fallback_code" VARCHAR(16),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_locales" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currencies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" CHAR(3) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "symbol" VARCHAR(8) NOT NULL,
    "minor_units" SMALLINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_currencies" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "websites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "base_currency_code" CHAR(3) NOT NULL,
    "default_store_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_websites" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "website_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "base_url" VARCHAR(255),
    "default_locale_code" VARCHAR(16) NOT NULL,
    "default_currency_code" CHAR(3) NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "prices_include_tax" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_stores" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_locales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_store_locales" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_currencies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_store_currencies" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attributes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "type" "AttributeType" NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "is_filterable" BOOLEAN NOT NULL DEFAULT false,
    "is_searchable" BOOLEAN NOT NULL DEFAULT false,
    "is_localizable" BOOLEAN NOT NULL DEFAULT false,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_attributes" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attribute_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "label" VARCHAR(255) NOT NULL,

    CONSTRAINT "pk_attribute_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attribute_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "swatch" VARCHAR(64),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_attribute_options" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_option_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "option_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "label" VARCHAR(255) NOT NULL,

    CONSTRAINT "pk_attribute_option_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_sets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_attribute_sets" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_set_attributes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attribute_set_id" UUID NOT NULL,
    "attribute_id" UUID NOT NULL,
    "group_name" VARCHAR(64) NOT NULL DEFAULT 'General',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_attribute_set_attributes" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_id" UUID,
    "path" TEXT NOT NULL,
    "level" SMALLINT NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "include_in_menu" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_categories" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "meta_title" VARCHAR(255),
    "meta_description" VARCHAR(512),

    CONSTRAINT "pk_category_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_websites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,

    CONSTRAINT "pk_category_websites" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sku" VARCHAR(64) NOT NULL,
    "type" "ProductType" NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ENABLED',
    "visibility" "ProductVisibility" NOT NULL DEFAULT 'CATALOG_SEARCH',
    "attribute_set_id" UUID NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "type_options" JSONB NOT NULL DEFAULT '{}',
    "weight_grams" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "pk_products" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "short_description" TEXT,
    "description" TEXT,
    "meta_title" VARCHAR(255),
    "meta_description" VARCHAR(512),
    "attributes" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "pk_product_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_websites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,

    CONSTRAINT "pk_product_websites" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_store_overrides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "status" "ProductStatus",
    "visibility" "ProductVisibility",
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_product_store_overrides" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "option_values" JSONB NOT NULL DEFAULT '{}',
    "option_signature" VARCHAR(512) NOT NULL DEFAULT '',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProductStatus" NOT NULL DEFAULT 'ENABLED',
    "weight_grams" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_product_variants" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configurable_attributes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "attribute_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_configurable_attributes" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_product_categories" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_relations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "related_product_id" UUID NOT NULL,
    "type" "ProductRelationType" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_product_relations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "input_type" "BundleInputType" NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_bundle_options" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_option_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "option_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "title" VARCHAR(255) NOT NULL,

    CONSTRAINT "pk_bundle_option_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_selections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "option_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "can_change_qty" BOOLEAN NOT NULL DEFAULT false,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_bundle_selections" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "images" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "storage_key" VARCHAR(512) NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "mime" VARCHAR(64) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "original_filename" VARCHAR(255),
    "renditions" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_images" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "image_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "alt" VARCHAR(255) NOT NULL,

    CONSTRAINT "pk_image_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "image_id" UUID NOT NULL,
    "owner_type" "ImageOwnerType" NOT NULL,
    "owner_id" UUID NOT NULL,
    "role" "ImageRole" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_image_links" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "url_rewrites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "request_path" VARCHAR(512) NOT NULL,
    "target_type" "UrlTargetType" NOT NULL,
    "target_id" UUID,
    "target_path" VARCHAR(512),
    "redirect_type" SMALLINT,
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_url_rewrites" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_locales_code" ON "locales"("code");

-- CreateIndex
CREATE INDEX "ix_locales_fallback_code" ON "locales"("fallback_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_currencies_code" ON "currencies"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_websites_code" ON "websites"("code");

-- CreateIndex
CREATE INDEX "ix_websites_base_currency_code" ON "websites"("base_currency_code");

-- CreateIndex
CREATE INDEX "ix_websites_default_store_id" ON "websites"("default_store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_stores_code" ON "stores"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_stores_base_url" ON "stores"("base_url");

-- CreateIndex
CREATE INDEX "ix_stores_website_id" ON "stores"("website_id");

-- CreateIndex
CREATE INDEX "ix_stores_default_locale_code" ON "stores"("default_locale_code");

-- CreateIndex
CREATE INDEX "ix_stores_default_currency_code" ON "stores"("default_currency_code");

-- CreateIndex
CREATE INDEX "ix_store_locales_locale_code" ON "store_locales"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_locales_store_id_locale_code" ON "store_locales"("store_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_store_currencies_currency_code" ON "store_currencies"("currency_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_currencies_store_id_currency_code" ON "store_currencies"("store_id", "currency_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_attributes_code" ON "attributes"("code");

-- CreateIndex
CREATE INDEX "ix_attribute_translations_locale_code" ON "attribute_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_attribute_translations_attribute_id_locale_code" ON "attribute_translations"("attribute_id", "locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_attribute_options_attribute_id_code" ON "attribute_options"("attribute_id", "code");

-- CreateIndex
CREATE INDEX "ix_attribute_option_translations_locale_code" ON "attribute_option_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_attribute_option_translations_option_id_locale_code" ON "attribute_option_translations"("option_id", "locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_attribute_sets_code" ON "attribute_sets"("code");

-- CreateIndex
CREATE INDEX "ix_attribute_set_attributes_attribute_id" ON "attribute_set_attributes"("attribute_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_attribute_set_attributes_attribute_set_id_attribute_id" ON "attribute_set_attributes"("attribute_set_id", "attribute_id");

-- CreateIndex
CREATE INDEX "ix_categories_parent_id_position" ON "categories"("parent_id", "position");

-- CreateIndex
CREATE INDEX "ix_category_translations_locale_code" ON "category_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_category_translations_category_id_locale_code" ON "category_translations"("category_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_category_websites_website_id" ON "category_websites"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_category_websites_category_id_website_id" ON "category_websites"("category_id", "website_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_products_sku" ON "products"("sku");

-- CreateIndex
CREATE INDEX "ix_products_attribute_set_id" ON "products"("attribute_set_id");

-- CreateIndex
CREATE INDEX "ix_products_type" ON "products"("type");

-- CreateIndex
CREATE INDEX "ix_products_deleted_at" ON "products"("deleted_at");

-- CreateIndex
CREATE INDEX "ix_products_attributes" ON "products" USING GIN ("attributes" jsonb_path_ops);

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_translations_product_id_locale_code" ON "product_translations"("product_id", "locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_translations_locale_code_slug" ON "product_translations"("locale_code", "slug");

-- CreateIndex
CREATE INDEX "ix_product_websites_website_id" ON "product_websites"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_websites_product_id_website_id" ON "product_websites"("product_id", "website_id");

-- CreateIndex
CREATE INDEX "ix_product_store_overrides_store_id" ON "product_store_overrides"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_store_overrides_product_id_store_id" ON "product_store_overrides"("product_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_variants_sku" ON "product_variants"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_variants_product_id_option_signature" ON "product_variants"("product_id", "option_signature");

-- CreateIndex
CREATE INDEX "ix_configurable_attributes_attribute_id" ON "configurable_attributes"("attribute_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_configurable_attributes_product_id_attribute_id" ON "configurable_attributes"("product_id", "attribute_id");

-- CreateIndex
CREATE INDEX "ix_product_categories_category_id_position" ON "product_categories"("category_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_categories_product_id_category_id" ON "product_categories"("product_id", "category_id");

-- CreateIndex
CREATE INDEX "ix_product_relations_related_product_id" ON "product_relations"("related_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_relations_product_id_related_product_id_type" ON "product_relations"("product_id", "related_product_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bundle_options_product_id_code" ON "bundle_options"("product_id", "code");

-- CreateIndex
CREATE INDEX "ix_bundle_option_translations_locale_code" ON "bundle_option_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bundle_option_translations_option_id_locale_code" ON "bundle_option_translations"("option_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_bundle_selections_variant_id" ON "bundle_selections"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bundle_selections_option_id_variant_id" ON "bundle_selections"("option_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_images_storage_key" ON "images"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_images_checksum" ON "images"("checksum");

-- CreateIndex
CREATE INDEX "ix_images_created_by_id" ON "images"("created_by_id");

-- CreateIndex
CREATE INDEX "ix_image_translations_locale_code" ON "image_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_image_translations_image_id_locale_code" ON "image_translations"("image_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_image_links_owner_type_owner_id_position" ON "image_links"("owner_type", "owner_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "uq_image_links_image_id_owner_type_owner_id_role" ON "image_links"("image_id", "owner_type", "owner_id", "role");

-- CreateIndex
CREATE INDEX "ix_url_rewrites_target_type_target_id" ON "url_rewrites"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "ix_url_rewrites_locale_code" ON "url_rewrites"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_url_rewrites_store_id_locale_code_request_path" ON "url_rewrites"("store_id", "locale_code", "request_path");

-- AddForeignKey
ALTER TABLE "locales" ADD CONSTRAINT "fk_locales_fallback_code" FOREIGN KEY ("fallback_code") REFERENCES "locales"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "fk_websites_base_currency_code" FOREIGN KEY ("base_currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "fk_websites_default_store_id" FOREIGN KEY ("default_store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "fk_stores_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "fk_stores_default_locale_code" FOREIGN KEY ("default_locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "fk_stores_default_currency_code" FOREIGN KEY ("default_currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_locales" ADD CONSTRAINT "fk_store_locales_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_locales" ADD CONSTRAINT "fk_store_locales_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_currencies" ADD CONSTRAINT "fk_store_currencies_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_currencies" ADD CONSTRAINT "fk_store_currencies_currency_code" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_translations" ADD CONSTRAINT "fk_attribute_translations_attribute_id" FOREIGN KEY ("attribute_id") REFERENCES "attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_translations" ADD CONSTRAINT "fk_attribute_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_options" ADD CONSTRAINT "fk_attribute_options_attribute_id" FOREIGN KEY ("attribute_id") REFERENCES "attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_option_translations" ADD CONSTRAINT "fk_attribute_option_translations_option_id" FOREIGN KEY ("option_id") REFERENCES "attribute_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_option_translations" ADD CONSTRAINT "fk_attribute_option_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_set_attributes" ADD CONSTRAINT "fk_attribute_set_attributes_attribute_set_id" FOREIGN KEY ("attribute_set_id") REFERENCES "attribute_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_set_attributes" ADD CONSTRAINT "fk_attribute_set_attributes_attribute_id" FOREIGN KEY ("attribute_id") REFERENCES "attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "fk_categories_parent_id" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_translations" ADD CONSTRAINT "fk_category_translations_category_id" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_translations" ADD CONSTRAINT "fk_category_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_websites" ADD CONSTRAINT "fk_category_websites_category_id" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_websites" ADD CONSTRAINT "fk_category_websites_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "fk_products_attribute_set_id" FOREIGN KEY ("attribute_set_id") REFERENCES "attribute_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_translations" ADD CONSTRAINT "fk_product_translations_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_translations" ADD CONSTRAINT "fk_product_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_websites" ADD CONSTRAINT "fk_product_websites_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_websites" ADD CONSTRAINT "fk_product_websites_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_store_overrides" ADD CONSTRAINT "fk_product_store_overrides_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_store_overrides" ADD CONSTRAINT "fk_product_store_overrides_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "fk_product_variants_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configurable_attributes" ADD CONSTRAINT "fk_configurable_attributes_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configurable_attributes" ADD CONSTRAINT "fk_configurable_attributes_attribute_id" FOREIGN KEY ("attribute_id") REFERENCES "attributes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "fk_product_categories_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "fk_product_categories_category_id" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_relations" ADD CONSTRAINT "fk_product_relations_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_relations" ADD CONSTRAINT "fk_product_relations_related_product_id" FOREIGN KEY ("related_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_options" ADD CONSTRAINT "fk_bundle_options_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_option_translations" ADD CONSTRAINT "fk_bundle_option_translations_option_id" FOREIGN KEY ("option_id") REFERENCES "bundle_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_option_translations" ADD CONSTRAINT "fk_bundle_option_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_selections" ADD CONSTRAINT "fk_bundle_selections_option_id" FOREIGN KEY ("option_id") REFERENCES "bundle_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_selections" ADD CONSTRAINT "fk_bundle_selections_variant_id" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "fk_images_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_translations" ADD CONSTRAINT "fk_image_translations_image_id" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_translations" ADD CONSTRAINT "fk_image_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_links" ADD CONSTRAINT "fk_image_links_image_id" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_rewrites" ADD CONSTRAINT "fk_url_rewrites_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_rewrites" ADD CONSTRAINT "fk_url_rewrites_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one default variant per product.
CREATE UNIQUE INDEX "uq_product_variants_default" ON "product_variants" ("product_id") WHERE "is_default";

-- ─── Integrity rules Prisma cannot express ───
ALTER TABLE "currencies" ADD CONSTRAINT "ck_currencies_code" CHECK ("code" ~ '^[A-Z]{3}$'),
                         ADD CONSTRAINT "ck_currencies_minor_units" CHECK ("minor_units" BETWEEN 0 AND 4);
ALTER TABLE "locales" ADD CONSTRAINT "ck_locales_code" CHECK ("code" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$'),
                      ADD CONSTRAINT "ck_locales_no_self_fallback" CHECK ("fallback_code" IS DISTINCT FROM "code");
ALTER TABLE "stores" ADD CONSTRAINT "ck_stores_country_code" CHECK ("country_code" ~ '^[A-Z]{2}$');
ALTER TABLE "categories" ADD CONSTRAINT "ck_categories_no_self_parent" CHECK ("parent_id" IS DISTINCT FROM "id");
ALTER TABLE "products" ADD CONSTRAINT "ck_products_weight" CHECK ("weight_grams" IS NULL OR "weight_grams" >= 0),
                       ADD CONSTRAINT "ck_products_attributes_object" CHECK (jsonb_typeof("attributes") = 'object');
ALTER TABLE "product_variants" ADD CONSTRAINT "ck_product_variants_weight" CHECK ("weight_grams" IS NULL OR "weight_grams" >= 0);
ALTER TABLE "product_relations" ADD CONSTRAINT "ck_product_relations_not_self" CHECK ("product_id" <> "related_product_id");
ALTER TABLE "bundle_selections" ADD CONSTRAINT "ck_bundle_selections_qty" CHECK ("qty" > 0);
ALTER TABLE "images" ADD CONSTRAINT "ck_images_dimensions" CHECK ("width" > 0 AND "height" > 0 AND "bytes" > 0);
ALTER TABLE "url_rewrites" ADD CONSTRAINT "ck_url_rewrites_redirect_type" CHECK ("redirect_type" IS NULL OR "redirect_type" IN (301, 302)),
                           ADD CONSTRAINT "ck_url_rewrites_target" CHECK (
                             ("target_type" = 'CUSTOM' AND "target_path" IS NOT NULL AND "redirect_type" IS NOT NULL)
                             OR ("target_type" <> 'CUSTOM' AND "target_id" IS NOT NULL));

-- ─── Reference data (admins activate what they sell in) ───
INSERT INTO "currencies" ("code", "name", "symbol", "minor_units", "is_active", "updated_at") VALUES
  ('USD', 'US Dollar', '$', 2, true, now()),
  ('EUR', 'Euro', '€', 2, false, now()),
  ('GBP', 'Pound Sterling', '£', 2, false, now()),
  ('VND', 'Vietnamese Dong', '₫', 0, false, now()),
  ('JPY', 'Japanese Yen', '¥', 0, false, now()),
  ('KRW', 'South Korean Won', '₩', 0, false, now()),
  ('CNY', 'Chinese Yuan', '¥', 2, false, now()),
  ('HKD', 'Hong Kong Dollar', 'HK$', 2, false, now()),
  ('TWD', 'New Taiwan Dollar', 'NT$', 2, false, now()),
  ('SGD', 'Singapore Dollar', 'S$', 2, false, now()),
  ('THB', 'Thai Baht', '฿', 2, false, now()),
  ('IDR', 'Indonesian Rupiah', 'Rp', 2, false, now()),
  ('MYR', 'Malaysian Ringgit', 'RM', 2, false, now()),
  ('PHP', 'Philippine Peso', '₱', 2, false, now()),
  ('INR', 'Indian Rupee', '₹', 2, false, now()),
  ('AUD', 'Australian Dollar', 'A$', 2, false, now()),
  ('NZD', 'New Zealand Dollar', 'NZ$', 2, false, now()),
  ('CAD', 'Canadian Dollar', 'C$', 2, false, now()),
  ('MXN', 'Mexican Peso', 'MX$', 2, false, now()),
  ('BRL', 'Brazilian Real', 'R$', 2, false, now()),
  ('CHF', 'Swiss Franc', 'CHF', 2, false, now()),
  ('SEK', 'Swedish Krona', 'kr', 2, false, now()),
  ('NOK', 'Norwegian Krone', 'kr', 2, false, now()),
  ('DKK', 'Danish Krone', 'kr', 2, false, now()),
  ('PLN', 'Polish Złoty', 'zł', 2, false, now()),
  ('CZK', 'Czech Koruna', 'Kč', 2, false, now()),
  ('AED', 'UAE Dirham', 'AED', 2, false, now()),
  ('SAR', 'Saudi Riyal', 'SAR', 2, false, now()),
  ('ZAR', 'South African Rand', 'R', 2, false, now()),
  ('KWD', 'Kuwaiti Dinar', 'KD', 3, false, now());

INSERT INTO "locales" ("code", "name", "is_active", "updated_at") VALUES ('en-US', 'English (United States)', true, now());
INSERT INTO "locales" ("code", "name", "is_active", "fallback_code", "updated_at") VALUES
  ('en-GB', 'English (United Kingdom)', false, 'en-US', now()),
  ('vi-VN', 'Tiếng Việt', false, 'en-US', now()),
  ('fr-FR', 'Français', false, 'en-US', now()),
  ('de-DE', 'Deutsch', false, 'en-US', now()),
  ('es-ES', 'Español', false, 'en-US', now()),
  ('it-IT', 'Italiano', false, 'en-US', now()),
  ('nl-NL', 'Nederlands', false, 'en-US', now()),
  ('pl-PL', 'Polski', false, 'en-US', now()),
  ('sv-SE', 'Svenska', false, 'en-US', now()),
  ('pt-BR', 'Português (Brasil)', false, 'en-US', now()),
  ('ja-JP', '日本語', false, 'en-US', now()),
  ('ko-KR', '한국어', false, 'en-US', now()),
  ('zh-CN', '简体中文', false, 'en-US', now()),
  ('zh-TW', '繁體中文', false, 'en-US', now()),
  ('th-TH', 'ไทย', false, 'en-US', now()),
  ('id-ID', 'Bahasa Indonesia', false, 'en-US', now()),
  ('ms-MY', 'Bahasa Melayu', false, 'en-US', now());

-- A default attribute set so products can be created immediately.
INSERT INTO "attribute_sets" ("code", "name", "updated_at") VALUES ('default', 'Default', now());
