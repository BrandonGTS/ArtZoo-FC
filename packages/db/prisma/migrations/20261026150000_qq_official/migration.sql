-- CreateTable
CREATE TABLE "QqOfficialBinding" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "groupOpenId" TEXT NOT NULL,
    "memberOpenId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QqOfficialBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QqOfficialBindingAudit" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "identityDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QqOfficialBindingAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QqOfficialChallenge" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "publicCodeHash" TEXT NOT NULL,
    "browserProofHash" TEXT NOT NULL,
    "selectedCandidateId" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "invalidatedAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QqOfficialChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QqOfficialCandidate" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "groupOpenId" TEXT NOT NULL,
    "memberOpenId" TEXT NOT NULL,
    "receiptCodeHash" TEXT NOT NULL,
    "finalProofHash" TEXT,
    "selectedAt" TIMESTAMPTZ(3),
    "provenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QqOfficialCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QqOfficialMessage" (
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "groupOpenId" TEXT NOT NULL,
    "refIdx" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QqOfficialMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QqOfficialInbound" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "groupOpenId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QqOfficialInbound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QqOfficialNonce" (
    "id" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QqOfficialNonce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QqOfficialDelivery" (
    "deliveryMode" TEXT NOT NULL DEFAULT 'SIMULATION',
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "groupOpenId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "activityRevision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "fence" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMPTZ(3),
    "dispatchedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "resultCode" TEXT,
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QqOfficialDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialBinding_appId_botId_groupOpenId_memberOpenId_key" ON "QqOfficialBinding"("appId", "botId", "groupOpenId", "memberOpenId");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialBinding_appId_botId_groupOpenId_accountId_key" ON "QqOfficialBinding"("appId", "botId", "groupOpenId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialChallenge_publicCodeHash_key" ON "QqOfficialChallenge"("publicCodeHash");

-- CreateIndex
CREATE INDEX "QqOfficialChallenge_accountId_expiresAt_idx" ON "QqOfficialChallenge"("accountId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialCandidate_receiptCodeHash_key" ON "QqOfficialCandidate"("receiptCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialCandidate_finalProofHash_key" ON "QqOfficialCandidate"("finalProofHash");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialCandidate_challengeId_appId_botId_groupOpenId_mem_key" ON "QqOfficialCandidate"("challengeId", "appId", "botId", "groupOpenId", "memberOpenId");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialMessage_deliveryId_key" ON "QqOfficialMessage"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialMessage_appId_botId_groupOpenId_refIdx_key" ON "QqOfficialMessage"("appId", "botId", "groupOpenId", "refIdx");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialInbound_appId_botId_groupOpenId_eventKey_key" ON "QqOfficialInbound"("appId", "botId", "groupOpenId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialNonce_nonceHash_key" ON "QqOfficialNonce"("nonceHash");

-- CreateIndex
CREATE UNIQUE INDEX "QqOfficialDelivery_eventKey_key" ON "QqOfficialDelivery"("eventKey");

-- CreateIndex
CREATE INDEX "QqOfficialDelivery_status_dueAt_idx" ON "QqOfficialDelivery"("status", "dueAt");

-- CreateIndex
CREATE INDEX "QqOfficialDelivery_activityId_status_idx" ON "QqOfficialDelivery"("activityId", "status");

-- AddForeignKey
ALTER TABLE "QqOfficialBinding" ADD CONSTRAINT "QqOfficialBinding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QqOfficialBindingAudit" ADD CONSTRAINT "QqOfficialBindingAudit_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QqOfficialChallenge" ADD CONSTRAINT "QqOfficialChallenge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QqOfficialCandidate" ADD CONSTRAINT "QqOfficialCandidate_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "QqOfficialChallenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

