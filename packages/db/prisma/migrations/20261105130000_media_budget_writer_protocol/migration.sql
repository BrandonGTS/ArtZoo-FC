-- Additive protocol extension: no historical receipt adoption, backfill, deletion or enablement.
ALTER TABLE "MediaUploadReceipt"
  ADD COLUMN "attemptId" VARCHAR(36),
  ADD COLUMN "objectIdentity" VARCHAR(256),
  ADD COLUMN "storageReservedAt" TIMESTAMPTZ(3),
  ADD COLUMN "metadataReservedBytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "MediaUploadReceipt" DROP CONSTRAINT "MediaUploadReceipt_positive";
ALTER TABLE "MediaUploadReceipt"
  ADD CONSTRAINT "MediaUploadReceipt_byte_bounds" CHECK ("rawBytes">0 AND "storedBytes">=0 AND "metadataReservedBytes">=0 AND "metadataReservedBytes"<="storedBytes"),
  ADD CONSTRAINT "MediaUploadReceipt_writer_pair" CHECK (("attemptId" IS NULL)=("objectIdentity" IS NULL)),
  ADD CONSTRAINT "MediaUploadReceipt_writer_allocation" CHECK ("attemptId" IS NULL OR "persistenceStartedAt" IS NULL OR ("storedBytes">0 AND "storageReservedAt" IS NOT NULL)),
  ADD CONSTRAINT "MediaUploadReceipt_raw_stage" CHECK ("storedBytes"<>0 OR ("storageReservedAt" IS NULL AND "persistenceStartedAt" IS NULL AND "state"<>'COMMITTED'));
CREATE UNIQUE INDEX "MediaUploadReceipt_attemptId_key" ON "MediaUploadReceipt"("attemptId");
CREATE UNIQUE INDEX "MediaUploadReceipt_objectIdentity_key" ON "MediaUploadReceipt"("objectIdentity");
