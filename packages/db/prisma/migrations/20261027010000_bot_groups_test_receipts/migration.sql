-- Additive management registry, no new group automatically enabled or historical events copied.
ALTER TABLE "BotManagementObservation" ADD COLUMN "groupRevision" INTEGER, ADD COLUMN "groupDigest" TEXT;
ALTER TABLE "BotManagementTest" ADD COLUMN "actorId" TEXT, ADD COLUMN "providerMessageId" TEXT, ADD COLUMN "refIdx" TEXT, ADD COLUMN "receiptDigest" TEXT, ADD COLUMN "sentAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "BotManagementTest_receiptDigest_key" ON "BotManagementTest"("receiptDigest");
CREATE TABLE "BotGroupState" ("id" TEXT PRIMARY KEY,"revision" INTEGER NOT NULL DEFAULT 0);
CREATE TABLE "BotGroup" ("id" TEXT PRIMARY KEY,"appId" TEXT NOT NULL,"botId" TEXT NOT NULL,"groupOpenId" TEXT NOT NULL,"label" TEXT NOT NULL,"enabled" BOOLEAN NOT NULL DEFAULT false,"enabledAt" TIMESTAMPTZ(3),"generation" INTEGER NOT NULL DEFAULT 1,"boundAt" TIMESTAMPTZ(3) NOT NULL,"legacy" BOOLEAN NOT NULL DEFAULT false,"createdById" TEXT,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "BotGroup_appId_botId_groupOpenId_key" ON "BotGroup"("appId","botId","groupOpenId");
CREATE TABLE "BotGroupChallenge" ("id" TEXT PRIMARY KEY,"accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,"sessionId" TEXT NOT NULL,"label" TEXT NOT NULL,"publicCodeHash" TEXT NOT NULL UNIQUE,"browserProofHash" TEXT NOT NULL,"selectedCandidateId" TEXT,"expiresAt" TIMESTAMPTZ(3) NOT NULL,"invalidatedAt" TIMESTAMPTZ(3),"consumedAt" TIMESTAMPTZ(3),"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "BotGroupChallenge_accountId_expiresAt_idx" ON "BotGroupChallenge"("accountId","expiresAt");
CREATE TABLE "BotGroupCandidate" ("id" TEXT PRIMARY KEY,"challengeId" TEXT NOT NULL REFERENCES "BotGroupChallenge"("id") ON DELETE RESTRICT,"appId" TEXT NOT NULL,"botId" TEXT NOT NULL,"groupOpenId" TEXT NOT NULL,"memberOpenId" TEXT NOT NULL,"receiptCodeHash" TEXT NOT NULL UNIQUE,"finalProofHash" TEXT UNIQUE,"provenAt" TIMESTAMPTZ(3),"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "BotGroupCandidate_challengeId_appId_botId_groupOpenId_memberOpenId_key" ON "BotGroupCandidate"("challengeId","appId","botId","groupOpenId","memberOpenId");
ALTER TABLE "QqOfficialDelivery" ADD COLUMN "groupGeneration" INTEGER;
