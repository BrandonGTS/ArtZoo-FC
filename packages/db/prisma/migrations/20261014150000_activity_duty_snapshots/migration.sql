-- Nullable additive fields intentionally keep previously published activities unchanged.
-- The catalog is maintained in source, not in database rows or a foreign key.
ALTER TABLE "Activity" ADD COLUMN "dutyId" TEXT;
ALTER TABLE "Activity" ADD COLUMN "dutySnapshot" JSONB;
ALTER TABLE "ActivitySeat" ADD COLUMN "groupKey" TEXT;
ALTER TABLE "ActivitySeat" ADD CONSTRAINT "ActivitySeat_groupKey_check"
  CHECK ("groupKey" IS NULL OR "groupKey" IN ('A', 'B', 'C'));
