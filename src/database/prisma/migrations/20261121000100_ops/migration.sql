-- 0009 — Phase 7: admin-defined jobs and their executions (imports, exports, reindexing; at most one
-- open run per job), outgoing webhooks with their deliveries (once per webhook and event), and the
-- audit log keyed by the after-event it records, so a redelivered event is logged once (PLAN.md §5).

-- CreateEnum
CREATE TYPE "JobExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "JobTrigger" AS ENUM ('SCHEDULE', 'MANUAL');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "event_id" UUID;

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "cron" VARCHAR(100),
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_jobs" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID,
    "type" VARCHAR(64) NOT NULL,
    "status" "JobExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "JobTrigger" NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "error" VARCHAR(2000),
    "input_key" VARCHAR(512),
    "output_key" VARCHAR(512),
    "output_name" VARCHAR(255),
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "actor_type" VARCHAR(16) NOT NULL,
    "actor_id" UUID,
    "actor_label" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "pk_job_executions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "events" VARCHAR(100)[] DEFAULT ARRAY[]::VARCHAR(100)[],
    "secret" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "disabled_reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_webhooks" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "webhook_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_name" VARCHAR(120) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response_status" INTEGER,
    "response_body" VARCHAR(1000),
    "error" VARCHAR(1000),
    "duration_ms" INTEGER,
    "next_attempt_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_webhook_deliveries" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_jobs_code" ON "jobs"("code");

-- CreateIndex
CREATE INDEX "ix_jobs_created_by_id" ON "jobs"("created_by_id");

-- CreateIndex
CREATE INDEX "ix_job_executions_job_id_created_at" ON "job_executions"("job_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_job_executions_status_created_at" ON "job_executions"("status", "created_at");

-- CreateIndex
CREATE INDEX "ix_job_executions_created_at" ON "job_executions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_job_executions_open_per_job" ON "job_executions"("job_id") WHERE (status = ANY (ARRAY['QUEUED'::"JobExecutionStatus", 'RUNNING'::"JobExecutionStatus"]));

-- CreateIndex
CREATE INDEX "ix_webhooks_created_by_id" ON "webhooks"("created_by_id");

-- CreateIndex
CREATE INDEX "ix_webhook_deliveries_webhook_id_created_at" ON "webhook_deliveries"("webhook_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_webhook_deliveries_status_next_attempt_at" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "ix_webhook_deliveries_created_at" ON "webhook_deliveries"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_webhook_deliveries_webhook_id_event_id" ON "webhook_deliveries"("webhook_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_audit_logs_event_id" ON "audit_logs"("event_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "fk_job_executions_job_id" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "fk_webhooks_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "fk_webhook_deliveries_webhook_id" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Checks
ALTER TABLE "jobs" ADD CONSTRAINT "ck_jobs_code" CHECK ("code" ~ '^[a-z0-9]+(?:[-_.][a-z0-9]+)*$');
ALTER TABLE "jobs" ADD CONSTRAINT "ck_jobs_params" CHECK (jsonb_typeof("params") = 'object');
ALTER TABLE "job_executions" ADD CONSTRAINT "ck_job_executions_progress" CHECK ("progress" BETWEEN 0 AND 100);
ALTER TABLE "job_executions" ADD CONSTRAINT "ck_job_executions_json" CHECK (
  jsonb_typeof("params") = 'object' AND jsonb_typeof("stats") = 'object' AND jsonb_typeof("errors") = 'array');
ALTER TABLE "job_executions" ADD CONSTRAINT "ck_job_executions_actor_type" CHECK ("actor_type" IN ('admin', 'api-key', 'system', 'customer'));
ALTER TABLE "job_executions" ADD CONSTRAINT "ck_job_executions_finished" CHECK (
  ("status" IN ('SUCCEEDED', 'FAILED', 'CANCELED')) = ("finished_at" IS NOT NULL));
ALTER TABLE "webhooks" ADD CONSTRAINT "ck_webhooks_url" CHECK ("url" ~ '^https?://');
ALTER TABLE "webhooks" ADD CONSTRAINT "ck_webhooks_events" CHECK (cardinality("events") > 0);
ALTER TABLE "webhooks" ADD CONSTRAINT "ck_webhooks_consecutive_failures" CHECK ("consecutive_failures" >= 0);
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "ck_webhook_deliveries_attempts" CHECK ("attempts" >= 0);
