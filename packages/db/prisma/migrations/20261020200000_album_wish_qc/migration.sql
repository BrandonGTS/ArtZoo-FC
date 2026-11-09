-- Approved album/photo and wish QC scope. Preserve original files and historical rows.
ALTER TABLE "AlbumPhoto" ADD COLUMN "rotation" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "AlbumPhoto_rotation_check" CHECK ("rotation" IN (0,90,180,270));
ALTER TABLE "AlbumComment" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "AlbumComment_id_albumId_key" ON "AlbumComment"("id","albumId");
CREATE TABLE "AlbumCommand" (
  "id" TEXT PRIMARY KEY, "actorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "submissionKey" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "result" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlbumCommand_actorId_submissionKey_key" UNIQUE ("actorId","submissionKey")
);
CREATE TABLE "AlbumCommentMedia" (
  "id" TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "albumId" TEXT NOT NULL REFERENCES "Album"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "commentId" TEXT, "batchId" TEXT NOT NULL, "batchIndex" INTEGER NOT NULL CHECK ("batchIndex" BETWEEN 0 AND 9),
  "fingerprint" TEXT NOT NULL, "mime" TEXT NOT NULL, "width" INTEGER NOT NULL CHECK ("width">0), "height" INTEGER NOT NULL CHECK ("height">0),
  "frames" INTEGER NOT NULL DEFAULT 1 CHECK ("frames" BETWEEN 1 AND 300), "position" INTEGER NOT NULL DEFAULT 0,
  "removedAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlbumCommentMedia_ownerId_batchId_batchIndex_key" UNIQUE ("ownerId","batchId","batchIndex"),
  CONSTRAINT "AlbumCommentMedia_commentId_albumId_fkey" FOREIGN KEY ("commentId","albumId") REFERENCES "AlbumComment"("id","albumId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "AlbumCommentMedia_albumId_commentId_removedAt_idx" ON "AlbumCommentMedia"("albumId","commentId","removedAt");
ALTER TABLE "Wish" ADD COLUMN "category" TEXT,
  ADD CONSTRAINT "Wish_category_check" CHECK ("category" IS NULL OR "category" IN ('MOUNT','CHALLENGE','CRAFT_GATHER','EXPLORE','ACHIEVEMENT','OTHER'));
-- Historical category stays NULL until the user confirms its presentation/classification.
ALTER TABLE "Wish" DROP CONSTRAINT "Wish_body_check",
  ADD CONSTRAINT "Wish_body_check" CHECK (char_length("body") BETWEEN 1 AND 11001);
-- Keep Wish_linked_not_deleted_check: completion atomically clears activityId while soft deleting.
ALTER TABLE "WishComment" ADD COLUMN "mentions" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "WishComment" DROP CONSTRAINT "WishComment_body_check",
  ADD CONSTRAINT "WishComment_body_check" CHECK (char_length("body") BETWEEN 0 AND 2000);
CREATE TABLE "WishMedia" (
  "id" TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "wishId" TEXT REFERENCES "Wish"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "commentId" TEXT, "batchId" TEXT NOT NULL, "batchIndex" INTEGER NOT NULL CHECK ("batchIndex" BETWEEN 0 AND 9),
  "fingerprint" TEXT NOT NULL, "mime" TEXT NOT NULL, "width" INTEGER NOT NULL CHECK ("width">0), "height" INTEGER NOT NULL CHECK ("height">0),
  "frames" INTEGER NOT NULL DEFAULT 1 CHECK ("frames" BETWEEN 1 AND 300), "position" INTEGER NOT NULL DEFAULT 0,
  "removedAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WishMedia_ownerId_batchId_batchIndex_key" UNIQUE ("ownerId","batchId","batchIndex"),
  CONSTRAINT "WishMedia_wishId_commentId_fkey" FOREIGN KEY ("wishId","commentId") REFERENCES "WishComment"("wishId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WishMedia_attachment_check" CHECK (("wishId" IS NULL)=("commentId" IS NULL))
);
CREATE INDEX "WishMedia_wishId_commentId_idx" ON "WishMedia"("wishId","commentId");

-- Explicitly selected covers and original upload scope for move/retry consistency.
ALTER TABLE "Album" ADD COLUMN "coverPhotoId" TEXT;
ALTER TABLE "Album" ADD CONSTRAINT "Album_coverPhotoId_fkey" FOREIGN KEY ("coverPhotoId") REFERENCES "AlbumPhoto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AlbumPhoto" ADD COLUMN "uploadAlbumId" TEXT;
CREATE UNIQUE INDEX "AlbumPhoto_original_upload_scope_key" ON "AlbumPhoto"((COALESCE("uploadAlbumId","albumId")),"uploaderId","batchId","batchIndex");
