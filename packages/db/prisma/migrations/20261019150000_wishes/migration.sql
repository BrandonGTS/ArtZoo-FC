-- Additive migration. Apply only through the integration owner; never to main DB from this task.
CREATE TABLE "Wish" (
 "id" TEXT PRIMARY KEY, "authorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "title" TEXT NOT NULL, "body" TEXT NOT NULL, "wantedContent" TEXT NOT NULL DEFAULT '', "convenientTime" TEXT NOT NULL DEFAULT '',
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 "activityId" TEXT UNIQUE REFERENCES "Activity"("id") ON DELETE RESTRICT,
 UNIQUE ("authorId", "idempotencyKey"),
 CHECK (char_length("title") BETWEEN 1 AND 100), CHECK (char_length("body") BETWEEN 1 AND 10000),
 CHECK (char_length("wantedContent") <= 1000), CHECK (char_length("convenientTime") <= 500)
);
CREATE INDEX "Wish_createdAt_id_idx" ON "Wish"("createdAt" DESC, "id" DESC);
CREATE TABLE "WishInterest" (
 "wishId" TEXT NOT NULL REFERENCES "Wish"("id") ON DELETE RESTRICT,
 "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("wishId", "accountId")
);
CREATE TABLE "WishComment" (
 "id" TEXT PRIMARY KEY, "wishId" TEXT NOT NULL REFERENCES "Wish"("id") ON DELETE RESTRICT,
 "authorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "body" TEXT NOT NULL CHECK (char_length("body") BETWEEN 1 AND 2000),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 UNIQUE ("wishId", "authorId", "idempotencyKey")
);
CREATE INDEX "WishComment_wishId_createdAt_id_idx" ON "WishComment"("wishId", "createdAt", "id");
CREATE TABLE "WishConversion" (
 "wishId" TEXT PRIMARY KEY REFERENCES "Wish"("id") ON DELETE RESTRICT,
 "actorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "activityId" TEXT UNIQUE NOT NULL REFERENCES "Activity"("id") ON DELETE RESTRICT,
 "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "WishNotification" (
 "id" TEXT PRIMARY KEY, "eventKey" TEXT UNIQUE NOT NULL,
 "wishId" TEXT NOT NULL REFERENCES "Wish"("id") ON DELETE RESTRICT,
 "activityId" TEXT NOT NULL REFERENCES "Activity"("id") ON DELETE RESTRICT,
 "recipientId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "readAt" TIMESTAMPTZ(3), "deletedAt" TIMESTAMPTZ(3)
);
CREATE INDEX "WishNotification_recipientId_createdAt_id_idx" ON "WishNotification"("recipientId", "createdAt", "id");
