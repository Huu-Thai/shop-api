-- 0007 — Phase 5: customer accounts (per website), addresses and storefront sessions; campaigns,
-- cart promotions, coupons and their usage; loyalty programs, tiers, accounts and the points ledger
-- (PLAN.md §3.2, §9 and §9.8).
--
-- Usage limits are enforced with conditional UPDATEs (times_used < usage_limit) in the redeeming
-- transaction; the CHECKs below are the last line of defence. The loyalty ledger is append-only;
-- credits keep `remaining`, debits record what they consumed in loyalty_allocations.

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PromotionUsageStatus" AS ENUM ('APPLIED', 'RELEASED');

-- CreateEnum
CREATE TYPE "LoyaltyTransactionType" AS ENUM ('EARN', 'REDEEM', 'EXPIRE', 'ADJUST', 'REVERSE');

-- AlterEnum

ALTER TYPE "ContentType" ADD VALUE 'CAMPAIGN';
ALTER TYPE "ContentType" ADD VALUE 'PROMOTION';

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "website_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(32),
    "customer_group_id" UUID NOT NULL,
    "locale_code" VARCHAR(16),
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "accepts_marketing" BOOLEAN NOT NULL DEFAULT false,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_customers" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
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
    "is_default_shipping" BOOLEAN NOT NULL DEFAULT false,
    "is_default_billing" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_customer_addresses" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "replaced_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "user_agent" VARCHAR(255),
    "ip" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_customer_sessions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" VARCHAR(2000),
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "unpublished_at" TIMESTAMPTZ(3),
    "budget_amount" BIGINT,
    "budget_currency_code" CHAR(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_campaigns" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "description" VARCHAR(2000),
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "unpublished_at" TIMESTAMPTZ(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stop_further" BOOLEAN NOT NULL DEFAULT false,
    "requires_coupon" BOOLEAN NOT NULL DEFAULT false,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "usage_limit" INTEGER,
    "uses_per_customer" INTEGER,
    "times_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_promotions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_websites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "promotion_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,

    CONSTRAINT "pk_promotion_websites" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "promotion_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "label" VARCHAR(255) NOT NULL,

    CONSTRAINT "pk_promotion_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "promotion_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "usage_limit" INTEGER,
    "uses_per_customer" INTEGER,
    "times_used" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "batch_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_coupons" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_usages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "promotion_id" UUID NOT NULL,
    "coupon_id" UUID,
    "customer_id" UUID,
    "order_ref" VARCHAR(64) NOT NULL,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "status" "PromotionUsageStatus" NOT NULL DEFAULT 'APPLIED',
    "released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_promotion_usages" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_programs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "website_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "spend_per_point" BIGINT NOT NULL,
    "point_value" BIGINT NOT NULL,
    "min_redeem_points" INTEGER NOT NULL DEFAULT 0,
    "max_redeem_percent" INTEGER NOT NULL DEFAULT 100,
    "expiry_days" INTEGER,
    "tier_window_days" INTEGER NOT NULL DEFAULT 365,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_loyalty_programs" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_tiers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "threshold_points" INTEGER NOT NULL,
    "multiplier_bp" INTEGER NOT NULL DEFAULT 10000,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_loyalty_tiers" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "lifetime_points" INTEGER NOT NULL DEFAULT 0,
    "tier_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_loyalty_accounts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "type" "LoyaltyTransactionType" NOT NULL,
    "points" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3),
    "order_ref" VARCHAR(64),
    "amount" BIGINT,
    "currency_code" CHAR(3),
    "note" VARCHAR(500),
    "actor_label" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_loyalty_transactions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "debit_id" UUID NOT NULL,
    "credit_id" UUID NOT NULL,
    "points" INTEGER NOT NULL,

    CONSTRAINT "pk_loyalty_allocations" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_customers_customer_group_id" ON "customers"("customer_group_id");

-- CreateIndex
CREATE INDEX "ix_customers_locale_code" ON "customers"("locale_code");

-- CreateIndex
CREATE INDEX "ix_customers_created_at" ON "customers"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_customers_website_id_email" ON "customers"("website_id", "email");

-- CreateIndex
CREATE INDEX "ix_customer_addresses_customer_id" ON "customer_addresses"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_customer_addresses_default_shipping" ON "customer_addresses"("customer_id") WHERE (is_default_shipping);

-- CreateIndex
CREATE UNIQUE INDEX "uq_customer_addresses_default_billing" ON "customer_addresses"("customer_id") WHERE (is_default_billing);

-- CreateIndex
CREATE UNIQUE INDEX "uq_customer_sessions_token_hash" ON "customer_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "ix_customer_sessions_customer_id" ON "customer_sessions"("customer_id");

-- CreateIndex
CREATE INDEX "ix_customer_sessions_family_id" ON "customer_sessions"("family_id");

-- CreateIndex
CREATE INDEX "ix_customer_sessions_replaced_by_id" ON "customer_sessions"("replaced_by_id");

-- CreateIndex
CREATE INDEX "ix_customer_sessions_expires_at" ON "customer_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_campaigns_code" ON "campaigns"("code");

-- CreateIndex
CREATE INDEX "ix_campaigns_budget_currency_code" ON "campaigns"("budget_currency_code");

-- CreateIndex
CREATE INDEX "ix_campaigns_status_published_at" ON "campaigns"("status", "published_at");

-- CreateIndex
CREATE INDEX "ix_promotions_campaign_id" ON "promotions"("campaign_id");

-- CreateIndex
CREATE INDEX "ix_promotions_status_published_at" ON "promotions"("status", "published_at");

-- CreateIndex
CREATE INDEX "ix_promotion_websites_website_id" ON "promotion_websites"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_promotion_websites_promotion_id_website_id" ON "promotion_websites"("promotion_id", "website_id");

-- CreateIndex
CREATE INDEX "ix_promotion_translations_locale_code" ON "promotion_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_promotion_translations_promotion_id_locale_code" ON "promotion_translations"("promotion_id", "locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_coupons_code" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "ix_coupons_promotion_id" ON "coupons"("promotion_id");

-- CreateIndex
CREATE INDEX "ix_coupons_batch_id" ON "coupons"("batch_id");

-- CreateIndex
CREATE INDEX "ix_promotion_usages_coupon_id" ON "promotion_usages"("coupon_id");

-- CreateIndex
CREATE INDEX "ix_promotion_usages_customer_id" ON "promotion_usages"("customer_id");

-- CreateIndex
CREATE INDEX "ix_promotion_usages_order_ref" ON "promotion_usages"("order_ref");

-- CreateIndex
CREATE UNIQUE INDEX "uq_promotion_usages_promotion_id_order_ref" ON "promotion_usages"("promotion_id", "order_ref");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loyalty_programs_website_id" ON "loyalty_programs"("website_id");

-- CreateIndex
CREATE INDEX "ix_loyalty_programs_currency_code" ON "loyalty_programs"("currency_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loyalty_tiers_program_id_code" ON "loyalty_tiers"("program_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loyalty_tiers_program_id_threshold_points" ON "loyalty_tiers"("program_id", "threshold_points");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loyalty_accounts_customer_id" ON "loyalty_accounts"("customer_id");

-- CreateIndex
CREATE INDEX "ix_loyalty_accounts_program_id" ON "loyalty_accounts"("program_id");

-- CreateIndex
CREATE INDEX "ix_loyalty_accounts_tier_id" ON "loyalty_accounts"("tier_id");

-- CreateIndex
CREATE INDEX "ix_loyalty_transactions_account_id_created_at" ON "loyalty_transactions"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_loyalty_transactions_expiring" ON "loyalty_transactions"("expires_at") WHERE (remaining > 0);

-- CreateIndex
CREATE INDEX "ix_loyalty_transactions_order_ref" ON "loyalty_transactions"("order_ref");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loyalty_transactions_order_once" ON "loyalty_transactions"("account_id", "type", "order_ref") WHERE (type IN ('EARN', 'REDEEM') AND order_ref IS NOT NULL);

-- CreateIndex
CREATE INDEX "ix_loyalty_allocations_credit_id" ON "loyalty_allocations"("credit_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loyalty_allocations_debit_id_credit_id" ON "loyalty_allocations"("debit_id", "credit_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "fk_customers_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "fk_customers_customer_group_id" FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "fk_customers_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "fk_customer_addresses_customer_id" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_sessions" ADD CONSTRAINT "fk_customer_sessions_customer_id" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_sessions" ADD CONSTRAINT "fk_customer_sessions_replaced_by_id" FOREIGN KEY ("replaced_by_id") REFERENCES "customer_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "fk_campaigns_budget_currency_code" FOREIGN KEY ("budget_currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "fk_promotions_campaign_id" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_websites" ADD CONSTRAINT "fk_promotion_websites_promotion_id" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_websites" ADD CONSTRAINT "fk_promotion_websites_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_translations" ADD CONSTRAINT "fk_promotion_translations_promotion_id" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_translations" ADD CONSTRAINT "fk_promotion_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "fk_coupons_promotion_id" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_usages" ADD CONSTRAINT "fk_promotion_usages_promotion_id" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_usages" ADD CONSTRAINT "fk_promotion_usages_coupon_id" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_usages" ADD CONSTRAINT "fk_promotion_usages_customer_id" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "fk_loyalty_programs_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "fk_loyalty_programs_currency_code" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_tiers" ADD CONSTRAINT "fk_loyalty_tiers_program_id" FOREIGN KEY ("program_id") REFERENCES "loyalty_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "fk_loyalty_accounts_program_id" FOREIGN KEY ("program_id") REFERENCES "loyalty_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "fk_loyalty_accounts_customer_id" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "fk_loyalty_accounts_tier_id" FOREIGN KEY ("tier_id") REFERENCES "loyalty_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "fk_loyalty_transactions_account_id" FOREIGN KEY ("account_id") REFERENCES "loyalty_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_allocations" ADD CONSTRAINT "fk_loyalty_allocations_debit_id" FOREIGN KEY ("debit_id") REFERENCES "loyalty_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_allocations" ADD CONSTRAINT "fk_loyalty_allocations_credit_id" FOREIGN KEY ("credit_id") REFERENCES "loyalty_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Checks
ALTER TABLE "customers" ADD CONSTRAINT "ck_customers_email" CHECK ("email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length("email") <= 254);
ALTER TABLE "customers" ADD CONSTRAINT "ck_customers_failed_logins" CHECK ("failed_logins" >= 0);
ALTER TABLE "customer_addresses" ADD CONSTRAINT "ck_customer_addresses_country_code" CHECK ("country_code" ~ '^[A-Z]{2}$');
ALTER TABLE "campaigns" ADD CONSTRAINT "ck_campaigns_code" CHECK ("code" ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$');
ALTER TABLE "campaigns" ADD CONSTRAINT "ck_campaigns_publish_window" CHECK ("unpublished_at" IS NULL OR "published_at" IS NULL OR "unpublished_at" > "published_at");
ALTER TABLE "campaigns" ADD CONSTRAINT "ck_campaigns_budget" CHECK (("budget_amount" IS NULL) = ("budget_currency_code" IS NULL) AND ("budget_amount" IS NULL OR "budget_amount" >= 0));
ALTER TABLE "promotions" ADD CONSTRAINT "ck_promotions_publish_window" CHECK ("unpublished_at" IS NULL OR "published_at" IS NULL OR "unpublished_at" > "published_at");
ALTER TABLE "promotions" ADD CONSTRAINT "ck_promotions_rules" CHECK (jsonb_typeof("conditions") = 'array' AND jsonb_typeof("actions") = 'array');
ALTER TABLE "promotions" ADD CONSTRAINT "ck_promotions_usage" CHECK ("times_used" >= 0 AND ("usage_limit" IS NULL OR ("usage_limit" > 0 AND "times_used" <= "usage_limit")) AND ("uses_per_customer" IS NULL OR "uses_per_customer" > 0));
ALTER TABLE "coupons" ADD CONSTRAINT "ck_coupons_code" CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$');
ALTER TABLE "coupons" ADD CONSTRAINT "ck_coupons_usage" CHECK ("times_used" >= 0 AND ("usage_limit" IS NULL OR ("usage_limit" > 0 AND "times_used" <= "usage_limit")) AND ("uses_per_customer" IS NULL OR "uses_per_customer" > 0));
ALTER TABLE "promotion_usages" ADD CONSTRAINT "ck_promotion_usages_discount" CHECK ("discount" >= 0);
ALTER TABLE "promotion_usages" ADD CONSTRAINT "ck_promotion_usages_released" CHECK (("status" = 'RELEASED') = ("released_at" IS NOT NULL));
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "ck_loyalty_programs_rates" CHECK ("spend_per_point" > 0 AND "point_value" > 0 AND "min_redeem_points" >= 0 AND "max_redeem_percent" BETWEEN 1 AND 100 AND ("expiry_days" IS NULL OR "expiry_days" > 0) AND "tier_window_days" > 0);
ALTER TABLE "loyalty_tiers" ADD CONSTRAINT "ck_loyalty_tiers_values" CHECK ("threshold_points" >= 0 AND "multiplier_bp" BETWEEN 0 AND 100000);
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "ck_loyalty_accounts_balance" CHECK ("balance" >= 0 AND "lifetime_points" >= 0);
-- Credits (EARN, positive ADJUST, REVERSE of a debit) are positive with 0 ≤ remaining ≤ points;
-- debits (REDEEM, EXPIRE, negative ADJUST, REVERSE of an earning) are negative with nothing remaining.
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "ck_loyalty_transactions_sign" CHECK (
  "points" <> 0 AND
  ("type" <> 'EARN' OR "points" > 0) AND
  ("type" NOT IN ('REDEEM', 'EXPIRE') OR "points" < 0) AND
  ("points" > 0 OR "remaining" = 0) AND
  ("remaining" >= 0 AND "remaining" <= GREATEST("points", 0)));
ALTER TABLE "loyalty_allocations" ADD CONSTRAINT "ck_loyalty_allocations_points" CHECK ("points" > 0);
