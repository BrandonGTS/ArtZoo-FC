-- Existing accounts remain unassigned; no data rewrite or inferred server.
ALTER TABLE "Account" ADD COLUMN "gameRegion" TEXT, ADD COLUMN "gameServer" TEXT;
ALTER TABLE "Account" ADD CONSTRAINT "Account_game_location_pair_check"
CHECK (("gameRegion" IS NULL AND "gameServer" IS NULL)
    OR ("gameRegion" IS NOT NULL AND "gameServer" IS NOT NULL AND "displayName" IS NOT NULL));
-- Deterministic byte-wise identity: no case folding or Unicode normalization.
CREATE UNIQUE INDEX "Account_gameServer_displayName_key"
ON "Account" ("gameServer" COLLATE "C", "displayName" COLLATE "C");
