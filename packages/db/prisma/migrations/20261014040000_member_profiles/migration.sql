-- Additive only. Existing accounts and game identity constraints stay unchanged.
CREATE TABLE "MemberProfile" (
  "accountId" TEXT NOT NULL,
  "bio" TEXT NOT NULL DEFAULT '',
  "commonJobs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "preferredPlaystyles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "revision" INTEGER NOT NULL DEFAULT 0,
  "avatarId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MemberProfile_pkey" PRIMARY KEY ("accountId"),
  CONSTRAINT "MemberProfile_revision_check" CHECK ("revision" >= 0)
);
CREATE TABLE "AvatarAsset" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "bytes" INTEGER NOT NULL,
  "smallBytes" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AvatarAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AvatarAsset_dimensions_check" CHECK ("width" > 0 AND "width" <= 512 AND "height" = "width"),
  CONSTRAINT "AvatarAsset_bytes_check" CHECK ("bytes" > 0 AND "smallBytes" > 0)
);
CREATE UNIQUE INDEX "MemberProfile_avatarId_key" ON "MemberProfile"("avatarId");
CREATE INDEX "AvatarAsset_accountId_idx" ON "AvatarAsset"("accountId");
ALTER TABLE "MemberProfile" ADD CONSTRAINT "MemberProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AvatarAsset" ADD CONSTRAINT "AvatarAsset_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberProfile" ADD CONSTRAINT "MemberProfile_avatarId_fkey" FOREIGN KEY ("avatarId") REFERENCES "AvatarAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
