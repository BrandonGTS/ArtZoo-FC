BEGIN;
ALTER TABLE "OfficialEvent" ADD COLUMN "imageId" TEXT;
CREATE TABLE "OfficialEventImage" (
 id TEXT PRIMARY KEY, "eventId" TEXT NOT NULL REFERENCES "OfficialEvent"(id) ON DELETE RESTRICT,
 "sourceUrl" TEXT NOT NULL, "sourcePageUrl" TEXT NOT NULL, "sourceKind" TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 mime TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','image/gif')),
 width INTEGER NOT NULL CHECK (width>0), height INTEGER NOT NULL CHECK (height>0),
 frames INTEGER NOT NULL CHECK (frames BETWEEN 1 AND 300),
 "originalBytes" INTEGER NOT NULL CHECK ("originalBytes" BETWEEN 1 AND 5242880),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "OfficialEventImage_source_kind_check" CHECK ("sourceKind" IN ('API','NEWS','TOPIC_METADATA','TOPIC_SECTION','MANUAL')),
 CONSTRAINT "OfficialEventImage_id_eventId_key" UNIQUE (id,"eventId"),
 CONSTRAINT "OfficialEventImage_identity_key" UNIQUE ("eventId",fingerprint,"sourceUrl")
);
ALTER TABLE "OfficialEvent" ADD CONSTRAINT "OfficialEvent_imageId_id_fkey"
 FOREIGN KEY ("imageId",id) REFERENCES "OfficialEventImage"(id,"eventId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "OfficialEvent" DROP CONSTRAINT "OfficialEvent_manual_fields_check";
ALTER TABLE "OfficialEvent" ADD CONSTRAINT "OfficialEvent_manual_fields_check"
 CHECK (jsonb_typeof("manualFields")='array' AND "manualFields" <@ '["title","sourceUrl","summary","startsAt","endsAt","status","image"]'::jsonb);
CREATE FUNCTION preserve_official_event_image() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'official image metadata must be retained'; END $$;
CREATE TRIGGER "OfficialEventImage_retained" BEFORE UPDATE OR DELETE ON "OfficialEventImage"
 FOR EACH ROW EXECUTE FUNCTION preserve_official_event_image();
COMMIT;
