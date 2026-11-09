-- New writes only. Never adopt, rehash, scan or backfill existing objects.
ALTER TABLE "MediaStoredComponent" ADD COLUMN "contentBindingSha256" VARCHAR(64), ADD COLUMN "storageIdentityFingerprint" VARCHAR(64);
ALTER TABLE "MediaStoredComponent" ADD CONSTRAINT "MediaStoredComponent_binding_shape" CHECK (
 ("contentBindingSha256" IS NULL OR "contentBindingSha256" ~ '^[a-f0-9]{64}$') AND
 ("storageIdentityFingerprint" IS NULL OR ("contentBindingSha256" IS NOT NULL AND "storageIdentityFingerprint" ~ '^[a-f0-9]{64}$'))
);
