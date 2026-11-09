-- CreateEnum
CREATE TYPE "AlbumPrimaryCategory" AS ENUM ('GAME', 'OFFLINE', 'DAILY');

-- CreateEnum
CREATE TYPE "AlbumUploadMode" AS ENUM ('AUTHOR', 'COMMUNITY', 'ACTIVITY');

-- CreateTable
CREATE TABLE "AlbumCategory" (
    "id" TEXT NOT NULL,
    "primary" "AlbumPrimaryCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AlbumCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Album" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "primary" "AlbumPrimaryCategory" NOT NULL,
    "categoryId" TEXT,
    "uploadMode" "AlbumUploadMode" NOT NULL,
    "activityId" TEXT,
    "seriesId" TEXT,
    "uploadsClosed" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Album_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumPhoto" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "batchIndex" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "frames" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL DEFAULT '',
    "periodActivityId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "featuredAt" TIMESTAMPTZ(3),
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumComment" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "photoId" TEXT,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "submissionKey" TEXT NOT NULL,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumLike" (
    "photoId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumLike_pkey" PRIMARY KEY ("photoId","accountId")
);

-- CreateTable
CREATE TABLE "AlbumAudit" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "photoId" TEXT,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumNotification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "photoId" TEXT,
    "kind" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlbumCategory_primary_position_id_idx" ON "AlbumCategory"("primary", "position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AlbumCategory_primary_label_key" ON "AlbumCategory"("primary", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Album_activityId_key" ON "Album"("activityId");

-- CreateIndex
CREATE UNIQUE INDEX "Album_seriesId_key" ON "Album"("seriesId");

-- CreateIndex
CREATE INDEX "Album_primary_categoryId_createdAt_id_idx" ON "Album"("primary", "categoryId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AlbumPhoto_albumId_periodActivityId_createdAt_id_idx" ON "AlbumPhoto"("albumId", "periodActivityId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AlbumPhoto_featuredAt_removedAt_id_idx" ON "AlbumPhoto"("featuredAt", "removedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AlbumPhoto_albumId_uploaderId_batchId_batchIndex_key" ON "AlbumPhoto"("albumId", "uploaderId", "batchId", "batchIndex");

-- CreateIndex
CREATE INDEX "AlbumComment_albumId_photoId_createdAt_id_idx" ON "AlbumComment"("albumId", "photoId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AlbumComment_authorId_submissionKey_key" ON "AlbumComment"("authorId", "submissionKey");

-- CreateIndex
CREATE INDEX "AlbumAudit_albumId_createdAt_id_idx" ON "AlbumAudit"("albumId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AlbumNotification_recipientId_readAt_createdAt_id_idx" ON "AlbumNotification"("recipientId", "readAt", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AlbumNotification_recipientId_commentId_key" ON "AlbumNotification"("recipientId", "commentId");

-- AddForeignKey
ALTER TABLE "Album" ADD CONSTRAINT "Album_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Album" ADD CONSTRAINT "Album_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AlbumCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumPhoto" ADD CONSTRAINT "AlbumPhoto_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumPhoto" ADD CONSTRAINT "AlbumPhoto_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumComment" ADD CONSTRAINT "AlbumComment_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumComment" ADD CONSTRAINT "AlbumComment_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "AlbumPhoto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumComment" ADD CONSTRAINT "AlbumComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumComment" ADD CONSTRAINT "AlbumComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AlbumComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumLike" ADD CONSTRAINT "AlbumLike_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "AlbumPhoto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumLike" ADD CONSTRAINT "AlbumLike_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumAudit" ADD CONSTRAINT "AlbumAudit_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumAudit" ADD CONSTRAINT "AlbumAudit_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "AlbumPhoto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumAudit" ADD CONSTRAINT "AlbumAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumNotification" ADD CONSTRAINT "AlbumNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Keep all original activity/account records; only append album-owned relations and constraints.
ALTER TABLE "Album" ADD CONSTRAINT "Album_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Album" ADD CONSTRAINT "Album_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "ActivitySeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AlbumPhoto" ADD CONSTRAINT "AlbumPhoto_periodActivityId_fkey" FOREIGN KEY ("periodActivityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AlbumNotification" ADD CONSTRAINT "AlbumNotification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "AlbumComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AlbumNotification" ADD CONSTRAINT "AlbumNotification_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AlbumNotification" ADD CONSTRAINT "AlbumNotification_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "AlbumPhoto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Album" ADD CONSTRAINT "Album_upload_scope_check" CHECK (("uploadMode"='ACTIVITY') = ("activityId" IS NOT NULL) AND ("seriesId" IS NULL OR "activityId" IS NOT NULL));
ALTER TABLE "AlbumPhoto" ADD CONSTRAINT "AlbumPhoto_batch_index_check" CHECK ("batchIndex" BETWEEN 0 AND 9);
ALTER TABLE "AlbumPhoto" ADD CONSTRAINT "AlbumPhoto_media_bounds_check" CHECK (bytes BETWEEN 1 AND 31457280 AND width > 0 AND height > 0 AND frames BETWEEN 1 AND 300);
