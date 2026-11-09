-- Add interactions without rewriting articles, old categories, or notification history.
ALTER TABLE "KnowledgeComment" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KnowledgeImage" ADD COLUMN "commentId" TEXT;
ALTER TABLE "KnowledgeImage" ADD COLUMN "commentPosition" INTEGER;
ALTER TABLE "KnowledgeImage" ADD CONSTRAINT "KnowledgeImage_commentId_fkey"
 FOREIGN KEY ("commentId") REFERENCES "KnowledgeComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "KnowledgeArticleInteraction" (
 "id" TEXT NOT NULL,
 "articleId" TEXT NOT NULL,
 "accountId" TEXT NOT NULL,
 "likedAt" TIMESTAMPTZ(3),
 "collectedAt" TIMESTAMPTZ(3),
 "likeNotifiedAt" TIMESTAMPTZ(3),
 "collectionNotifiedAt" TIMESTAMPTZ(3),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "KnowledgeArticleInteraction_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "KnowledgeArticleInteraction_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "KnowledgeArticleInteraction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "KnowledgeArticleInteraction_articleId_accountId_key" ON "KnowledgeArticleInteraction"("articleId","accountId");
CREATE INDEX "KnowledgeArticleInteraction_articleId_likedAt_idx" ON "KnowledgeArticleInteraction"("articleId","likedAt");
CREATE INDEX "KnowledgeArticleInteraction_articleId_collectedAt_idx" ON "KnowledgeArticleInteraction"("articleId","collectedAt");
CREATE TABLE "KnowledgeArticleRead" (
 "id" TEXT NOT NULL,
 "articleId" TEXT NOT NULL,
 "sessionKey" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "KnowledgeArticleRead_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "KnowledgeArticleRead_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "KnowledgeArticleRead_articleId_sessionKey_key" ON "KnowledgeArticleRead"("articleId","sessionKey");
INSERT INTO "KnowledgeCategory" (id,label,active,revision)
 SELECT gen_random_uuid()::text,label,true,0 FROM (VALUES
 ('日常杂谈'),('同人创作'),('剧情讨论'),('游戏记录'),('举手提问'),('建议和BUG反馈')
 ) AS requested(label) ON CONFLICT (label) DO NOTHING;
