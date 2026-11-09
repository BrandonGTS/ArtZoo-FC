-- DATA07: non-unique query indexes only; no row rewrite, cleanup or business change.
-- Ordinary CREATE INDEX takes table locks. Production application is separately reviewed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE INDEX "AlbumPhoto_uploaderId_createdAt_id_idx" ON "AlbumPhoto" ("uploaderId", "createdAt", "id");
CREATE INDEX "TeamMembership_accountId_state_idx" ON "TeamMembership" ("accountId", "state");
CREATE INDEX "AlbumPhoto_albumId_createdAt_id_idx" ON "AlbumPhoto" ("albumId", "createdAt", "id");
CREATE INDEX "Album_createdAt_id_idx" ON "Album" ("createdAt", "id");
-- Prisma's configured schema cannot express these predicates / INCLUDE columns.
CREATE INDEX "Account_due_activity_decay_idx" ON "Account" ("activityDecayAt", "id") WHERE "activityPoints" >= 3;
CREATE INDEX "ActivityRegistration_pending_attendance_idx" ON "ActivityRegistration" ("activityId", "id") INCLUDE ("accountId")
  WHERE "status" = 'ACTIVE' AND "attendanceStatus" IS NULL AND "attendanceRecordedAt" IS NULL AND "attendancePenaltyId" IS NULL;
COMMIT;
