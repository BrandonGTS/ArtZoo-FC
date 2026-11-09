BEGIN;
-- New facts only: do not update Account rows or invent facts before activation.
LOCK TABLE "Account" IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION lottery_eligibility_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() $$;
CREATE TABLE "LotteryEligibilityControl" ("id" integer PRIMARY KEY CHECK ("id"=1), "enabledAt" timestamptz(6) NOT NULL);
CREATE TABLE "LotteryAccountStatus" (
 "accountId" text PRIMARY KEY REFERENCES "Account"("id") ON DELETE RESTRICT,
 "active" boolean NOT NULL DEFAULT true, "revision" integer NOT NULL DEFAULT 0,
 "reason" text NOT NULL DEFAULT 'Feature activation baseline',
 "changedById" text REFERENCES "Account"("id") ON DELETE RESTRICT
);
CREATE TABLE "LotteryAccountFact" (
 "sequence" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 "accountId" text NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "effectiveAt" timestamptz(6) NOT NULL, "registeredAt" timestamptz(6) NOT NULL,
 "membership" "Membership" NOT NULL, "active" boolean NOT NULL,
 "displayName" text, "kind" text NOT NULL CHECK ("kind" IN ('BASELINE','REGISTER','IDENTITY','ACTIVE')),
 "reason" text, "changedById" text REFERENCES "Account"("id") ON DELETE RESTRICT
);
CREATE INDEX "LotteryAccountFact_asof_idx" ON "LotteryAccountFact"("accountId","effectiveAt" DESC,"sequence" DESC);
INSERT INTO "LotteryEligibilityControl" VALUES (1,lottery_eligibility_now());
-- The existing account contract has no deactivation lifecycle before this activation.
-- Establish its current all-active policy once; later inactive states are never reset here.
INSERT INTO "LotteryAccountStatus" ("accountId","active") SELECT "id",true FROM "Account";
INSERT INTO "LotteryAccountFact" ("accountId","effectiveAt","registeredAt","membership","active","displayName","kind")
 SELECT a."id",c."enabledAt",a."createdAt",a."membership",s."active",a."displayName",'BASELINE'
 FROM "Account" a JOIN "LotteryAccountStatus" s ON s."accountId"=a."id" CROSS JOIN "LotteryEligibilityControl" c;
CREATE FUNCTION lottery_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Lottery eligibility history and activation boundary are immutable';
END $$;
CREATE TRIGGER "LotteryFact_immutable" BEFORE UPDATE OR DELETE ON "LotteryAccountFact" FOR EACH ROW EXECUTE FUNCTION lottery_history_immutable();
CREATE TRIGGER "LotteryControl_immutable" BEFORE UPDATE OR DELETE ON "LotteryEligibilityControl" FOR EACH ROW EXECUTE FUNCTION lottery_history_immutable();
CREATE TRIGGER "LotteryStatus_no_delete" BEFORE DELETE ON "LotteryAccountStatus" FOR EACH ROW EXECUTE FUNCTION lottery_history_immutable();
CREATE FUNCTION lottery_capture_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t timestamptz(6); registered timestamptz(6); enabled timestamptz(6); enabled_state boolean;
BEGIN
 SELECT "enabledAt" INTO STRICT enabled FROM "LotteryEligibilityControl" WHERE "id"=1;
 t := GREATEST(lottery_eligibility_now(),enabled);
 IF TG_OP='INSERT' THEN
  INSERT INTO "LotteryAccountStatus" ("accountId","reason") VALUES (NEW."id",'Registration');
  registered := t;
 ELSE
  IF NEW."membership" IS NOT DISTINCT FROM OLD."membership" AND NEW."displayName" IS NOT DISTINCT FROM OLD."displayName" THEN RETURN NEW; END IF;
  SELECT "registeredAt",GREATEST(t,"effectiveAt") INTO STRICT registered,t FROM "LotteryAccountFact" WHERE "accountId"=NEW."id" ORDER BY "sequence" DESC LIMIT 1;
 END IF;
 SELECT "active" INTO STRICT enabled_state FROM "LotteryAccountStatus" WHERE "accountId"=NEW."id";
 INSERT INTO "LotteryAccountFact" ("accountId","effectiveAt","registeredAt","membership","active","displayName","kind")
 VALUES (NEW."id",t,registered,NEW."membership",enabled_state,NEW."displayName",CASE WHEN TG_OP='INSERT' THEN 'REGISTER' ELSE 'IDENTITY' END);
 RETURN NEW;
END $$;
CREATE TRIGGER "LotteryAccount_capture" AFTER INSERT OR UPDATE OF "membership","displayName" ON "Account" FOR EACH ROW EXECUTE FUNCTION lottery_capture_account();
CREATE FUNCTION lottery_lock_status_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM "id" FROM "Account" WHERE "id"=NEW."accountId" FOR NO KEY UPDATE;
 IF NEW."accountId" IS DISTINCT FROM OLD."accountId" OR NEW."revision"<>OLD."revision"+1 OR btrim(NEW."reason")='' THEN RAISE EXCEPTION 'Invalid lottery account status command'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "LotteryStatus_lock" BEFORE UPDATE ON "LotteryAccountStatus" FOR EACH ROW EXECUTE FUNCTION lottery_lock_status_account();
CREATE FUNCTION lottery_capture_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "Account"%ROWTYPE; registered timestamptz(6); t timestamptz(6);
BEGIN
 SELECT * INTO STRICT a FROM "Account" WHERE "id"=NEW."accountId";
 SELECT "registeredAt" INTO STRICT registered FROM "LotteryAccountFact" WHERE "accountId"=NEW."accountId" ORDER BY "sequence" DESC LIMIT 1;
 SELECT GREATEST(lottery_eligibility_now(),"enabledAt",(SELECT max("effectiveAt") FROM "LotteryAccountFact" WHERE "accountId"=NEW."accountId")) INTO STRICT t FROM "LotteryEligibilityControl" WHERE "id"=1;
 INSERT INTO "LotteryAccountFact" ("accountId","effectiveAt","registeredAt","membership","active","displayName","kind","reason","changedById")
 VALUES (a."id",t,registered,a."membership",NEW."active",a."displayName",'ACTIVE',NEW."reason",NEW."changedById");
 RETURN NEW;
END $$;
CREATE TRIGGER "LotteryStatus_capture" AFTER UPDATE ON "LotteryAccountStatus" FOR EACH ROW EXECUTE FUNCTION lottery_capture_status();

-- Never hold the table fence while waiting on row-first writers (activity score updates).
-- The caller rolls back the whole transaction on false before retrying.
CREATE FUNCTION lottery_try_account_fence() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
 LOCK TABLE "Account" IN SHARE MODE NOWAIT;
 PERFORM "id" FROM "Account" ORDER BY "id" FOR SHARE NOWAIT;
 RETURN true;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;
COMMIT;
