-- Explicit recruitment completion is independent of team lifecycle.
-- Existing teams retain NULL; fullness is never treated as completion.
ALTER TABLE "FixedTeam" ADD COLUMN "recruitmentCompletedAt" TIMESTAMPTZ(3);
CREATE INDEX "FixedTeam_recruitmentCompletedAt_state_createdAt_idx"
  ON "FixedTeam" ("recruitmentCompletedAt", "state", "createdAt");
