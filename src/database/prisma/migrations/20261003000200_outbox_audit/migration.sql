-- 0002 — Phase 0 transactional outbox and audit log (PLAN.md §4).

-- Every after-commit domain event is written here in the SAME transaction as the change that
-- produced it, dispatched right after commit, and re-dispatched by the relay if the process dies.
-- No foreign keys: payloads reference rows by id and must outlive them (e.g. delete events).
CREATE TABLE "outbox_events" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "event_name"   VARCHAR(120) NOT NULL,
    "payload"      JSONB        NOT NULL,
    "origin"       VARCHAR(16)  NOT NULL,
    "attempts"     INTEGER      NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "last_error"   TEXT,
    "failed_at"    TIMESTAMPTZ(3),
    "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "pk_outbox_events" PRIMARY KEY ("id")
);
CREATE INDEX "ix_outbox_events_origin_available_at" ON "outbox_events" ("origin", "available_at");
CREATE INDEX "ix_outbox_events_failed_at" ON "outbox_events" ("failed_at");

-- Who changed what, from after-events. No FKs: history outlives the rows it describes.
CREATE TABLE "audit_logs" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_type"  VARCHAR(16) NOT NULL,
    "actor_id"    UUID,
    "actor_label" VARCHAR(255) NOT NULL,
    "action"      VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id"   VARCHAR(64),
    "changes"     JSONB,
    "request_id"  VARCHAR(64),
    "ip"          VARCHAR(64),
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "pk_audit_logs" PRIMARY KEY ("id")
);
CREATE INDEX "ix_audit_logs_entity_type_entity_id_created_at" ON "audit_logs" ("entity_type", "entity_id", "created_at" DESC);
CREATE INDEX "ix_audit_logs_actor_id_created_at" ON "audit_logs" ("actor_id", "created_at" DESC);
CREATE INDEX "ix_audit_logs_created_at" ON "audit_logs" ("created_at");
