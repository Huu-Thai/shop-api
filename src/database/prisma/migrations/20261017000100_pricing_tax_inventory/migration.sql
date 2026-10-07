-- 0004 — Phase 2: customer groups, multi-country tax, price books + price index, exchange rates,
-- inventory sources, stock, reservations and the stock ledger (PLAN.md §3.2, §9).
-- CreateEnum
CREATE TYPE "TaxClassType" AS ENUM ('PRODUCT', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MovementReason" AS ENUM ('RECEIPT', 'ADJUSTMENT', 'SALE', 'RETURN', 'CORRECTION');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "tax_class_id" UUID;

-- CreateTable
CREATE TABLE "tax_classes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" "TaxClassType" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_tax_classes" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "tax_class_id" UUID,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_customer_groups" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_zones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "rounding" VARCHAR(8) NOT NULL DEFAULT 'LINE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_tax_zones" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_zone_regions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "zone_id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(16),
    "postcode_pattern" VARCHAR(32),

    CONSTRAINT "pk_tax_zone_regions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "zone_id" UUID NOT NULL,
    "product_tax_class_id" UUID NOT NULL,
    "customer_tax_class_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "rate" DECIMAL(7,4) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_compound" BOOLEAN NOT NULL DEFAULT false,
    "valid_from" DATE NOT NULL DEFAULT '1970-01-01'::date,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_tax_rates" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_books" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "website_id" UUID,
    "store_id" UUID,
    "customer_group_id" UUID,
    "includes_tax" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "valid_from" TIMESTAMPTZ(3),
    "valid_to" TIMESTAMPTZ(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_price_books" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_book_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "price_book_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "min_qty" INTEGER NOT NULL DEFAULT 1,
    "amount" BIGINT NOT NULL,
    "compare_at_amount" BIGINT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_price_book_entries" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_index" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "variant_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "customer_group_id" UUID NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "min_qty" INTEGER NOT NULL DEFAULT 1,
    "net_amount" BIGINT NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "compare_at_net" BIGINT,
    "compare_at_gross" BIGINT,
    "tax_rate" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "price_book_id" UUID NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_price_index" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "base_currency_code" CHAR(3) NOT NULL,
    "quote_currency_code" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_exchange_rates" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_inventory_sources" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_inventory_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "website_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_website_inventory_sources" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "safety_stock" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_inventories" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "variant_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "group_id" UUID NOT NULL,
    "reference_type" VARCHAR(32) NOT NULL,
    "reference_id" VARCHAR(64) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_inventory_reservations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "quantity_after" INTEGER NOT NULL,
    "reason" "MovementReason" NOT NULL,
    "reference" VARCHAR(128),
    "note" VARCHAR(500),
    "actor_label" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_inventory_movements" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_tax_classes_code" ON "tax_classes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_customer_groups_code" ON "customer_groups"("code");

-- CreateIndex
CREATE INDEX "ix_customer_groups_tax_class_id" ON "customer_groups"("tax_class_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_tax_zones_code" ON "tax_zones"("code");

-- CreateIndex
CREATE INDEX "ix_tax_zone_regions_zone_id" ON "tax_zone_regions"("zone_id");

-- CreateIndex
CREATE INDEX "ix_tax_zone_regions_country_code_region_code" ON "tax_zone_regions"("country_code", "region_code");

-- CreateIndex
CREATE INDEX "ix_tax_rates_zone_id_product_tax_class_id" ON "tax_rates"("zone_id", "product_tax_class_id");

-- CreateIndex
CREATE INDEX "ix_tax_rates_product_tax_class_id" ON "tax_rates"("product_tax_class_id");

-- CreateIndex
CREATE INDEX "ix_tax_rates_customer_tax_class_id" ON "tax_rates"("customer_tax_class_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_price_books_code" ON "price_books"("code");

-- CreateIndex
CREATE INDEX "ix_price_books_currency_code" ON "price_books"("currency_code");

-- CreateIndex
CREATE INDEX "ix_price_books_website_id" ON "price_books"("website_id");

-- CreateIndex
CREATE INDEX "ix_price_books_store_id" ON "price_books"("store_id");

-- CreateIndex
CREATE INDEX "ix_price_books_customer_group_id" ON "price_books"("customer_group_id");

-- CreateIndex
CREATE INDEX "ix_price_book_entries_variant_id" ON "price_book_entries"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_price_book_entries_price_book_id_variant_id_min_qty" ON "price_book_entries"("price_book_id", "variant_id", "min_qty");

-- CreateIndex
CREATE INDEX "ix_price_index_store_id_customer_group_id_currency_code" ON "price_index"("store_id", "customer_group_id", "currency_code");

-- CreateIndex
CREATE INDEX "ix_price_index_customer_group_id" ON "price_index"("customer_group_id");

-- CreateIndex
CREATE INDEX "ix_price_index_currency_code" ON "price_index"("currency_code");

-- CreateIndex
CREATE INDEX "ix_price_index_price_book_id" ON "price_index"("price_book_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_price_index_variant_store_group_currency_qty" ON "price_index"("variant_id", "store_id", "customer_group_id", "currency_code", "min_qty");

-- CreateIndex
CREATE INDEX "ix_exchange_rates_quote_currency_code" ON "exchange_rates"("quote_currency_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_exchange_rates_base_quote_valid_from" ON "exchange_rates"("base_currency_code", "quote_currency_code", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_sources_code" ON "inventory_sources"("code");

-- CreateIndex
CREATE INDEX "ix_website_inventory_sources_source_id" ON "website_inventory_sources"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_website_inventory_sources_website_id_source_id" ON "website_inventory_sources"("website_id", "source_id");

-- CreateIndex
CREATE INDEX "ix_inventories_variant_id" ON "inventories"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventories_source_id_variant_id" ON "inventories"("source_id", "variant_id");

-- CreateIndex
CREATE INDEX "ix_inventory_reservations_variant_id" ON "inventory_reservations"("variant_id");

-- CreateIndex
CREATE INDEX "ix_inventory_reservations_source_id" ON "inventory_reservations"("source_id");

-- CreateIndex
CREATE INDEX "ix_inventory_reservations_group_id" ON "inventory_reservations"("group_id");

-- CreateIndex
CREATE INDEX "ix_inventory_reservations_reference" ON "inventory_reservations"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "ix_inventory_reservations_active_expires_at" ON "inventory_reservations"("expires_at") WHERE (status = 'ACTIVE'::"ReservationStatus");

-- CreateIndex
CREATE INDEX "ix_inventory_movements_source_id_variant_id_created_at" ON "inventory_movements"("source_id", "variant_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_inventory_movements_variant_id" ON "inventory_movements"("variant_id");

-- CreateIndex
CREATE INDEX "ix_products_tax_class_id" ON "products"("tax_class_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "fk_products_tax_class_id" FOREIGN KEY ("tax_class_id") REFERENCES "tax_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_groups" ADD CONSTRAINT "fk_customer_groups_tax_class_id" FOREIGN KEY ("tax_class_id") REFERENCES "tax_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_zone_regions" ADD CONSTRAINT "fk_tax_zone_regions_zone_id" FOREIGN KEY ("zone_id") REFERENCES "tax_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "fk_tax_rates_zone_id" FOREIGN KEY ("zone_id") REFERENCES "tax_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "fk_tax_rates_product_tax_class_id" FOREIGN KEY ("product_tax_class_id") REFERENCES "tax_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "fk_tax_rates_customer_tax_class_id" FOREIGN KEY ("customer_tax_class_id") REFERENCES "tax_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_books" ADD CONSTRAINT "fk_price_books_currency_code" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_books" ADD CONSTRAINT "fk_price_books_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_books" ADD CONSTRAINT "fk_price_books_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_books" ADD CONSTRAINT "fk_price_books_customer_group_id" FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_entries" ADD CONSTRAINT "fk_price_book_entries_price_book_id" FOREIGN KEY ("price_book_id") REFERENCES "price_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_entries" ADD CONSTRAINT "fk_price_book_entries_variant_id" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_index" ADD CONSTRAINT "fk_price_index_variant_id" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_index" ADD CONSTRAINT "fk_price_index_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_index" ADD CONSTRAINT "fk_price_index_customer_group_id" FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_index" ADD CONSTRAINT "fk_price_index_currency_code" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_index" ADD CONSTRAINT "fk_price_index_price_book_id" FOREIGN KEY ("price_book_id") REFERENCES "price_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "fk_exchange_rates_base_currency_code" FOREIGN KEY ("base_currency_code") REFERENCES "currencies"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "fk_exchange_rates_quote_currency_code" FOREIGN KEY ("quote_currency_code") REFERENCES "currencies"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_inventory_sources" ADD CONSTRAINT "fk_website_inventory_sources_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_inventory_sources" ADD CONSTRAINT "fk_website_inventory_sources_source_id" FOREIGN KEY ("source_id") REFERENCES "inventory_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventories" ADD CONSTRAINT "fk_inventories_source_id" FOREIGN KEY ("source_id") REFERENCES "inventory_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventories" ADD CONSTRAINT "fk_inventories_variant_id" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "fk_inventory_reservations_variant_id" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "fk_inventory_reservations_source_id" FOREIGN KEY ("source_id") REFERENCES "inventory_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "fk_inventory_movements_source_id" FOREIGN KEY ("source_id") REFERENCES "inventory_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "fk_inventory_movements_variant_id" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity rules ───
ALTER TABLE "tax_zones" ADD CONSTRAINT "ck_tax_zones_rounding" CHECK ("rounding" IN ('LINE', 'TOTAL'));
ALTER TABLE "tax_zone_regions" ADD CONSTRAINT "ck_tax_zone_regions_country_code" CHECK ("country_code" ~ '^[A-Z]{2}$');
ALTER TABLE "tax_rates" ADD CONSTRAINT "ck_tax_rates_rate" CHECK ("rate" >= 0 AND "rate" <= 100),
                        ADD CONSTRAINT "ck_tax_rates_validity" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");
ALTER TABLE "price_books" ADD CONSTRAINT "ck_price_books_validity" CHECK ("valid_to" IS NULL OR "valid_from" IS NULL OR "valid_to" > "valid_from"),
                          ADD CONSTRAINT "ck_price_books_scope" CHECK ("store_id" IS NULL OR "website_id" IS NULL);
ALTER TABLE "price_book_entries" ADD CONSTRAINT "ck_price_book_entries_amount" CHECK ("amount" >= 0 AND ("compare_at_amount" IS NULL OR "compare_at_amount" >= 0)),
                                 ADD CONSTRAINT "ck_price_book_entries_min_qty" CHECK ("min_qty" >= 1);
ALTER TABLE "exchange_rates" ADD CONSTRAINT "ck_exchange_rates_rate" CHECK ("rate" > 0),
                             ADD CONSTRAINT "ck_exchange_rates_pair" CHECK ("base_currency_code" <> "quote_currency_code");
ALTER TABLE "inventory_sources" ADD CONSTRAINT "ck_inventory_sources_country_code" CHECK ("country_code" ~ '^[A-Z]{2}$');
-- The oversell guard: reservations can never exceed physical stock.
ALTER TABLE "inventories" ADD CONSTRAINT "ck_inventories_quantities"
  CHECK ("quantity" >= 0 AND "reserved" >= 0 AND "safety_stock" >= 0 AND "reserved" <= "quantity");
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "ck_inventory_reservations_quantity" CHECK ("quantity" > 0);
ALTER TABLE "inventory_movements" ADD CONSTRAINT "ck_inventory_movements_quantity_after" CHECK ("quantity_after" >= 0);

-- ─── Reference data ───
INSERT INTO "tax_classes" ("code", "name", "type", "updated_at") VALUES
  ('standard', 'Standard rate', 'PRODUCT', now()),
  ('reduced', 'Reduced rate', 'PRODUCT', now()),
  ('zero', 'Zero rate / exempt', 'PRODUCT', now()),
  ('retail', 'Retail customer', 'CUSTOMER', now()),
  ('business', 'Business customer', 'CUSTOMER', now());

INSERT INTO "customer_groups" ("code", "name", "tax_class_id", "is_system", "updated_at")
SELECT g.code, g.name, c.id, g.is_system, now()
  FROM (VALUES ('guest', 'Not logged in', 'retail', true),
               ('general', 'General', 'retail', true),
               ('wholesale', 'Wholesale', 'business', false)) AS g(code, name, class, is_system)
  JOIN "tax_classes" c ON c.code = g.class;
