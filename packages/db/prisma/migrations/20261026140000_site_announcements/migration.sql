-- Additive local feature: no existing invitation, account, media, score or notification data changes.
CREATE TABLE "SiteAnnouncement" (
  "id" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SiteAnnouncement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SiteAnnouncement_text_check" CHECK (char_length("text") BETWEEN 1 AND 2000),
  CONSTRAINT "SiteAnnouncement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SiteAnnouncement_active_createdAt_id_idx" ON "SiteAnnouncement"("active", "createdAt", "id");
CREATE INDEX "SiteAnnouncement_createdAt_id_idx" ON "SiteAnnouncement"("createdAt", "id");
CREATE TABLE "SiteAnnouncementState" (
  "id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SiteAnnouncementState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SiteAnnouncementState_singleton_check" CHECK ("id" = 'site'),
  CONSTRAINT "SiteAnnouncementState_revision_check" CHECK ("revision" >= 0)
);
CREATE TABLE "SiteAnnouncementCommand" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SiteAnnouncementCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SiteAnnouncementCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SiteAnnouncementCommand_actorId_idempotencyKey_key" ON "SiteAnnouncementCommand"("actorId", "idempotencyKey");
