BEGIN;
CREATE TABLE "ActivityShare" (
 "id" TEXT PRIMARY KEY,"activityId" TEXT NOT NULL REFERENCES "Activity"("id") ON DELETE RESTRICT,
 "creatorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "title" TEXT NOT NULL DEFAULT '',"body" TEXT NOT NULL DEFAULT '',"mediaIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 "revision" INTEGER NOT NULL DEFAULT 0 CHECK("revision">=0),"featuredAt" TIMESTAMPTZ(3),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(char_length("title")<=100 AND char_length("body")<=2000),
 CHECK("featuredAt" IS NULL OR (char_length(btrim("title"))>0 AND char_length(btrim("body"))>0))
);
CREATE INDEX "ActivityShare_featuredAt_id_idx" ON "ActivityShare"("featuredAt","id");
CREATE INDEX "ActivityShare_activityId_createdAt_id_idx" ON "ActivityShare"("activityId","createdAt","id");
CREATE TABLE "ActivityShareMedia" (
 "id" TEXT PRIMARY KEY,"shareId" TEXT NOT NULL REFERENCES "ActivityShare"("id") ON DELETE RESTRICT,
 "ownerId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,"batchId" TEXT NOT NULL,"batchIndex" INTEGER NOT NULL CHECK("batchIndex">=0 AND "batchIndex"<10),
 "fingerprint" TEXT NOT NULL,"mime" TEXT NOT NULL,"width" INTEGER NOT NULL CHECK("width">0),"height" INTEGER NOT NULL CHECK("height">0),"frames" INTEGER NOT NULL CHECK("frames">0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("ownerId","batchId","batchIndex")
);
CREATE INDEX "ActivityShareMedia_shareId_createdAt_id_idx" ON "ActivityShareMedia"("shareId","createdAt","id");
CREATE TABLE "ActivityShareAudit" (
 "id" TEXT PRIMARY KEY,"shareId" TEXT NOT NULL REFERENCES "ActivityShare"("id") ON DELETE RESTRICT,
 "actorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,"action" TEXT NOT NULL,"reason" TEXT NOT NULL,
 "before" JSONB NOT NULL,"after" JSONB NOT NULL,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ActivityShareAudit_shareId_createdAt_id_idx" ON "ActivityShareAudit"("shareId","createdAt","id");
CREATE TABLE "ActivityShareCommand" (
 "id" TEXT PRIMARY KEY,"shareId" TEXT NOT NULL REFERENCES "ActivityShare"("id") ON DELETE RESTRICT,
 "actorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,"idempotencyKey" TEXT NOT NULL,"requestFingerprint" TEXT NOT NULL,"action" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE("actorId","idempotencyKey")
);
CREATE FUNCTION activity_share_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Activity share history is append-only'; END; $$;
CREATE TRIGGER activity_share_audit_append_only BEFORE UPDATE OR DELETE ON "ActivityShareAudit" FOR EACH ROW EXECUTE FUNCTION activity_share_append_only();
CREATE TRIGGER activity_share_command_append_only BEFORE UPDATE OR DELETE ON "ActivityShareCommand" FOR EACH ROW EXECUTE FUNCTION activity_share_append_only();
COMMIT;
