-- Receiver-side visibility only. Original notifications, delivery and business rows remain intact.
ALTER TABLE "ActivityOutbox" ADD COLUMN "messageDeletedAt" TIMESTAMPTZ(3);
ALTER TABLE "ActivityScoreChange" ADD COLUMN "messageDeletedAt" TIMESTAMPTZ(3);
