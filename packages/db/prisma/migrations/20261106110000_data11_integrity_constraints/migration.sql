-- DATA11 canonical integrity only; no data rewrite or DATA08 time conversion.
-- A single DO statement is atomic even when Prisma executes a migration statement by statement.
-- Session timeouts are set before the DO starts; no explicit transaction can remain aborted.
SET lock_timeout = '1s';
SET statement_timeout = '10s';
SET idle_in_transaction_session_timeout = '15s';

DO $data11$
BEGIN
ALTER TABLE public."QqOfficialDelivery" ADD CONSTRAINT "QqOfficialDelivery_status_check" CHECK ("status" IN ('PENDING','CLAIMED','DISPATCHING','SENT','SIMULATED','UNKNOWN','DENIED','FAILED','CANCELLED','EXPIRED')) NOT VALID;
ALTER TABLE public."BotManagementTest" ADD CONSTRAINT "BotManagementTest_status_check" CHECK ("status" IN ('PENDING','CLAIMED','DISPATCHING','SENT','SIMULATED','UNKNOWN','DENIED','CANCELLED','EXPIRED')) NOT VALID;
ALTER TABLE public."QqOfficialDelivery" ADD CONSTRAINT "QqOfficialDelivery_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public."AlbumPhoto" ADD CONSTRAINT "AlbumPhoto_uploadAlbumId_fkey" FOREIGN KEY ("uploadAlbumId") REFERENCES public."Album" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public."BotGroup" ADD CONSTRAINT "BotGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."Account" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public."BotManagementTest" ADD CONSTRAINT "BotManagementTest_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public."QqOfficialDelivery" VALIDATE CONSTRAINT "QqOfficialDelivery_status_check";
ALTER TABLE public."BotManagementTest" VALIDATE CONSTRAINT "BotManagementTest_status_check";
ALTER TABLE public."QqOfficialDelivery" VALIDATE CONSTRAINT "QqOfficialDelivery_activityId_fkey";
ALTER TABLE public."AlbumPhoto" VALIDATE CONSTRAINT "AlbumPhoto_uploadAlbumId_fkey";
ALTER TABLE public."BotGroup" VALIDATE CONSTRAINT "BotGroup_createdById_fkey";
ALTER TABLE public."BotManagementTest" VALIDATE CONSTRAINT "BotManagementTest_actorId_fkey";
END
$data11$;

RESET lock_timeout;
RESET statement_timeout;
RESET idle_in_transaction_session_timeout;
