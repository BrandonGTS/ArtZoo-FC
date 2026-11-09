-- AlterTable
ALTER TABLE "KnowledgeArticle" ADD COLUMN     "bodyFormat" TEXT NOT NULL DEFAULT 'PLAIN';

-- AlterTable
ALTER TABLE "KnowledgeVersion" ADD COLUMN     "bodyFormat" TEXT NOT NULL DEFAULT 'PLAIN';

-- CreateTable
CREATE TABLE "KnowledgeImage" (
    "id" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "articleId" TEXT,
    "batchId" TEXT NOT NULL,
    "batchIndex" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "frames" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeImage_articleId_idx" ON "KnowledgeImage"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeImage_uploaderId_batchId_batchIndex_key" ON "KnowledgeImage"("uploaderId", "batchId", "batchIndex");

-- AddForeignKey
ALTER TABLE "KnowledgeImage" ADD CONSTRAINT "KnowledgeImage_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeImage" ADD CONSTRAINT "KnowledgeImage_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_bodyFormat_check" CHECK ("bodyFormat" IN ('PLAIN','RICH_V1'));
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_bodyFormat_check" CHECK ("bodyFormat" IN ('PLAIN','RICH_V1'));
ALTER TABLE "KnowledgeImage" ADD CONSTRAINT "KnowledgeImage_batchIndex_check" CHECK ("batchIndex" BETWEEN 0 AND 9);
ALTER TABLE "KnowledgeImage" ADD CONSTRAINT "KnowledgeImage_dimensions_check" CHECK (width>0 AND height>0 AND frames>0 AND bytes>0 AND bytes<=31457280);
