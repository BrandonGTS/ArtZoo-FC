-- CreateEnum
CREATE TYPE "ActivityScene" AS ENUM ('GAME', 'OFFLINE');

-- CreateEnum
CREATE TYPE "ActivityMode" AS ENUM ('SINGLE', 'SERIES');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEventKind" ADD VALUE 'REGISTRATION_CONFIRMED';
ALTER TYPE "ActivityEventKind" ADD VALUE 'SERIES_READY';
ALTER TYPE "ActivityEventKind" ADD VALUE 'SERIES_FORMED';

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "capacityUnlimited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "meetingInstructions" TEXT,
ADD COLUMN     "mode" "ActivityMode" NOT NULL DEFAULT 'SINGLE',
ADD COLUMN     "periodNumber" INTEGER,
ADD COLUMN     "registrationClosesAt" TIMESTAMPTZ(3),
ADD COLUMN     "scene" "ActivityScene" NOT NULL DEFAULT 'GAME',
ADD COLUMN     "seriesId" TEXT;

-- CreateTable
CREATE TABLE "ActivitySeries" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RECRUITING',
    "weekdays" INTEGER[],
    "durationMinutes" INTEGER NOT NULL,
    "totalPeriods" INTEGER NOT NULL,
    "endDate" TEXT,
    "formedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "readyNotifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivitySeries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivitySeries_state_createdAt_idx" ON "ActivitySeries"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_seriesId_periodNumber_key" ON "Activity"("seriesId", "periodNumber");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "ActivitySeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Keep existing activities GAME/SINGLE without rewriting records or producing events.
ALTER TABLE "ActivitySeries" ADD CONSTRAINT "ActivitySeries_finite_plan_check"
CHECK ("totalPeriods" BETWEEN 2 AND 10 AND "durationMinutes" > 0
  AND cardinality("weekdays") BETWEEN 1 AND 7 AND "weekdays" <@ ARRAY[1,2,3,4,5,6,7]
  AND "state" IN ('RECRUITING','FORMED','CANCELLED'));
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_series_shape_check"
CHECK (("mode" = 'SINGLE' AND "seriesId" IS NULL AND "periodNumber" IS NULL)
  OR ("mode" = 'SERIES' AND "scene" = 'GAME' AND "seriesId" IS NOT NULL AND "periodNumber" BETWEEN 1 AND 10 AND NOT "capacityUnlimited"));
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_offline_shape_check"
CHECK ("scene" <> 'OFFLINE' OR ("mode" = 'SINGLE' AND "category" = 'SOCIAL'
  AND "location" IS NOT NULL AND "registrationClosesAt" IS NOT NULL AND "registrationClosesAt" <= "startsAt"
  AND "dutyId" IS NULL AND "dutySnapshot" IS NULL AND "completionEnabledAt" IS NULL));

-- New private signup/series events retain all existing notification routes.
ALTER TABLE "ActivityOutbox" DROP CONSTRAINT "ActivityOutbox_route_check";
ALTER TABLE "ActivityOutbox" ADD CONSTRAINT "ActivityOutbox_route_check" CHECK (
  ("kind"::text = 'ACTIVITY_PUBLISHED' AND "channel" = 'QQ' AND "recipientId" IS NULL AND "registrationId" IS NULL) OR
  ("kind"::text IN ('REGISTRATION_CREATED', 'REGISTRATION_WITHDRAWN', 'REGISTRATION_CONFIRMED') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL) OR
  ("kind"::text IN ('ACTIVITY_RESCHEDULED', 'ACTIVITY_CANCELLED') AND "registrationId" IS NULL AND
    (("channel" = 'QQ' AND "recipientId" IS NULL) OR ("channel" = 'IN_APP' AND "recipientId" IS NOT NULL))) OR
  ("kind"::text = 'ACTIVITY_PENALTY' AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL) OR
  ("kind"::text IN ('ACTIVITY_SCORE_CORRECTED', 'ATTENDANCE_APPEAL_RESULT', 'ACTIVITY_COMPLETED') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL) OR
  ("kind"::text IN ('SERIES_READY', 'SERIES_FORMED') AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL) OR
  ("kind"::text = 'PENALTY_APPEAL_RESULT' AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL)
);

-- Unlimited offline registration appends seats beyond the publication transport bound.
-- Bounded game/series/offline plans retain their 200-seat contract validation.
ALTER TABLE "ActivitySeat" DROP CONSTRAINT "ActivitySeat_position_check";
ALTER TABLE "ActivitySeat" ADD CONSTRAINT "ActivitySeat_position_check" CHECK ("position" >= 0);
