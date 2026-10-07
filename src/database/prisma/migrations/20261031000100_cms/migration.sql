-- 0006 — Phase 4: CMS (pages, posts, tags, blocks + placements), navigation menus, merchandising
-- (banners, sliders) and the publish/unpublish scheduler (PLAN.md §9 & §14 Phase 4).
--
-- Content is visible when status is PUBLISHED/SCHEDULED, published_at <= now() and unpublished_at is
-- unset or later; the scheduler only moves the status forward, so storefront reads are correct even
-- while it lags. Slugs are unique per scope through url_rewrites (CMS_PAGE "/slug", CMS_POST "/blog/slug").

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('PAGE', 'POST', 'BLOCK', 'BANNER', 'SLIDER');

-- CreateEnum
CREATE TYPE "ScheduleAction" AS ENUM ('PUBLISH', 'UNPUBLISH');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BlockTargetType" AS ENUM ('PAGE', 'POST', 'CATEGORY', 'PRODUCT');

-- CreateEnum
CREATE TYPE "MenuLinkType" AS ENUM ('URL', 'PAGE', 'POST', 'CATEGORY', 'PRODUCT');

-- AlterEnum

ALTER TYPE "UrlTargetType" ADD VALUE 'CMS_PAGE';
ALTER TYPE "UrlTargetType" ADD VALUE 'CMS_POST';

-- CreateTable
CREATE TABLE "pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "layout" VARCHAR(64) NOT NULL DEFAULT 'default',
    "published_at" TIMESTAMPTZ(3),
    "unpublished_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_pages" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "page_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "meta_title" VARCHAR(255),
    "meta_description" VARCHAR(512),

    CONSTRAINT "pk_page_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "unpublished_at" TIMESTAMPTZ(3),
    "author_id" UUID,
    "featured_image_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_posts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "post_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "excerpt" VARCHAR(1000),
    "content" TEXT NOT NULL DEFAULT '',
    "meta_title" VARCHAR(255),
    "meta_description" VARCHAR(512),

    CONSTRAINT "pk_post_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_tags" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tag_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "pk_tag_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "post_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "pk_post_tags" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identifier" VARCHAR(64) NOT NULL,
    "store_id" UUID,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "unpublished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_blocks" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "block_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "block_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "title" VARCHAR(255),
    "content" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "pk_block_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "block_placements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "block_id" UUID NOT NULL,
    "target_type" "BlockTargetType" NOT NULL,
    "target_id" UUID NOT NULL,
    "region" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_block_placements" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menus" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "store_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_menus" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "menu_id" UUID NOT NULL,
    "parent_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "link_type" "MenuLinkType" NOT NULL,
    "target_id" UUID,
    "url" VARCHAR(512),
    "open_in_new_tab" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pk_menu_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "item_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "label" VARCHAR(255) NOT NULL,

    CONSTRAINT "pk_menu_item_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banners" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "placement" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "store_id" UUID,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "unpublished_at" TIMESTAMPTZ(3),
    "position" INTEGER NOT NULL DEFAULT 0,
    "link_url" VARCHAR(512),
    "image_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_banners" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banner_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "banner_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "title" VARCHAR(255),
    "subtitle" VARCHAR(500),
    "cta_label" VARCHAR(100),
    "image_id" UUID,

    CONSTRAINT "pk_banner_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sliders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "store_id" UUID,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "unpublished_at" TIMESTAMPTZ(3),
    "autoplay_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_sliders" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slider_id" UUID NOT NULL,
    "image_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "link_url" VARCHAR(512),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pk_slides" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slide_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slide_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "title" VARCHAR(255),
    "caption" VARCHAR(1000),
    "cta_label" VARCHAR(100),

    CONSTRAINT "pk_slide_translations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "target_type" "ContentType" NOT NULL,
    "target_id" UUID NOT NULL,
    "action" "ScheduleAction" NOT NULL,
    "run_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "executed_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_schedules" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_pages_store_id" ON "pages"("store_id");

-- CreateIndex
CREATE INDEX "ix_pages_created_by_id" ON "pages"("created_by_id");

-- CreateIndex
CREATE INDEX "ix_pages_status_published_at" ON "pages"("status", "published_at");

