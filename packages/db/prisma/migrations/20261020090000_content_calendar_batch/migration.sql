BEGIN;

-- A comment attachment retains the original owning post and media identity.
ALTER TABLE "DailyMedia" ADD COLUMN "commentId" TEXT;
CREATE UNIQUE INDEX "DailyComment_id_postId_key" ON "DailyComment"(id,"postId");
CREATE INDEX "DailyMedia_commentId_position_idx" ON "DailyMedia"("commentId",position);
ALTER TABLE "DailyMedia" ADD CONSTRAINT "DailyMedia_commentId_postId_fkey"
 FOREIGN KEY ("commentId","postId") REFERENCES "DailyComment"(id,"postId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyMedia" ADD CONSTRAINT "DailyMedia_comment_post_check"
 CHECK ("commentId" IS NULL OR "postId" IS NOT NULL);

ALTER TABLE "OfficialEvent" ADD COLUMN "manualFields" JSONB NOT NULL DEFAULT '[]',
 ADD COLUMN "sourceSnapshot" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "OfficialEvent" ADD CONSTRAINT "OfficialEvent_manual_fields_check"
 CHECK (jsonb_typeof("manualFields")='array' AND "manualFields" <@ '["title","sourceUrl","summary","startsAt","endsAt","status"]'::jsonb),
 ADD CONSTRAINT "OfficialEvent_source_snapshot_check" CHECK (jsonb_typeof("sourceSnapshot")='object');

-- Infer only actual legacy administrator changes. COLLECTED-only pending rows
-- remain automatic candidates; existing rejection/withdrawal decisions remain protected.
UPDATE "OfficialEvent" e SET "manualFields"=COALESCE((
 SELECT jsonb_agg(f.field ORDER BY f.ordinal) FROM (VALUES
  ('summary',1, e.summary <> ''),
  ('startsAt',2, e."startsAt" IS NOT NULL),
  ('endsAt',3, e."endsAt" IS NOT NULL)
 ) AS f(field,ordinal,filled)
 WHERE EXISTS (SELECT 1 FROM "OfficialEventAudit" a WHERE a."eventId"=e.id AND a.action IN ('SAVE','APPROVE')
  AND a.before ? f.field AND a.after ? f.field AND a.before->f.field IS DISTINCT FROM a.after->f.field)
 OR (f.filled AND NOT EXISTS (SELECT 1 FROM "OfficialEventAudit" a WHERE a."eventId"=e.id AND a.action IN ('SAVE','APPROVE')
  AND a.before ? f.field AND a.after ? f.field))
),'[]'::jsonb) || CASE WHEN e.status IN ('REJECTED','WITHDRAWN') OR EXISTS (
 SELECT 1 FROM "OfficialEventAudit" a WHERE a."eventId"=e.id AND a.action IN ('REJECT','WITHDRAW'))
 THEN '["status"]'::jsonb ELSE '[]'::jsonb END;

-- Verified calendar dates may publish even when the optional news supplement is absent.
ALTER TABLE "OfficialEvent" DROP CONSTRAINT "OfficialEvent_published_check";
ALTER TABLE "OfficialEvent" ADD CONSTRAINT "OfficialEvent_published_check"
 CHECK (status NOT IN ('PUBLISHED','WITHDRAWN') OR ("startsAt" IS NOT NULL AND "endsAt" IS NOT NULL));

-- Preserve retained identity and append-only audits. Source changes now have
-- complete before/after snapshots; a legacy news identity may be canonicalized once.
CREATE OR REPLACE FUNCTION preserve_official_event_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'official records must be retained'; END IF;
 IF (NEW.id,NEW."sourceKey",NEW."createdAt") IS DISTINCT FROM (OLD.id,OLD."sourceKey",OLD."createdAt")
 THEN RAISE EXCEPTION 'official identity must be retained'; END IF;
 IF NEW."externalId" IS DISTINCT FROM OLD."externalId" AND NOT (
  OLD."externalId" ~ '^(activity|news):' AND NEW."externalId" ~ '^calendar:[0-9]{1,20}$'
 ) THEN RAISE EXCEPTION 'official calendar identity must be retained'; END IF;
 RETURN NEW;
END $$;

-- Add the requested sections without rewriting existing categories or article references.
INSERT INTO "KnowledgeCategory" (id,label,active,revision)
 SELECT gen_random_uuid()::text,label,true,0 FROM (VALUES
 ('生活杂谈'),('同人创作'),('剧情讨论'),('建议和 BUG 反馈'),('游戏记录'),('举手提问')
 ) AS requested(label) ON CONFLICT (label) DO NOTHING;

COMMIT;
