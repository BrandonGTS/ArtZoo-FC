-- Additive lifecycle state; no account, activity, registration or notification is deleted.
ALTER TYPE "ActivityEventKind" ADD VALUE 'REGISTRATION_WITHDRAWN';
ALTER TYPE "ActivityEventKind" ADD VALUE 'ACTIVITY_RESCHEDULED';
ALTER TYPE "ActivityEventKind" ADD VALUE 'ACTIVITY_CANCELLED';
ALTER TYPE "ActivityEventKind" ADD VALUE 'ACTIVITY_PENALTY';
ALTER TABLE "Activity" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cancelledAt" TIMESTAMPTZ(3), ADD COLUMN "cancellationReason" TEXT,
  ADD COLUMN "continuedAt" TIMESTAMPTZ(3);
ALTER TABLE "ActivityRegistration" ALTER COLUMN "seatId" DROP NOT NULL,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "exitedAt" TIMESTAMPTZ(3), ADD COLUMN "seatSnapshot" JSONB,
  ADD COLUMN "rescheduleExitAllowed" BOOLEAN NOT NULL DEFAULT false;
DROP INDEX "ActivityRegistration_activityId_accountId_key";
CREATE INDEX "ActivityRegistration_activityId_accountId_idx" ON "ActivityRegistration"("activityId", "accountId");
-- Historical attempts remain; one active registration per account/activity is still enforced in SQL.
CREATE UNIQUE INDEX "ActivityRegistration_active_account_key" ON "ActivityRegistration"("activityId", "accountId") WHERE "status" = 'ACTIVE';
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_state_check" CHECK (
  ("status" = 'ACTIVE' AND "seatId" IS NOT NULL AND "exitedAt" IS NULL) OR
  ("status" IN ('WITHDRAWN', 'CANCELLED') AND "seatId" IS NULL AND "exitedAt" IS NOT NULL AND "seatSnapshot" IS NOT NULL)
);
ALTER TABLE "ActivityOutbox" ADD COLUMN "payload" JSONB;
-- New event enum values cannot be referenced in the same migration transaction as ADD VALUE.
-- Use text for routing guards, while preserving the original publication/signup routes.
ALTER TABLE "ActivityOutbox" DROP CONSTRAINT "ActivityOutbox_route_check";
ALTER TABLE "ActivityOutbox" ADD CONSTRAINT "ActivityOutbox_route_check" CHECK (
  ("kind"::text = 'ACTIVITY_PUBLISHED' AND "channel" = 'QQ' AND "recipientId" IS NULL AND "registrationId" IS NULL) OR
  ("kind"::text IN ('REGISTRATION_CREATED', 'REGISTRATION_WITHDRAWN') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL) OR
  ("kind"::text IN ('ACTIVITY_RESCHEDULED', 'ACTIVITY_CANCELLED') AND "registrationId" IS NULL AND
    (("channel" = 'QQ' AND "recipientId" IS NULL) OR ("channel" = 'IN_APP' AND "recipientId" IS NOT NULL))) OR
  ("kind"::text = 'ACTIVITY_PENALTY' AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL)
);
CREATE TABLE "ActivityCommand" (
  "id" TEXT NOT NULL PRIMARY KEY, "activityId" TEXT NOT NULL, "actorId" TEXT,
  "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "before" JSONB NOT NULL, "after" JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ActivityCommand_activityId_actorId_idempotencyKey_key" ON "ActivityCommand"("activityId", "actorId", "idempotencyKey");
CREATE INDEX "ActivityCommand_activityId_createdAt_idx" ON "ActivityCommand"("activityId", "createdAt");
CREATE TABLE "ActivityPenalty" (
  "id" TEXT NOT NULL PRIMARY KEY, "eventKey" TEXT NOT NULL, "accountId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL, "registrationId" TEXT, "points" INTEGER NOT NULL, "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("registrationId") REFERENCES "ActivityRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ActivityPenalty_points_check" CHECK (
    ("reason" = 'LATE_WITHDRAWAL' AND "points" = 1) OR
    ("reason" = 'LATE_CANCELLATION' AND "points" = 2))
);
CREATE UNIQUE INDEX "ActivityPenalty_eventKey_key" ON "ActivityPenalty"("eventKey");
CREATE INDEX "ActivityPenalty_accountId_createdAt_idx" ON "ActivityPenalty"("accountId", "createdAt");

-- Edits may reorder retained seats without transient unique-position violations.
DROP INDEX "ActivitySeat_activityId_position_key";
ALTER TABLE "ActivitySeat" ADD CONSTRAINT "ActivitySeat_activityId_position_key" UNIQUE ("activityId", "position") DEFERRABLE INITIALLY IMMEDIATE;

-- Zero-based counters apply only to new actions; no historical penalties are inferred.
ALTER TABLE "Account" ADD COLUMN "activityPoints" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "activityDecayAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "Account_activity_standing_check" CHECK (
    "activityPoints" >= 0 AND (("activityPoints" < 3 AND "activityDecayAt" IS NULL) OR
    ("activityPoints" >= 3 AND "activityDecayAt" IS NOT NULL)));
-- Legacy activities that already started before adoption do not generate backfilled cancellations/notices.
ALTER TABLE "Activity" ADD COLUMN "managementEnabledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE TABLE "ActivityScoreChange" (
  "id" TEXT NOT NULL PRIMARY KEY, "eventKey" TEXT NOT NULL, "accountId" TEXT NOT NULL,
  "penaltyId" TEXT, "delta" INTEGER NOT NULL, "pointsBefore" INTEGER NOT NULL, "pointsAfter" INTEGER NOT NULL,
  "reason" TEXT NOT NULL, "notices" TEXT[] NOT NULL DEFAULT '{}',
  "simulatedAt" TIMESTAMPTZ(3) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("penaltyId") REFERENCES "ActivityPenalty"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ActivityScoreChange_points_check" CHECK ("pointsBefore" >= 0 AND "pointsAfter" >= 0 AND "pointsAfter" - "pointsBefore" = "delta")
);
CREATE UNIQUE INDEX "ActivityScoreChange_eventKey_key" ON "ActivityScoreChange"("eventKey");
CREATE UNIQUE INDEX "ActivityScoreChange_penaltyId_key" ON "ActivityScoreChange"("penaltyId");
CREATE INDEX "ActivityScoreChange_accountId_createdAt_idx" ON "ActivityScoreChange"("accountId", "createdAt");
