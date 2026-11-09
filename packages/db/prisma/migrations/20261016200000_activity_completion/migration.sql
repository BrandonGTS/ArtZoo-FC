-- Existing activities remain NULL; only activities created after adoption receive a default.
ALTER TABLE "Activity" ADD COLUMN "completionEnabledAt" TIMESTAMPTZ(3);
ALTER TABLE "Activity" ALTER COLUMN "completionEnabledAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TYPE "ActivityEventKind" ADD VALUE 'ACTIVITY_COMPLETED';
CREATE TABLE "ActivityCompletion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "activityId" TEXT NOT NULL REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "registrationId" TEXT NOT NULL REFERENCES "ActivityRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "active" BOOLEAN NOT NULL, "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "evaluatedAt" TIMESTAMPTZ(3) NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE UNIQUE INDEX "ActivityCompletion_registrationId_key" ON "ActivityCompletion"("registrationId");
CREATE UNIQUE INDEX "ActivityCompletion_activityId_accountId_key" ON "ActivityCompletion"("activityId","accountId");
ALTER TABLE "ActivityScoreChange" ADD COLUMN "completionId" TEXT REFERENCES "ActivityCompletion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ActivityScoreChange_completionId_key" ON "ActivityScoreChange"("completionId");
ALTER TABLE "ActivityOutbox" DROP CONSTRAINT "ActivityOutbox_route_check";
ALTER TABLE "ActivityOutbox" ADD CONSTRAINT "ActivityOutbox_route_check" CHECK (
  ("kind"::text = 'ACTIVITY_PUBLISHED' AND "channel" = 'QQ' AND "recipientId" IS NULL AND "registrationId" IS NULL) OR
  ("kind"::text IN ('REGISTRATION_CREATED', 'REGISTRATION_WITHDRAWN') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL) OR
  ("kind"::text IN ('ACTIVITY_RESCHEDULED', 'ACTIVITY_CANCELLED') AND "registrationId" IS NULL AND
    (("channel" = 'QQ' AND "recipientId" IS NULL) OR ("channel" = 'IN_APP' AND "recipientId" IS NOT NULL))) OR
  ("kind"::text = 'ACTIVITY_PENALTY' AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL) OR
  ("kind"::text IN ('ACTIVITY_SCORE_CORRECTED', 'ATTENDANCE_APPEAL_RESULT', 'ACTIVITY_COMPLETED') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL)
);
