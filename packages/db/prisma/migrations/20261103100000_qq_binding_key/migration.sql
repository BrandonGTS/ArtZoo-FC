-- Additive only: existing confirmed bindings remain intact and usable as protocol 1.
ALTER TABLE "QqOfficialBinding" ADD COLUMN "protocolVersion" INTEGER NOT NULL DEFAULT 1;
CREATE TABLE "QqOfficialBindingKey" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "groupOpenId" TEXT NOT NULL,
  "enabledAt" TIMESTAMPTZ(3) NOT NULL,
  "keyHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3),
  "invalidatedAt" TIMESTAMPTZ(3),
  "bindingId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QqOfficialBindingKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QqOfficialBindingKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "QqOfficialBindingKey_keyHash_key" ON "QqOfficialBindingKey"("keyHash");
CREATE INDEX "QqOfficialBindingKey_accountId_expiresAt_idx" ON "QqOfficialBindingKey"("accountId", "expiresAt");
