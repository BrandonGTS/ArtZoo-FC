-- Additive, dormant until a super-administrator explicitly publishes a config.
CREATE TABLE "BotManagementState"("id" TEXT PRIMARY KEY,"scope" JSONB NOT NULL,"draft" JSONB NOT NULL,"draftRevision" INTEGER NOT NULL DEFAULT 0,"publishedVersion" INTEGER NOT NULL DEFAULT 0,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "BotManagementPublication"("version" INTEGER PRIMARY KEY,"digest" TEXT NOT NULL,"scope" JSONB NOT NULL,"config" JSONB NOT NULL,"actorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "BotManagementAudit"("id" TEXT PRIMARY KEY,"actorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,"idempotencyKey" TEXT NOT NULL,"fingerprint" TEXT NOT NULL,"action" TEXT NOT NULL,"before" JSONB NOT NULL,"after" JSONB NOT NULL,"result" JSONB NOT NULL,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "BotManagementAudit_actorId_idempotencyKey_key" ON "BotManagementAudit"("actorId","idempotencyKey");
CREATE INDEX "BotManagementAudit_createdAt_id_idx" ON "BotManagementAudit"("createdAt","id");
CREATE TABLE "BotManagementObservation"("id" TEXT PRIMARY KEY,"reportedVersion" INTEGER NOT NULL,"reportedDigest" TEXT,"applyError" TEXT,"telemetry" JSONB NOT NULL,"observedAt" TIMESTAMPTZ(3) NOT NULL);
CREATE TABLE "BotManagementTest"("id" TEXT PRIMARY KEY,"version" INTEGER NOT NULL REFERENCES "BotManagementPublication"("version") ON DELETE RESTRICT,"scope" JSONB NOT NULL,"content" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'PENDING',"leaseOwner" TEXT,"leaseUntil" TIMESTAMPTZ(3),"expiresAt" TIMESTAMPTZ(3) NOT NULL,"resultCode" TEXT,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "BotManagementTest_status_createdAt_idx" ON "BotManagementTest"("status","createdAt");
ALTER TABLE "QqOfficialDelivery" ADD COLUMN "renderedContent" TEXT, ADD COLUMN "managementVersion" INTEGER;
CREATE TABLE "BotManagementSendRecord"("id" TEXT PRIMARY KEY,"direction" TEXT NOT NULL,"outcome" TEXT NOT NULL,"eventAt" TIMESTAMPTZ(3) NOT NULL,"observedAt" TIMESTAMPTZ(3) NOT NULL);
CREATE INDEX "BotManagementSendRecord_eventAt_id_idx" ON "BotManagementSendRecord"("eventAt","id");
ALTER TABLE "BotManagementPublication" ADD COLUMN "notificationEpoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "QqOfficialDelivery" ADD COLUMN "planningEpoch" INTEGER;
