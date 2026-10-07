-- 0001 — Phase 0 foundation: extensions and back-office identity (PLAN.md §3.1, §7).

-- citext: case-insensitive e-mails and codes. gen_random_uuid() is built in since Postgres 13.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE "AdminUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE "admin_users" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "email"               CITEXT NOT NULL,
    "password_hash"       TEXT NOT NULL,
    "first_name"          VARCHAR(100),
    "last_name"           VARCHAR(100),
    "status"              "AdminUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_logins"       INTEGER NOT NULL DEFAULT 0,
    "locked_until"        TIMESTAMPTZ(3),
    "last_login_at"       TIMESTAMPTZ(3),
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ(3) NOT NULL,
    "deleted_at"          TIMESTAMPTZ(3),
    CONSTRAINT "pk_admin_users" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_admin_users_email" ON "admin_users" ("email");
CREATE INDEX "ix_admin_users_deleted_at" ON "admin_users" ("deleted_at");

CREATE TABLE "roles" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "code"        VARCHAR(64) NOT NULL,
    "name"        VARCHAR(100) NOT NULL,
    "description" TEXT,
    "is_system"   BOOLEAN NOT NULL DEFAULT false,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "pk_roles" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_roles_code" ON "roles" ("code");

CREATE TABLE "role_permissions" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "role_id"    UUID NOT NULL,
    "permission" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "pk_role_permissions" PRIMARY KEY ("id"),
    CONSTRAINT "fk_role_permissions_role_id" FOREIGN KEY ("role_id")
        REFERENCES "roles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Leading column role_id: also serves the FK.
CREATE UNIQUE INDEX "uq_role_permissions_role_id_permission" ON "role_permissions" ("role_id", "permission");

CREATE TABLE "admin_user_roles" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_user_id" UUID NOT NULL,
    "role_id"       UUID NOT NULL,
    "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "pk_admin_user_roles" PRIMARY KEY ("id"),
    CONSTRAINT "fk_admin_user_roles_admin_user_id" FOREIGN KEY ("admin_user_id")
        REFERENCES "admin_users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- RESTRICT: a role still assigned to users cannot be deleted by accident.
    CONSTRAINT "fk_admin_user_roles_role_id" FOREIGN KEY ("role_id")
        REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_admin_user_roles_admin_user_id_role_id" ON "admin_user_roles" ("admin_user_id", "role_id");
CREATE INDEX "ix_admin_user_roles_role_id" ON "admin_user_roles" ("role_id");

CREATE TABLE "refresh_tokens" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_user_id"  UUID NOT NULL,
    "family_id"      UUID NOT NULL,
    "token_hash"     CHAR(64) NOT NULL,
    "replaced_by_id" UUID,
    "expires_at"     TIMESTAMPTZ(3) NOT NULL,
    "revoked_at"     TIMESTAMPTZ(3),
    "user_agent"     VARCHAR(255),
    "ip"             VARCHAR(64),
    "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "pk_refresh_tokens" PRIMARY KEY ("id"),
    CONSTRAINT "fk_refresh_tokens_admin_user_id" FOREIGN KEY ("admin_user_id")
        REFERENCES "admin_users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_refresh_tokens_replaced_by_id" FOREIGN KEY ("replaced_by_id")
        REFERENCES "refresh_tokens" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash");
CREATE INDEX "ix_refresh_tokens_admin_user_id" ON "refresh_tokens" ("admin_user_id");
CREATE INDEX "ix_refresh_tokens_family_id" ON "refresh_tokens" ("family_id");
CREATE INDEX "ix_refresh_tokens_replaced_by_id" ON "refresh_tokens" ("replaced_by_id");
CREATE INDEX "ix_refresh_tokens_expires_at" ON "refresh_tokens" ("expires_at");

CREATE TABLE "api_keys" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "name"          VARCHAR(100) NOT NULL,
    "prefix"        VARCHAR(16) NOT NULL,
    "key_hash"      CHAR(64) NOT NULL,
    "permissions"   TEXT[],
    "created_by_id" UUID,
    "expires_at"    TIMESTAMPTZ(3),
    "last_used_at"  TIMESTAMPTZ(3),
    "revoked_at"    TIMESTAMPTZ(3),
    "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at"    TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "pk_api_keys" PRIMARY KEY ("id"),
    -- SET NULL: keys survive the deletion of the admin who created them.
    CONSTRAINT "fk_api_keys_created_by_id" FOREIGN KEY ("created_by_id")
        REFERENCES "admin_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_api_keys_prefix" ON "api_keys" ("prefix");
CREATE UNIQUE INDEX "uq_api_keys_key_hash" ON "api_keys" ("key_hash");
CREATE INDEX "ix_api_keys_created_by_id" ON "api_keys" ("created_by_id");

-- System roles. Permissions are strings from the code catalogue (src/modules/admin/permissions.ts).
INSERT INTO "roles" ("code", "name", "description", "is_system", "updated_at") VALUES
  ('super-admin', 'Super administrator', 'Every permission, including user and role management.', true, now());
INSERT INTO "role_permissions" ("role_id", "permission")
  SELECT "id", '*' FROM "roles" WHERE "code" = 'super-admin';
