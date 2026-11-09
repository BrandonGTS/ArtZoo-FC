-- Preserve every existing invitation and account; removal is reversible metadata.
ALTER TABLE "Invitation" ADD COLUMN "removedAt" TIMESTAMP(3),
ADD COLUMN "tokenCiphertext" TEXT;

-- Identity audit pages filter by action and order by time/id.
CREATE INDEX "AccountAudit_action_createdAt_id_idx" ON "AccountAudit"("action", "createdAt", "id");
