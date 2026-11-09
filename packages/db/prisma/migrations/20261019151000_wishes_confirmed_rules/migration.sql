-- Additional additive proposal, after migration.sql. Main integration owner applies it.
ALTER TABLE "Wish" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "deletedAt" TIMESTAMPTZ(3),
 ADD CONSTRAINT "Wish_linked_not_deleted_check" CHECK ("deletedAt" IS NULL OR "activityId" IS NULL);
ALTER TABLE "WishInterest" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT TRUE,
 ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "WishComment" ADD COLUMN "parentId" TEXT,
 ADD CONSTRAINT "WishComment_wishId_id_key" UNIQUE ("wishId","id"),
 ADD CONSTRAINT "WishComment_wishId_parentId_fkey" FOREIGN KEY ("wishId","parentId") REFERENCES "WishComment"("wishId","id") ON DELETE RESTRICT;
CREATE TABLE "WishCommand" (
 "wishId" TEXT NOT NULL REFERENCES "Wish"("id") ON DELETE RESTRICT,
 "actorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "idempotencyKey" TEXT NOT NULL, "kind" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 "payload" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("wishId","actorId","idempotencyKey")
);
ALTER TABLE "WishNotification" ALTER COLUMN "activityId" DROP NOT NULL,
 ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'WISH_CONVERTED',
 ADD COLUMN "commentId" TEXT REFERENCES "WishComment"("id") ON DELETE RESTRICT,
 ADD CONSTRAINT "WishNotification_kind_check" CHECK (
  ("kind"='WISH_CONVERTED' AND "activityId" IS NOT NULL AND "commentId" IS NULL) OR
  ("kind"='WISH_INTERACTION' AND "commentId" IS NOT NULL AND "activityId" IS NULL));
CREATE INDEX "WishInterest_wishId_active_updatedAt_idx" ON "WishInterest"("wishId","active","updatedAt");
