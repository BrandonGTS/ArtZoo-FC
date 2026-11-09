ALTER TABLE "Account" ADD COLUMN "adminRoleRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Account" ADD CONSTRAINT "Account_adminRoleRevision_check" CHECK ("adminRoleRevision">=0);
CREATE TABLE "AdminManagementCommand" (
 "id" TEXT NOT NULL PRIMARY KEY,"actorId" TEXT NOT NULL,"idempotencyKey" TEXT NOT NULL,"requestFingerprint" TEXT NOT NULL,"kind" TEXT NOT NULL,"targetAccountId" TEXT,"result" JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AdminManagementCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AdminManagementCommand_kind_check" CHECK ("kind" IN ('ADMIN_ROLE_CHANGED','PUBLIC_ADMIN_QQ_CHANGED'))
);
CREATE UNIQUE INDEX "AdminManagementCommand_actorId_idempotencyKey_key" ON "AdminManagementCommand"("actorId","idempotencyKey");
CREATE TABLE "AdminManagementAudit" (
 "id" TEXT NOT NULL PRIMARY KEY,"actorId" TEXT NOT NULL,"targetAccountId" TEXT,"kind" TEXT NOT NULL,"reason" TEXT NOT NULL,"beforeRole" "AdminRole","afterRole" "AdminRole","beforeQq" TEXT,"afterQq" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AdminManagementAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AdminManagementAudit_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AdminManagementAudit_reason_check" CHECK (length(trim("reason")) BETWEEN 1 AND 1000),
 CONSTRAINT "AdminManagementAudit_kind_check" CHECK (("kind"='ADMIN_ROLE_CHANGED' AND "targetAccountId" IS NOT NULL AND "beforeRole" IS NOT NULL AND "afterRole" IS NOT NULL AND "beforeQq" IS NULL AND "afterQq" IS NULL AND "beforeRole"<>"afterRole" AND "beforeRole" IN ('NONE','ADMIN') AND "afterRole" IN ('NONE','ADMIN')) OR ("kind"='PUBLIC_ADMIN_QQ_CHANGED' AND "targetAccountId" IS NULL AND "beforeRole" IS NULL AND "afterRole" IS NULL))
);
CREATE INDEX "AdminManagementAudit_kind_createdAt_id_idx" ON "AdminManagementAudit"("kind","createdAt","id");
CREATE TABLE "PublicSiteSettings" (
 "id" TEXT NOT NULL PRIMARY KEY,"adminQq" TEXT,"revision" INTEGER NOT NULL,"updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "PublicSiteSettings_id_check" CHECK ("id"='public'),
 CONSTRAINT "PublicSiteSettings_revision_check" CHECK ("revision">=1),
 CONSTRAINT "PublicSiteSettings_adminQq_check" CHECK ("adminQq" IS NULL OR "adminQq" ~ '^[1-9][0-9]{4,11}$')
);
CREATE FUNCTION "adminManagementAppendOnly"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Management history is append-only'; END; $$;
CREATE TRIGGER "AdminManagementAudit_append_only" BEFORE UPDATE OR DELETE ON "AdminManagementAudit" FOR EACH ROW EXECUTE FUNCTION "adminManagementAppendOnly"();
CREATE TRIGGER "AdminManagementCommand_append_only" BEFORE UPDATE OR DELETE ON "AdminManagementCommand" FOR EACH ROW EXECUTE FUNCTION "adminManagementAppendOnly"();
