-- Exact new official three-variant shape only; no adoption, tables, backfill or enablement.
ALTER TABLE "MediaStoredComponent" DROP CONSTRAINT "MediaStoredComponent_shape";
ALTER TABLE "MediaStoredComponent" ADD CONSTRAINT "MediaStoredComponent_shape" CHECK (
  "id" ~ '^[a-f0-9]{64}$' AND "chargedBytes">0 AND length("objectKey")>0 AND length("generation")>0 AND
  ("baselineFingerprint" IS NULL OR "baselineFingerprint" ~ '^[a-f0-9]{64}$') AND
  (("policy"='AGGREGATE_NEVER' AND "part" IN ('aggregate','knowledge-media')) OR
   ("policy"='AVATAR_VARIANT' AND "part" IN ('avatar-full','avatar-small') AND "namespace"='avatar') OR
   ("policy"='KNOWLEDGE_JOURNAL' AND "part"='knowledge-journal' AND "namespace"='knowledge') OR
   ("policy"='QUICK_LINK_BYTEA' AND "part"='quick-icon-bytea' AND "namespace" IN ('quick-icon-manual','quick-icon-auto') AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$') OR
   ("policy"='OFFICIAL_VARIANT' AND "part" IN ('official-original','official-preview','official-thumbnail') AND "namespace"='official-image' AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$')));
