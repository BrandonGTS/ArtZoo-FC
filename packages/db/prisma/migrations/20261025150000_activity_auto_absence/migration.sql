-- Existing activities remain unopted-in. Only rows inserted after adoption receive the default.
ALTER TABLE "Activity" ADD COLUMN "autoAbsenceEnabledAt" TIMESTAMPTZ(3);
ALTER TABLE "Activity" ALTER COLUMN "autoAbsenceEnabledAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ActivityRegistration" ADD COLUMN "attendanceSource" TEXT;
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_attendance_source_check" CHECK (
  "attendanceSource" IS NULL OR
  ("attendanceSource" IN ('ORGANIZER','AUTO_DEADLINE') AND "attendanceStatus" IS NOT NULL AND "attendanceRecordedAt" IS NOT NULL)
);
CREATE INDEX "Activity_autoAbsenceEnabledAt_endsAt_id_idx" ON "Activity"("endsAt","id")
  WHERE "autoAbsenceEnabledAt" IS NOT NULL AND "scene"='GAME' AND "mode"='SINGLE' AND "cancelledAt" IS NULL;
