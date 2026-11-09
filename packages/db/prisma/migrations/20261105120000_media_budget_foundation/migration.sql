-- Additive MEDIA03 foundation. Does not inspect, backfill, delete or enable any media.
CREATE TABLE "MediaBudgetState" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "baselineBytes" BIGINT NOT NULL DEFAULT 0,
  "committedBytes" BIGINT NOT NULL DEFAULT 0,
  "reservedBytes" BIGINT NOT NULL DEFAULT 0,
  "baselineFingerprint" VARCHAR(64),
  "baselineInitializedAt" TIMESTAMPTZ(3),
  CONSTRAINT "MediaBudgetState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MediaBudgetState_singleton" CHECK ("id" = 'global'),
  CONSTRAINT "MediaBudgetState_nonnegative" CHECK ("baselineBytes">=0 AND "committedBytes">=0 AND "reservedBytes">=0),
  CONSTRAINT "MediaBudgetState_baseline_pair" CHECK (("baselineFingerprint" IS NULL) = ("baselineInitializedAt" IS NULL)),
  CONSTRAINT "MediaBudgetState_baseline_hash" CHECK ("baselineFingerprint" IS NULL OR "baselineFingerprint" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE "MediaDailyBudget" (
  "accountId" TEXT NOT NULL,
  "day" VARCHAR(10) NOT NULL,
  "committedBytes" BIGINT NOT NULL DEFAULT 0,
  "reservedBytes" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "MediaDailyBudget_pkey" PRIMARY KEY ("accountId","day"),
  CONSTRAINT "MediaDailyBudget_nonnegative" CHECK ("committedBytes">=0 AND "reservedBytes">=0),
  CONSTRAINT "MediaDailyBudget_day" CHECK ("day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
CREATE TABLE "MediaUploadReceipt" (
  "scope" VARCHAR(64) NOT NULL,
  "operationKey" VARCHAR(256) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "accountId" TEXT,
  "day" VARCHAR(10),
  "rawBytes" BIGINT NOT NULL,
  "storedBytes" BIGINT NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "persistenceStartedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "settledAt" TIMESTAMPTZ(3),
  CONSTRAINT "MediaUploadReceipt_pkey" PRIMARY KEY ("scope","operationKey"),
  CONSTRAINT "MediaUploadReceipt_positive" CHECK ("rawBytes">0 AND "storedBytes">0),
  CONSTRAINT "MediaUploadReceipt_actor_day_pair" CHECK (("accountId" IS NULL) = ("day" IS NULL)),
  CONSTRAINT "MediaUploadReceipt_day" CHECK ("day" IS NULL OR "day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT "MediaUploadReceipt_fingerprint" CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "MediaUploadReceipt_state" CHECK ("state" IN ('RESERVED','COMMITTED','FAILED','UNKNOWN')),
  CONSTRAINT "MediaUploadReceipt_settled" CHECK (("state" IN ('COMMITTED','FAILED')) = ("settledAt" IS NOT NULL)),
  CONSTRAINT "MediaUploadReceipt_commit_started" CHECK ("state" <> 'COMMITTED' OR "persistenceStartedAt" IS NOT NULL),
  CONSTRAINT "MediaUploadReceipt_failed_prewrite" CHECK ("state" <> 'FAILED' OR "persistenceStartedAt" IS NULL),
  CONSTRAINT "MediaUploadReceipt_times" CHECK ("updatedAt">="createdAt" AND ("persistenceStartedAt" IS NULL OR "persistenceStartedAt">="createdAt") AND ("settledAt" IS NULL OR "settledAt">="createdAt"))
);
CREATE INDEX "MediaUploadReceipt_accountId_day_idx" ON "MediaUploadReceipt"("accountId","day");
