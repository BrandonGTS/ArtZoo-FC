-- MEDIA03 candidate64: only future typed Knowledge/AlbumComment files and permanent observed mount facts.
SET lock_timeout = '1s';
SET statement_timeout = '10s';
SET idle_in_transaction_session_timeout = '15s';
DO $media64$
BEGIN
ALTER TABLE "MediaStoredComponent" DROP CONSTRAINT "MediaStoredComponent_shape";
ALTER TABLE "MediaStoredComponent" ADD CONSTRAINT "MediaStoredComponent_shape" CHECK (
  "id" ~ '^[a-f0-9]{64}$' AND "chargedBytes">0 AND length("objectKey")>0 AND length("generation")>0 AND
  ("baselineFingerprint" IS NULL OR "baselineFingerprint" ~ '^[a-f0-9]{64}$') AND
  (("policy"='AGGREGATE_NEVER' AND "part" IN ('aggregate','knowledge-media')) OR
   ("policy"='AVATAR_VARIANT' AND "part" IN ('avatar-full','avatar-small') AND "namespace"='avatar') OR
   ("policy"='KNOWLEDGE_JOURNAL' AND "part"='knowledge-journal' AND "namespace"='knowledge') OR
   ("policy"='QUICK_LINK_BYTEA' AND "part"='quick-icon-bytea' AND "namespace" IN ('quick-icon-manual','quick-icon-auto') AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$') OR
   ("policy"='OFFICIAL_VARIANT' AND "part" IN ('official-original','official-preview','official-thumbnail') AND "namespace"='official-image' AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$') OR
   ("policy"='PHOTO_VARIANT' AND "part" IN ('photo-original','photo-preview','photo-thumbnail')
    AND "namespace" IN ('daily','wish','lottery-image','knowledge','album-comment') AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$')));

ALTER TABLE "KnowledgeImage" ADD COLUMN "orphanMountedAt" TIMESTAMPTZ(3);
CREATE FUNCTION artzoo_preserve_knowledge_mount() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD."orphanMountedAt" IS NOT NULL OR OLD."articleId" IS NOT NULL OR OLD."commentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Previously mounted media must remain retained';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."articleId" IS NOT NULL OR NEW."commentId" IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM "MediaRetirementIntent" i
      JOIN "MediaStoredComponent" c ON c.id=i."componentId"
      JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='knowledge' AND c.policy='PHOTO_VARIANT'
        AND c."objectKey"='knowledge:'||NEW.id AND r.scope='knowledge'
        AND r."objectIdentity"=c."objectKey" AND r."attemptId"=c.generation AND r.state='COMMITTED') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Fenced media cannot be attached';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."orphanMountedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Mount fact is server observed';
    END IF;
    IF NEW."articleId" IS NOT NULL OR NEW."commentId" IS NOT NULL THEN NEW."orphanMountedAt" := clock_timestamp(); END IF;
    RETURN NEW;
  END IF;
  IF NEW."orphanMountedAt" IS DISTINCT FROM OLD."orphanMountedAt" THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Mount fact is permanent';
  END IF;
  IF OLD."orphanMountedAt" IS NULL AND (OLD."articleId" IS NOT NULL OR OLD."commentId" IS NOT NULL OR NEW."articleId" IS NOT NULL OR NEW."commentId" IS NOT NULL) THEN
    NEW."orphanMountedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER "KnowledgeImage_permanent_mount" BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeImage"
FOR EACH ROW EXECUTE FUNCTION artzoo_preserve_knowledge_mount();

ALTER TABLE "AlbumCommentMedia" ADD COLUMN "orphanMountedAt" TIMESTAMPTZ(3);
CREATE FUNCTION artzoo_preserve_album_comment_mount() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD."orphanMountedAt" IS NOT NULL OR OLD."commentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Previously mounted media must remain retained';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."commentId" IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM "MediaRetirementIntent" i
      JOIN "MediaStoredComponent" c ON c.id=i."componentId"
      JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='album-comment' AND c.policy='PHOTO_VARIANT'
        AND c."objectKey"='album-comment:'||NEW.id AND r.scope='album-comment'
        AND r."objectIdentity"=c."objectKey" AND r."attemptId"=c.generation AND r.state='COMMITTED') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Fenced media cannot be attached';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."orphanMountedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Mount fact is server observed';
    END IF;
    IF NEW."commentId" IS NOT NULL THEN NEW."orphanMountedAt" := clock_timestamp(); END IF;
    RETURN NEW;
  END IF;
  IF NEW."orphanMountedAt" IS DISTINCT FROM OLD."orphanMountedAt" THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Mount fact is permanent';
  END IF;
  IF OLD."orphanMountedAt" IS NULL AND (OLD."commentId" IS NOT NULL OR NEW."commentId" IS NOT NULL) THEN
    NEW."orphanMountedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER "AlbumCommentMedia_permanent_mount" BEFORE INSERT OR UPDATE OR DELETE ON "AlbumCommentMedia"
FOR EACH ROW EXECUTE FUNCTION artzoo_preserve_album_comment_mount();
END
$media64$;
