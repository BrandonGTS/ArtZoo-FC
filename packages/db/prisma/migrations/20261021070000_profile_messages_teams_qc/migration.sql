-- New UI fields retain all historical team values. No historical notifications are generated.
ALTER TABLE "FixedTeam" ADD COLUMN "dutyName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "progress" TEXT NOT NULL DEFAULT '', ADD COLUMN "strategy" TEXT NOT NULL DEFAULT '';
CREATE TABLE "MessageNotification" (
 "id" TEXT NOT NULL, "recipientId" TEXT NOT NULL, "actorId" TEXT,
 "kind" TEXT NOT NULL, "sourceType" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
 "commentId" TEXT, "eventKey" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "readAt" TIMESTAMPTZ(3), "deletedAt" TIMESTAMPTZ(3),
 CONSTRAINT "MessageNotification_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "MessageNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "MessageNotification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MessageNotification_eventKey_key" ON "MessageNotification"("eventKey");
CREATE INDEX "MessageNotification_recipientId_deletedAt_createdAt_id_idx" ON "MessageNotification"("recipientId","deletedAt","createdAt","id");
CREATE INDEX "MessageNotification_recipientId_readAt_deletedAt_idx" ON "MessageNotification"("recipientId","readAt","deletedAt");
