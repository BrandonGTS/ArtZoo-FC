-- Additive only. Applied exclusively to a fresh disposable DB by the lottery task.
CREATE TABLE "Lottery" (
 "id" TEXT PRIMARY KEY, "creatorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "idempotencyKey" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
 "title" VARCHAR(80) NOT NULL, "kind" TEXT NOT NULL CHECK ("kind" IN ('ORDINARY','MONTHLY')),
 "mode" TEXT NOT NULL CHECK ("mode" IN ('MANUAL','AUTO')), "audience" TEXT NOT NULL CHECK ("audience" IN ('MEMBER','MEMBER_FRIEND')),
 "month" VARCHAR(7), "minDays" INTEGER, "prizes" JSONB NOT NULL,
 "drawAt" TIMESTAMPTZ(3) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "state" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("state" IN ('OPEN','DRAWN','CANCELLED')),
 "result" JSONB, "closedAt" TIMESTAMPTZ(3), UNIQUE ("creatorId","idempotencyKey"),
 CHECK (("kind"='ORDINARY' AND "month" IS NULL AND "minDays" IS NULL) OR ("kind"='MONTHLY' AND "month" IS NOT NULL AND "minDays" BETWEEN 1 AND 31)),
 CHECK (("state"='DRAWN') = ("result" IS NOT NULL))
);
CREATE INDEX "Lottery_state_drawAt_idx" ON "Lottery"("state","drawAt");
CREATE TABLE "LotteryEntry" (
 "lotteryId" TEXT NOT NULL REFERENCES "Lottery"("id") ON DELETE RESTRICT,
 "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "state" TEXT NOT NULL CHECK ("state" IN ('ACTIVE','WITHDRAWN')),
 "source" TEXT NOT NULL CHECK ("source" IN ('MANUAL','AUTO')),
 "joinedAt" TIMESTAMPTZ(3) NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 PRIMARY KEY ("lotteryId","accountId")
);
CREATE TABLE "LotteryCommand" (
 "lotteryId" TEXT NOT NULL REFERENCES "Lottery"("id") ON DELETE RESTRICT,
 "actorId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT,
 "key" TEXT NOT NULL, "action" TEXT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
 PRIMARY KEY ("lotteryId","actorId","key")
);
CREATE TABLE "LotteryNotification" (
 "eventKey" TEXT PRIMARY KEY, "lotteryId" TEXT NOT NULL REFERENCES "Lottery"("id") ON DELETE RESTRICT,
 "recipientId" TEXT REFERENCES "Account"("id") ON DELETE RESTRICT, "channel" TEXT NOT NULL CHECK ("channel" IN ('IN_APP','QQ')),
 "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
 "simulatedAt" TIMESTAMPTZ(3), "attempts" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "LotteryNotification_pending_idx" ON "LotteryNotification"("simulatedAt","createdAt");
-- Published settings and final result are immutable even if a future caller bypasses service guards.
CREATE FUNCTION lottery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."state" <> 'OPEN' OR (to_jsonb(NEW) - ARRAY['state','result','closedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','result','closedAt']) THEN
  RAISE EXCEPTION 'Published lottery and final result are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Lottery_immutable" BEFORE UPDATE ON "Lottery" FOR EACH ROW EXECUTE FUNCTION lottery_immutable();
