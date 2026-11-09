-- CreateEnum
CREATE TYPE "ActivityCategory" AS ENUM ('DUNGEON', 'SOCIAL');

-- CreateEnum
CREATE TYPE "ActivitySeatKind" AS ENUM ('ANY', 'ROLE', 'JOB');

-- CreateEnum
CREATE TYPE "ActivityRole" AS ENUM ('TANK', 'HEALER', 'DAMAGE');

-- CreateEnum
CREATE TYPE "ActivityEventKind" AS ENUM ('ACTIVITY_PUBLISHED', 'REGISTRATION_CREATED');

-- CreateEnum
CREATE TYPE "ActivityNotificationChannel" AS ENUM ('QQ', 'IN_APP');

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ActivityCategory" NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivitySeat" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "ActivitySeatKind" NOT NULL,
    "role" "ActivityRole",
    "job" TEXT,

    CONSTRAINT "ActivitySeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityRegistration" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "job" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityOutbox" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "registrationId" TEXT,
    "kind" "ActivityEventKind" NOT NULL,
    "channel" "ActivityNotificationChannel" NOT NULL,
    "recipientId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityMockDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityMockDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Activity_startsAt_id_idx" ON "Activity"("startsAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_organizerId_idempotencyKey_key" ON "Activity"("organizerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ActivitySeat_activityId_position_key" ON "ActivitySeat"("activityId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ActivitySeat_id_activityId_key" ON "ActivitySeat"("id", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityRegistration_seatId_key" ON "ActivityRegistration"("seatId");

-- CreateIndex
CREATE INDEX "ActivityRegistration_accountId_createdAt_idx" ON "ActivityRegistration"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityRegistration_activityId_accountId_key" ON "ActivityRegistration"("activityId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityRegistration_seatId_activityId_key" ON "ActivityRegistration"("seatId", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityOutbox_eventKey_key" ON "ActivityOutbox"("eventKey");

-- CreateIndex
CREATE INDEX "ActivityOutbox_recipientId_createdAt_idx" ON "ActivityOutbox"("recipientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityMockDelivery_eventId_key" ON "ActivityMockDelivery"("eventId");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySeat" ADD CONSTRAINT "ActivitySeat_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_seatId_activityId_fkey" FOREIGN KEY ("seatId", "activityId") REFERENCES "ActivitySeat"("id", "activityId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityOutbox" ADD CONSTRAINT "ActivityOutbox_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityOutbox" ADD CONSTRAINT "ActivityOutbox_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ActivityRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityOutbox" ADD CONSTRAINT "ActivityOutbox_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityMockDelivery" ADD CONSTRAINT "ActivityMockDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ActivityOutbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Database guardrails complement service validation without changing existing rows/tables.
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_time_range_check" CHECK ("endsAt" > "startsAt");
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_text_bounds_check" CHECK (
  char_length(btrim("title")) BETWEEN 1 AND 100 AND char_length("description") <= 2000
);
ALTER TABLE "ActivitySeat" ADD CONSTRAINT "ActivitySeat_position_check" CHECK ("position" >= 0 AND "position" < 200);
ALTER TABLE "ActivitySeat" ADD CONSTRAINT "ActivitySeat_requirement_check" CHECK (
  ("kind" = 'ANY' AND "role" IS NULL AND "job" IS NULL) OR
  ("kind" = 'ROLE' AND "role" IS NOT NULL AND "job" IS NULL) OR
  ("kind" = 'JOB' AND "role" IS NULL AND "job" IS NOT NULL)
);
ALTER TABLE "ActivityOutbox" ADD CONSTRAINT "ActivityOutbox_route_check" CHECK (
  ("kind" = 'ACTIVITY_PUBLISHED' AND "channel" = 'QQ' AND "recipientId" IS NULL AND "registrationId" IS NULL) OR
  ("kind" = 'REGISTRATION_CREATED' AND "channel" = 'IN_APP' AND "recipientId" IS NOT NULL AND "registrationId" IS NOT NULL)
);