-- CreateIndex
CREATE INDEX "ix_page_translations_locale_code_slug" ON "page_translations"("locale_code", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "uq_page_translations_page_id_locale_code" ON "page_translations"("page_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_posts_store_id" ON "posts"("store_id");

-- CreateIndex
CREATE INDEX "ix_posts_author_id" ON "posts"("author_id");

-- CreateIndex
CREATE INDEX "ix_posts_featured_image_id" ON "posts"("featured_image_id");

-- CreateIndex
CREATE INDEX "ix_posts_status_published_at" ON "posts"("status", "published_at");

-- CreateIndex
CREATE INDEX "ix_post_translations_locale_code_slug" ON "post_translations"("locale_code", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "uq_post_translations_post_id_locale_code" ON "post_translations"("post_id", "locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_tags_code" ON "tags"("code");

-- CreateIndex
CREATE INDEX "ix_tag_translations_locale_code" ON "tag_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_tag_translations_tag_id_locale_code" ON "tag_translations"("tag_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_post_tags_tag_id" ON "post_tags"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_post_tags_post_id_tag_id" ON "post_tags"("post_id", "tag_id");

-- CreateIndex
CREATE INDEX "ix_blocks_store_id" ON "blocks"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_blocks_identifier_global" ON "blocks"("identifier") WHERE (store_id IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "uq_blocks_identifier_store_id" ON "blocks"("identifier", "store_id") WHERE (store_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "ix_block_translations_locale_code" ON "block_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_block_translations_block_id_locale_code" ON "block_translations"("block_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_block_placements_target_region_position" ON "block_placements"("target_type", "target_id", "region", "position");

-- CreateIndex
CREATE UNIQUE INDEX "uq_block_placements_block_target_region" ON "block_placements"("block_id", "target_type", "target_id", "region");

-- CreateIndex
CREATE INDEX "ix_menus_store_id" ON "menus"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_menus_code_global" ON "menus"("code") WHERE (store_id IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "uq_menus_code_store_id" ON "menus"("code", "store_id") WHERE (store_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "ix_menu_items_menu_id_parent_id_position" ON "menu_items"("menu_id", "parent_id", "position");

-- CreateIndex
CREATE INDEX "ix_menu_items_parent_id" ON "menu_items"("parent_id");

-- CreateIndex
CREATE INDEX "ix_menu_item_translations_locale_code" ON "menu_item_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_menu_item_translations_item_id_locale_code" ON "menu_item_translations"("item_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_banners_placement_position" ON "banners"("placement", "position");

-- CreateIndex
CREATE INDEX "ix_banners_store_id" ON "banners"("store_id");

-- CreateIndex
CREATE INDEX "ix_banners_image_id" ON "banners"("image_id");

-- CreateIndex
CREATE INDEX "ix_banner_translations_locale_code" ON "banner_translations"("locale_code");

-- CreateIndex
CREATE INDEX "ix_banner_translations_image_id" ON "banner_translations"("image_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_banner_translations_banner_id_locale_code" ON "banner_translations"("banner_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_sliders_store_id" ON "sliders"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sliders_code_global" ON "sliders"("code") WHERE (store_id IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "uq_sliders_code_store_id" ON "sliders"("code", "store_id") WHERE (store_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "ix_slides_slider_id_position" ON "slides"("slider_id", "position");

-- CreateIndex
CREATE INDEX "ix_slides_image_id" ON "slides"("image_id");

-- CreateIndex
CREATE INDEX "ix_slide_translations_locale_code" ON "slide_translations"("locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_slide_translations_slide_id_locale_code" ON "slide_translations"("slide_id", "locale_code");

-- CreateIndex
CREATE INDEX "ix_schedules_pending_run_at" ON "schedules"("run_at") WHERE (status = 'PENDING'::"ScheduleStatus");

-- CreateIndex
CREATE INDEX "ix_schedules_target" ON "schedules"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "ix_schedules_created_by_id" ON "schedules"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_schedules_pending_target_action" ON "schedules"("target_type", "target_id", "action") WHERE (status = 'PENDING'::"ScheduleStatus");

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "fk_pages_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "fk_pages_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_translations" ADD CONSTRAINT "fk_page_translations_page_id" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_translations" ADD CONSTRAINT "fk_page_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_author_id" FOREIGN KEY ("author_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_featured_image_id" FOREIGN KEY ("featured_image_id") REFERENCES "images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_translations" ADD CONSTRAINT "fk_post_translations_post_id" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_translations" ADD CONSTRAINT "fk_post_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_translations" ADD CONSTRAINT "fk_tag_translations_tag_id" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_translations" ADD CONSTRAINT "fk_tag_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_tags" ADD CONSTRAINT "fk_post_tags_post_id" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_tags" ADD CONSTRAINT "fk_post_tags_tag_id" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "fk_blocks_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block_translations" ADD CONSTRAINT "fk_block_translations_block_id" FOREIGN KEY ("block_id") REFERENCES "blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block_translations" ADD CONSTRAINT "fk_block_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block_placements" ADD CONSTRAINT "fk_block_placements_block_id" FOREIGN KEY ("block_id") REFERENCES "blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menus" ADD CONSTRAINT "fk_menus_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "fk_menu_items_menu_id" FOREIGN KEY ("menu_id") REFERENCES "menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "fk_menu_items_parent_id" FOREIGN KEY ("parent_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_translations" ADD CONSTRAINT "fk_menu_item_translations_item_id" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_translations" ADD CONSTRAINT "fk_menu_item_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banners" ADD CONSTRAINT "fk_banners_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banners" ADD CONSTRAINT "fk_banners_image_id" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banner_translations" ADD CONSTRAINT "fk_banner_translations_banner_id" FOREIGN KEY ("banner_id") REFERENCES "banners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banner_translations" ADD CONSTRAINT "fk_banner_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banner_translations" ADD CONSTRAINT "fk_banner_translations_image_id" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sliders" ADD CONSTRAINT "fk_sliders_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slides" ADD CONSTRAINT "fk_slides_slider_id" FOREIGN KEY ("slider_id") REFERENCES "sliders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slides" ADD CONSTRAINT "fk_slides_image_id" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slide_translations" ADD CONSTRAINT "fk_slide_translations_slide_id" FOREIGN KEY ("slide_id") REFERENCES "slides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slide_translations" ADD CONSTRAINT "fk_slide_translations_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "fk_schedules_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Checks
ALTER TABLE "pages" ADD CONSTRAINT "ck_pages_publish_window" CHECK ("unpublished_at" IS NULL OR "published_at" IS NULL OR "unpublished_at" > "published_at");
ALTER TABLE "pages" ADD CONSTRAINT "ck_pages_layout" CHECK ("layout" ~ '^[a-z0-9][a-z0-9_-]*$');
ALTER TABLE "posts" ADD CONSTRAINT "ck_posts_publish_window" CHECK ("unpublished_at" IS NULL OR "published_at" IS NULL OR "unpublished_at" > "published_at");
ALTER TABLE "blocks" ADD CONSTRAINT "ck_blocks_publish_window" CHECK ("unpublished_at" IS NULL OR "published_at" IS NULL OR "unpublished_at" > "published_at");
ALTER TABLE "banners" ADD CONSTRAINT "ck_banners_publish_window" CHECK ("unpublished_at" IS NULL OR "published_at" IS NULL OR "unpublished_at" > "published_at");
ALTER TABLE "sliders" ADD CONSTRAINT "ck_sliders_publish_window" CHECK ("unpublished_at" IS NULL OR "published_at" IS NULL OR "unpublished_at" > "published_at");
ALTER TABLE "page_translations" ADD CONSTRAINT "ck_page_translations_slug" CHECK ("slug" ~ '^[a-z0-9]+(?:[-/][a-z0-9]+)*$');
ALTER TABLE "post_translations" ADD CONSTRAINT "ck_post_translations_slug" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');
ALTER TABLE "tags" ADD CONSTRAINT "ck_tags_code" CHECK ("code" ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$');
ALTER TABLE "blocks" ADD CONSTRAINT "ck_blocks_identifier" CHECK ("identifier" ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$');
ALTER TABLE "menus" ADD CONSTRAINT "ck_menus_code" CHECK ("code" ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$');
ALTER TABLE "sliders" ADD CONSTRAINT "ck_sliders_code" CHECK ("code" ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$');
ALTER TABLE "banners" ADD CONSTRAINT "ck_banners_placement" CHECK ("placement" ~ '^[a-z0-9]+(?:[-_.][a-z0-9]+)*$');
ALTER TABLE "block_placements" ADD CONSTRAINT "ck_block_placements_region" CHECK ("region" ~ '^[a-z0-9]+(?:[-_.][a-z0-9]+)*$');
ALTER TABLE "sliders" ADD CONSTRAINT "ck_sliders_autoplay_ms" CHECK ("autoplay_ms" IS NULL OR "autoplay_ms" BETWEEN 1000 AND 60000);
-- A URL item carries a URL and no target; every other link type carries a target and no URL.
ALTER TABLE "menu_items" ADD CONSTRAINT "ck_menu_items_link" CHECK (
  ("link_type" = 'URL' AND "url" IS NOT NULL AND "target_id" IS NULL) OR
  ("link_type" <> 'URL' AND "target_id" IS NOT NULL AND "url" IS NULL));
ALTER TABLE "menu_items" ADD CONSTRAINT "ck_menu_items_not_own_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "schedules" ADD CONSTRAINT "ck_schedules_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "schedules" ADD CONSTRAINT "ck_schedules_executed" CHECK (("status" = 'PENDING') = ("executed_at" IS NULL) OR "status" = 'CANCELLED');
