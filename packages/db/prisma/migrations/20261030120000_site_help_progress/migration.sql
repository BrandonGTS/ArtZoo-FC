-- Append-only learning progress. No existing table or progress is rewritten.
CREATE TABLE "SiteHelpStepProgress" (
  "accountId" TEXT NOT NULL,
  "lessonId" VARCHAR(64) NOT NULL,
  "version" INTEGER NOT NULL,
  "stepId" VARCHAR(64) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SiteHelpStepProgress_pkey" PRIMARY KEY ("accountId", "lessonId", "version", "stepId"),
  CONSTRAINT "SiteHelpStepProgress_valid_identity" CHECK (
    "version" > 0
    AND "lessonId" ~ '^[a-z][a-z0-9-]{0,63}$'
    AND "stepId" ~ '^[a-z][a-z0-9-]{0,63}$'
  )
);
ALTER TABLE "SiteHelpStepProgress"
  ADD CONSTRAINT "SiteHelpStepProgress_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
