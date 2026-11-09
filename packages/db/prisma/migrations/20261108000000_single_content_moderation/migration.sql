-- Additive only: governance is independent of author completion/cancellation.
-- Existing contents, associations, entries, results, messages and media stay intact.
ALTER TABLE "Wish" ADD COLUMN "moderatedAt" TIMESTAMPTZ(3);
ALTER TABLE "Lottery" ADD COLUMN "moderatedAt" TIMESTAMPTZ(3),
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Lottery" ADD CONSTRAINT "Lottery_revision_nonnegative" CHECK ("revision" >= 0);
ALTER TABLE "LotteryCommand" ADD COLUMN "requestFingerprint" TEXT,
  ADD COLUMN "payload" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "LotteryCommand" ADD CONSTRAINT "LotteryCommand_moderation_evidence" CHECK (
  "action" <> 'moderate' OR COALESCE((
    "requestFingerprint" IS NOT NULL AND length("requestFingerprint") = 64
    AND jsonb_typeof("payload"->'reason') = 'string'
    AND length(btrim("payload"->>'reason')) BETWEEN 1 AND 1000
    AND jsonb_typeof("payload"->'expectedRevision') = 'number'
  ), FALSE)
);

-- Preserve the original immutable published settings/final-result boundary.
-- A revision advances once per normal close or independent governance action.
CREATE OR REPLACE FUNCTION lottery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."moderatedAt" IS NOT NULL OR NEW."revision" <> OLD."revision" + 1
 OR (to_jsonb(NEW) - ARRAY['state','result','closedAt','moderatedAt','revision'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['state','result','closedAt','moderatedAt','revision']) THEN
  RAISE EXCEPTION 'Published lottery and final result are immutable';
 END IF;
 IF NEW."moderatedAt" IS NOT NULL THEN
  IF ROW(NEW."state", NEW."result", NEW."closedAt")
     IS DISTINCT FROM ROW(OLD."state", OLD."result", OLD."closedAt") THEN
   RAISE EXCEPTION 'Governance must preserve lottery state and final result';
  END IF;
 ELSIF OLD."state" <> 'OPEN' THEN
  RAISE EXCEPTION 'Published lottery and final result are immutable';
 END IF;
 RETURN NEW;
END $$;
