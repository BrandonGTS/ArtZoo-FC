-- Extend the existing public website catalog; original fields, rows and categories remain unchanged.
ALTER TABLE "ResourceLink" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "iconBytes" BYTEA, ADD COLUMN "iconVersion" VARCHAR(64);
WITH ordered AS (SELECT "id", (row_number() OVER (ORDER BY "name","id") - 1)::int AS ordinal FROM "ResourceLink")
 UPDATE "ResourceLink" SET "position"=ordered.ordinal FROM ordered WHERE "ResourceLink"."id"=ordered."id";
CREATE INDEX "ResourceLink_position_id_idx" ON "ResourceLink"("position","id");
CREATE TABLE "QuickLinkState" (
 "id" TEXT PRIMARY KEY CHECK ("id"='global'), "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision">=0)
);
INSERT INTO "QuickLinkState"("id","revision") VALUES ('global',0);
CREATE TABLE "QuickLinkCommand" (
 "id" TEXT PRIMARY KEY, "actorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('create','update','remove','move')),
 "result" JSONB NOT NULL, "snapshot" JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "QuickLinkCommand_actorId_idempotencyKey_key" UNIQUE ("actorId","idempotencyKey")
);
