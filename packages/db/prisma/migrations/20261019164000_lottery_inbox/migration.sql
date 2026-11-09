-- Existing notifications retain NULL message IDs: do not replay historical notices.
ALTER TABLE "LotteryNotification" ADD COLUMN "messageId" text;
ALTER TABLE "LotteryNotification" ALTER COLUMN "messageId" SET DEFAULT gen_random_uuid()::text;
ALTER TABLE "LotteryNotification" ADD COLUMN "readAt" timestamptz(3), ADD COLUMN "deletedAt" timestamptz(3);
CREATE UNIQUE INDEX "LotteryNotification_messageId_key" ON "LotteryNotification"("messageId");
CREATE INDEX "LotteryNotification_recipient_created_idx" ON "LotteryNotification"("recipientId","createdAt","messageId");
