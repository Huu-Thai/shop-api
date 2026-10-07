-- 0008 — Phase 6: shipping methods, carts, orders (snapshots, history), document sequences, payment
-- providers and store payment methods, payments with their transaction trail, webhook de-duplication,
-- refunds, shipments, invoices and credit memos (PLAN.md §3.2, §9.6).
--
-- Money is minor units (BIGINT). One open payment per order (partial unique index), webhooks once per
-- provider event, orders once per idempotency key and store.

-- CreateEnum
CREATE TYPE "ShippingRateType" AS ENUM ('FLAT', 'PER_ITEM');

-- CreateEnum
CREATE TYPE "CartStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'MERGED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PROCESSING', 'COMPLETE', 'CANCELED', 'CLOSED');

-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('UNPAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderFulfillmentStatus" AS ENUM ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'FULFILLED');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('SHIPPING', 'BILLING');

-- CreateEnum
CREATE TYPE "PaymentProviderCode" AS ENUM ('STRIPE', 'PAYPAL', 'VNPAY', 'MOMO', 'COD');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AWAITING_COLLECTION', 'CAPTURED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PaymentTransactionType" AS ENUM ('INITIATE', 'CAPTURE', 'VOID', 'REFUND', 'FAILURE');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('SHIPPED', 'DELIVERED');

-- CreateTable
CREATE TABLE "shipping_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "website_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "carrier" VARCHAR(64) NOT NULL,
    "rate_type" "ShippingRateType" NOT NULL DEFAULT 'FLAT',
    "amounts" JSONB NOT NULL,
    "free_over" JSONB,
    "country_codes" CHAR(2)[] DEFAULT ARRAY[]::CHAR(2)[],
    "tax_class_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_shipping_methods" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_method_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "method_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" VARCHAR(500),

    CONSTRAINT "pk_shipping_method_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "customer_id" UUID,
    "token_hash" CHAR(64),
    "status" "CartStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency_code" CHAR(3) NOT NULL,
    "email" CITEXT,
    "coupon_code" VARCHAR(64),
    "shipping_address" JSONB,
    "billing_address" JSONB,
    "shipping_method_id" UUID,
    "loyalty_points" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_carts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cart_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "signature" VARCHAR(512) NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_cart_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" VARCHAR(64) NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_document_sequences" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" VARCHAR(32) NOT NULL,
    "store_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "customer_id" UUID,
    "cart_id" UUID,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "access_token_hash" CHAR(64) NOT NULL,
    "email" CITEXT NOT NULL,
    "customer_group_code" VARCHAR(64) NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "payment_status" "OrderPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "fulfillment_status" "OrderFulfillmentStatus" NOT NULL DEFAULT 'UNFULFILLED',
    "prices_include_tax" BOOLEAN NOT NULL,
    "subtotal" BIGINT NOT NULL,
    "discount_total" BIGINT NOT NULL DEFAULT 0,
    "shipping_total" BIGINT NOT NULL DEFAULT 0,
    "tax_total" BIGINT NOT NULL DEFAULT 0,
    "grand_total" BIGINT NOT NULL,
    "loyalty_points" INTEGER NOT NULL DEFAULT 0,
    "loyalty_amount" BIGINT NOT NULL DEFAULT 0,
    "amount_due" BIGINT NOT NULL,
    "amount_paid" BIGINT NOT NULL DEFAULT 0,
    "amount_refunded" BIGINT NOT NULL DEFAULT 0,
    "coupon_code" VARCHAR(64),
    "shipping_method_code" VARCHAR(64),
    "shipping_method_name" VARCHAR(255),
    "discounts" JSONB NOT NULL DEFAULT '[]',
    "tax_breakdown" JSONB NOT NULL DEFAULT '[]',
    "placed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),
    "canceled_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_orders" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "parent_item_id" UUID,
    "product_id" UUID,
    "variant_id" UUID,
    "sku" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "row_total" BIGINT NOT NULL,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "tax_amount" BIGINT NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "options" JSONB NOT NULL DEFAULT '[]',
    "reservation_group_id" UUID,
    "qty_shipped" INTEGER NOT NULL DEFAULT 0,
    "qty_refunded" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_order_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_addresses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "type" "AddressType" NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "company" VARCHAR(255),
    "phone" VARCHAR(32),
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(16),
    "city" VARCHAR(100) NOT NULL,
    "postcode" VARCHAR(20),
    "line1" VARCHAR(255) NOT NULL,
    "line2" VARCHAR(255),

    CONSTRAINT "pk_order_addresses" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "actor_label" VARCHAR(255) NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_order_history" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" "PaymentProviderCode" NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "mode" "PaymentMode" NOT NULL DEFAULT 'TEST',
    "credentials" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_payment_providers" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "min_amounts" JSONB,
    "max_amounts" JSONB,
    "country_codes" CHAR(2)[] DEFAULT ARRAY[]::CHAR(2)[],
    "currency_codes" CHAR(3)[] DEFAULT ARRAY[]::CHAR(3)[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_payment_methods" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_payment_method_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "method_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" VARCHAR(500),

    CONSTRAINT "pk_store_payment_method_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "method_id" UUID,
    "provider_id" UUID NOT NULL,
    "provider_code" "PaymentProviderCode" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" BIGINT NOT NULL,
    "amount_refunded" BIGINT NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "provider_ref" VARCHAR(128),
    "capture_ref" VARCHAR(128),
    "action" JSONB,
    "failure_reason" VARCHAR(500),
    "captured_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_payments" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "type" "PaymentTransactionType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "provider_ref" VARCHAR(128),
    "source" VARCHAR(32) NOT NULL,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_payment_transactions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "provider_event_id" VARCHAR(128) NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL,
    "error" VARCHAR(1000),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_payment_webhook_events" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(500),
    "items" JSONB NOT NULL DEFAULT '[]',
    "restock" BOOLEAN NOT NULL DEFAULT false,
    "provider_ref" VARCHAR(128),
    "failure_reason" VARCHAR(500),
    "idempotency_key" VARCHAR(100),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_refunds" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "carrier" VARCHAR(64) NOT NULL,
    "tracking_number" VARCHAR(128),
    "tracking_url" VARCHAR(512),
    "status" "ShipmentStatus" NOT NULL DEFAULT 'SHIPPED',
    "shipped_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_shipments" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shipment_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "pk_shipment_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "subtotal" BIGINT NOT NULL,
    "discount_total" BIGINT NOT NULL,
    "shipping_total" BIGINT NOT NULL,
    "tax_total" BIGINT NOT NULL,
    "grand_total" BIGINT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_invoices" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_memos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_credit_memos" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_shipping_methods_tax_class_id" ON "shipping_methods"("tax_class_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipping_methods_website_id_code" ON "shipping_methods"("website_id", "code");

-- CreateIndex
CREATE INDEX "ix_shipping_method_translations_locale_code" ON "shipping_method_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipping_method_translations_method_id_locale_code" ON "shipping_method_translations"("method_id", "locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carts_token_hash" ON "carts"("token_hash");

-- CreateIndex
CREATE INDEX "ix_carts_customer_id" ON "carts"("customer_id");

-- CreateIndex
CREATE INDEX "ix_carts_shipping_method_id" ON "carts"("shipping_method_id");

-- CreateIndex
CREATE INDEX "ix_carts_updated_at" ON "carts"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carts_active_customer" ON "carts"("store_id", "customer_id") WHERE (status = 'ACTIVE'::"CartStatus" AND customer_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "ix_cart_items_variant_id" ON "cart_items"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cart_items_cart_id_variant_id_signature" ON "cart_items"("cart_id", "variant_id", "signature");

-- CreateIndex
CREATE UNIQUE INDEX "uq_document_sequences_scope" ON "document_sequences"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "uq_orders_number" ON "orders"("number");

-- CreateIndex
CREATE INDEX "ix_orders_website_id" ON "orders"("website_id");

-- CreateIndex
CREATE INDEX "ix_orders_customer_id_placed_at" ON "orders"("customer_id", "placed_at" DESC);

-- CreateIndex
CREATE INDEX "ix_orders_currency_code" ON "orders"("currency_code");

-- CreateIndex
CREATE INDEX "ix_orders_status_placed_at" ON "orders"("status", "placed_at");

-- CreateIndex
CREATE INDEX "ix_orders_email" ON "orders"("email");

-- CreateIndex
CREATE UNIQUE INDEX "uq_orders_store_id_idempotency_key" ON "orders"("store_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_orders_cart_id" ON "orders"("cart_id");

-- CreateIndex
CREATE INDEX "ix_order_items_order_id" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "ix_order_items_parent_item_id" ON "order_items"("parent_item_id");

-- CreateIndex
CREATE INDEX "ix_order_items_product_id" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "ix_order_items_variant_id" ON "order_items"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_addresses_order_id_type" ON "order_addresses"("order_id", "type");

-- CreateIndex
CREATE INDEX "ix_order_history_order_id_created_at" ON "order_history"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_store_payment_methods_provider_id" ON "store_payment_methods"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_payment_methods_store_id_code" ON "store_payment_methods"("store_id", "code");

-- CreateIndex
CREATE INDEX "ix_store_payment_method_translations_locale_code" ON "store_payment_method_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_payment_method_translations_method_id_locale_code" ON "store_payment_method_translations"("method_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_payments_method_id" ON "payments"("method_id");

-- CreateIndex
CREATE INDEX "ix_payments_provider_id_provider_ref" ON "payments"("provider_id", "provider_ref");

-- CreateIndex
CREATE INDEX "ix_payments_status_created_at" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payments_open_per_order" ON "payments"("order_id") WHERE (status = ANY (ARRAY['PENDING'::"PaymentStatus", 'AWAITING_COLLECTION'::"PaymentStatus", 'CAPTURED'::"PaymentStatus"]));

-- CreateIndex
CREATE INDEX "ix_payment_transactions_payment_id_created_at" ON "payment_transactions"("payment_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_payment_webhook_events_received_at" ON "payment_webhook_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payment_webhook_events_provider_event" ON "payment_webhook_events"("provider_id", "provider_event_id");

-- CreateIndex
CREATE INDEX "ix_refunds_payment_id" ON "refunds"("payment_id");

-- CreateIndex
CREATE INDEX "ix_refunds_created_by_id" ON "refunds"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_refunds_order_id_idempotency_key" ON "refunds"("order_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipments_number" ON "shipments"("number");

-- CreateIndex
CREATE INDEX "ix_shipments_order_id" ON "shipments"("order_id");

-- CreateIndex
CREATE INDEX "ix_shipment_items_order_item_id" ON "shipment_items"("order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipment_items_shipment_id_order_item_id" ON "shipment_items"("shipment_id", "order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invoices_order_id" ON "invoices"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invoices_number" ON "invoices"("number");

-- CreateIndex
CREATE UNIQUE INDEX "uq_credit_memos_refund_id" ON "credit_memos"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_credit_memos_number" ON "credit_memos"("number");

-- CreateIndex
CREATE INDEX "ix_credit_memos_order_id" ON "credit_memos"("order_id");

-- AddForeignKey
ALTER TABLE "shipping_methods" ADD CONSTRAINT "fk_shipping_methods_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_methods" ADD CONSTRAINT "fk_shipping_methods_tax_class_id" FOREIGN KEY ("tax_class_id") REFERENCES "tax_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_method_translations" ADD CONSTRAINT "fk_shipping_method_translations_method_id" FOREIGN KEY ("method_id") REFERENCES "shipping_methods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_method_translations" ADD CONSTRAINT "fk_shipping_method_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "fk_carts_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "fk_carts_customer_id" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "fk_carts_shipping_method_id" FOREIGN KEY ("shipping_method_id") REFERENCES "shipping_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "fk_cart_items_cart_id" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "fk_cart_items_variant_id" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_customer_id" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_currency_code" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "fk_order_items_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "fk_order_items_parent_item_id" FOREIGN KEY ("parent_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "fk_order_items_product_id" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "fk_order_items_variant_id" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_addresses" ADD CONSTRAINT "fk_order_addresses_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_history" ADD CONSTRAINT "fk_order_history_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_payment_methods" ADD CONSTRAINT "fk_store_payment_methods_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_payment_methods" ADD CONSTRAINT "fk_store_payment_methods_provider_id" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_payment_method_translations" ADD CONSTRAINT "fk_store_payment_method_translations_method_id" FOREIGN KEY ("method_id") REFERENCES "store_payment_methods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_payment_method_translations" ADD CONSTRAINT "fk_store_payment_method_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_method_id" FOREIGN KEY ("method_id") REFERENCES "store_payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_provider_id" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "fk_payment_transactions_payment_id" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "fk_payment_webhook_events_provider_id" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "fk_refunds_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "fk_refunds_payment_id" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "fk_refunds_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "fk_shipments_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "fk_shipment_items_shipment_id" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "fk_shipment_items_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "fk_invoices_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memos" ADD CONSTRAINT "fk_credit_memos_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memos" ADD CONSTRAINT "fk_credit_memos_refund_id" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Checks
ALTER TABLE "shipping_methods" ADD CONSTRAINT "ck_shipping_methods_code" CHECK ("code" ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$');
ALTER TABLE "shipping_methods" ADD CONSTRAINT "ck_shipping_methods_amounts" CHECK (jsonb_typeof("amounts") = 'object' AND ("free_over" IS NULL OR jsonb_typeof("free_over") = 'object'));
ALTER TABLE "carts" ADD CONSTRAINT "ck_carts_owner" CHECK ("customer_id" IS NOT NULL OR "token_hash" IS NOT NULL);
ALTER TABLE "carts" ADD CONSTRAINT "ck_carts_loyalty_points" CHECK ("loyalty_points" >= 0);
ALTER TABLE "cart_items" ADD CONSTRAINT "ck_cart_items_quantity" CHECK ("quantity" BETWEEN 1 AND 10000);
ALTER TABLE "orders" ADD CONSTRAINT "ck_orders_amounts" CHECK (
  "subtotal" >= 0 AND "discount_total" >= 0 AND "shipping_total" >= 0 AND "tax_total" >= 0 AND "grand_total" >= 0 AND
  "loyalty_amount" >= 0 AND "loyalty_points" >= 0 AND "amount_due" = "grand_total" - "loyalty_amount" AND "amount_due" >= 0 AND
  "amount_paid" >= 0 AND "amount_refunded" >= 0 AND "amount_refunded" <= "amount_paid");
ALTER TABLE "order_items" ADD CONSTRAINT "ck_order_items_quantities" CHECK (
  "quantity" > 0 AND "qty_shipped" BETWEEN 0 AND "quantity" AND "qty_refunded" BETWEEN 0 AND "quantity" AND
  "unit_price" >= 0 AND "row_total" >= 0 AND "discount" BETWEEN 0 AND "row_total" AND "tax_amount" >= 0);
ALTER TABLE "order_addresses" ADD CONSTRAINT "ck_order_addresses_country_code" CHECK ("country_code" ~ '^[A-Z]{2}$');
ALTER TABLE "store_payment_methods" ADD CONSTRAINT "ck_store_payment_methods_code" CHECK ("code" ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$');
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_amounts" CHECK ("amount" > 0 AND "amount_refunded" BETWEEN 0 AND "amount");
ALTER TABLE "refunds" ADD CONSTRAINT "ck_refunds_amount" CHECK ("amount" > 0 AND jsonb_typeof("items") = 'array');
ALTER TABLE "shipment_items" ADD CONSTRAINT "ck_shipment_items_quantity" CHECK ("quantity" > 0);
ALTER TABLE "credit_memos" ADD CONSTRAINT "ck_credit_memos_amounts" CHECK ("amount" > 0 AND "tax_amount" BETWEEN 0 AND "amount");
ALTER TABLE "document_sequences" ADD CONSTRAINT "ck_document_sequences_next_value" CHECK ("next_value" >= 1);
