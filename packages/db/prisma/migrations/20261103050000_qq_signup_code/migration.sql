-- Additive only: no historical notices, registrations, or existing mappings are changed.
CREATE TABLE "QqOfficialSignupCode" (
  "code" TEXT NOT NULL,
  "activatedAt" TIMESTAMPTZ(3),
  "appId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "groupOpenId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QqOfficialSignupCode_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "QqOfficialSignupCode_format" CHECK ("code" ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$')
);
CREATE UNIQUE INDEX "QqOfficialSignupCode_appId_botId_groupOpenId_activityId_key"
  ON "QqOfficialSignupCode" ("appId", "botId", "groupOpenId", "activityId");

ALTER TABLE "QqOfficialDelivery"
  ADD COLUMN "signupCode" TEXT,
  ADD COLUMN "signupButton" BOOLEAN NOT NULL DEFAULT false;
