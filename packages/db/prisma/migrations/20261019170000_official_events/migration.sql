BEGIN;
-- Additive official information; never infer dates from news publication or backfill notices.
CREATE TABLE "OfficialEvent" (
 id TEXT PRIMARY KEY, "sourceKey" TEXT NOT NULL, "externalId" TEXT NOT NULL,
 "sourceUrl" TEXT NOT NULL, "sourceTitle" TEXT NOT NULL, "sourceText" TEXT NOT NULL,
 "requestFingerprint" TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', summary TEXT NOT NULL DEFAULT '',
 "startsAt" timestamptz(3), "endsAt" timestamptz(3), revision INTEGER NOT NULL DEFAULT 0,
 "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "OfficialEvent_status_check" CHECK(status IN ('PENDING','PUBLISHED','REJECTED','WITHDRAWN')),
 CONSTRAINT "OfficialEvent_time_check" CHECK("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt">"startsAt"),
 CONSTRAINT "OfficialEvent_published_check" CHECK(status NOT IN ('PUBLISHED','WITHDRAWN') OR ("startsAt" IS NOT NULL AND "endsAt" IS NOT NULL AND length(trim(summary))>0)),
 CONSTRAINT "OfficialEvent_revision_check" CHECK(revision>=0)
);
CREATE UNIQUE INDEX "OfficialEvent_sourceKey_externalId_key" ON "OfficialEvent"("sourceKey","externalId");
CREATE INDEX "OfficialEvent_status_createdAt_id_idx" ON "OfficialEvent"(status,"createdAt",id);
CREATE INDEX "OfficialEvent_status_startsAt_endsAt_idx" ON "OfficialEvent"(status,"startsAt","endsAt");
CREATE TABLE "OfficialEventAudit" (
 id TEXT PRIMARY KEY, "eventId" TEXT NOT NULL REFERENCES "OfficialEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "actorId" TEXT REFERENCES "Account"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 action TEXT NOT NULL, reason TEXT NOT NULL, before JSONB NOT NULL, after JSONB NOT NULL,
 "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OfficialEventAudit_eventId_createdAt_id_idx" ON "OfficialEventAudit"("eventId","createdAt",id);
CREATE TABLE "OfficialEventCommand" (
 id TEXT PRIMARY KEY, "eventId" TEXT NOT NULL REFERENCES "OfficialEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "actorId" TEXT NOT NULL REFERENCES "Account"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL, action TEXT NOT NULL,
 "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "OfficialEventCommand_eventId_actorId_idempotencyKey_key" ON "OfficialEventCommand"("eventId","actorId","idempotencyKey");
CREATE TABLE "OfficialSyncRun" (
 id TEXT PRIMARY KEY, trigger TEXT NOT NULL, "actorId" TEXT REFERENCES "Account"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "idempotencyKey" TEXT, status TEXT NOT NULL DEFAULT 'RUNNING', imported INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0,
 errors JSONB NOT NULL DEFAULT '[]', "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" timestamptz(3),
 CONSTRAINT "OfficialSyncRun_status_check" CHECK(status IN ('RUNNING','COMPLETED','PARTIAL','FAILED'))
);
CREATE UNIQUE INDEX "OfficialSyncRun_actorId_idempotencyKey_key" ON "OfficialSyncRun"("actorId","idempotencyKey");
CREATE INDEX "OfficialSyncRun_createdAt_id_idx" ON "OfficialSyncRun"("createdAt",id);
CREATE FUNCTION preserve_official_event_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'official records must be retained'; END IF;
 IF (NEW."sourceKey",NEW."externalId",NEW."sourceUrl",NEW."sourceTitle",NEW."sourceText",NEW."requestFingerprint",NEW."createdAt")
 IS DISTINCT FROM (OLD."sourceKey",OLD."externalId",OLD."sourceUrl",OLD."sourceTitle",OLD."sourceText",OLD."requestFingerprint",OLD."createdAt")
 THEN RAISE EXCEPTION 'official original must be retained'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "OfficialEvent_original_immutable" BEFORE UPDATE OR DELETE ON "OfficialEvent" FOR EACH ROW EXECUTE FUNCTION preserve_official_event_original();
CREATE FUNCTION preserve_official_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'official audit must be retained'; END $$;
CREATE TRIGGER "OfficialEventAudit_append_only" BEFORE UPDATE OR DELETE ON "OfficialEventAudit" FOR EACH ROW EXECUTE FUNCTION preserve_official_audit();
CREATE TRIGGER "OfficialEventCommand_append_only" BEFORE UPDATE OR DELETE ON "OfficialEventCommand" FOR EACH ROW EXECUTE FUNCTION preserve_official_audit();

COMMIT;
