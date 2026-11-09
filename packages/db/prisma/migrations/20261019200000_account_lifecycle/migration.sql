BEGIN;
-- Add lifecycle history and the approved terminal application state; no existing rows are updated.
CREATE TABLE "AccountLifecycleCommand" (
 "id" TEXT NOT NULL PRIMARY KEY,"actorId" TEXT NOT NULL,"targetAccountId" TEXT NOT NULL,"idempotencyKey" TEXT NOT NULL,"requestFingerprint" TEXT NOT NULL,"result" JSONB NOT NULL,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AccountLifecycleCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AccountLifecycleCommand_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AccountLifecycleCommand_actorId_idempotencyKey_key" ON "AccountLifecycleCommand"("actorId","idempotencyKey");
CREATE TABLE "AccountLifecycleAudit" (
 "id" TEXT NOT NULL PRIMARY KEY,"actorId" TEXT NOT NULL,"targetAccountId" TEXT NOT NULL,"beforeActive" BOOLEAN NOT NULL,"afterActive" BOOLEAN NOT NULL,"revisionBefore" INTEGER NOT NULL,"revisionAfter" INTEGER NOT NULL,"reason" TEXT NOT NULL,"impact" JSONB NOT NULL,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AccountLifecycleAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AccountLifecycleAudit_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AccountLifecycleAudit_transition_check" CHECK ("beforeActive"<>"afterActive" AND "revisionBefore">=0 AND "revisionAfter"="revisionBefore"+1 AND length(trim("reason")) BETWEEN 1 AND 1000 AND "actorId"<>"targetAccountId")
);
CREATE INDEX "AccountLifecycleAudit_targetAccountId_createdAt_id_idx" ON "AccountLifecycleAudit"("targetAccountId","createdAt","id");
CREATE INDEX "AccountLifecycleAudit_createdAt_id_idx" ON "AccountLifecycleAudit"("createdAt","id");
CREATE FUNCTION "accountLifecycleAppendOnly"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Account lifecycle history is append-only'; END; $$;
CREATE TRIGGER "AccountLifecycleAudit_append_only" BEFORE UPDATE OR DELETE ON "AccountLifecycleAudit" FOR EACH ROW EXECUTE FUNCTION "accountLifecycleAppendOnly"();
CREATE TRIGGER "AccountLifecycleCommand_append_only" BEFORE UPDATE OR DELETE ON "AccountLifecycleCommand" FOR EACH ROW EXECUTE FUNCTION "accountLifecycleAppendOnly"();

-- Preserve every existing valid state/time pairing and add only the approved cancellation terminal.
ALTER TABLE "TeamApplication" DROP CONSTRAINT "TeamApplication_state_check";
ALTER TABLE "TeamApplication" ADD CONSTRAINT "TeamApplication_state_check" CHECK (
 ("state"='PENDING' AND "decidedAt" IS NULL) OR
 ("state" IN ('ACCEPTED','REJECTED','CANCELLED') AND "decidedAt" IS NOT NULL)
);
COMMIT;
