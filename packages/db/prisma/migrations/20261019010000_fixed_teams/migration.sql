-- CreateTable
CREATE TABLE "FixedTeam" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "commonTimes" TEXT NOT NULL DEFAULT '',
    "qqGroupId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dissolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "FixedTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamSeat" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "ActivitySeatKind" NOT NULL,
    "role" "ActivityRole",
    "job" TEXT,

    CONSTRAINT "TeamSeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMembership" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "seatId" TEXT,
    "accountId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "job" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMPTZ(3),

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamApplication" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TeamApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamSession" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PROPOSED',
    "timeVersion" INTEGER NOT NULL DEFAULT 0,
    "confirmedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamFeedback" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "timeVersion" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "choice" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TeamFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamSessionMember" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "timeVersion" INTEGER NOT NULL,
    "membershipId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "job" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'MEMBER',

    CONSTRAINT "TeamSessionMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamCommand" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamNotification" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "recipientId" TEXT,
    "kind" TEXT NOT NULL,
    "channel" "ActivityNotificationChannel" NOT NULL,
    "qqGroupTarget" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "simulatedAt" TIMESTAMPTZ(3) NOT NULL,
    "messageReadAt" TIMESTAMPTZ(3),
    "messageDeletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TeamNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FixedTeam_state_createdAt_id_idx" ON "FixedTeam"("state", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FixedTeam_creatorId_idempotencyKey_key" ON "FixedTeam"("creatorId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TeamSeat_teamId_position_key" ON "TeamSeat"("teamId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "TeamSeat_id_teamId_key" ON "TeamSeat"("id", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMembership_seatId_key" ON "TeamMembership"("seatId");

-- CreateIndex
CREATE INDEX "TeamMembership_teamId_accountId_state_idx" ON "TeamMembership"("teamId", "accountId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMembership_seatId_teamId_key" ON "TeamMembership"("seatId", "teamId");

-- CreateIndex
CREATE INDEX "TeamApplication_teamId_state_createdAt_idx" ON "TeamApplication"("teamId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "TeamApplication_accountId_createdAt_idx" ON "TeamApplication"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "TeamSession_teamId_startsAt_id_idx" ON "TeamSession"("teamId", "startsAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TeamFeedback_sessionId_timeVersion_accountId_key" ON "TeamFeedback"("sessionId", "timeVersion", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamSessionMember_sessionId_timeVersion_position_key" ON "TeamSessionMember"("sessionId", "timeVersion", "position");

-- CreateIndex
CREATE UNIQUE INDEX "TeamCommand_teamId_actorId_idempotencyKey_key" ON "TeamCommand"("teamId", "actorId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TeamNotification_eventKey_key" ON "TeamNotification"("eventKey");

-- CreateIndex
CREATE INDEX "TeamNotification_recipientId_channel_messageReadAt_createdA_idx" ON "TeamNotification"("recipientId", "channel", "messageReadAt", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "FixedTeam" ADD CONSTRAINT "FixedTeam_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSeat" ADD CONSTRAINT "TeamSeat_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "FixedTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "FixedTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_seatId_teamId_fkey" FOREIGN KEY ("seatId", "teamId") REFERENCES "TeamSeat"("id", "teamId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamApplication" ADD CONSTRAINT "TeamApplication_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "FixedTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamApplication" ADD CONSTRAINT "TeamApplication_seatId_teamId_fkey" FOREIGN KEY ("seatId", "teamId") REFERENCES "TeamSeat"("id", "teamId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamApplication" ADD CONSTRAINT "TeamApplication_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSession" ADD CONSTRAINT "TeamSession_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "FixedTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamFeedback" ADD CONSTRAINT "TeamFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TeamSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamFeedback" ADD CONSTRAINT "TeamFeedback_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSessionMember" ADD CONSTRAINT "TeamSessionMember_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TeamSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSessionMember" ADD CONSTRAINT "TeamSessionMember_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "TeamMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSessionMember" ADD CONSTRAINT "TeamSessionMember_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamCommand" ADD CONSTRAINT "TeamCommand_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "FixedTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamCommand" ADD CONSTRAINT "TeamCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamNotification" ADD CONSTRAINT "TeamNotification_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "FixedTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamNotification" ADD CONSTRAINT "TeamNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Isolate fixed-team lifecycle and preserve former roster/feedback history.
CREATE UNIQUE INDEX "TeamMembership_active_account_key" ON "TeamMembership" ("teamId", "accountId") WHERE "state" = 'ACTIVE';
ALTER TABLE "FixedTeam" ADD CONSTRAINT "FixedTeam_state_check" CHECK ("state" IN ('ACTIVE','DISSOLVED'));
ALTER TABLE "TeamSeat" ADD CONSTRAINT "TeamSeat_shape_check" CHECK ("position" BETWEEN 0 AND 7 AND (("kind"='ROLE' AND "role" IS NOT NULL AND "job" IS NULL) OR ("kind"='JOB' AND "job" IS NOT NULL AND "role" IS NULL)));
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_state_check" CHECK ("position" BETWEEN 0 AND 7 AND (("state"='ACTIVE' AND "seatId" IS NOT NULL AND "leftAt" IS NULL) OR ("state" IN ('LEFT','REMOVED') AND "seatId" IS NULL AND "leftAt" IS NOT NULL)));
ALTER TABLE "TeamApplication" ADD CONSTRAINT "TeamApplication_state_check" CHECK (("state"='PENDING' AND "decidedAt" IS NULL) OR ("state" IN ('ACCEPTED','REJECTED') AND "decidedAt" IS NOT NULL));
ALTER TABLE "TeamSession" ADD CONSTRAINT "TeamSession_state_check" CHECK ("endsAt">"startsAt" AND "timeVersion">=0 AND (("state"='PROPOSED' AND "confirmedAt" IS NULL AND "cancelledAt" IS NULL) OR ("state"='CONFIRMED' AND "confirmedAt" IS NOT NULL AND "cancelledAt" IS NULL) OR ("state"='CANCELLED' AND "cancelledAt" IS NOT NULL)));
ALTER TABLE "TeamFeedback" ADD CONSTRAINT "TeamFeedback_choice_check" CHECK ("choice" IN ('CAN','CANNOT') AND "timeVersion">=0);
ALTER TABLE "TeamSessionMember" ADD CONSTRAINT "TeamSessionMember_position_check" CHECK ("position" BETWEEN 0 AND 7 AND "timeVersion">=0 AND "state" IN ('MEMBER','NEEDS_SUBSTITUTE'));
ALTER TABLE "TeamNotification" ADD CONSTRAINT "TeamNotification_route_check" CHECK (("channel"='IN_APP' AND "recipientId" IS NOT NULL AND "qqGroupTarget" IS NULL) OR ("channel"='QQ' AND "recipientId" IS NULL AND "qqGroupTarget" IS NOT NULL));
