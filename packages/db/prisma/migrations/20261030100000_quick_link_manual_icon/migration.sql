-- Existing catalog images stay automatic; no link, icon bytes or user data is replaced.
ALTER TABLE "ResourceLink"
 ADD COLUMN "iconSource" VARCHAR(8) NOT NULL DEFAULT 'auto',
 ADD CONSTRAINT "ResourceLink_iconSource_check" CHECK ("iconSource" IN ('auto','manual')),
 ADD CONSTRAINT "ResourceLink_manual_icon_check" CHECK (
  "iconSource" <> 'manual' OR (
   "iconBytes" IS NOT NULL AND octet_length("iconBytes") BETWEEN 1 AND 65536
   AND "iconVersion" IS NOT NULL AND "iconVersion" ~ '^[a-f0-9]{64}$'
  )
 );
