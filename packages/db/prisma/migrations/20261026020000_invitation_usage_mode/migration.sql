-- Preserve every existing invitation as single-use. No existing lifecycle data is rewritten.
CREATE TYPE "InvitationUsageMode" AS ENUM ('SINGLE', 'MULTIPLE');
ALTER TABLE "Invitation" ADD COLUMN "usageMode" "InvitationUsageMode" NOT NULL DEFAULT 'SINGLE';
