ALTER TABLE "ActivityPenalty" DROP CONSTRAINT "ActivityPenalty_points_check";
ALTER TABLE "ActivityPenalty" ADD CONSTRAINT "ActivityPenalty_points_check" CHECK (
 ("reason" = 'LATE_WITHDRAWAL' AND "points" = 1) OR
 ("reason" IN ('LATE_CANCELLATION','NO_SHOW','SERIES_UNAGREED_ABSENCE','SERIES_UNCOMMUNICATED_EXIT') AND "points" = 2)
);
