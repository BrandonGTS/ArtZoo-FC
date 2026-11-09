-- Additive records only. Existing confirmed rosters and historical membership remain intact.
ALTER TABLE "TeamSessionMember" ADD COLUMN "confirmedStartsAt" TIMESTAMPTZ(3), ADD COLUMN "confirmedEndsAt" TIMESTAMPTZ(3);
-- Only the current version has trustworthy legacy times. Never relabel older roster versions.
UPDATE "TeamSessionMember" m SET "confirmedStartsAt"=s."startsAt", "confirmedEndsAt"=s."endsAt" FROM "TeamSession" s WHERE m."sessionId"=s."id" AND m."timeVersion"=s."timeVersion";
CREATE TABLE "TeamSessionLeave" (
 "id" TEXT NOT NULL PRIMARY KEY, "memberId" TEXT NOT NULL UNIQUE,
 "reason" TEXT NOT NULL, "recordedById" TEXT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "TeamSessionLeave_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "TeamSessionMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TeamSessionLeave_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TeamSessionLeave_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1000)
);
CREATE TABLE "TeamSessionSubstitute" (
 "id" TEXT NOT NULL PRIMARY KEY, "sessionId" TEXT NOT NULL, "timeVersion" INTEGER NOT NULL,
 "position" INTEGER NOT NULL, "kind" TEXT NOT NULL, "accountId" TEXT,
 "confirmedStartsAt" TIMESTAMPTZ(3) NOT NULL, "confirmedEndsAt" TIMESTAMPTZ(3) NOT NULL,
 "displayName" TEXT, "gameRegion" TEXT, "gameServer" TEXT, "job" TEXT NOT NULL,
 "recordedById" TEXT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL, "endedAt" TIMESTAMPTZ(3),
 CONSTRAINT "TeamSessionSubstitute_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TeamSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TeamSessionSubstitute_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TeamSessionSubstitute_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TeamSessionSubstitute_shape_check" CHECK ("position" BETWEEN 0 AND 7 AND "timeVersion">=0 AND
 (("kind"='REGISTERED' AND "accountId" IS NOT NULL AND "displayName" IS NULL AND "gameRegion" IS NULL AND "gameServer" IS NULL) OR
 ("kind"='EXTERNAL' AND "accountId" IS NULL AND "displayName" IS NOT NULL AND "gameRegion" IS NOT NULL AND "gameServer" IS NOT NULL AND length(btrim("displayName"))>0 AND length(btrim("gameRegion"))>0 AND length(btrim("gameServer"))>0))),
 CONSTRAINT "TeamSessionSubstitute_period_check" CHECK ("confirmedEndsAt">"confirmedStartsAt"),
 CONSTRAINT "TeamSessionSubstitute_time_check" CHECK ("endedAt" IS NULL OR "endedAt">="createdAt")
);
CREATE INDEX "TeamSessionSubstitute_sessionId_timeVersion_position_idx" ON "TeamSessionSubstitute"("sessionId","timeVersion","position");
CREATE UNIQUE INDEX "TeamSessionSubstitute_active_position_key" ON "TeamSessionSubstitute"("sessionId","timeVersion","position") WHERE "endedAt" IS NULL;
CREATE UNIQUE INDEX "TeamSessionSubstitute_active_account_key" ON "TeamSessionSubstitute"("sessionId","timeVersion","accountId") WHERE "endedAt" IS NULL AND "accountId" IS NOT NULL;
