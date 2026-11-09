-- DATA08: only UTC-semantic timestamp(3) data may use this migration.
-- This does NOT establish that an existing deployment has UTC-only history.
-- Stop writes and prove historical semantics/backup/compatibility before production use.
BEGIN;
SET LOCAL lock_timeout = '1500ms';
SET LOCAL statement_timeout = '15s';
SET LOCAL idle_in_transaction_session_timeout = '15s';

-- Acquire every lock before changing any column; no partial table conversion on timeout.
LOCK TABLE public."Account", public."AccountAudit", public."AccountRateEvent", public."AccountSession", public."AdminManagementAudit", public."AdminManagementCommand", public."AvatarAsset", public."Invitation", public."MemberProfile", public."PublicSiteSettings", public."SiteAnnouncement", public."SiteAnnouncementCommand", public."VerificationCode" IN ACCESS EXCLUSIVE MODE;

DO $data08$
BEGIN
  IF (SELECT count(*) FROM (VALUES
    ('Account', 'createdAt'),
    ('Account', 'updatedAt'),
    ('AccountSession', 'createdAt'),
    ('AccountSession', 'expiresAt'),
    ('AccountSession', 'revokedAt'),
    ('Invitation', 'createdAt'),
    ('Invitation', 'expiresAt'),
    ('Invitation', 'usedAt'),
    ('Invitation', 'revokedAt'),
    ('Invitation', 'removedAt'),
    ('VerificationCode', 'createdAt'),
    ('VerificationCode', 'expiresAt'),
    ('VerificationCode', 'consumedAt'),
    ('VerificationCode', 'invalidatedAt'),
    ('VerificationCode', 'deliveredAt'),
    ('AccountRateEvent', 'createdAt'),
    ('AccountAudit', 'createdAt'),
    ('MemberProfile', 'createdAt'),
    ('MemberProfile', 'updatedAt'),
    ('AvatarAsset', 'createdAt'),
    ('AdminManagementCommand', 'createdAt'),
    ('AdminManagementAudit', 'createdAt'),
    ('PublicSiteSettings', 'updatedAt'),
    ('SiteAnnouncement', 'deletedAt'),
    ('SiteAnnouncement', 'createdAt'),
    ('SiteAnnouncementCommand', 'createdAt')
  ) AS wanted(table_name, column_name)
  JOIN pg_catalog.pg_namespace n ON n.nspname = 'public'
  JOIN pg_catalog.pg_class r ON r.relnamespace = n.oid AND r.relname = wanted.table_name AND r.relkind = 'r'
  JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid AND a.attname = wanted.column_name
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'timestamp without time zone'::regtype AND a.atttypmod = 3) <> 26
  THEN
    RAISE EXCEPTION 'DATA08 expected exactly 26 timestamp(3) source columns';
  END IF;
END
$data08$;

ALTER TABLE public."Account"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE timestamptz(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE public."AccountSession"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "expiresAt" TYPE timestamptz(3) USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "revokedAt" TYPE timestamptz(3) USING "revokedAt" AT TIME ZONE 'UTC';

ALTER TABLE public."Invitation"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "expiresAt" TYPE timestamptz(3) USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "usedAt" TYPE timestamptz(3) USING "usedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "revokedAt" TYPE timestamptz(3) USING "revokedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "removedAt" TYPE timestamptz(3) USING "removedAt" AT TIME ZONE 'UTC';

ALTER TABLE public."VerificationCode"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "expiresAt" TYPE timestamptz(3) USING "expiresAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "consumedAt" TYPE timestamptz(3) USING "consumedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "invalidatedAt" TYPE timestamptz(3) USING "invalidatedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "deliveredAt" TYPE timestamptz(3) USING "deliveredAt" AT TIME ZONE 'UTC';

ALTER TABLE public."AccountRateEvent"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE public."AccountAudit"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE public."MemberProfile"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE timestamptz(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE public."AvatarAsset"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE public."AdminManagementCommand"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE public."AdminManagementAudit"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE public."PublicSiteSettings"
  ALTER COLUMN "updatedAt" TYPE timestamptz(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE public."SiteAnnouncement"
  ALTER COLUMN "deletedAt" TYPE timestamptz(3) USING "deletedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE public."SiteAnnouncementCommand"
  ALTER COLUMN "createdAt" TYPE timestamptz(3) USING "createdAt" AT TIME ZONE 'UTC';

COMMIT;
