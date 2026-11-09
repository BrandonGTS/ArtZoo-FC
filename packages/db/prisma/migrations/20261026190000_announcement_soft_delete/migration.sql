-- Additive soft deletion; existing announcement text, selection, command history and all other business data remain intact.
ALTER TABLE "SiteAnnouncement" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedById" TEXT;
ALTER TABLE "SiteAnnouncement" ADD CONSTRAINT "SiteAnnouncement_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SiteAnnouncement" ADD CONSTRAINT "SiteAnnouncement_deletion_check" CHECK (("deletedAt" IS NULL AND "deletedById" IS NULL) OR ("deletedAt" IS NOT NULL AND "deletedById" IS NOT NULL AND "active" = false));
CREATE INDEX "SiteAnnouncement_deletedAt_active_createdAt_id_idx" ON "SiteAnnouncement"("deletedAt", "active", "createdAt", "id");
