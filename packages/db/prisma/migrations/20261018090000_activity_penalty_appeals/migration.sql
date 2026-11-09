-- No historical eligibility or score replay backfill; only newly created penalties opt in.
ALTER TABLE "ActivityPenalty" ADD COLUMN "appealEnabledAt" TIMESTAMPTZ(3);
ALTER TABLE "ActivityPenalty" ALTER COLUMN "appealEnabledAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TYPE "ActivityEventKind" ADD VALUE 'PENALTY_APPEAL_RESULT';
CREATE TABLE "ActivityPenaltyAppeal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sequence" BIGSERIAL NOT NULL UNIQUE,
  "penaltyId" TEXT NOT NULL REFERENCES "ActivityPenalty"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reason" TEXT NOT NULL,
  "submissionKey" TEXT NOT NULL,
  "submissionFingerprint" TEXT NOT NULL,
  "decisionKey" TEXT,
  "decisionFingerprint" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED')),
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "decisionReason" TEXT,
  "decidedById" TEXT REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ActivityPenaltyAppeal_decision_check" CHECK (
    ("status" = 'PENDING' AND "revision" = 0 AND "decidedAt" IS NULL AND "decidedById" IS NULL AND "decisionReason" IS NULL AND "decisionKey" IS NULL AND "decisionFingerprint" IS NULL) OR
    ("status" <> 'PENDING' AND "revision" = 1 AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL AND "decisionReason" IS NOT NULL AND "decisionKey" IS NOT NULL AND "decisionFingerprint" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "ActivityPenaltyAppeal_accountId_submissionKey_key" ON "ActivityPenaltyAppeal"("accountId","submissionKey");
CREATE UNIQUE INDEX "ActivityPenaltyAppeal_decidedById_decisionKey_key" ON "ActivityPenaltyAppeal"("decidedById","decisionKey");
CREATE UNIQUE INDEX "ActivityPenaltyAppeal_one_pending" ON "ActivityPenaltyAppeal"("penaltyId") WHERE "status" = 'PENDING';
CREATE INDEX "ActivityPenaltyAppeal_status_createdAt_sequence_idx" ON "ActivityPenaltyAppeal"("status","createdAt","sequence");
CREATE INDEX "ActivityPenaltyAppeal_penaltyId_sequence_idx" ON "ActivityPenaltyAppeal"("penaltyId","sequence");
ALTER TABLE "ActivityOutbox" DROP CONSTRAINT "ActivityOutbox_route_check";
ALTER TABLE "ActivityOutbox" ADD CONSTRAINT "ActivityOutbox_route_check" CHECK (
  ("kind"::text = 'ACTIVITY_PUBLISHED' AND "channel" = 'QQ' AND "recipientId" IS NULL AND "registrationId" IS NULL) OR
  ("kind"::text IN ('REGISTRATION_CREATED', 'REGISTRATION_WITHDRAWN') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL) OR
  ("kind"::text IN ('ACTIVITY_RESCHEDULED', 'ACTIVITY_CANCELLED') AND "registrationId" IS NULL AND
    (("channel" = 'QQ' AND "recipientId" IS NULL) OR ("channel" = 'IN_APP' AND "recipientId" IS NOT NULL))) OR
  ("kind"::text = 'ACTIVITY_PENALTY' AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL) OR
  ("kind"::text IN ('ACTIVITY_SCORE_CORRECTED', 'ATTENDANCE_APPEAL_RESULT', 'ACTIVITY_COMPLETED') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL) OR
  ("kind"::text = 'PENALTY_APPEAL_RESULT' AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL)
);
