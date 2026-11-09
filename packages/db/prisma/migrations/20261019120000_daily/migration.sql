-- CreateTable
CREATE TABLE "DailyPost" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mentions" TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMPTZ(3),
    "removedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DailyPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyMedia" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "postId" TEXT,
    "batchId" TEXT NOT NULL,
    "batchIndex" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "frames" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "mentions" TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DailyComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyLike" (
    "postId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,

    CONSTRAINT "DailyLike_pkey" PRIMARY KEY ("postId","accountId")
);

-- CreateTable
CREATE TABLE "DailyCommand" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "submissionKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyNotification" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "commentId" TEXT,
    "recipientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DailyNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyAudit" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "commentId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyPost_createdAt_id_idx" ON "DailyPost"("createdAt", "id");

-- CreateIndex
CREATE INDEX "DailyPost_authorId_createdAt_id_idx" ON "DailyPost"("authorId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "DailyMedia_postId_position_idx" ON "DailyMedia"("postId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMedia_ownerId_batchId_batchIndex_key" ON "DailyMedia"("ownerId", "batchId", "batchIndex");

-- CreateIndex
CREATE INDEX "DailyComment_postId_createdAt_id_idx" ON "DailyComment"("postId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DailyCommand_actorId_submissionKey_key" ON "DailyCommand"("actorId", "submissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "DailyNotification_eventKey_key" ON "DailyNotification"("eventKey");

-- CreateIndex
CREATE INDEX "DailyNotification_recipientId_deletedAt_readAt_createdAt_idx" ON "DailyNotification"("recipientId", "deletedAt", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "DailyAudit_postId_createdAt_idx" ON "DailyAudit"("postId", "createdAt");

-- AddForeignKey
ALTER TABLE "DailyPost" ADD CONSTRAINT "DailyPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyMedia" ADD CONSTRAINT "DailyMedia_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyMedia" ADD CONSTRAINT "DailyMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DailyPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyComment" ADD CONSTRAINT "DailyComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DailyPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyComment" ADD CONSTRAINT "DailyComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyComment" ADD CONSTRAINT "DailyComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DailyComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyLike" ADD CONSTRAINT "DailyLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DailyPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyLike" ADD CONSTRAINT "DailyLike_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyCommand" ADD CONSTRAINT "DailyCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNotification" ADD CONSTRAINT "DailyNotification_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DailyPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNotification" ADD CONSTRAINT "DailyNotification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "DailyComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNotification" ADD CONSTRAINT "DailyNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyAudit" ADD CONSTRAINT "DailyAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyAudit" ADD CONSTRAINT "DailyAudit_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DailyPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyAudit" ADD CONSTRAINT "DailyAudit_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "DailyComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
