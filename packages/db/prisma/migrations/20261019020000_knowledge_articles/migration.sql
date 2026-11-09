-- CreateTable
CREATE TABLE "KnowledgeCategory" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "KnowledgeCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeArticle" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "submissionKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "jobs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "playstyles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gameVersions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "editMode" TEXT NOT NULL DEFAULT 'AUTHOR',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeVersion" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "editorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "restoredFromId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeContribution" (
    "articleId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeContribution_pkey" PRIMARY KEY ("articleId","accountId")
);

-- CreateTable
CREATE TABLE "KnowledgeComment" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "parentId" TEXT,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "submissionKey" TEXT NOT NULL,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeNotification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageReadAt" TIMESTAMPTZ(3),
    "messageDeletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "KnowledgeNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeAudit" (
    "id" TEXT NOT NULL,
    "articleId" TEXT,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeCategory_label_key" ON "KnowledgeCategory"("label");

-- CreateIndex
CREATE INDEX "KnowledgeArticle_categoryId_createdAt_id_idx" ON "KnowledgeArticle"("categoryId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeArticle_authorId_submissionKey_key" ON "KnowledgeArticle"("authorId", "submissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVersion_articleId_number_key" ON "KnowledgeVersion"("articleId", "number");

-- CreateIndex
CREATE INDEX "KnowledgeComment_articleId_createdAt_id_idx" ON "KnowledgeComment"("articleId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeComment_authorId_submissionKey_key" ON "KnowledgeComment"("authorId", "submissionKey");

-- CreateIndex
CREATE INDEX "KnowledgeNotification_recipientId_createdAt_id_idx" ON "KnowledgeNotification"("recipientId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeNotification_commentId_recipientId_key" ON "KnowledgeNotification"("commentId", "recipientId");

-- AddForeignKey
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "KnowledgeCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeContribution" ADD CONSTRAINT "KnowledgeContribution_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeContribution" ADD CONSTRAINT "KnowledgeContribution_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeComment" ADD CONSTRAINT "KnowledgeComment_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeComment" ADD CONSTRAINT "KnowledgeComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeComment" ADD CONSTRAINT "KnowledgeComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "KnowledgeComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeNotification" ADD CONSTRAINT "KnowledgeNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeNotification" ADD CONSTRAINT "KnowledgeNotification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "KnowledgeComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeAudit" ADD CONSTRAINT "KnowledgeAudit_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeAudit" ADD CONSTRAINT "KnowledgeAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_editMode_check" CHECK ("editMode" IN ('AUTHOR','COMMUNITY'));
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_revision_check" CHECK (revision >= 0);
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_number_check" CHECK (number > 0);
