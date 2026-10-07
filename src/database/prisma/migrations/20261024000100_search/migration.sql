-- 0005 — Phase 3: search settings per website and the search_documents projection (PLAN.md §9.5).

-- Accent-insensitive matching ("Áo thun" = "ao thun"). unaccent() is STABLE; the wrapper pins the
-- dictionary so it can be used in indexed expressions and gives identical results at index and query time.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE OR REPLACE FUNCTION shop_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- Text search configuration per locale (stemming where Postgres has a dictionary, else 'simple').
CREATE OR REPLACE FUNCTION shop_search_config(locale text) RETURNS regconfig
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT CASE split_part(lower(locale), '-', 1)
    WHEN 'en' THEN 'english' WHEN 'de' THEN 'german' WHEN 'fr' THEN 'french' WHEN 'es' THEN 'spanish'
    WHEN 'it' THEN 'italian' WHEN 'nl' THEN 'dutch' WHEN 'pt' THEN 'portuguese' WHEN 'sv' THEN 'swedish'
    WHEN 'da' THEN 'danish' WHEN 'fi' THEN 'finnish' WHEN 'no' THEN 'norwegian' WHEN 'ru' THEN 'russian'
    WHEN 'tr' THEN 'turkish' WHEN 'id' THEN 'indonesian'
    ELSE 'simple' END::regconfig $$;

-- CreateEnum
CREATE TYPE "SearchProviderKind" AS ENUM ('POSTGRES', 'ELASTICSEARCH', 'OPENSEARCH', 'MEILISEARCH');

-- CreateEnum
CREATE TYPE "SearchBuildStatus" AS ENUM ('READY', 'BUILDING', 'FAILED');

-- CreateTable
CREATE TABLE "search_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "website_id" UUID NOT NULL,
    "provider" "SearchProviderKind" NOT NULL DEFAULT 'POSTGRES',
    "connection" TEXT,
    "index_prefix" VARCHAR(32) NOT NULL DEFAULT 'shop',
    "synonyms" JSONB NOT NULL DEFAULT '[]',
    "stopwords" JSONB NOT NULL DEFAULT '[]',
    "active_generation" INTEGER NOT NULL DEFAULT 0,
    "pending_provider" "SearchProviderKind",
    "pending_connection" TEXT,
    "pending_generation" INTEGER,
    "status" "SearchBuildStatus" NOT NULL DEFAULT 'READY',
    "last_error" TEXT,
    "build_started_at" TIMESTAMPTZ(3),
    "last_built_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_search_settings" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "locale_code" VARCHAR(16) NOT NULL,
    "entity_type" VARCHAR(16) NOT NULL DEFAULT 'PRODUCT',
    "entity_id" UUID NOT NULL,
    "document" JSONB NOT NULL,
    "search_vector" tsvector,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_search_documents" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_search_settings_website_id" ON "search_settings"("website_id");

-- CreateIndex
CREATE INDEX "ix_search_documents_search_vector" ON "search_documents" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "ix_search_documents_document" ON "search_documents" USING GIN ("document" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "ix_search_documents_entity" ON "search_documents"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "ix_search_documents_locale_code" ON "search_documents"("locale_code");

-- CreateIndex
CREATE INDEX "ix_search_documents_store_id_updated_at" ON "search_documents"("store_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_search_documents_store_locale_entity" ON "search_documents"("store_id", "locale_code", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "search_settings" ADD CONSTRAINT "fk_search_settings_website_id" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_documents" ADD CONSTRAINT "fk_search_documents_store_id" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_documents" ADD CONSTRAINT "fk_search_documents_locale_code" FOREIGN KEY ("locale_code") REFERENCES "locales"("code") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "search_documents" ADD CONSTRAINT "ck_search_documents_document_object" CHECK (jsonb_typeof("document") = 'object');
ALTER TABLE "search_settings" ADD CONSTRAINT "ck_search_settings_index_prefix" CHECK ("index_prefix" ~ '^[a-z][a-z0-9_]{0,31}$');
