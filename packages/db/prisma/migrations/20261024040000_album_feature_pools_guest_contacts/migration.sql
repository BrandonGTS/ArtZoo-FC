-- Additive only: existing albums remain internal; no old photo is selected or authorized.
CREATE TYPE "AlbumPublicity" AS ENUM ('INTERNAL', 'PUBLIC_FEATURED');
CREATE TYPE "FeaturedPhotoPool" AS ENUM ('CANDIDATE', 'SELECTED');
CREATE TYPE "GuestContactStatus" AS ENUM ('PENDING', 'PROCESSED');
ALTER TABLE "Album" ADD COLUMN "publicity" "AlbumPublicity" NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE "AlbumPhoto" ADD COLUMN "featuredPool" "FeaturedPhotoPool", ADD COLUMN "featuredSelectedAt" TIMESTAMPTZ(3);
-- Legacy non-null featuredAt with no pool is retained as internal metadata, never a selected projection.
ALTER TABLE "AlbumPhoto" ADD CONSTRAINT "AlbumPhoto_feature_pool_shape_check" CHECK (
 ("featuredAt" IS NULL AND "featuredPool" IS NULL AND "featuredSelectedAt" IS NULL) OR
 ("featuredAt" IS NOT NULL AND (
   ("featuredPool" IS NULL AND "featuredSelectedAt" IS NULL) OR
   ("featuredPool"='CANDIDATE' AND "featuredSelectedAt" IS NULL) OR
   ("featuredPool"='SELECTED' AND "featuredSelectedAt" IS NOT NULL))));
CREATE INDEX "AlbumPhoto_feature_pool_order_idx" ON "AlbumPhoto"("featuredPool", "featuredSelectedAt", "id");
CREATE TABLE "GuestContactMessage" (
 "id" TEXT NOT NULL,
 "submissionKey" TEXT NOT NULL,
 "requestFingerprint" TEXT NOT NULL,
 "qq" TEXT NOT NULL,
 "message" TEXT NOT NULL,
 "status" "GuestContactStatus" NOT NULL DEFAULT 'PENDING',
 "processedById" TEXT,
 "processedAt" TIMESTAMPTZ(3),
 "revision" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "GuestContactMessage_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "GuestContactMessage_qq_check" CHECK ("qq" ~ '^[1-9][0-9]{4,11}$'),
 CONSTRAINT "GuestContactMessage_text_check" CHECK (length(btrim("message")) BETWEEN 1 AND 500),
 CONSTRAINT "GuestContactMessage_revision_check" CHECK ("revision">=0),
 CONSTRAINT "GuestContactMessage_fingerprint_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
 CONSTRAINT "GuestContactMessage_key_check" CHECK ("submissionKey" ~ '^[A-Za-z0-9_-]{16,128}$'),
 CONSTRAINT "GuestContactMessage_processing_check" CHECK (
  ("status"='PENDING' AND "processedById" IS NULL AND "processedAt" IS NULL) OR
  ("status"='PROCESSED' AND "processedById" IS NOT NULL AND "processedAt" IS NOT NULL)),
 CONSTRAINT "GuestContactMessage_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GuestContactMessage_submissionKey_key" ON "GuestContactMessage"("submissionKey");
CREATE INDEX "GuestContactMessage_status_createdAt_id_idx" ON "GuestContactMessage"("status","createdAt","id");
