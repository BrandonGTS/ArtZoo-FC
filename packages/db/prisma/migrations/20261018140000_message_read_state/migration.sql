-- Existing durable notifications remain intact. NULL means not yet marked read; no receipts are generated.
ALTER TABLE "ActivityOutbox" ADD COLUMN "messageReadAt" TIMESTAMPTZ(3);
ALTER TABLE "ActivityScoreChange" ADD COLUMN "messageReadAt" TIMESTAMPTZ(3);
CREATE INDEX "ActivityOutbox_recipientId_channel_messageReadAt_createdAt_id_idx" ON "ActivityOutbox"("recipientId","channel","messageReadAt","createdAt","id");
CREATE INDEX "ActivityScoreChange_accountId_messageReadAt_createdAt_id_idx" ON "ActivityScoreChange"("accountId","messageReadAt","createdAt","id");
