-- Only future explicitly enrolled server generations may expire. NULL historical rows stay untouched.
ALTER TABLE "MediaUploadReceipt" ADD COLUMN "reservationProtocol" VARCHAR(32);
ALTER TABLE "MediaUploadReceipt" ADD CONSTRAINT "MediaUploadReceipt_reservation_protocol_shape" CHECK (
  "reservationProtocol" IS NULL OR (
    "reservationProtocol"='prewrite-expiry-v1'
    AND scope IN ('avatar','album-photo','album-comment','knowledge','daily','wish','activity-share','lottery-image','official-image')
    AND "attemptId" IS NOT NULL AND "objectIdentity" IS NOT NULL
  )
);
CREATE INDEX "MediaUploadReceipt_reservation_candidates_idx" ON "MediaUploadReceipt"
  ("reservationProtocol",state,"persistenceStartedAt","createdAt",scope,"operationKey");
