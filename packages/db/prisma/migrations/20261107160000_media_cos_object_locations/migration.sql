-- COS phase 66. Add only a new empty locator table: no legacy scan, adoption or backfill.
BEGIN;
SET LOCAL lock_timeout = '1500ms';
SET LOCAL statement_timeout = '15s';
SET LOCAL idle_in_transaction_session_timeout = '15s';

CREATE TABLE "MediaCosObject" (
  "id" VARCHAR(36) NOT NULL,
  "scope" VARCHAR(32) NOT NULL,
  "objectId" VARCHAR(36) NOT NULL,
  "part" VARCHAR(16) NOT NULL,
  "accountId" VARCHAR(36),
  "bucket" VARCHAR(71) NOT NULL,
  "region" VARCHAR(32) NOT NULL,
  "prefix" VARCHAR(163) NOT NULL,
  "objectKey" VARCHAR(512) NOT NULL,
  "bytes" BIGINT NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "etag" VARCHAR(256),
  "identityFingerprint" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaCosObject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MediaCosObject_uuid_check" CHECK (
    "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    "objectId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "MediaCosObject_scope_part_check" CHECK (
    ("scope" = 'avatars' AND "part" IN ('full', 'small')) OR
    ("scope" = 'quick-icons' AND "part" = 'icon') OR
    ("scope" IN ('albums', 'album-comments', 'daily', 'wishes', 'lottery',
      'knowledge', 'activity-shares', 'official') AND "part" IN ('original', 'preview', 'thumbnail'))),
  CONSTRAINT "MediaCosObject_owner_check" CHECK (
    ("scope" = 'lottery' AND "accountId" IS NOT NULL AND
      "accountId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') OR
    ("scope" <> 'lottery' AND "accountId" IS NULL)),
  CONSTRAINT "MediaCosObject_address_check" CHECK (
    "region" = 'ap-hongkong' AND "bucket" ~ '^[a-z0-9][a-z0-9-]{0,49}-[0-9]{5,20}$' AND
    "prefix" ~ '^[a-z0-9][a-z0-9-]{0,39}(/[a-z0-9][a-z0-9-]{0,39}){0,3}$' AND
    "objectKey" = "prefix" || '/' || "scope" || '/' ||
      CASE WHEN "scope" = 'lottery' THEN "accountId" || '/' ELSE '' END || "objectId" || '.' || "part"),
  CONSTRAINT "MediaCosObject_content_check" CHECK (
    "bytes" > 0 AND "bytes" <= 9007199254740991 AND "sha256" ~ '^[0-9a-f]{64}$'),
  -- VARCHAR(256) supplies the length bound; PostgreSQL regex repetition counts stop at 255.
  CONSTRAINT "MediaCosObject_observation_check" CHECK (
    ("etag" IS NULL AND "identityFingerprint" IS NULL) OR
    ("etag" IS NOT NULL AND "identityFingerprint" IS NOT NULL AND
      "etag" COLLATE "C" ~ '^[!-~]+$' AND "identityFingerprint" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "MediaCosObject_created_at_check" CHECK (isfinite("createdAt"))
);
CREATE UNIQUE INDEX "MediaCosObject_scope_objectId_part_key"
  ON "MediaCosObject"("scope", "objectId", "part");
CREATE UNIQUE INDEX "MediaCosObject_region_bucket_objectKey_key"
  ON "MediaCosObject"("region", "bucket", "objectKey");

-- No foreign keys: business deletion must not remove routing or storage evidence.
CREATE FUNCTION "guardMediaCosObject"() RETURNS trigger LANGUAGE plpgsql AS $cos_locator$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'COS locator deletion is not supported' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW."etag" IS NOT NULL OR NEW."identityFingerprint" IS NOT NULL THEN
      RAISE EXCEPTION 'COS observation requires a separate CAS' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW."id", NEW."scope", NEW."objectId", NEW."part", NEW."accountId",
      NEW."bucket", NEW."region", NEW."prefix", NEW."objectKey", NEW."bytes", NEW."sha256", NEW."createdAt")
      IS DISTINCT FROM
      ROW(OLD."id", OLD."scope", OLD."objectId", OLD."part", OLD."accountId",
      OLD."bucket", OLD."region", OLD."prefix", OLD."objectKey", OLD."bytes", OLD."sha256", OLD."createdAt") THEN
      RAISE EXCEPTION 'COS locator is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD."etag" IS NOT NULL AND
      ROW(NEW."etag", NEW."identityFingerprint") IS DISTINCT FROM
      ROW(OLD."etag", OLD."identityFingerprint") THEN
      RAISE EXCEPTION 'COS observation is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$cos_locator$;
CREATE TRIGGER "MediaCosObject_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "MediaCosObject"
  FOR EACH ROW EXECUTE FUNCTION "guardMediaCosObject"();
COMMIT;
