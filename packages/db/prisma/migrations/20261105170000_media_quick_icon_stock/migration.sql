-- New BYTEA components only. No adoption, scan, enablement or historical accounting rewrite.
ALTER TABLE "ResourceLink" ADD COLUMN "iconBudgetComponentId" VARCHAR(64);
ALTER TABLE "ResourceLink" ADD COLUMN "iconBudgetMutationXid" VARCHAR(20);
CREATE UNIQUE INDEX "ResourceLink_iconBudgetComponentId_key" ON "ResourceLink"("iconBudgetComponentId");
ALTER TABLE "ResourceLink" ADD CONSTRAINT "ResourceLink_iconBudgetComponentId_fkey"
 FOREIGN KEY ("iconBudgetComponentId") REFERENCES "MediaStoredComponent"(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ResourceLink" ADD CONSTRAINT "ResourceLink_icon_budget_shape"
 CHECK ("iconBudgetComponentId" IS NULL OR ("iconBytes" IS NOT NULL AND "iconBudgetMutationXid" IS NOT NULL AND "iconBudgetMutationXid" ~ '^[0-9]{1,20}$' AND "iconVersion" IS NOT NULL AND "iconVersion" ~ '^[a-f0-9]{64}$'));
ALTER TABLE "MediaStoredComponent" DROP CONSTRAINT "MediaStoredComponent_shape";
ALTER TABLE "MediaStoredComponent" ADD CONSTRAINT "MediaStoredComponent_shape" CHECK (
  "id" ~ '^[a-f0-9]{64}$' AND "chargedBytes">0 AND length("objectKey")>0 AND length("generation")>0 AND
  ("baselineFingerprint" IS NULL OR "baselineFingerprint" ~ '^[a-f0-9]{64}$') AND
  (("policy"='AGGREGATE_NEVER' AND "part" IN ('aggregate','knowledge-media')) OR
   ("policy"='AVATAR_VARIANT' AND "part" IN ('avatar-full','avatar-small') AND "namespace"='avatar') OR
   ("policy"='KNOWLEDGE_JOURNAL' AND "part"='knowledge-journal' AND "namespace"='knowledge') OR
   ("policy"='QUICK_LINK_BYTEA' AND "part"='quick-icon-bytea' AND "namespace" IN ('quick-icon-manual','quick-icon-auto') AND "contentBindingSha256" IS NOT NULL AND "contentBindingSha256" ~ '^[a-f0-9]{64}$')));
-- Fires on an actual original icon write, INCLUDING equal bytes/version and OFF writers.
-- Pointer-only tail binding does not name either trigger column and cannot clear itself.
CREATE FUNCTION artzoo_clear_quick_icon_budget_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW."iconBudgetComponentId" := NULL;
 IF TG_OP='INSERT' AND NEW."iconBytes" IS NULL THEN
  NEW."iconBudgetMutationXid" := NULL;
 ELSE
  NEW."iconBudgetMutationXid" := pg_current_xact_id()::text;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "ResourceLink_icon_budget_invalidate"
 BEFORE INSERT OR UPDATE OF "iconBytes", "iconVersion" ON "ResourceLink"
 FOR EACH ROW EXECUTE FUNCTION artzoo_clear_quick_icon_budget_binding();
