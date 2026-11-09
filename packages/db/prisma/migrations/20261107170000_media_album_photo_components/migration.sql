-- Album COS phase 67: permit only future typed album-photo receipt components.
-- Preserve every old shape branch verbatim. No row rewrite, historical adoption, credit or cleanup.
SET lock_timeout = '1s';
SET statement_timeout = '10s';
SET idle_in_transaction_session_timeout = '15s';

DO $album67$
BEGIN
ALTER TABLE "MediaStoredComponent" DROP CONSTRAINT "MediaStoredComponent_shape";
ALTER TABLE "MediaStoredComponent" ADD CONSTRAINT "MediaStoredComponent_shape" CHECK (
 (
  "id" ~ '^[a-f0-9]{64}$' AND "chargedBytes">0 AND length("objectKey")>0 AND length("generation")>0 AND
  ("baselineFingerprint" IS NULL OR "baselineFingerprint" ~ '^[a-f0-9]{64}$') AND
  (("policy"='AGGREGATE_NEVER' AND "part" IN ('aggregate','knowledge-media')) OR
   ("policy"='AVATAR_VARIANT' AND "part" IN ('avatar-full','avatar-small') AND "namespace"='avatar') OR
   ("policy"='KNOWLEDGE_JOURNAL' AND "part"='knowledge-journal' AND "namespace"='knowledge') OR
   ("policy"='QUICK_LINK_BYTEA' AND "part"='quick-icon-bytea' AND "namespace" IN ('quick-icon-manual','quick-icon-auto') AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$') OR
   ("policy"='OFFICIAL_VARIANT' AND "part" IN ('official-original','official-preview','official-thumbnail') AND "namespace"='official-image' AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$') OR
   ("policy"='PHOTO_VARIANT' AND "part" IN ('photo-original','photo-preview','photo-thumbnail')
    AND "namespace" IN ('daily','wish','lottery-image','knowledge','album-comment') AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$'))
 ) OR (
  "id" ~ '^[a-f0-9]{64}$' AND "chargedBytes">0 AND
  "sourceKind"='RECEIPT' AND "receiptScope"='album-photo' AND "namespace"='album-photo' AND
  "receiptOperationKey" IS NOT NULL AND length("receiptOperationKey")>0 AND
  "policy"='PHOTO_VARIANT' AND "part" IN ('photo-original','photo-preview','photo-thumbnail') AND
  "objectKey" ~ '^album-photo:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
  "generation" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
  "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$'
 ));
END
$album67$;
