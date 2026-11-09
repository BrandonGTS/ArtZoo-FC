-- Additive local QC ownership metadata; existing accounts remain unmarked.
ALTER TABLE "Account" ADD COLUMN "localQcNamespace" TEXT, ADD COLUMN "localQcSlot" TEXT;
CREATE UNIQUE INDEX "Account_localQcNamespace_localQcSlot_key" ON "Account"("localQcNamespace", "localQcSlot");
ALTER TABLE "Account" ADD CONSTRAINT "Account_local_qc_marker_check" CHECK (
 ("localQcNamespace" IS NULL AND "localQcSlot" IS NULL) OR
 ("localQcNamespace" IS NOT NULL AND "localQcSlot" IS NOT NULL AND
  "localQcNamespace" = 'artzoo-local-qc-v1' AND "localQcSlot" IN ('member-a','member-b','friend','admin')));
CREATE TABLE "LocalQcRun" (
 "namespace" TEXT PRIMARY KEY,
 "anchor" TIMESTAMPTZ(3) NOT NULL,
 "manifestHash" TEXT NOT NULL CHECK ("manifestHash" ~ '^[a-f0-9]{64}$'),
 "bindings" JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "LocalQcRecord" (
 "namespace" TEXT NOT NULL,
 "slot" TEXT NOT NULL,
 "kind" TEXT NOT NULL,
 "entityId" TEXT NOT NULL,
 "digest" TEXT NOT NULL CHECK ("digest" ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("namespace", "slot")
);

-- Ownership baselines are immutable; ordinary application writes cannot reset a QC import.
CREATE FUNCTION local_qc_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Local QC ownership records are append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER local_qc_run_append_only BEFORE UPDATE OR DELETE ON "LocalQcRun"
 FOR EACH ROW EXECUTE FUNCTION local_qc_ledger_append_only();
CREATE TRIGGER local_qc_record_append_only BEFORE UPDATE OR DELETE ON "LocalQcRecord"
 FOR EACH ROW EXECUTE FUNCTION local_qc_ledger_append_only();
