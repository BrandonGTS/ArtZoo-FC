-- MEDIA03 canonical63: final typed photo shape and permanent Lottery mount fact only.
-- One atomic DO; no historical adoption/backfill, budget enablement or cleanup.
SET lock_timeout = '1s';
SET statement_timeout = '10s';
SET idle_in_transaction_session_timeout = '15s';

DO $media03$
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
    AND "namespace" IN ('daily','wish','lottery-image') AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$')));


ALTER TABLE "MediaUploadReceipt" ADD COLUMN "lotteryMountedAt" TIMESTAMPTZ(3);
ALTER TABLE "MediaUploadReceipt" ADD CONSTRAINT "MediaUploadReceipt_lottery_mount_shape" CHECK (
  "lotteryMountedAt" IS NULL OR (
    scope='lottery-image' AND "accountId" IS NOT NULL AND "attemptId" IS NOT NULL
    AND "objectIdentity" IS NOT NULL AND "persistenceStartedAt" IS NOT NULL
    AND state IN ('RESERVED','UNKNOWN','COMMITTED') AND isfinite("lotteryMountedAt")
  )
);
CREATE FUNCTION artzoo_preserve_lottery_mount_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."lotteryMountedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='MediaUploadReceipt_lottery_mount_fact', MESSAGE='Lottery mount fact requires an existing started typed receipt';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD."lotteryMountedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='MediaUploadReceipt_lottery_mount_fact', MESSAGE='Lottery mount fact is permanent';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."lotteryMountedAt" IS NOT NULL THEN
    -- Existing settle/UNKNOWN/replay transitions may only change these lifecycle fields.
    IF (to_jsonb(NEW)-ARRAY['state','settledAt','updatedAt'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','settledAt','updatedAt']) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='MediaUploadReceipt_lottery_mount_fact', MESSAGE='Lottery mounted identity and generation are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."lotteryMountedAt" IS NOT NULL THEN
    IF (to_jsonb(NEW)-ARRAY['lotteryMountedAt','updatedAt'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['lotteryMountedAt','updatedAt'])
       OR NEW.scope<>'lottery-image' OR NEW."persistenceStartedAt" IS NULL
       OR NEW.state NOT IN ('RESERVED','UNKNOWN','COMMITTED')
       OR NEW."metadataReservedBytes"<>0
       OR NEW."objectIdentity" !~ '^lottery:[a-f0-9-]{36}:[a-f0-9-]{36}$'
       OR split_part(NEW."objectIdentity",':',2)<>NEW."accountId"
       OR NOT EXISTS (
         SELECT 1 FROM "MediaStoredComponent" c
         WHERE c."receiptScope"=NEW.scope AND c."receiptOperationKey"=NEW."operationKey"
         GROUP BY c."receiptScope",c."receiptOperationKey"
         HAVING count(*)=3 AND count(DISTINCT c.part)=3
           AND sum(c."chargedBytes")=NEW."storedBytes"
           AND bool_and(c."sourceKind"='RECEIPT' AND c."baselineStateId" IS NULL
             AND c."baselineFingerprint" IS NULL AND c.namespace='lottery-image'
             AND c."objectKey"=NEW."objectIdentity" AND c.generation=NEW."attemptId"
             AND c.policy='PHOTO_VARIANT'
             AND c.part IN ('photo-original','photo-preview','photo-thumbnail')
             AND c."contentBindingSha256" ~ '^[a-f0-9]{64}$'
             AND c."chargedBytes">0
             AND c."chargedBytes"<=CASE WHEN c.part='photo-original' THEN 31457280 ELSE 62914560 END)
       )
       OR EXISTS (
         SELECT 1 FROM "MediaRetirementIntent" i JOIN "MediaStoredComponent" c ON c.id=i."componentId"
         WHERE c."receiptScope"=NEW.scope AND c."receiptOperationKey"=NEW."operationKey"
       ) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='MediaUploadReceipt_lottery_mount_fact', MESSAGE='Lottery mount fact requires the exact unfenced typed generation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "MediaUploadReceipt_lottery_mount_fact"
  BEFORE INSERT OR UPDATE OR DELETE ON "MediaUploadReceipt"
  FOR EACH ROW EXECUTE FUNCTION artzoo_preserve_lottery_mount_fact();
END
$media03$;

RESET lock_timeout;
RESET statement_timeout;
RESET idle_in_transaction_session_timeout;
