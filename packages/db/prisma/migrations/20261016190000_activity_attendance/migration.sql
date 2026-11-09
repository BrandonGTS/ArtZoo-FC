ALTER TYPE "ActivityEventKind" ADD VALUE 'ACTIVITY_SCORE_CORRECTED';
ALTER TYPE "ActivityEventKind" ADD VALUE 'ATTENDANCE_APPEAL_RESULT';
-- Extend the existing database guards; preserve every previously permitted route and penalty.
ALTER TABLE "ActivityPenalty" DROP CONSTRAINT "ActivityPenalty_points_check";
ALTER TABLE "ActivityPenalty" ADD CONSTRAINT "ActivityPenalty_points_check" CHECK (
  ("reason" = 'LATE_WITHDRAWAL' AND "points" = 1) OR
  ("reason" IN ('LATE_CANCELLATION', 'NO_SHOW') AND "points" = 2)
);
ALTER TABLE "ActivityOutbox" DROP CONSTRAINT "ActivityOutbox_route_check";
ALTER TABLE "ActivityOutbox" ADD CONSTRAINT "ActivityOutbox_route_check" CHECK (
  ("kind"::text = 'ACTIVITY_PUBLISHED' AND "channel" = 'QQ' AND "recipientId" IS NULL AND "registrationId" IS NULL) OR
  ("kind"::text IN ('REGISTRATION_CREATED', 'REGISTRATION_WITHDRAWN') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL) OR
  ("kind"::text IN ('ACTIVITY_RESCHEDULED', 'ACTIVITY_CANCELLED') AND "registrationId" IS NULL AND
    (("channel" = 'QQ' AND "recipientId" IS NULL) OR ("channel" = 'IN_APP' AND "recipientId" IS NOT NULL))) OR
  ("kind"::text = 'ACTIVITY_PENALTY' AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL) OR
  ("kind"::text IN ('ACTIVITY_SCORE_CORRECTED', 'ATTENDANCE_APPEAL_RESULT') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL)
);
ALTER TABLE "Activity" ADD COLUMN "attendanceEnabledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ActivityRegistration"
  ADD COLUMN "attendanceStatus" TEXT,
  ADD COLUMN "attendanceRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attendanceRecordedAt" TIMESTAMPTZ(3),
  ADD COLUMN "attendanceUpdatedAt" TIMESTAMPTZ(3),
  ADD COLUMN "attendancePenaltyId" TEXT;
ALTER TABLE "ActivityPenalty" ADD COLUMN "reversedAt" TIMESTAMPTZ(3), ADD COLUMN "reversalReason" TEXT;
ALTER TABLE "ActivityScoreChange" ADD COLUMN "sequence" BIGSERIAL NOT NULL,
  ADD COLUMN "decayBefore" TIMESTAMPTZ(3), ADD COLUMN "decayAfter" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "ActivityScoreChange_sequence_key" ON "ActivityScoreChange"("sequence");
CREATE UNIQUE INDEX "ActivityRegistration_attendancePenaltyId_key" ON "ActivityRegistration"("attendancePenaltyId");
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_attendancePenaltyId_fkey"
  FOREIGN KEY ("attendancePenaltyId") REFERENCES "ActivityPenalty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_attendance_state_check" CHECK (
  "attendanceRevision" >= 0 AND (
    ("attendanceStatus" IS NULL AND "attendanceRecordedAt" IS NULL AND "attendanceUpdatedAt" IS NULL AND "attendancePenaltyId" IS NULL) OR
    ("attendanceStatus" IS NOT NULL AND "attendanceStatus" = 'PRESENT' AND "attendanceRecordedAt" IS NOT NULL AND "attendanceUpdatedAt" IS NOT NULL AND "attendancePenaltyId" IS NULL) OR
    ("attendanceStatus" IS NOT NULL AND "attendanceStatus" = 'ABSENT' AND "attendanceRecordedAt" IS NOT NULL AND "attendanceUpdatedAt" IS NOT NULL AND "attendancePenaltyId" IS NOT NULL)
  ));
CREATE TABLE "ActivityAttendanceAppeal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "registrationId" TEXT NOT NULL REFERENCES "ActivityRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "attendanceRevision" INTEGER NOT NULL,
  "requestedStatus" TEXT NOT NULL CHECK ("requestedStatus" IN ('PRESENT','ABSENT')),
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED')),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "decisionReason" TEXT,
  "decidedById" TEXT REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ActivityAttendanceAppeal_decision_check" CHECK (
    ("status" = 'PENDING' AND "decidedAt" IS NULL AND "decidedById" IS NULL AND "decisionReason" IS NULL) OR
    ("status" <> 'PENDING' AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL AND "decisionReason" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "ActivityAttendanceAppeal_one_pending" ON "ActivityAttendanceAppeal"("registrationId") WHERE "status" = 'PENDING';
CREATE INDEX "ActivityAttendanceAppeal_status_createdAt_id_idx" ON "ActivityAttendanceAppeal"("status","createdAt","id");
CREATE INDEX "ActivityAttendanceAppeal_registrationId_createdAt_id_idx" ON "ActivityAttendanceAppeal"("registrationId","createdAt","id");
