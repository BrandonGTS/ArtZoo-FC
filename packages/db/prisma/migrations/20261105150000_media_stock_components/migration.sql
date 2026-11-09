-- Audit-preserving stock accounting. No historical receipt rewrite, scan, deletion or runtime enable.
ALTER TABLE "MediaBudgetState" ADD COLUMN "creditedBytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "MediaBudgetState" ADD CONSTRAINT "MediaBudgetState_credit_bound"
 CHECK ("creditedBytes">=0 AND "creditedBytes"::numeric<="baselineBytes"::numeric+"committedBytes"::numeric);
CREATE TABLE "MediaStoredComponent" (
 "id" VARCHAR(64) NOT NULL,
 "sourceKind" VARCHAR(16) NOT NULL,
 "receiptScope" VARCHAR(64), "receiptOperationKey" VARCHAR(256),
 "baselineStateId" TEXT, "baselineFingerprint" VARCHAR(64),
 "namespace" VARCHAR(64) NOT NULL, "objectKey" VARCHAR(256) NOT NULL,
 "generation" VARCHAR(64) NOT NULL, "part" VARCHAR(32) NOT NULL, "policy" VARCHAR(32) NOT NULL,
 "chargedBytes" BIGINT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "MediaStoredComponent_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "MediaStoredComponent_receipt_fkey" FOREIGN KEY ("receiptScope","receiptOperationKey") REFERENCES "MediaUploadReceipt"(scope,"operationKey") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "MediaStoredComponent_baseline_fkey" FOREIGN KEY ("baselineStateId") REFERENCES "MediaBudgetState"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "MediaStoredComponent_source" CHECK (
  ("sourceKind"='RECEIPT' AND "receiptScope" IS NOT NULL AND "receiptOperationKey" IS NOT NULL AND "baselineStateId" IS NULL AND "baselineFingerprint" IS NULL) OR
  ("sourceKind"='BASELINE' AND "receiptScope" IS NULL AND "receiptOperationKey" IS NULL AND "baselineStateId" IS NOT NULL AND "baselineStateId"='global' AND "baselineFingerprint" IS NOT NULL)),
 CONSTRAINT "MediaStoredComponent_shape" CHECK (
  "id" ~ '^[a-f0-9]{64}$' AND "chargedBytes">0 AND length("objectKey")>0 AND length("generation")>0 AND
  ("baselineFingerprint" IS NULL OR "baselineFingerprint" ~ '^[a-f0-9]{64}$') AND
  (("policy"='AGGREGATE_NEVER' AND "part" IN ('aggregate','knowledge-media')) OR
   ("policy"='AVATAR_VARIANT' AND "part" IN ('avatar-full','avatar-small') AND "namespace"='avatar') OR
   ("policy"='KNOWLEDGE_JOURNAL' AND "part"='knowledge-journal' AND "namespace"='knowledge')))
);
CREATE UNIQUE INDEX "MediaStoredComponent_namespace_objectKey_generation_part_key" ON "MediaStoredComponent"("namespace","objectKey",generation,part);
CREATE INDEX "MediaStoredComponent_receiptScope_receiptOperationKey_idx" ON "MediaStoredComponent"("receiptScope","receiptOperationKey");
CREATE TABLE "MediaRetirementIntent" (
 "id" VARCHAR(64) NOT NULL, "componentId" VARCHAR(64) NOT NULL,
 "identityFingerprint" VARCHAR(64) NOT NULL, "authorityFingerprint" VARCHAR(64) NOT NULL,
 "state" VARCHAR(16) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL, "acknowledgedAt" TIMESTAMPTZ(3),
 CONSTRAINT "MediaRetirementIntent_pkey" PRIMARY KEY(id),
 CONSTRAINT "MediaRetirementIntent_componentId_fkey" FOREIGN KEY("componentId") REFERENCES "MediaStoredComponent"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "MediaRetirementIntent_shape" CHECK (
  id ~ '^[a-f0-9]{64}$' AND "identityFingerprint" ~ '^[a-f0-9]{64}$' AND "authorityFingerprint" ~ '^[a-f0-9]{64}$' AND
  state IN ('PREPARED','ACKNOWLEDGED') AND ((state='ACKNOWLEDGED')=("acknowledgedAt" IS NOT NULL)) AND ("acknowledgedAt" IS NULL OR "acknowledgedAt">="createdAt"))
);
CREATE UNIQUE INDEX "MediaRetirementIntent_componentId_key" ON "MediaRetirementIntent"("componentId");
CREATE UNIQUE INDEX "MediaRetirementIntent_id_componentId_key" ON "MediaRetirementIntent"(id,"componentId");
CREATE TABLE "MediaStorageCredit" (
 "componentId" VARCHAR(64) NOT NULL, "intentId" VARCHAR(64) NOT NULL,
 bytes BIGINT NOT NULL, "evidenceFingerprint" VARCHAR(64) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "MediaStorageCredit_pkey" PRIMARY KEY("componentId"),
 CONSTRAINT "MediaStorageCredit_componentId_fkey" FOREIGN KEY("componentId") REFERENCES "MediaStoredComponent"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "MediaStorageCredit_intentId_fkey" FOREIGN KEY("intentId","componentId") REFERENCES "MediaRetirementIntent"(id,"componentId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "MediaStorageCredit_shape" CHECK (bytes>0 AND "evidenceFingerprint" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "MediaStorageCredit_intentId_key" ON "MediaStorageCredit"("intentId");
CREATE UNIQUE INDEX "MediaStorageCredit_intentId_componentId_key" ON "MediaStorageCredit"("intentId","componentId");
