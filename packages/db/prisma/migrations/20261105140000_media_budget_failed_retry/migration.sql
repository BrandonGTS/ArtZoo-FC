-- Append-only retry links. Existing FAILED audit rows and all historical bytes remain intact.
ALTER TABLE "MediaUploadReceipt"
  ADD COLUMN "retryHeadKey" VARCHAR(256),
  ADD COLUMN "retryRootKey" VARCHAR(256);
ALTER TABLE "MediaUploadReceipt"
  ADD CONSTRAINT "MediaUploadReceipt_retry_shape" CHECK (
    ("retryHeadKey" IS NULL OR ("retryRootKey" IS NULL AND "state"='FAILED' AND "persistenceStartedAt" IS NULL AND "retryHeadKey"<>"operationKey" AND "retryHeadKey" ~ '^retry:[a-f0-9]{64}$'))
    AND ("retryRootKey" IS NULL OR ("retryHeadKey" IS NULL AND "retryRootKey"<>"operationKey" AND "operationKey" ~ '^retry:[a-f0-9]{64}$'))
  );
