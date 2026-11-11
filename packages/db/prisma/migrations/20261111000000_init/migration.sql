-- ArtZoo 初始迁移：建立新站的全部数据库结构。
--
-- 由来（阶段 3，2026-11-11）：
--   这个文件替换了旧站留下的 68 个历史迁移（20261013110000_account_invitation 到
--   20261108000000_single_content_moderation）。做法是在空库里按顺序跑完 68 个迁移，
--   用 pg_dump 17.11 导出结构。对导出内容只做了两处处理：
--     1. 去掉 pg_dump 的会话设置和注释头；
--     2. 16 处"文本列只能取这几个值"的检查（如 state IN ('RESERVED', ...)）改回旧迁移原来的 IN 写法。
--        pg_dump 导出的等价写法重新执行后，数据库内部保存的表达式会多一层类型转换，结构快照能看出差别。
--   最后补上旧迁移写入的初始数据。
--
-- 验证：
--   跑完本文件后，数据库结构快照（packages/db/prisma/schema-snapshot.txt）与 68 个旧迁移的结果逐行一致，
--   唯一差别是知识库少了 2 个旧分区（见文件末尾说明，站长 2026-11-11 决定）。
--
-- 注意：
--   检查约束、带条件的唯一索引、触发器和函数在 schema.prisma 里写不出来，只记录在这里和结构快照里。
--   已合并的迁移不要修改；要改结构，请新建一个迁移，并运行 pnpm db:snapshot --write 更新快照。

BEGIN;

-- 函数排在表前面（与 pg_dump 相同）。个别函数在声明里引用了表的行类型（如 "Account"%ROWTYPE），
-- 所以本事务内暂停创建函数时的函数体检查；函数第一次被调用时仍会完整检查。只影响本事务。
SET LOCAL check_function_bodies = false;

-- ==================== 枚举 ====================

CREATE TYPE public."ActivityCategory" AS ENUM (
    'DUNGEON',
    'SOCIAL'
);

CREATE TYPE public."ActivityEventKind" AS ENUM (
    'ACTIVITY_PUBLISHED',
    'REGISTRATION_CREATED',
    'REGISTRATION_WITHDRAWN',
    'ACTIVITY_RESCHEDULED',
    'ACTIVITY_CANCELLED',
    'ACTIVITY_PENALTY',
    'ACTIVITY_SCORE_CORRECTED',
    'ATTENDANCE_APPEAL_RESULT',
    'ACTIVITY_COMPLETED',
    'PENALTY_APPEAL_RESULT',
    'REGISTRATION_CONFIRMED',
    'SERIES_READY',
    'SERIES_FORMED'
);

CREATE TYPE public."ActivityMode" AS ENUM (
    'SINGLE',
    'SERIES'
);

CREATE TYPE public."ActivityNotificationChannel" AS ENUM (
    'QQ',
    'IN_APP'
);

CREATE TYPE public."ActivityRole" AS ENUM (
    'TANK',
    'HEALER',
    'DAMAGE'
);

CREATE TYPE public."ActivityScene" AS ENUM (
    'GAME',
    'OFFLINE'
);

CREATE TYPE public."ActivitySeatKind" AS ENUM (
    'ANY',
    'ROLE',
    'JOB'
);

CREATE TYPE public."AdminRole" AS ENUM (
    'NONE',
    'ADMIN',
    'SUPER_ADMIN'
);

CREATE TYPE public."AlbumPrimaryCategory" AS ENUM (
    'GAME',
    'OFFLINE',
    'DAILY'
);

CREATE TYPE public."AlbumPublicity" AS ENUM (
    'INTERNAL',
    'PUBLIC_FEATURED'
);

CREATE TYPE public."AlbumUploadMode" AS ENUM (
    'AUTHOR',
    'COMMUNITY',
    'ACTIVITY'
);

CREATE TYPE public."FeaturedPhotoPool" AS ENUM (
    'CANDIDATE',
    'SELECTED'
);

CREATE TYPE public."GuestContactStatus" AS ENUM (
    'PENDING',
    'PROCESSED'
);

CREATE TYPE public."InvitationUsageMode" AS ENUM (
    'SINGLE',
    'MULTIPLE'
);

CREATE TYPE public."Membership" AS ENUM (
    'MEMBER',
    'FRIEND'
);

CREATE TYPE public."VerificationPurpose" AS ENUM (
    'REGISTER',
    'RESET_PASSWORD'
);

-- ==================== 函数 ====================

CREATE FUNCTION public."accountLifecycleAppendOnly"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'Account lifecycle history is append-only'; END; $$;

CREATE FUNCTION public.activity_share_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'Activity share history is append-only'; END; $$;

CREATE FUNCTION public."adminManagementAppendOnly"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'Management history is append-only'; END; $$;

CREATE FUNCTION public.artzoo_clear_quick_icon_budget_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.artzoo_preserve_album_comment_mount() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD."orphanMountedAt" IS NOT NULL OR OLD."commentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Previously mounted media must remain retained';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."commentId" IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM "MediaRetirementIntent" i
      JOIN "MediaStoredComponent" c ON c.id=i."componentId"
      JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='album-comment' AND c.policy='PHOTO_VARIANT'
        AND c."objectKey"='album-comment:'||NEW.id AND r.scope='album-comment'
        AND r."objectIdentity"=c."objectKey" AND r."attemptId"=c.generation AND r.state='COMMITTED') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Fenced media cannot be attached';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."orphanMountedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Mount fact is server observed';
    END IF;
    IF NEW."commentId" IS NOT NULL THEN NEW."orphanMountedAt" := clock_timestamp(); END IF;
    RETURN NEW;
  END IF;
  IF NEW."orphanMountedAt" IS DISTINCT FROM OLD."orphanMountedAt" THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Mount fact is permanent';
  END IF;
  IF OLD."orphanMountedAt" IS NULL AND (OLD."commentId" IS NOT NULL OR NEW."commentId" IS NOT NULL) THEN
    NEW."orphanMountedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION public.artzoo_preserve_knowledge_mount() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD."orphanMountedAt" IS NOT NULL OR OLD."articleId" IS NOT NULL OR OLD."commentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Previously mounted media must remain retained';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."articleId" IS NOT NULL OR NEW."commentId" IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM "MediaRetirementIntent" i
      JOIN "MediaStoredComponent" c ON c.id=i."componentId"
      JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='knowledge' AND c.policy='PHOTO_VARIANT'
        AND c."objectKey"='knowledge:'||NEW.id AND r.scope='knowledge'
        AND r."objectIdentity"=c."objectKey" AND r."attemptId"=c.generation AND r.state='COMMITTED') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Fenced media cannot be attached';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."orphanMountedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Mount fact is server observed';
    END IF;
    IF NEW."articleId" IS NOT NULL OR NEW."commentId" IS NOT NULL THEN NEW."orphanMountedAt" := clock_timestamp(); END IF;
    RETURN NEW;
  END IF;
  IF NEW."orphanMountedAt" IS DISTINCT FROM OLD."orphanMountedAt" THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Mount fact is permanent';
  END IF;
  IF OLD."orphanMountedAt" IS NULL AND (OLD."articleId" IS NOT NULL OR OLD."commentId" IS NOT NULL OR NEW."articleId" IS NOT NULL OR NEW."commentId" IS NOT NULL) THEN
    NEW."orphanMountedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION public.artzoo_preserve_lottery_mount_fact() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."lotteryMountedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='MediaUploadReceipt_lottery_mount_fact', MESSAGE='Lottery mount fact requires an existing started typed receipt';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD."lotteryMountedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='MediaUploadReceipt_lottery_mount_fact', MESSAGE='Lottery mount fact is permanent';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."lotteryMountedAt" IS NOT NULL THEN
    -- Existing settle/UNKNOWN/replay transitions may only change these lifecycle fields.
    IF (to_jsonb(NEW)-ARRAY['state','settledAt','updatedAt'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','settledAt','updatedAt']) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='MediaUploadReceipt_lottery_mount_fact', MESSAGE='Lottery mounted identity and generation are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."lotteryMountedAt" IS NOT NULL THEN
    IF (to_jsonb(NEW)-ARRAY['lotteryMountedAt','updatedAt'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['lotteryMountedAt','updatedAt'])
       OR NEW.scope<>'lottery-image' OR NEW."persistenceStartedAt" IS NULL
       OR NEW.state NOT IN ('RESERVED','UNKNOWN','COMMITTED')
       OR NEW."metadataReservedBytes"<>0
       OR NEW."objectIdentity" !~ '^lottery:[a-f0-9-]{36}:[a-f0-9-]{36}$'
       OR split_part(NEW."objectIdentity",':',2)<>NEW."accountId"
       OR NOT EXISTS (
         SELECT 1 FROM "MediaStoredComponent" c
         WHERE c."receiptScope"=NEW.scope AND c."receiptOperationKey"=NEW."operationKey"
         GROUP BY c."receiptScope",c."receiptOperationKey"
         HAVING count(*)=3 AND count(DISTINCT c.part)=3
           AND sum(c."chargedBytes")=NEW."storedBytes"
           AND bool_and(c."sourceKind"='RECEIPT' AND c."baselineStateId" IS NULL
             AND c."baselineFingerprint" IS NULL AND c.namespace='lottery-image'
             AND c."objectKey"=NEW."objectIdentity" AND c.generation=NEW."attemptId"
             AND c.policy='PHOTO_VARIANT'
             AND c.part IN ('photo-original','photo-preview','photo-thumbnail')
             AND c."contentBindingSha256" ~ '^[a-f0-9]{64}$'
             AND c."chargedBytes">0
             AND c."chargedBytes"<=CASE WHEN c.part='photo-original' THEN 31457280 ELSE 62914560 END)
       )
       OR EXISTS (
         SELECT 1 FROM "MediaRetirementIntent" i JOIN "MediaStoredComponent" c ON c.id=i."componentId"
         WHERE c."receiptScope"=NEW.scope AND c."receiptOperationKey"=NEW."operationKey"
       ) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='MediaUploadReceipt_lottery_mount_fact', MESSAGE='Lottery mount fact requires the exact unfenced typed generation';
    END IF;
  END IF;
  RETURN NEW;
END $_$;

CREATE FUNCTION public."guardMediaCosObject"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;

CREATE FUNCTION public.local_qc_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 RAISE EXCEPTION 'Local QC ownership records are append-only' USING ERRCODE='23514';
END;
$$;

CREATE FUNCTION public.lottery_capture_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.lottery_capture_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE a "Account"%ROWTYPE; registered timestamptz(6); t timestamptz(6);
BEGIN
 SELECT * INTO STRICT a FROM "Account" WHERE "id"=NEW."accountId";
 SELECT "registeredAt" INTO STRICT registered FROM "LotteryAccountFact" WHERE "accountId"=NEW."accountId" ORDER BY "sequence" DESC LIMIT 1;
 SELECT GREATEST(lottery_eligibility_now(),"enabledAt",(SELECT max("effectiveAt") FROM "LotteryAccountFact" WHERE "accountId"=NEW."accountId")) INTO STRICT t FROM "LotteryEligibilityControl" WHERE "id"=1;
 INSERT INTO "LotteryAccountFact" ("accountId","effectiveAt","registeredAt","membership","active","displayName","kind","reason","changedById")
 VALUES (a."id",t,registered,a."membership",NEW."active",a."displayName",'ACTIVE',NEW."reason",NEW."changedById");
 RETURN NEW;
END $$;

CREATE FUNCTION public.lottery_eligibility_now() RETURNS timestamp with time zone
    LANGUAGE sql
    AS $$ SELECT clock_timestamp() $$;

CREATE FUNCTION public.lottery_history_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 RAISE EXCEPTION 'Lottery eligibility history and activation boundary are immutable';
END $$;

CREATE FUNCTION public.lottery_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 IF OLD."moderatedAt" IS NOT NULL OR NEW."revision" <> OLD."revision" + 1
 OR (to_jsonb(NEW) - ARRAY['state','result','closedAt','moderatedAt','revision'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['state','result','closedAt','moderatedAt','revision']) THEN
  RAISE EXCEPTION 'Published lottery and final result are immutable';
 END IF;
 IF NEW."moderatedAt" IS NOT NULL THEN
  IF ROW(NEW."state", NEW."result", NEW."closedAt")
     IS DISTINCT FROM ROW(OLD."state", OLD."result", OLD."closedAt") THEN
   RAISE EXCEPTION 'Governance must preserve lottery state and final result';
  END IF;
 ELSIF OLD."state" <> 'OPEN' THEN
  RAISE EXCEPTION 'Published lottery and final result are immutable';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.lottery_lock_status_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 PERFORM "id" FROM "Account" WHERE "id"=NEW."accountId" FOR NO KEY UPDATE;
 IF NEW."accountId" IS DISTINCT FROM OLD."accountId" OR NEW."revision"<>OLD."revision"+1 OR btrim(NEW."reason")='' THEN RAISE EXCEPTION 'Invalid lottery account status command'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.lottery_try_account_fence() RETURNS boolean
    LANGUAGE plpgsql
    AS $$ BEGIN
 LOCK TABLE "Account" IN SHARE MODE NOWAIT;
 PERFORM "id" FROM "Account" ORDER BY "id" FOR SHARE NOWAIT;
 RETURN true;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;

CREATE FUNCTION public.preserve_official_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'official audit must be retained'; END $$;

CREATE FUNCTION public.preserve_official_event_image() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
 BEGIN RAISE EXCEPTION 'official image metadata must be retained'; END $$;

CREATE FUNCTION public.preserve_official_event_original() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'official records must be retained'; END IF;
 IF (NEW.id,NEW."sourceKey",NEW."createdAt") IS DISTINCT FROM (OLD.id,OLD."sourceKey",OLD."createdAt")
 THEN RAISE EXCEPTION 'official identity must be retained'; END IF;
 IF NEW."externalId" IS DISTINCT FROM OLD."externalId" AND NOT (
  OLD."externalId" ~ '^(activity|news):' AND NEW."externalId" ~ '^calendar:[0-9]{1,20}$'
 ) THEN RAISE EXCEPTION 'official calendar identity must be retained'; END IF;
 RETURN NEW;
END $_$;

-- ==================== 表（含自增序列） ====================

CREATE TABLE public."Account" (
    id text NOT NULL,
    phone text NOT NULL,
    "passwordHash" text NOT NULL,
    "passwordVersion" integer DEFAULT 0 NOT NULL,
    "displayName" text,
    membership public."Membership" NOT NULL,
    "adminRole" public."AdminRole" DEFAULT 'NONE'::public."AdminRole" NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "gameRegion" text,
    "gameServer" text,
    "activityPoints" integer DEFAULT 0 NOT NULL,
    "activityDecayAt" timestamp(3) with time zone,
    "adminRoleRevision" integer DEFAULT 0 NOT NULL,
    "localQcNamespace" text,
    "localQcSlot" text,
    CONSTRAINT "Account_activity_standing_check" CHECK ((("activityPoints" >= 0) AND ((("activityPoints" < 3) AND ("activityDecayAt" IS NULL)) OR (("activityPoints" >= 3) AND ("activityDecayAt" IS NOT NULL))))),
    CONSTRAINT "Account_adminRoleRevision_check" CHECK (("adminRoleRevision" >= 0)),
    CONSTRAINT "Account_game_location_pair_check" CHECK (((("gameRegion" IS NULL) AND ("gameServer" IS NULL)) OR (("gameRegion" IS NOT NULL) AND ("gameServer" IS NOT NULL) AND ("displayName" IS NOT NULL)))),
    CONSTRAINT "Account_local_qc_marker_check" CHECK (((("localQcNamespace" IS NULL) AND ("localQcSlot" IS NULL)) OR (("localQcNamespace" IS NOT NULL) AND ("localQcSlot" IS NOT NULL) AND ("localQcNamespace" = 'artzoo-local-qc-v1'::text) AND ("localQcSlot" = ANY (ARRAY['member-a'::text, 'member-b'::text, 'friend'::text, 'admin'::text])))))
);

CREATE TABLE public."AccountAudit" (
    id text NOT NULL,
    action text NOT NULL,
    "actorId" text NOT NULL,
    "targetAccountId" text,
    "invitationId" text,
    "beforeMembership" public."Membership",
    "afterMembership" public."Membership",
    reason text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."AccountLifecycleAudit" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "targetAccountId" text NOT NULL,
    "beforeActive" boolean NOT NULL,
    "afterActive" boolean NOT NULL,
    "revisionBefore" integer NOT NULL,
    "revisionAfter" integer NOT NULL,
    reason text NOT NULL,
    impact jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "AccountLifecycleAudit_transition_check" CHECK ((("beforeActive" <> "afterActive") AND ("revisionBefore" >= 0) AND ("revisionAfter" = ("revisionBefore" + 1)) AND ((length(TRIM(BOTH FROM reason)) >= 1) AND (length(TRIM(BOTH FROM reason)) <= 1000)) AND ("actorId" <> "targetAccountId")))
);

CREATE TABLE public."AccountLifecycleCommand" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "targetAccountId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    result jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."AccountRateEvent" (
    id text NOT NULL,
    key text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."AccountSession" (
    id text NOT NULL,
    "tokenHash" text NOT NULL,
    "accountId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "revokedAt" timestamp(3) with time zone
);

CREATE TABLE public."Activity" (
    id text NOT NULL,
    "organizerId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    category public."ActivityCategory" NOT NULL,
    "startsAt" timestamp(3) with time zone NOT NULL,
    "endsAt" timestamp(3) with time zone NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "dutyId" text,
    "dutySnapshot" jsonb,
    revision integer DEFAULT 0 NOT NULL,
    "cancelledAt" timestamp(3) with time zone,
    "cancellationReason" text,
    "continuedAt" timestamp(3) with time zone,
    "managementEnabledAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "attendanceEnabledAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completionEnabledAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP,
    "capacityUnlimited" boolean DEFAULT false NOT NULL,
    location text,
    "meetingInstructions" text,
    mode public."ActivityMode" DEFAULT 'SINGLE'::public."ActivityMode" NOT NULL,
    "periodNumber" integer,
    "registrationClosesAt" timestamp(3) with time zone,
    scene public."ActivityScene" DEFAULT 'GAME'::public."ActivityScene" NOT NULL,
    "seriesId" text,
    "autoAbsenceEnabledAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Activity_offline_shape_check" CHECK (((scene <> 'OFFLINE'::public."ActivityScene") OR ((mode = 'SINGLE'::public."ActivityMode") AND (category = 'SOCIAL'::public."ActivityCategory") AND (location IS NOT NULL) AND ("registrationClosesAt" IS NOT NULL) AND ("registrationClosesAt" <= "startsAt") AND ("dutyId" IS NULL) AND ("dutySnapshot" IS NULL) AND ("completionEnabledAt" IS NULL)))),
    CONSTRAINT "Activity_series_shape_check" CHECK ((((mode = 'SINGLE'::public."ActivityMode") AND ("seriesId" IS NULL) AND ("periodNumber" IS NULL)) OR ((mode = 'SERIES'::public."ActivityMode") AND (scene = 'GAME'::public."ActivityScene") AND ("seriesId" IS NOT NULL) AND (("periodNumber" >= 1) AND ("periodNumber" <= 10)) AND (NOT "capacityUnlimited")))),
    CONSTRAINT "Activity_text_bounds_check" CHECK ((((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 100)) AND (char_length(description) <= 2000))),
    CONSTRAINT "Activity_time_range_check" CHECK (("endsAt" > "startsAt"))
);

CREATE TABLE public."ActivityAttendanceAppeal" (
    id text NOT NULL,
    "registrationId" text NOT NULL,
    "accountId" text NOT NULL,
    "attendanceRevision" integer NOT NULL,
    "requestedStatus" text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "decisionReason" text,
    "decidedById" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "decidedAt" timestamp(3) with time zone,
    CONSTRAINT "ActivityAttendanceAppeal_decision_check" CHECK ((((status = 'PENDING'::text) AND ("decidedAt" IS NULL) AND ("decidedById" IS NULL) AND ("decisionReason" IS NULL)) OR ((status <> 'PENDING'::text) AND ("decidedAt" IS NOT NULL) AND ("decidedById" IS NOT NULL) AND ("decisionReason" IS NOT NULL)))),
    CONSTRAINT "ActivityAttendanceAppeal_requestedStatus_check" CHECK (("requestedStatus" = ANY (ARRAY['PRESENT'::text, 'ABSENT'::text]))),
    CONSTRAINT "ActivityAttendanceAppeal_status_check" CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])))
);

CREATE TABLE public."ActivityCommand" (
    id text NOT NULL,
    "activityId" text NOT NULL,
    "actorId" text,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    kind text NOT NULL,
    before jsonb NOT NULL,
    after jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."ActivityCompletion" (
    id text NOT NULL,
    "activityId" text NOT NULL,
    "accountId" text NOT NULL,
    "registrationId" text NOT NULL,
    active boolean NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "evaluatedAt" timestamp(3) with time zone NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    CONSTRAINT "ActivityCompletion_revision_check" CHECK ((revision >= 0))
);

CREATE TABLE public."ActivityMockDelivery" (
    id text NOT NULL,
    "eventId" text NOT NULL,
    "deliveredAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."ActivityOutbox" (
    id text NOT NULL,
    "eventKey" text NOT NULL,
    "activityId" text NOT NULL,
    "registrationId" text,
    kind public."ActivityEventKind" NOT NULL,
    channel public."ActivityNotificationChannel" NOT NULL,
    "recipientId" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    payload jsonb,
    "messageReadAt" timestamp(3) with time zone,
    "messageDeletedAt" timestamp(3) with time zone,
    CONSTRAINT "ActivityOutbox_route_check" CHECK (((((kind)::text = 'ACTIVITY_PUBLISHED'::text) AND (channel = 'QQ'::public."ActivityNotificationChannel") AND ("recipientId" IS NULL) AND ("registrationId" IS NULL)) OR (((kind)::text = ANY (ARRAY['REGISTRATION_CREATED'::text, 'REGISTRATION_WITHDRAWN'::text, 'REGISTRATION_CONFIRMED'::text])) AND (channel = 'IN_APP'::public."ActivityNotificationChannel") AND ("recipientId" IS NOT NULL) AND ("registrationId" IS NOT NULL)) OR (((kind)::text = ANY (ARRAY['ACTIVITY_RESCHEDULED'::text, 'ACTIVITY_CANCELLED'::text])) AND ("registrationId" IS NULL) AND (((channel = 'QQ'::public."ActivityNotificationChannel") AND ("recipientId" IS NULL)) OR ((channel = 'IN_APP'::public."ActivityNotificationChannel") AND ("recipientId" IS NOT NULL)))) OR (((kind)::text = 'ACTIVITY_PENALTY'::text) AND (channel = 'IN_APP'::public."ActivityNotificationChannel") AND ("recipientId" IS NOT NULL)) OR (((kind)::text = ANY (ARRAY['ACTIVITY_SCORE_CORRECTED'::text, 'ATTENDANCE_APPEAL_RESULT'::text, 'ACTIVITY_COMPLETED'::text])) AND (channel = 'IN_APP'::public."ActivityNotificationChannel") AND ("recipientId" IS NOT NULL) AND ("registrationId" IS NOT NULL)) OR (((kind)::text = ANY (ARRAY['SERIES_READY'::text, 'SERIES_FORMED'::text])) AND (channel = 'IN_APP'::public."ActivityNotificationChannel") AND ("recipientId" IS NOT NULL)) OR (((kind)::text = 'PENALTY_APPEAL_RESULT'::text) AND (channel = 'IN_APP'::public."ActivityNotificationChannel") AND ("recipientId" IS NOT NULL))))
);

CREATE TABLE public."ActivityPenalty" (
    id text NOT NULL,
    "eventKey" text NOT NULL,
    "accountId" text NOT NULL,
    "activityId" text NOT NULL,
    "registrationId" text,
    points integer NOT NULL,
    reason text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "reversedAt" timestamp(3) with time zone,
    "reversalReason" text,
    "appealEnabledAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivityPenalty_points_check" CHECK ((((reason = 'LATE_WITHDRAWAL'::text) AND (points = 1)) OR ((reason = ANY (ARRAY['LATE_CANCELLATION'::text, 'NO_SHOW'::text, 'SERIES_UNAGREED_ABSENCE'::text, 'SERIES_UNCOMMUNICATED_EXIT'::text])) AND (points = 2))))
);

CREATE TABLE public."ActivityPenaltyAppeal" (
    id text NOT NULL,
    sequence bigint NOT NULL,
    "penaltyId" text NOT NULL,
    "accountId" text NOT NULL,
    reason text NOT NULL,
    "submissionKey" text NOT NULL,
    "submissionFingerprint" text NOT NULL,
    "decisionKey" text,
    "decisionFingerprint" text,
    status text DEFAULT 'PENDING'::text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "decisionReason" text,
    "decidedById" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "decidedAt" timestamp(3) with time zone,
    CONSTRAINT "ActivityPenaltyAppeal_decision_check" CHECK ((((status = 'PENDING'::text) AND (revision = 0) AND ("decidedAt" IS NULL) AND ("decidedById" IS NULL) AND ("decisionReason" IS NULL) AND ("decisionKey" IS NULL) AND ("decisionFingerprint" IS NULL)) OR ((status <> 'PENDING'::text) AND (revision = 1) AND ("decidedAt" IS NOT NULL) AND ("decidedById" IS NOT NULL) AND ("decisionReason" IS NOT NULL) AND ("decisionKey" IS NOT NULL) AND ("decisionFingerprint" IS NOT NULL)))),
    CONSTRAINT "ActivityPenaltyAppeal_revision_check" CHECK ((revision >= 0)),
    CONSTRAINT "ActivityPenaltyAppeal_status_check" CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])))
);

CREATE SEQUENCE public."ActivityPenaltyAppeal_sequence_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public."ActivityPenaltyAppeal_sequence_seq" OWNED BY public."ActivityPenaltyAppeal".sequence;

CREATE TABLE public."ActivityRegistration" (
    id text NOT NULL,
    "activityId" text NOT NULL,
    "seatId" text,
    "accountId" text NOT NULL,
    job text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    "exitedAt" timestamp(3) with time zone,
    "seatSnapshot" jsonb,
    "rescheduleExitAllowed" boolean DEFAULT false NOT NULL,
    "attendanceStatus" text,
    "attendanceRevision" integer DEFAULT 0 NOT NULL,
    "attendanceRecordedAt" timestamp(3) with time zone,
    "attendanceUpdatedAt" timestamp(3) with time zone,
    "attendancePenaltyId" text,
    "attendanceSource" text,
    CONSTRAINT "ActivityRegistration_attendance_source_check" CHECK ((("attendanceSource" IS NULL) OR (("attendanceSource" = ANY (ARRAY['ORGANIZER'::text, 'AUTO_DEADLINE'::text])) AND ("attendanceStatus" IS NOT NULL) AND ("attendanceRecordedAt" IS NOT NULL)))),
    CONSTRAINT "ActivityRegistration_attendance_state_check" CHECK ((("attendanceRevision" >= 0) AND ((("attendanceStatus" IS NULL) AND ("attendanceRecordedAt" IS NULL) AND ("attendanceUpdatedAt" IS NULL) AND ("attendancePenaltyId" IS NULL)) OR (("attendanceStatus" IS NOT NULL) AND ("attendanceStatus" = 'PRESENT'::text) AND ("attendanceRecordedAt" IS NOT NULL) AND ("attendanceUpdatedAt" IS NOT NULL) AND ("attendancePenaltyId" IS NULL)) OR (("attendanceStatus" IS NOT NULL) AND ("attendanceStatus" = 'ABSENT'::text) AND ("attendanceRecordedAt" IS NOT NULL) AND ("attendanceUpdatedAt" IS NOT NULL) AND ("attendancePenaltyId" IS NOT NULL))))),
    CONSTRAINT "ActivityRegistration_state_check" CHECK ((((status = 'ACTIVE'::text) AND ("seatId" IS NOT NULL) AND ("exitedAt" IS NULL)) OR ((status = ANY (ARRAY['WITHDRAWN'::text, 'CANCELLED'::text])) AND ("seatId" IS NULL) AND ("exitedAt" IS NOT NULL) AND ("seatSnapshot" IS NOT NULL))))
);

CREATE TABLE public."ActivityScoreChange" (
    id text NOT NULL,
    "eventKey" text NOT NULL,
    "accountId" text NOT NULL,
    "penaltyId" text,
    delta integer NOT NULL,
    "pointsBefore" integer NOT NULL,
    "pointsAfter" integer NOT NULL,
    reason text NOT NULL,
    notices text[] DEFAULT '{}'::text[] NOT NULL,
    "simulatedAt" timestamp(3) with time zone NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    sequence bigint NOT NULL,
    "decayBefore" timestamp(3) with time zone,
    "decayAfter" timestamp(3) with time zone,
    "completionId" text,
    "messageReadAt" timestamp(3) with time zone,
    "messageDeletedAt" timestamp(3) with time zone,
    CONSTRAINT "ActivityScoreChange_points_check" CHECK ((("pointsBefore" >= 0) AND ("pointsAfter" >= 0) AND (("pointsAfter" - "pointsBefore") = delta)))
);

CREATE SEQUENCE public."ActivityScoreChange_sequence_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public."ActivityScoreChange_sequence_seq" OWNED BY public."ActivityScoreChange".sequence;

CREATE TABLE public."ActivitySeat" (
    id text NOT NULL,
    "activityId" text NOT NULL,
    "position" integer NOT NULL,
    kind public."ActivitySeatKind" NOT NULL,
    role public."ActivityRole",
    job text,
    "groupKey" text,
    CONSTRAINT "ActivitySeat_groupKey_check" CHECK ((("groupKey" IS NULL) OR ("groupKey" = ANY (ARRAY['A'::text, 'B'::text, 'C'::text])))),
    CONSTRAINT "ActivitySeat_position_check" CHECK (("position" >= 0)),
    CONSTRAINT "ActivitySeat_requirement_check" CHECK ((((kind = 'ANY'::public."ActivitySeatKind") AND (role IS NULL) AND (job IS NULL)) OR ((kind = 'ROLE'::public."ActivitySeatKind") AND (role IS NOT NULL) AND (job IS NULL)) OR ((kind = 'JOB'::public."ActivitySeatKind") AND (role IS NULL) AND (job IS NOT NULL))))
);

CREATE TABLE public."ActivitySeries" (
    id text NOT NULL,
    state text DEFAULT 'RECRUITING'::text NOT NULL,
    weekdays integer[],
    "durationMinutes" integer NOT NULL,
    "totalPeriods" integer NOT NULL,
    "endDate" text,
    "formedAt" timestamp(3) with time zone,
    "cancelledAt" timestamp(3) with time zone,
    "readyNotifiedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ActivitySeries_finite_plan_check" CHECK (((("totalPeriods" >= 2) AND ("totalPeriods" <= 10)) AND ("durationMinutes" > 0) AND ((cardinality(weekdays) >= 1) AND (cardinality(weekdays) <= 7)) AND (weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]) AND (state = ANY (ARRAY['RECRUITING'::text, 'FORMED'::text, 'CANCELLED'::text]))))
);

CREATE TABLE public."ActivityShare" (
    id text NOT NULL,
    "activityId" text NOT NULL,
    "creatorId" text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    "mediaIds" text[] DEFAULT ARRAY[]::text[] NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "featuredAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ActivityShare_check" CHECK (((char_length(title) <= 100) AND (char_length(body) <= 2000))),
    CONSTRAINT "ActivityShare_check1" CHECK ((("featuredAt" IS NULL) OR ((char_length(btrim(title)) > 0) AND (char_length(btrim(body)) > 0)))),
    CONSTRAINT "ActivityShare_revision_check" CHECK ((revision >= 0))
);

CREATE TABLE public."ActivityShareAudit" (
    id text NOT NULL,
    "shareId" text NOT NULL,
    "actorId" text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    before jsonb NOT NULL,
    after jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."ActivityShareCommand" (
    id text NOT NULL,
    "shareId" text NOT NULL,
    "actorId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    action text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."ActivityShareMedia" (
    id text NOT NULL,
    "shareId" text NOT NULL,
    "ownerId" text NOT NULL,
    "batchId" text NOT NULL,
    "batchIndex" integer NOT NULL,
    fingerprint text NOT NULL,
    mime text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    frames integer NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ActivityShareMedia_batchIndex_check" CHECK ((("batchIndex" >= 0) AND ("batchIndex" < 10))),
    CONSTRAINT "ActivityShareMedia_frames_check" CHECK ((frames > 0)),
    CONSTRAINT "ActivityShareMedia_height_check" CHECK ((height > 0)),
    CONSTRAINT "ActivityShareMedia_width_check" CHECK ((width > 0))
);

CREATE TABLE public."AdminManagementAudit" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "targetAccountId" text,
    kind text NOT NULL,
    reason text NOT NULL,
    "beforeRole" public."AdminRole",
    "afterRole" public."AdminRole",
    "beforeQq" text,
    "afterQq" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "AdminManagementAudit_kind_check" CHECK ((((kind = 'ADMIN_ROLE_CHANGED'::text) AND ("targetAccountId" IS NOT NULL) AND ("beforeRole" IS NOT NULL) AND ("afterRole" IS NOT NULL) AND ("beforeQq" IS NULL) AND ("afterQq" IS NULL) AND ("beforeRole" <> "afterRole") AND ("beforeRole" = ANY (ARRAY['NONE'::public."AdminRole", 'ADMIN'::public."AdminRole"])) AND ("afterRole" = ANY (ARRAY['NONE'::public."AdminRole", 'ADMIN'::public."AdminRole"]))) OR ((kind = 'PUBLIC_ADMIN_QQ_CHANGED'::text) AND ("targetAccountId" IS NULL) AND ("beforeRole" IS NULL) AND ("afterRole" IS NULL)))),
    CONSTRAINT "AdminManagementAudit_reason_check" CHECK (((length(TRIM(BOTH FROM reason)) >= 1) AND (length(TRIM(BOTH FROM reason)) <= 1000)))
);

CREATE TABLE public."AdminManagementCommand" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    kind text NOT NULL,
    "targetAccountId" text,
    result jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "AdminManagementCommand_kind_check" CHECK ((kind = ANY (ARRAY['ADMIN_ROLE_CHANGED'::text, 'PUBLIC_ADMIN_QQ_CHANGED'::text])))
);

CREATE TABLE public."Album" (
    id text NOT NULL,
    "creatorId" text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "primary" public."AlbumPrimaryCategory" NOT NULL,
    "categoryId" text,
    "uploadMode" public."AlbumUploadMode" NOT NULL,
    "activityId" text,
    "seriesId" text,
    "uploadsClosed" boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "removedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "coverPhotoId" text,
    publicity public."AlbumPublicity" DEFAULT 'INTERNAL'::public."AlbumPublicity" NOT NULL,
    CONSTRAINT "Album_upload_scope_check" CHECK (((("uploadMode" = 'ACTIVITY'::public."AlbumUploadMode") = ("activityId" IS NOT NULL)) AND (("seriesId" IS NULL) OR ("activityId" IS NOT NULL))))
);

CREATE TABLE public."AlbumAudit" (
    id text NOT NULL,
    "albumId" text NOT NULL,
    "photoId" text,
    "actorId" text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."AlbumCategory" (
    id text NOT NULL,
    "primary" public."AlbumPrimaryCategory" NOT NULL,
    label text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL
);

CREATE TABLE public."AlbumCommand" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "submissionKey" text NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."AlbumComment" (
    id text NOT NULL,
    "albumId" text NOT NULL,
    "photoId" text,
    "authorId" text NOT NULL,
    "parentId" text,
    body text NOT NULL,
    mentions text[] DEFAULT ARRAY[]::text[],
    "submissionKey" text NOT NULL,
    "removedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revision integer DEFAULT 0 NOT NULL
);

CREATE TABLE public."AlbumCommentMedia" (
    id text NOT NULL,
    "ownerId" text NOT NULL,
    "albumId" text NOT NULL,
    "commentId" text,
    "batchId" text NOT NULL,
    "batchIndex" integer NOT NULL,
    fingerprint text NOT NULL,
    mime text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    frames integer DEFAULT 1 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "removedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "orphanMountedAt" timestamp(3) with time zone,
    CONSTRAINT "AlbumCommentMedia_batchIndex_check" CHECK ((("batchIndex" >= 0) AND ("batchIndex" <= 9))),
    CONSTRAINT "AlbumCommentMedia_frames_check" CHECK (((frames >= 1) AND (frames <= 300))),
    CONSTRAINT "AlbumCommentMedia_height_check" CHECK ((height > 0)),
    CONSTRAINT "AlbumCommentMedia_width_check" CHECK ((width > 0))
);

CREATE TABLE public."AlbumLike" (
    "photoId" text NOT NULL,
    "accountId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."AlbumNotification" (
    id text NOT NULL,
    "recipientId" text NOT NULL,
    "commentId" text NOT NULL,
    "albumId" text NOT NULL,
    "photoId" text,
    kind text NOT NULL,
    "readAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "messageDeletedAt" timestamp(3) with time zone
);

CREATE TABLE public."AlbumPhoto" (
    id text NOT NULL,
    "albumId" text NOT NULL,
    "uploaderId" text NOT NULL,
    "batchId" text NOT NULL,
    "batchIndex" integer NOT NULL,
    digest text NOT NULL,
    "originalName" text NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    frames integer DEFAULT 1 NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "periodActivityId" text,
    revision integer DEFAULT 0 NOT NULL,
    "featuredAt" timestamp(3) with time zone,
    "removedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    rotation integer DEFAULT 0 NOT NULL,
    "uploadAlbumId" text,
    "featuredPool" public."FeaturedPhotoPool",
    "featuredSelectedAt" timestamp(3) with time zone,
    CONSTRAINT "AlbumPhoto_batch_index_check" CHECK ((("batchIndex" >= 0) AND ("batchIndex" <= 9))),
    CONSTRAINT "AlbumPhoto_feature_pool_shape_check" CHECK (((("featuredAt" IS NULL) AND ("featuredPool" IS NULL) AND ("featuredSelectedAt" IS NULL)) OR (("featuredAt" IS NOT NULL) AND ((("featuredPool" IS NULL) AND ("featuredSelectedAt" IS NULL)) OR (("featuredPool" = 'CANDIDATE'::public."FeaturedPhotoPool") AND ("featuredSelectedAt" IS NULL)) OR (("featuredPool" = 'SELECTED'::public."FeaturedPhotoPool") AND ("featuredSelectedAt" IS NOT NULL)))))),
    CONSTRAINT "AlbumPhoto_media_bounds_check" CHECK ((((bytes >= 1) AND (bytes <= 31457280)) AND (width > 0) AND (height > 0) AND ((frames >= 1) AND (frames <= 300)))),
    CONSTRAINT "AlbumPhoto_rotation_check" CHECK ((rotation = ANY (ARRAY[0, 90, 180, 270])))
);

CREATE TABLE public."AvatarAsset" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    bytes integer NOT NULL,
    "smallBytes" integer NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "AvatarAsset_bytes_check" CHECK (((bytes > 0) AND ("smallBytes" > 0))),
    CONSTRAINT "AvatarAsset_dimensions_check" CHECK (((width > 0) AND (width <= 512) AND (height = width)))
);

CREATE TABLE public."BotGroup" (
    id text NOT NULL,
    "appId" text NOT NULL,
    "botId" text NOT NULL,
    "groupOpenId" text NOT NULL,
    label text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    "enabledAt" timestamp(3) with time zone,
    generation integer DEFAULT 1 NOT NULL,
    "boundAt" timestamp(3) with time zone NOT NULL,
    legacy boolean DEFAULT false NOT NULL,
    "createdById" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."BotGroupCandidate" (
    id text NOT NULL,
    "challengeId" text NOT NULL,
    "appId" text NOT NULL,
    "botId" text NOT NULL,
    "groupOpenId" text NOT NULL,
    "memberOpenId" text NOT NULL,
    "receiptCodeHash" text NOT NULL,
    "finalProofHash" text,
    "provenAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."BotGroupChallenge" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "sessionId" text NOT NULL,
    label text NOT NULL,
    "publicCodeHash" text NOT NULL,
    "browserProofHash" text NOT NULL,
    "selectedCandidateId" text,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "invalidatedAt" timestamp(3) with time zone,
    "consumedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."BotGroupState" (
    id text NOT NULL,
    revision integer DEFAULT 0 NOT NULL
);

CREATE TABLE public."BotManagementAudit" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    fingerprint text NOT NULL,
    action text NOT NULL,
    before jsonb NOT NULL,
    after jsonb NOT NULL,
    result jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."BotManagementObservation" (
    id text NOT NULL,
    "reportedVersion" integer NOT NULL,
    "reportedDigest" text,
    "applyError" text,
    telemetry jsonb NOT NULL,
    "observedAt" timestamp(3) with time zone NOT NULL,
    "groupRevision" integer,
    "groupDigest" text
);

CREATE TABLE public."BotManagementPublication" (
    version integer NOT NULL,
    digest text NOT NULL,
    scope jsonb NOT NULL,
    config jsonb NOT NULL,
    "actorId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "notificationEpoch" integer DEFAULT 0 NOT NULL
);

CREATE TABLE public."BotManagementSendRecord" (
    id text NOT NULL,
    direction text NOT NULL,
    outcome text NOT NULL,
    "eventAt" timestamp(3) with time zone NOT NULL,
    "observedAt" timestamp(3) with time zone NOT NULL
);

CREATE TABLE public."BotManagementState" (
    id text NOT NULL,
    scope jsonb NOT NULL,
    draft jsonb NOT NULL,
    "draftRevision" integer DEFAULT 0 NOT NULL,
    "publishedVersion" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."BotManagementTest" (
    id text NOT NULL,
    version integer NOT NULL,
    scope jsonb NOT NULL,
    content text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    "leaseOwner" text,
    "leaseUntil" timestamp(3) with time zone,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "resultCode" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "actorId" text,
    "providerMessageId" text,
    "refIdx" text,
    "receiptDigest" text,
    "sentAt" timestamp(3) with time zone,
    CONSTRAINT "BotManagementTest_status_check" CHECK ((status = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text, 'DISPATCHING'::text, 'SENT'::text, 'SIMULATED'::text, 'UNKNOWN'::text, 'DENIED'::text, 'CANCELLED'::text, 'EXPIRED'::text])))
);

CREATE TABLE public."DailyAudit" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "postId" text NOT NULL,
    "commentId" text,
    action text NOT NULL,
    reason text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."DailyCheckin" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    day character varying(10) NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "DailyCheckin_day_check" CHECK ((((day)::text ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'::text) AND (to_char((to_date((day)::text, 'YYYY-MM-DD'::text))::timestamp with time zone, 'YYYY-MM-DD'::text) = (day)::text)))
);

CREATE TABLE public."DailyCommand" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "submissionKey" text NOT NULL,
    fingerprint text NOT NULL,
    "resultId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."DailyComment" (
    id text NOT NULL,
    "postId" text NOT NULL,
    "authorId" text NOT NULL,
    "parentId" text,
    body text NOT NULL,
    mentions text[],
    revision integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "removedAt" timestamp(3) with time zone
);

CREATE TABLE public."DailyLike" (
    "postId" text NOT NULL,
    "accountId" text NOT NULL
);

CREATE TABLE public."DailyMedia" (
    id text NOT NULL,
    "ownerId" text NOT NULL,
    "postId" text,
    "batchId" text NOT NULL,
    "batchIndex" integer NOT NULL,
    fingerprint text NOT NULL,
    mime text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    frames integer NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "removedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "commentId" text,
    CONSTRAINT "DailyMedia_comment_post_check" CHECK ((("commentId" IS NULL) OR ("postId" IS NOT NULL)))
);

CREATE TABLE public."DailyNotification" (
    id text NOT NULL,
    "eventKey" text NOT NULL,
    "postId" text NOT NULL,
    "commentId" text,
    "recipientId" text NOT NULL,
    kind text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "readAt" timestamp(3) with time zone,
    "deletedAt" timestamp(3) with time zone
);

CREATE TABLE public."DailyPost" (
    id text NOT NULL,
    "authorId" text NOT NULL,
    body text NOT NULL,
    mentions text[],
    revision integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "editedAt" timestamp(3) with time zone,
    "removedAt" timestamp(3) with time zone
);

CREATE TABLE public."EnvironmentProbe" (
    id integer NOT NULL
);

CREATE TABLE public."FixedTeam" (
    id text NOT NULL,
    "creatorId" text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    "commonTimes" text DEFAULT ''::text NOT NULL,
    "qqGroupId" text,
    state text DEFAULT 'ACTIVE'::text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "dissolvedAt" timestamp(3) with time zone,
    "dutyName" text DEFAULT ''::text NOT NULL,
    progress text DEFAULT ''::text NOT NULL,
    strategy text DEFAULT ''::text NOT NULL,
    "recruitmentCompletedAt" timestamp(3) with time zone,
    CONSTRAINT "FixedTeam_state_check" CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'DISSOLVED'::text])))
);

CREATE TABLE public."GuestContactMessage" (
    id text NOT NULL,
    "submissionKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    qq text NOT NULL,
    message text NOT NULL,
    status public."GuestContactStatus" DEFAULT 'PENDING'::public."GuestContactStatus" NOT NULL,
    "processedById" text,
    "processedAt" timestamp(3) with time zone,
    revision integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "GuestContactMessage_fingerprint_check" CHECK (("requestFingerprint" ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT "GuestContactMessage_key_check" CHECK (("submissionKey" ~ '^[A-Za-z0-9_-]{16,128}$'::text)),
    CONSTRAINT "GuestContactMessage_processing_check" CHECK ((((status = 'PENDING'::public."GuestContactStatus") AND ("processedById" IS NULL) AND ("processedAt" IS NULL)) OR ((status = 'PROCESSED'::public."GuestContactStatus") AND ("processedById" IS NOT NULL) AND ("processedAt" IS NOT NULL)))),
    CONSTRAINT "GuestContactMessage_qq_check" CHECK ((qq ~ '^[1-9][0-9]{4,11}$'::text)),
    CONSTRAINT "GuestContactMessage_revision_check" CHECK ((revision >= 0)),
    CONSTRAINT "GuestContactMessage_text_check" CHECK (((length(btrim(message)) >= 1) AND (length(btrim(message)) <= 500)))
);

CREATE TABLE public."Invitation" (
    id text NOT NULL,
    "tokenHash" text NOT NULL,
    membership public."Membership" NOT NULL,
    "createdById" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "usedAt" timestamp(3) with time zone,
    "usedById" text,
    "revokedAt" timestamp(3) with time zone,
    "removedAt" timestamp(3) with time zone,
    "tokenCiphertext" text,
    "usageMode" public."InvitationUsageMode" DEFAULT 'SINGLE'::public."InvitationUsageMode" NOT NULL
);

CREATE TABLE public."KnowledgeArticle" (
    id text NOT NULL,
    "authorId" text NOT NULL,
    "submissionKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    "categoryId" text NOT NULL,
    jobs text[] DEFAULT ARRAY[]::text[],
    playstyles text[] DEFAULT ARRAY[]::text[],
    "gameVersions" text[] DEFAULT ARRAY[]::text[],
    "editMode" text DEFAULT 'AUTHOR'::text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "removedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "bodyFormat" text DEFAULT 'PLAIN'::text NOT NULL,
    CONSTRAINT "KnowledgeArticle_bodyFormat_check" CHECK (("bodyFormat" = ANY (ARRAY['PLAIN'::text, 'RICH_V1'::text]))),
    CONSTRAINT "KnowledgeArticle_editMode_check" CHECK (("editMode" = ANY (ARRAY['AUTHOR'::text, 'COMMUNITY'::text]))),
    CONSTRAINT "KnowledgeArticle_revision_check" CHECK ((revision >= 0))
);

CREATE TABLE public."KnowledgeArticleInteraction" (
    id text NOT NULL,
    "articleId" text NOT NULL,
    "accountId" text NOT NULL,
    "likedAt" timestamp(3) with time zone,
    "collectedAt" timestamp(3) with time zone,
    "likeNotifiedAt" timestamp(3) with time zone,
    "collectionNotifiedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."KnowledgeArticleRead" (
    id text NOT NULL,
    "articleId" text NOT NULL,
    "sessionKey" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."KnowledgeAudit" (
    id text NOT NULL,
    "articleId" text,
    "actorId" text NOT NULL,
    action text NOT NULL,
    "targetId" text NOT NULL,
    reason text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."KnowledgeCategory" (
    id text NOT NULL,
    label text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    revision integer DEFAULT 0 NOT NULL
);

CREATE TABLE public."KnowledgeComment" (
    id text NOT NULL,
    "articleId" text NOT NULL,
    "authorId" text NOT NULL,
    body text NOT NULL,
    "parentId" text,
    mentions text[] DEFAULT ARRAY[]::text[],
    "submissionKey" text NOT NULL,
    "removedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revision integer DEFAULT 0 NOT NULL
);

CREATE TABLE public."KnowledgeContribution" (
    "articleId" text NOT NULL,
    "accountId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."KnowledgeImage" (
    id text NOT NULL,
    "uploaderId" text NOT NULL,
    "articleId" text,
    "batchId" text NOT NULL,
    "batchIndex" integer NOT NULL,
    digest text NOT NULL,
    "originalName" text NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    frames integer NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "commentId" text,
    "commentPosition" integer,
    "orphanMountedAt" timestamp(3) with time zone,
    CONSTRAINT "KnowledgeImage_batchIndex_check" CHECK ((("batchIndex" >= 0) AND ("batchIndex" <= 9))),
    CONSTRAINT "KnowledgeImage_dimensions_check" CHECK (((width > 0) AND (height > 0) AND (frames > 0) AND (bytes > 0) AND (bytes <= 31457280)))
);

CREATE TABLE public."KnowledgeNotification" (
    id text NOT NULL,
    "recipientId" text NOT NULL,
    "commentId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "messageReadAt" timestamp(3) with time zone,
    "messageDeletedAt" timestamp(3) with time zone
);

CREATE TABLE public."KnowledgeVersion" (
    id text NOT NULL,
    "articleId" text NOT NULL,
    "editorId" text NOT NULL,
    body text NOT NULL,
    number integer NOT NULL,
    "restoredFromId" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "bodyFormat" text DEFAULT 'PLAIN'::text NOT NULL,
    CONSTRAINT "KnowledgeVersion_bodyFormat_check" CHECK (("bodyFormat" = ANY (ARRAY['PLAIN'::text, 'RICH_V1'::text]))),
    CONSTRAINT "KnowledgeVersion_number_check" CHECK ((number > 0))
);

CREATE TABLE public."LocalQcRecord" (
    namespace text NOT NULL,
    slot text NOT NULL,
    kind text NOT NULL,
    "entityId" text NOT NULL,
    digest text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "LocalQcRecord_digest_check" CHECK ((digest ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE public."LocalQcRun" (
    namespace text NOT NULL,
    anchor timestamp(3) with time zone NOT NULL,
    "manifestHash" text NOT NULL,
    bindings jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "LocalQcRun_manifestHash_check" CHECK (("manifestHash" ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE public."Lottery" (
    id text NOT NULL,
    "creatorId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    fingerprint text NOT NULL,
    title character varying(80) NOT NULL,
    kind text NOT NULL,
    mode text NOT NULL,
    audience text NOT NULL,
    month character varying(7),
    "minDays" integer,
    prizes jsonb NOT NULL,
    "drawAt" timestamp(3) with time zone NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    state text DEFAULT 'OPEN'::text NOT NULL,
    result jsonb,
    "closedAt" timestamp(3) with time zone,
    "moderatedAt" timestamp(3) with time zone,
    revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT "Lottery_audience_check" CHECK ((audience = ANY (ARRAY['MEMBER'::text, 'MEMBER_FRIEND'::text]))),
    CONSTRAINT "Lottery_check" CHECK ((((kind = 'ORDINARY'::text) AND (month IS NULL) AND ("minDays" IS NULL)) OR ((kind = 'MONTHLY'::text) AND (month IS NOT NULL) AND (("minDays" >= 1) AND ("minDays" <= 31))))),
    CONSTRAINT "Lottery_check1" CHECK (((state = 'DRAWN'::text) = (result IS NOT NULL))),
    CONSTRAINT "Lottery_kind_check" CHECK ((kind = ANY (ARRAY['ORDINARY'::text, 'MONTHLY'::text]))),
    CONSTRAINT "Lottery_mode_check" CHECK ((mode = ANY (ARRAY['MANUAL'::text, 'AUTO'::text]))),
    CONSTRAINT "Lottery_revision_nonnegative" CHECK ((revision >= 0)),
    CONSTRAINT "Lottery_state_check" CHECK ((state = ANY (ARRAY['OPEN'::text, 'DRAWN'::text, 'CANCELLED'::text])))
);

CREATE TABLE public."LotteryAccountFact" (
    sequence bigint NOT NULL,
    "accountId" text NOT NULL,
    "effectiveAt" timestamp(6) with time zone NOT NULL,
    "registeredAt" timestamp(6) with time zone NOT NULL,
    membership public."Membership" NOT NULL,
    active boolean NOT NULL,
    "displayName" text,
    kind text NOT NULL,
    reason text,
    "changedById" text,
    CONSTRAINT "LotteryAccountFact_kind_check" CHECK ((kind = ANY (ARRAY['BASELINE'::text, 'REGISTER'::text, 'IDENTITY'::text, 'ACTIVE'::text])))
);

ALTER TABLE public."LotteryAccountFact" ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public."LotteryAccountFact_sequence_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public."LotteryAccountStatus" (
    "accountId" text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    reason text DEFAULT 'Feature activation baseline'::text NOT NULL,
    "changedById" text
);

CREATE TABLE public."LotteryCommand" (
    "lotteryId" text NOT NULL,
    "actorId" text NOT NULL,
    key text NOT NULL,
    action text NOT NULL,
    "createdAt" timestamp(3) with time zone NOT NULL,
    "requestFingerprint" text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT "LotteryCommand_moderation_evidence" CHECK (((action <> 'moderate'::text) OR COALESCE((("requestFingerprint" IS NOT NULL) AND (length("requestFingerprint") = 64) AND (jsonb_typeof((payload -> 'reason'::text)) = 'string'::text) AND ((length(btrim((payload ->> 'reason'::text))) >= 1) AND (length(btrim((payload ->> 'reason'::text))) <= 1000)) AND (jsonb_typeof((payload -> 'expectedRevision'::text)) = 'number'::text)), false)))
);

CREATE TABLE public."LotteryEligibilityControl" (
    id integer NOT NULL,
    "enabledAt" timestamp(6) with time zone NOT NULL,
    CONSTRAINT "LotteryEligibilityControl_id_check" CHECK ((id = 1))
);

CREATE TABLE public."LotteryEntry" (
    "lotteryId" text NOT NULL,
    "accountId" text NOT NULL,
    state text NOT NULL,
    source text NOT NULL,
    "joinedAt" timestamp(3) with time zone NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    CONSTRAINT "LotteryEntry_source_check" CHECK ((source = ANY (ARRAY['MANUAL'::text, 'AUTO'::text]))),
    CONSTRAINT "LotteryEntry_state_check" CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'WITHDRAWN'::text])))
);

CREATE TABLE public."LotteryNotification" (
    "eventKey" text NOT NULL,
    "lotteryId" text NOT NULL,
    "recipientId" text,
    channel text NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone NOT NULL,
    "simulatedAt" timestamp(3) with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    "messageId" text DEFAULT (gen_random_uuid())::text,
    "readAt" timestamp(3) with time zone,
    "deletedAt" timestamp(3) with time zone,
    CONSTRAINT "LotteryNotification_channel_check" CHECK ((channel = ANY (ARRAY['IN_APP'::text, 'QQ'::text])))
);

CREATE TABLE public."MediaBudgetState" (
    id text DEFAULT 'global'::text NOT NULL,
    "baselineBytes" bigint DEFAULT 0 NOT NULL,
    "committedBytes" bigint DEFAULT 0 NOT NULL,
    "reservedBytes" bigint DEFAULT 0 NOT NULL,
    "baselineFingerprint" character varying(64),
    "baselineInitializedAt" timestamp(3) with time zone,
    "creditedBytes" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "MediaBudgetState_baseline_hash" CHECK ((("baselineFingerprint" IS NULL) OR (("baselineFingerprint")::text ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT "MediaBudgetState_baseline_pair" CHECK ((("baselineFingerprint" IS NULL) = ("baselineInitializedAt" IS NULL))),
    CONSTRAINT "MediaBudgetState_credit_bound" CHECK ((("creditedBytes" >= 0) AND (("creditedBytes")::numeric <= (("baselineBytes")::numeric + ("committedBytes")::numeric)))),
    CONSTRAINT "MediaBudgetState_nonnegative" CHECK ((("baselineBytes" >= 0) AND ("committedBytes" >= 0) AND ("reservedBytes" >= 0))),
    CONSTRAINT "MediaBudgetState_singleton" CHECK ((id = 'global'::text))
);

CREATE TABLE public."MediaCosObject" (
    id character varying(36) NOT NULL,
    scope character varying(32) NOT NULL,
    "objectId" character varying(36) NOT NULL,
    part character varying(16) NOT NULL,
    "accountId" character varying(36),
    bucket character varying(71) NOT NULL,
    region character varying(32) NOT NULL,
    prefix character varying(163) NOT NULL,
    "objectKey" character varying(512) NOT NULL,
    bytes bigint NOT NULL,
    sha256 character varying(64) NOT NULL,
    etag character varying(256),
    "identityFingerprint" character varying(64),
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "MediaCosObject_address_check" CHECK ((((region)::text = 'ap-hongkong'::text) AND ((bucket)::text ~ '^[a-z0-9][a-z0-9-]{0,49}-[0-9]{5,20}$'::text) AND ((prefix)::text ~ '^[a-z0-9][a-z0-9-]{0,39}(/[a-z0-9][a-z0-9-]{0,39}){0,3}$'::text) AND (("objectKey")::text = ((((((((prefix)::text || '/'::text) || (scope)::text) || '/'::text) ||
CASE
    WHEN ((scope)::text = 'lottery'::text) THEN (("accountId")::text || '/'::text)
    ELSE ''::text
END) || ("objectId")::text) || '.'::text) || (part)::text)))),
    CONSTRAINT "MediaCosObject_content_check" CHECK (((bytes > 0) AND (bytes <= '9007199254740991'::bigint) AND ((sha256)::text ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT "MediaCosObject_created_at_check" CHECK (isfinite("createdAt")),
    CONSTRAINT "MediaCosObject_observation_check" CHECK ((((etag IS NULL) AND ("identityFingerprint" IS NULL)) OR ((etag IS NOT NULL) AND ("identityFingerprint" IS NOT NULL) AND (((etag)::text COLLATE "C") ~ '^[!-~]+$'::text) AND (("identityFingerprint")::text ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT "MediaCosObject_owner_check" CHECK (((((scope)::text = 'lottery'::text) AND ("accountId" IS NOT NULL) AND (("accountId")::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)) OR (((scope)::text <> 'lottery'::text) AND ("accountId" IS NULL)))),
    CONSTRAINT "MediaCosObject_scope_part_check" CHECK (((((scope)::text = 'avatars'::text) AND (part IN ('full', 'small'))) OR (((scope)::text = 'quick-icons'::text) AND ((part)::text = 'icon'::text)) OR ((scope IN ('albums', 'album-comments', 'daily', 'wishes', 'lottery', 'knowledge', 'activity-shares', 'official')) AND (part IN ('original', 'preview', 'thumbnail'))))),
    CONSTRAINT "MediaCosObject_uuid_check" CHECK ((((id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND (("objectId")::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)))
);

CREATE TABLE public."MediaDailyBudget" (
    "accountId" text NOT NULL,
    day character varying(10) NOT NULL,
    "committedBytes" bigint DEFAULT 0 NOT NULL,
    "reservedBytes" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "MediaDailyBudget_day" CHECK (((day)::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text)),
    CONSTRAINT "MediaDailyBudget_nonnegative" CHECK ((("committedBytes" >= 0) AND ("reservedBytes" >= 0)))
);

CREATE TABLE public."MediaRetirementIntent" (
    id character varying(64) NOT NULL,
    "componentId" character varying(64) NOT NULL,
    "identityFingerprint" character varying(64) NOT NULL,
    "authorityFingerprint" character varying(64) NOT NULL,
    state character varying(16) NOT NULL,
    "createdAt" timestamp(3) with time zone NOT NULL,
    "acknowledgedAt" timestamp(3) with time zone,
    CONSTRAINT "MediaRetirementIntent_shape" CHECK ((((id)::text ~ '^[a-f0-9]{64}$'::text) AND (("identityFingerprint")::text ~ '^[a-f0-9]{64}$'::text) AND (("authorityFingerprint")::text ~ '^[a-f0-9]{64}$'::text) AND (state IN ('PREPARED', 'ACKNOWLEDGED')) AND (((state)::text = 'ACKNOWLEDGED'::text) = ("acknowledgedAt" IS NOT NULL)) AND (("acknowledgedAt" IS NULL) OR ("acknowledgedAt" >= "createdAt"))))
);

CREATE TABLE public."MediaStorageCredit" (
    "componentId" character varying(64) NOT NULL,
    "intentId" character varying(64) NOT NULL,
    bytes bigint NOT NULL,
    "evidenceFingerprint" character varying(64) NOT NULL,
    "createdAt" timestamp(3) with time zone NOT NULL,
    CONSTRAINT "MediaStorageCredit_shape" CHECK (((bytes > 0) AND (("evidenceFingerprint")::text ~ '^[a-f0-9]{64}$'::text)))
);

CREATE TABLE public."MediaStoredComponent" (
    id character varying(64) NOT NULL,
    "sourceKind" character varying(16) NOT NULL,
    "receiptScope" character varying(64),
    "receiptOperationKey" character varying(256),
    "baselineStateId" text,
    "baselineFingerprint" character varying(64),
    namespace character varying(64) NOT NULL,
    "objectKey" character varying(256) NOT NULL,
    generation character varying(64) NOT NULL,
    part character varying(32) NOT NULL,
    policy character varying(32) NOT NULL,
    "chargedBytes" bigint NOT NULL,
    "createdAt" timestamp(3) with time zone NOT NULL,
    "contentBindingSha256" character varying(64),
    "storageIdentityFingerprint" character varying(64),
    CONSTRAINT "MediaStoredComponent_binding_shape" CHECK (((("contentBindingSha256" IS NULL) OR (("contentBindingSha256")::text ~ '^[a-f0-9]{64}$'::text)) AND (("storageIdentityFingerprint" IS NULL) OR (("contentBindingSha256" IS NOT NULL) AND (("storageIdentityFingerprint")::text ~ '^[a-f0-9]{64}$'::text))))),
    CONSTRAINT "MediaStoredComponent_shape" CHECK (((((id)::text ~ '^[a-f0-9]{64}$'::text) AND ("chargedBytes" > 0) AND (length(("objectKey")::text) > 0) AND (length((generation)::text) > 0) AND (("baselineFingerprint" IS NULL) OR (("baselineFingerprint")::text ~ '^[a-f0-9]{64}$'::text)) AND ((((policy)::text = 'AGGREGATE_NEVER'::text) AND (part IN ('aggregate', 'knowledge-media'))) OR (((policy)::text = 'AVATAR_VARIANT'::text) AND (part IN ('avatar-full', 'avatar-small')) AND ((namespace)::text = 'avatar'::text)) OR (((policy)::text = 'KNOWLEDGE_JOURNAL'::text) AND ((part)::text = 'knowledge-journal'::text) AND ((namespace)::text = 'knowledge'::text)) OR (((policy)::text = 'QUICK_LINK_BYTEA'::text) AND ((part)::text = 'quick-icon-bytea'::text) AND (namespace IN ('quick-icon-manual', 'quick-icon-auto')) AND ("contentBindingSha256" IS NOT NULL) AND (("contentBindingSha256")::text ~ '^[a-f0-9]{64}$'::text)) OR (((policy)::text = 'OFFICIAL_VARIANT'::text) AND (part IN ('official-original', 'official-preview', 'official-thumbnail')) AND ((namespace)::text = 'official-image'::text) AND ("contentBindingSha256" IS NOT NULL) AND (("contentBindingSha256")::text ~ '^[a-f0-9]{64}$'::text)) OR (((policy)::text = 'PHOTO_VARIANT'::text) AND (part IN ('photo-original', 'photo-preview', 'photo-thumbnail')) AND (namespace IN ('daily', 'wish', 'lottery-image', 'knowledge', 'album-comment')) AND ("contentBindingSha256" IS NOT NULL) AND (("contentBindingSha256")::text ~ '^[a-f0-9]{64}$'::text)))) OR (((id)::text ~ '^[a-f0-9]{64}$'::text) AND ("chargedBytes" > 0) AND (("sourceKind")::text = 'RECEIPT'::text) AND (("receiptScope")::text = 'album-photo'::text) AND ((namespace)::text = 'album-photo'::text) AND ("receiptOperationKey" IS NOT NULL) AND (length(("receiptOperationKey")::text) > 0) AND ((policy)::text = 'PHOTO_VARIANT'::text) AND (part IN ('photo-original', 'photo-preview', 'photo-thumbnail')) AND (("objectKey")::text ~ '^album-photo:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((generation)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ("contentBindingSha256" IS NOT NULL) AND (("contentBindingSha256")::text ~ '^[a-f0-9]{64}$'::text)))),
    CONSTRAINT "MediaStoredComponent_source" CHECK ((((("sourceKind")::text = 'RECEIPT'::text) AND ("receiptScope" IS NOT NULL) AND ("receiptOperationKey" IS NOT NULL) AND ("baselineStateId" IS NULL) AND ("baselineFingerprint" IS NULL)) OR ((("sourceKind")::text = 'BASELINE'::text) AND ("receiptScope" IS NULL) AND ("receiptOperationKey" IS NULL) AND ("baselineStateId" IS NOT NULL) AND ("baselineStateId" = 'global'::text) AND ("baselineFingerprint" IS NOT NULL))))
);

CREATE TABLE public."MediaUploadReceipt" (
    scope character varying(64) NOT NULL,
    "operationKey" character varying(256) NOT NULL,
    fingerprint character varying(64) NOT NULL,
    "accountId" text,
    day character varying(10),
    "rawBytes" bigint NOT NULL,
    "storedBytes" bigint NOT NULL,
    state character varying(16) NOT NULL,
    "persistenceStartedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "settledAt" timestamp(3) with time zone,
    "attemptId" character varying(36),
    "objectIdentity" character varying(256),
    "storageReservedAt" timestamp(3) with time zone,
    "metadataReservedBytes" bigint DEFAULT 0 NOT NULL,
    "retryHeadKey" character varying(256),
    "retryRootKey" character varying(256),
    "reservationProtocol" character varying(32),
    "lotteryMountedAt" timestamp(3) with time zone,
    CONSTRAINT "MediaUploadReceipt_actor_day_pair" CHECK ((("accountId" IS NULL) = (day IS NULL))),
    CONSTRAINT "MediaUploadReceipt_byte_bounds" CHECK ((("rawBytes" > 0) AND ("storedBytes" >= 0) AND ("metadataReservedBytes" >= 0) AND ("metadataReservedBytes" <= "storedBytes"))),
    CONSTRAINT "MediaUploadReceipt_commit_started" CHECK ((((state)::text <> 'COMMITTED'::text) OR ("persistenceStartedAt" IS NOT NULL))),
    CONSTRAINT "MediaUploadReceipt_day" CHECK (((day IS NULL) OR ((day)::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text))),
    CONSTRAINT "MediaUploadReceipt_failed_prewrite" CHECK ((((state)::text <> 'FAILED'::text) OR ("persistenceStartedAt" IS NULL))),
    CONSTRAINT "MediaUploadReceipt_fingerprint" CHECK (((fingerprint)::text ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT "MediaUploadReceipt_lottery_mount_shape" CHECK ((("lotteryMountedAt" IS NULL) OR (((scope)::text = 'lottery-image'::text) AND ("accountId" IS NOT NULL) AND ("attemptId" IS NOT NULL) AND ("objectIdentity" IS NOT NULL) AND ("persistenceStartedAt" IS NOT NULL) AND (state IN ('RESERVED', 'UNKNOWN', 'COMMITTED')) AND isfinite("lotteryMountedAt")))),
    CONSTRAINT "MediaUploadReceipt_raw_stage" CHECK ((("storedBytes" <> 0) OR (("storageReservedAt" IS NULL) AND ("persistenceStartedAt" IS NULL) AND ((state)::text <> 'COMMITTED'::text)))),
    CONSTRAINT "MediaUploadReceipt_reservation_protocol_shape" CHECK ((("reservationProtocol" IS NULL) OR ((("reservationProtocol")::text = 'prewrite-expiry-v1'::text) AND (scope IN ('avatar', 'album-photo', 'album-comment', 'knowledge', 'daily', 'wish', 'activity-share', 'lottery-image', 'official-image')) AND ("attemptId" IS NOT NULL) AND ("objectIdentity" IS NOT NULL)))),
    CONSTRAINT "MediaUploadReceipt_retry_shape" CHECK (((("retryHeadKey" IS NULL) OR (("retryRootKey" IS NULL) AND ((state)::text = 'FAILED'::text) AND ("persistenceStartedAt" IS NULL) AND (("retryHeadKey")::text <> ("operationKey")::text) AND (("retryHeadKey")::text ~ '^retry:[a-f0-9]{64}$'::text))) AND (("retryRootKey" IS NULL) OR (("retryHeadKey" IS NULL) AND (("retryRootKey")::text <> ("operationKey")::text) AND (("operationKey")::text ~ '^retry:[a-f0-9]{64}$'::text))))),
    CONSTRAINT "MediaUploadReceipt_settled" CHECK (((state IN ('COMMITTED', 'FAILED')) = ("settledAt" IS NOT NULL))),
    CONSTRAINT "MediaUploadReceipt_state" CHECK ((state IN ('RESERVED', 'COMMITTED', 'FAILED', 'UNKNOWN'))),
    CONSTRAINT "MediaUploadReceipt_times" CHECK ((("updatedAt" >= "createdAt") AND (("persistenceStartedAt" IS NULL) OR ("persistenceStartedAt" >= "createdAt")) AND (("settledAt" IS NULL) OR ("settledAt" >= "createdAt")))),
    CONSTRAINT "MediaUploadReceipt_writer_allocation" CHECK ((("attemptId" IS NULL) OR ("persistenceStartedAt" IS NULL) OR (("storedBytes" > 0) AND ("storageReservedAt" IS NOT NULL)))),
    CONSTRAINT "MediaUploadReceipt_writer_pair" CHECK ((("attemptId" IS NULL) = ("objectIdentity" IS NULL)))
);

CREATE TABLE public."MemberProfile" (
    "accountId" text NOT NULL,
    bio text DEFAULT ''::text NOT NULL,
    "commonJobs" text[] DEFAULT ARRAY[]::text[] NOT NULL,
    "preferredPlaystyles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "avatarId" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    CONSTRAINT "MemberProfile_revision_check" CHECK ((revision >= 0))
);

CREATE TABLE public."MessageNotification" (
    id text NOT NULL,
    "recipientId" text NOT NULL,
    "actorId" text,
    kind text NOT NULL,
    "sourceType" text NOT NULL,
    "sourceId" text NOT NULL,
    "commentId" text,
    "eventKey" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "readAt" timestamp(3) with time zone,
    "deletedAt" timestamp(3) with time zone
);

CREATE TABLE public."OfficialEvent" (
    id text NOT NULL,
    "sourceKey" text NOT NULL,
    "externalId" text NOT NULL,
    "sourceUrl" text NOT NULL,
    "sourceTitle" text NOT NULL,
    "sourceText" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    "startsAt" timestamp(3) with time zone,
    "endsAt" timestamp(3) with time zone,
    revision integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "manualFields" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "sourceSnapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "imageId" text,
    CONSTRAINT "OfficialEvent_manual_fields_check" CHECK (((jsonb_typeof("manualFields") = 'array'::text) AND ("manualFields" <@ '["title", "sourceUrl", "summary", "startsAt", "endsAt", "status", "image"]'::jsonb))),
    CONSTRAINT "OfficialEvent_published_check" CHECK (((status <> ALL (ARRAY['PUBLISHED'::text, 'WITHDRAWN'::text])) OR (("startsAt" IS NOT NULL) AND ("endsAt" IS NOT NULL)))),
    CONSTRAINT "OfficialEvent_revision_check" CHECK ((revision >= 0)),
    CONSTRAINT "OfficialEvent_source_snapshot_check" CHECK ((jsonb_typeof("sourceSnapshot") = 'object'::text)),
    CONSTRAINT "OfficialEvent_status_check" CHECK ((status = ANY (ARRAY['PENDING'::text, 'PUBLISHED'::text, 'REJECTED'::text, 'WITHDRAWN'::text]))),
    CONSTRAINT "OfficialEvent_time_check" CHECK ((("startsAt" IS NULL) OR ("endsAt" IS NULL) OR ("endsAt" > "startsAt")))
);

CREATE TABLE public."OfficialEventAudit" (
    id text NOT NULL,
    "eventId" text NOT NULL,
    "actorId" text,
    action text NOT NULL,
    reason text NOT NULL,
    before jsonb NOT NULL,
    after jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."OfficialEventCommand" (
    id text NOT NULL,
    "eventId" text NOT NULL,
    "actorId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    action text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."OfficialEventImage" (
    id text NOT NULL,
    "eventId" text NOT NULL,
    "sourceUrl" text NOT NULL,
    "sourcePageUrl" text NOT NULL,
    "sourceKind" text NOT NULL,
    fingerprint text NOT NULL,
    mime text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    frames integer NOT NULL,
    "originalBytes" integer NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "OfficialEventImage_fingerprint_check" CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT "OfficialEventImage_frames_check" CHECK (((frames >= 1) AND (frames <= 300))),
    CONSTRAINT "OfficialEventImage_height_check" CHECK ((height > 0)),
    CONSTRAINT "OfficialEventImage_mime_check" CHECK ((mime = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text, 'image/gif'::text]))),
    CONSTRAINT "OfficialEventImage_originalBytes_check" CHECK ((("originalBytes" >= 1) AND ("originalBytes" <= 5242880))),
    CONSTRAINT "OfficialEventImage_source_kind_check" CHECK (("sourceKind" = ANY (ARRAY['API'::text, 'NEWS'::text, 'TOPIC_METADATA'::text, 'TOPIC_SECTION'::text, 'MANUAL'::text]))),
    CONSTRAINT "OfficialEventImage_width_check" CHECK ((width > 0))
);

CREATE TABLE public."OfficialSyncRun" (
    id text NOT NULL,
    trigger text NOT NULL,
    "actorId" text,
    "idempotencyKey" text,
    status text DEFAULT 'RUNNING'::text NOT NULL,
    imported integer DEFAULT 0 NOT NULL,
    unchanged integer DEFAULT 0 NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "finishedAt" timestamp(3) with time zone,
    CONSTRAINT "OfficialSyncRun_status_check" CHECK ((status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text, 'PARTIAL'::text, 'FAILED'::text])))
);

CREATE TABLE public."PublicSiteSettings" (
    id text NOT NULL,
    "adminQq" text,
    revision integer NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    CONSTRAINT "PublicSiteSettings_adminQq_check" CHECK ((("adminQq" IS NULL) OR ("adminQq" ~ '^[1-9][0-9]{4,11}$'::text))),
    CONSTRAINT "PublicSiteSettings_id_check" CHECK ((id = 'public'::text)),
    CONSTRAINT "PublicSiteSettings_revision_check" CHECK ((revision >= 1))
);

CREATE TABLE public."QqOfficialBinding" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "appId" text NOT NULL,
    "botId" text NOT NULL,
    "groupOpenId" text NOT NULL,
    "memberOpenId" text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "confirmedAt" timestamp(3) with time zone NOT NULL,
    "protocolVersion" integer DEFAULT 1 NOT NULL
);

CREATE TABLE public."QqOfficialBindingAudit" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    action text NOT NULL,
    "identityDigest" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."QqOfficialBindingKey" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "sessionId" text NOT NULL,
    "appId" text NOT NULL,
    "botId" text NOT NULL,
    "groupOpenId" text NOT NULL,
    "enabledAt" timestamp(3) with time zone NOT NULL,
    "keyHash" text NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "consumedAt" timestamp(3) with time zone,
    "invalidatedAt" timestamp(3) with time zone,
    "bindingId" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."QqOfficialCandidate" (
    id text NOT NULL,
    "challengeId" text NOT NULL,
    "appId" text NOT NULL,
    "botId" text NOT NULL,
    "groupOpenId" text NOT NULL,
    "memberOpenId" text NOT NULL,
    "receiptCodeHash" text NOT NULL,
    "finalProofHash" text,
    "selectedAt" timestamp(3) with time zone,
    "provenAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."QqOfficialChallenge" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "sessionId" text NOT NULL,
    "publicCodeHash" text NOT NULL,
    "browserProofHash" text NOT NULL,
    "selectedCandidateId" text,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "invalidatedAt" timestamp(3) with time zone,
    "consumedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."QqOfficialDelivery" (
    "deliveryMode" text DEFAULT 'SIMULATION'::text NOT NULL,
    id text NOT NULL,
    "eventKey" text NOT NULL,
    "appId" text NOT NULL,
    "botId" text NOT NULL,
    "groupOpenId" text NOT NULL,
    "activityId" text NOT NULL,
    "activityRevision" integer NOT NULL,
    kind text NOT NULL,
    "dueAt" timestamp(3) with time zone NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    fence integer DEFAULT 0 NOT NULL,
    "leaseOwner" text,
    "leaseUntil" timestamp(3) with time zone,
    "dispatchedAt" timestamp(3) with time zone,
    "sentAt" timestamp(3) with time zone,
    "resultCode" text,
    "providerMessageId" text,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "renderedContent" text,
    "managementVersion" integer,
    "planningEpoch" integer,
    "groupGeneration" integer,
    "signupCode" text,
    "signupButton" boolean DEFAULT false NOT NULL,
    CONSTRAINT "QqOfficialDelivery_status_check" CHECK ((status = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text, 'DISPATCHING'::text, 'SENT'::text, 'SIMULATED'::text, 'UNKNOWN'::text, 'DENIED'::text, 'FAILED'::text, 'CANCELLED'::text, 'EXPIRED'::text])))
);

CREATE TABLE public."QqOfficialInbound" (
    id text NOT NULL,
    "appId" text NOT NULL,
    "botId" text NOT NULL,
    "groupOpenId" text NOT NULL,
    "eventKey" text NOT NULL,
    fingerprint text NOT NULL,
    result jsonb,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."QqOfficialMessage" (
    simulated boolean DEFAULT false NOT NULL,
    id text NOT NULL,
    "deliveryId" text NOT NULL,
    "appId" text NOT NULL,
    "botId" text NOT NULL,
    "groupOpenId" text NOT NULL,
    "refIdx" text NOT NULL,
    "activityId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."QqOfficialNonce" (
    id text NOT NULL,
    "nonceHash" text NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."QqOfficialSignupCode" (
    code text NOT NULL,
    "activatedAt" timestamp(3) with time zone,
    "appId" text NOT NULL,
    "botId" text NOT NULL,
    "groupOpenId" text NOT NULL,
    "activityId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "QqOfficialSignupCode_format" CHECK ((code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$'::text))
);

CREATE TABLE public."QuickLinkCommand" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    kind text NOT NULL,
    result jsonb NOT NULL,
    snapshot jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "QuickLinkCommand_kind_check" CHECK ((kind = ANY (ARRAY['create'::text, 'update'::text, 'remove'::text, 'move'::text])))
);

CREATE TABLE public."QuickLinkState" (
    id text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT "QuickLinkState_id_check" CHECK ((id = 'global'::text)),
    CONSTRAINT "QuickLinkState_revision_check" CHECK ((revision >= 0))
);

CREATE TABLE public."ResourceCategory" (
    id text NOT NULL,
    name character varying(40) NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL
);

CREATE TABLE public."ResourceLink" (
    id text NOT NULL,
    name character varying(80) NOT NULL,
    purpose character varying(200) NOT NULL,
    url character varying(2048) NOT NULL,
    "categoryId" text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "iconBytes" bytea,
    "iconVersion" character varying(64),
    "iconSource" character varying(8) DEFAULT 'auto'::character varying NOT NULL,
    "iconBudgetComponentId" character varying(64),
    "iconBudgetMutationXid" character varying(20),
    CONSTRAINT "ResourceLink_iconSource_check" CHECK (("iconSource" IN ('auto', 'manual'))),
    CONSTRAINT "ResourceLink_icon_budget_shape" CHECK ((("iconBudgetComponentId" IS NULL) OR (("iconBytes" IS NOT NULL) AND ("iconBudgetMutationXid" IS NOT NULL) AND (("iconBudgetMutationXid")::text ~ '^[0-9]{1,20}$'::text) AND ("iconVersion" IS NOT NULL) AND (("iconVersion")::text ~ '^[a-f0-9]{64}$'::text)))),
    CONSTRAINT "ResourceLink_manual_icon_check" CHECK (((("iconSource")::text <> 'manual'::text) OR (("iconBytes" IS NOT NULL) AND ((octet_length("iconBytes") >= 1) AND (octet_length("iconBytes") <= 65536)) AND ("iconVersion" IS NOT NULL) AND (("iconVersion")::text ~ '^[a-f0-9]{64}$'::text))))
);

CREATE TABLE public."SiteAnnouncement" (
    id text NOT NULL,
    text text NOT NULL,
    active boolean DEFAULT false NOT NULL,
    "createdById" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deletedAt" timestamp(3) with time zone,
    "deletedById" text,
    CONSTRAINT "SiteAnnouncement_deletion_check" CHECK (((("deletedAt" IS NULL) AND ("deletedById" IS NULL)) OR (("deletedAt" IS NOT NULL) AND ("deletedById" IS NOT NULL) AND (active = false)))),
    CONSTRAINT "SiteAnnouncement_text_check" CHECK (((char_length(text) >= 1) AND (char_length(text) <= 2000)))
);

CREATE TABLE public."SiteAnnouncementCommand" (
    id text NOT NULL,
    "actorId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    kind text NOT NULL,
    result jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."SiteAnnouncementState" (
    id text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT "SiteAnnouncementState_revision_check" CHECK ((revision >= 0)),
    CONSTRAINT "SiteAnnouncementState_singleton_check" CHECK ((id = 'site'::text))
);

CREATE TABLE public."SiteHelpStepProgress" (
    "accountId" text NOT NULL,
    "lessonId" character varying(64) NOT NULL,
    version integer NOT NULL,
    "stepId" character varying(64) NOT NULL,
    "completedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "SiteHelpStepProgress_valid_identity" CHECK (((version > 0) AND (("lessonId")::text ~ '^[a-z][a-z0-9-]{0,63}$'::text) AND (("stepId")::text ~ '^[a-z][a-z0-9-]{0,63}$'::text)))
);

CREATE TABLE public."TeamApplication" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "seatId" text NOT NULL,
    "accountId" text NOT NULL,
    job text NOT NULL,
    note text NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "decidedAt" timestamp(3) with time zone,
    CONSTRAINT "TeamApplication_state_check" CHECK ((((state = 'PENDING'::text) AND ("decidedAt" IS NULL)) OR ((state = ANY (ARRAY['ACCEPTED'::text, 'REJECTED'::text, 'CANCELLED'::text])) AND ("decidedAt" IS NOT NULL))))
);

CREATE TABLE public."TeamCommand" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "actorId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    kind text NOT NULL,
    before jsonb NOT NULL,
    after jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."TeamFeedback" (
    id text NOT NULL,
    "sessionId" text NOT NULL,
    "timeVersion" integer NOT NULL,
    "accountId" text NOT NULL,
    choice text NOT NULL,
    "updatedAt" timestamp(3) with time zone NOT NULL,
    CONSTRAINT "TeamFeedback_choice_check" CHECK (((choice = ANY (ARRAY['CAN'::text, 'CANNOT'::text])) AND ("timeVersion" >= 0)))
);

CREATE TABLE public."TeamMembership" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "seatId" text,
    "accountId" text NOT NULL,
    "position" integer NOT NULL,
    job text NOT NULL,
    state text DEFAULT 'ACTIVE'::text NOT NULL,
    "joinedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "leftAt" timestamp(3) with time zone,
    CONSTRAINT "TeamMembership_state_check" CHECK (((("position" >= 0) AND ("position" <= 7)) AND (((state = 'ACTIVE'::text) AND ("seatId" IS NOT NULL) AND ("leftAt" IS NULL)) OR ((state = ANY (ARRAY['LEFT'::text, 'REMOVED'::text])) AND ("seatId" IS NULL) AND ("leftAt" IS NOT NULL)))))
);

CREATE TABLE public."TeamNotification" (
    id text NOT NULL,
    "eventKey" text NOT NULL,
    "teamId" text NOT NULL,
    "recipientId" text,
    kind text NOT NULL,
    channel public."ActivityNotificationChannel" NOT NULL,
    "qqGroupTarget" text,
    payload jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "simulatedAt" timestamp(3) with time zone NOT NULL,
    "messageReadAt" timestamp(3) with time zone,
    "messageDeletedAt" timestamp(3) with time zone,
    CONSTRAINT "TeamNotification_route_check" CHECK ((((channel = 'IN_APP'::public."ActivityNotificationChannel") AND ("recipientId" IS NOT NULL) AND ("qqGroupTarget" IS NULL)) OR ((channel = 'QQ'::public."ActivityNotificationChannel") AND ("recipientId" IS NULL) AND ("qqGroupTarget" IS NOT NULL))))
);

CREATE TABLE public."TeamParticipationChange" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "memberId" text,
    "substituteId" text,
    status text NOT NULL,
    reason text NOT NULL,
    "actorId" text NOT NULL,
    "recordedAt" timestamp(3) with time zone NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT "TeamParticipationChange_reason_check" CHECK (((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 1000))),
    CONSTRAINT "TeamParticipationChange_status_check" CHECK (((status = ANY (ARRAY['PRESENT'::text, 'LEAVE'::text, 'ABSENT'::text])) AND (revision > 0))),
    CONSTRAINT "TeamParticipationChange_target_check" CHECK ((((("memberId" IS NOT NULL))::integer + (("substituteId" IS NOT NULL))::integer) = 1))
);

CREATE TABLE public."TeamSeat" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "position" integer NOT NULL,
    kind public."ActivitySeatKind" NOT NULL,
    role public."ActivityRole",
    job text,
    CONSTRAINT "TeamSeat_shape_check" CHECK (((("position" >= 0) AND ("position" <= 7)) AND (((kind = 'ROLE'::public."ActivitySeatKind") AND (role IS NOT NULL) AND (job IS NULL)) OR ((kind = 'JOB'::public."ActivitySeatKind") AND (job IS NOT NULL) AND (role IS NULL)))))
);

CREATE TABLE public."TeamSession" (
    id text NOT NULL,
    "teamId" text NOT NULL,
    "startsAt" timestamp(3) with time zone NOT NULL,
    "endsAt" timestamp(3) with time zone NOT NULL,
    state text DEFAULT 'PROPOSED'::text NOT NULL,
    "timeVersion" integer DEFAULT 0 NOT NULL,
    "confirmedAt" timestamp(3) with time zone,
    "cancelledAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "TeamSession_state_check" CHECK ((("endsAt" > "startsAt") AND ("timeVersion" >= 0) AND (((state = 'PROPOSED'::text) AND ("confirmedAt" IS NULL) AND ("cancelledAt" IS NULL)) OR ((state = 'CONFIRMED'::text) AND ("confirmedAt" IS NOT NULL) AND ("cancelledAt" IS NULL)) OR ((state = 'CANCELLED'::text) AND ("cancelledAt" IS NOT NULL)))))
);

CREATE TABLE public."TeamSessionLeave" (
    id text NOT NULL,
    "memberId" text NOT NULL,
    reason text NOT NULL,
    "recordedById" text NOT NULL,
    "createdAt" timestamp(3) with time zone NOT NULL,
    CONSTRAINT "TeamSessionLeave_reason_check" CHECK (((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 1000)))
);

CREATE TABLE public."TeamSessionMember" (
    id text NOT NULL,
    "sessionId" text NOT NULL,
    "timeVersion" integer NOT NULL,
    "membershipId" text NOT NULL,
    "accountId" text NOT NULL,
    "position" integer NOT NULL,
    job text NOT NULL,
    state text DEFAULT 'MEMBER'::text NOT NULL,
    "confirmedStartsAt" timestamp(3) with time zone,
    "confirmedEndsAt" timestamp(3) with time zone,
    CONSTRAINT "TeamSessionMember_position_check" CHECK (((("position" >= 0) AND ("position" <= 7)) AND ("timeVersion" >= 0) AND (state = ANY (ARRAY['MEMBER'::text, 'NEEDS_SUBSTITUTE'::text]))))
);

CREATE TABLE public."TeamSessionSubstitute" (
    id text NOT NULL,
    "sessionId" text NOT NULL,
    "timeVersion" integer NOT NULL,
    "position" integer NOT NULL,
    kind text NOT NULL,
    "accountId" text,
    "confirmedStartsAt" timestamp(3) with time zone NOT NULL,
    "confirmedEndsAt" timestamp(3) with time zone NOT NULL,
    "displayName" text,
    "gameRegion" text,
    "gameServer" text,
    job text NOT NULL,
    "recordedById" text NOT NULL,
    "createdAt" timestamp(3) with time zone NOT NULL,
    "endedAt" timestamp(3) with time zone,
    CONSTRAINT "TeamSessionSubstitute_period_check" CHECK (("confirmedEndsAt" > "confirmedStartsAt")),
    CONSTRAINT "TeamSessionSubstitute_shape_check" CHECK (((("position" >= 0) AND ("position" <= 7)) AND ("timeVersion" >= 0) AND (((kind = 'REGISTERED'::text) AND ("accountId" IS NOT NULL) AND ("displayName" IS NULL) AND ("gameRegion" IS NULL) AND ("gameServer" IS NULL)) OR ((kind = 'EXTERNAL'::text) AND ("accountId" IS NULL) AND ("displayName" IS NOT NULL) AND ("gameRegion" IS NOT NULL) AND ("gameServer" IS NOT NULL) AND (length(btrim("displayName")) > 0) AND (length(btrim("gameRegion")) > 0) AND (length(btrim("gameServer")) > 0))))),
    CONSTRAINT "TeamSessionSubstitute_time_check" CHECK ((("endedAt" IS NULL) OR ("endedAt" >= "createdAt")))
);

CREATE TABLE public."VerificationCode" (
    id text NOT NULL,
    phone text NOT NULL,
    purpose public."VerificationPurpose" NOT NULL,
    "invitationId" text,
    "codeHash" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "consumedAt" timestamp(3) with time zone,
    "invalidatedAt" timestamp(3) with time zone,
    "deliveredAt" timestamp(3) with time zone
);

CREATE TABLE public."Wish" (
    id text NOT NULL,
    "authorId" text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    "wantedContent" text DEFAULT ''::text NOT NULL,
    "convenientTime" text DEFAULT ''::text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    "activityId" text,
    revision integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deletedAt" timestamp(3) with time zone,
    category text,
    "moderatedAt" timestamp(3) with time zone,
    CONSTRAINT "Wish_body_check" CHECK (((char_length(body) >= 1) AND (char_length(body) <= 11001))),
    CONSTRAINT "Wish_category_check" CHECK (((category IS NULL) OR (category = ANY (ARRAY['MOUNT'::text, 'CHALLENGE'::text, 'CRAFT_GATHER'::text, 'EXPLORE'::text, 'ACHIEVEMENT'::text, 'OTHER'::text])))),
    CONSTRAINT "Wish_convenientTime_check" CHECK ((char_length("convenientTime") <= 500)),
    CONSTRAINT "Wish_linked_not_deleted_check" CHECK ((("deletedAt" IS NULL) OR ("activityId" IS NULL))),
    CONSTRAINT "Wish_title_check" CHECK (((char_length(title) >= 1) AND (char_length(title) <= 100))),
    CONSTRAINT "Wish_wantedContent_check" CHECK ((char_length("wantedContent") <= 1000))
);

CREATE TABLE public."WishCommand" (
    "wishId" text NOT NULL,
    "actorId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    kind text NOT NULL,
    "requestFingerprint" text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."WishComment" (
    id text NOT NULL,
    "wishId" text NOT NULL,
    "authorId" text NOT NULL,
    body text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    "parentId" text,
    mentions text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT "WishComment_body_check" CHECK (((char_length(body) >= 0) AND (char_length(body) <= 2000)))
);

CREATE TABLE public."WishConversion" (
    "wishId" text NOT NULL,
    "actorId" text NOT NULL,
    "activityId" text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "requestFingerprint" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."WishInterest" (
    "wishId" text NOT NULL,
    "accountId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."WishMedia" (
    id text NOT NULL,
    "ownerId" text NOT NULL,
    "wishId" text,
    "commentId" text,
    "batchId" text NOT NULL,
    "batchIndex" integer NOT NULL,
    fingerprint text NOT NULL,
    mime text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    frames integer DEFAULT 1 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "removedAt" timestamp(3) with time zone,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "WishMedia_attachment_check" CHECK ((("wishId" IS NULL) = ("commentId" IS NULL))),
    CONSTRAINT "WishMedia_batchIndex_check" CHECK ((("batchIndex" >= 0) AND ("batchIndex" <= 9))),
    CONSTRAINT "WishMedia_frames_check" CHECK (((frames >= 1) AND (frames <= 300))),
    CONSTRAINT "WishMedia_height_check" CHECK ((height > 0)),
    CONSTRAINT "WishMedia_width_check" CHECK ((width > 0))
);

CREATE TABLE public."WishNotification" (
    id text NOT NULL,
    "eventKey" text NOT NULL,
    "wishId" text NOT NULL,
    "activityId" text,
    "recipientId" text NOT NULL,
    "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "readAt" timestamp(3) with time zone,
    "deletedAt" timestamp(3) with time zone,
    kind text DEFAULT 'WISH_CONVERTED'::text NOT NULL,
    "commentId" text,
    CONSTRAINT "WishNotification_kind_check" CHECK ((((kind = 'WISH_CONVERTED'::text) AND ("activityId" IS NOT NULL) AND ("commentId" IS NULL)) OR ((kind = 'WISH_INTERACTION'::text) AND ("commentId" IS NOT NULL) AND ("activityId" IS NULL))))
);

-- ==================== 默认值 ====================

ALTER TABLE ONLY public."ActivityPenaltyAppeal" ALTER COLUMN sequence SET DEFAULT nextval('public."ActivityPenaltyAppeal_sequence_seq"'::regclass);

ALTER TABLE ONLY public."ActivityScoreChange" ALTER COLUMN sequence SET DEFAULT nextval('public."ActivityScoreChange_sequence_seq"'::regclass);

-- ==================== 约束 ====================

ALTER TABLE ONLY public."AccountAudit"
    ADD CONSTRAINT "AccountAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AccountLifecycleAudit"
    ADD CONSTRAINT "AccountLifecycleAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AccountLifecycleCommand"
    ADD CONSTRAINT "AccountLifecycleCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AccountRateEvent"
    ADD CONSTRAINT "AccountRateEvent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AccountSession"
    ADD CONSTRAINT "AccountSession_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityAttendanceAppeal"
    ADD CONSTRAINT "ActivityAttendanceAppeal_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityCommand"
    ADD CONSTRAINT "ActivityCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityCompletion"
    ADD CONSTRAINT "ActivityCompletion_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityMockDelivery"
    ADD CONSTRAINT "ActivityMockDelivery_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityOutbox"
    ADD CONSTRAINT "ActivityOutbox_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityPenaltyAppeal"
    ADD CONSTRAINT "ActivityPenaltyAppeal_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityPenaltyAppeal"
    ADD CONSTRAINT "ActivityPenaltyAppeal_sequence_key" UNIQUE (sequence);

ALTER TABLE ONLY public."ActivityPenalty"
    ADD CONSTRAINT "ActivityPenalty_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityRegistration"
    ADD CONSTRAINT "ActivityRegistration_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityScoreChange"
    ADD CONSTRAINT "ActivityScoreChange_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivitySeat"
    ADD CONSTRAINT "ActivitySeat_activityId_position_key" UNIQUE ("activityId", "position") DEFERRABLE;

ALTER TABLE ONLY public."ActivitySeat"
    ADD CONSTRAINT "ActivitySeat_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivitySeries"
    ADD CONSTRAINT "ActivitySeries_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityShareAudit"
    ADD CONSTRAINT "ActivityShareAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityShareCommand"
    ADD CONSTRAINT "ActivityShareCommand_actorId_idempotencyKey_key" UNIQUE ("actorId", "idempotencyKey");

ALTER TABLE ONLY public."ActivityShareCommand"
    ADD CONSTRAINT "ActivityShareCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityShareMedia"
    ADD CONSTRAINT "ActivityShareMedia_ownerId_batchId_batchIndex_key" UNIQUE ("ownerId", "batchId", "batchIndex");

ALTER TABLE ONLY public."ActivityShareMedia"
    ADD CONSTRAINT "ActivityShareMedia_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ActivityShare"
    ADD CONSTRAINT "ActivityShare_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Activity"
    ADD CONSTRAINT "Activity_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AdminManagementAudit"
    ADD CONSTRAINT "AdminManagementAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AdminManagementCommand"
    ADD CONSTRAINT "AdminManagementCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AlbumAudit"
    ADD CONSTRAINT "AlbumAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AlbumCategory"
    ADD CONSTRAINT "AlbumCategory_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AlbumCommand"
    ADD CONSTRAINT "AlbumCommand_actorId_submissionKey_key" UNIQUE ("actorId", "submissionKey");

ALTER TABLE ONLY public."AlbumCommand"
    ADD CONSTRAINT "AlbumCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AlbumCommentMedia"
    ADD CONSTRAINT "AlbumCommentMedia_ownerId_batchId_batchIndex_key" UNIQUE ("ownerId", "batchId", "batchIndex");

ALTER TABLE ONLY public."AlbumCommentMedia"
    ADD CONSTRAINT "AlbumCommentMedia_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AlbumComment"
    ADD CONSTRAINT "AlbumComment_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AlbumLike"
    ADD CONSTRAINT "AlbumLike_pkey" PRIMARY KEY ("photoId", "accountId");

ALTER TABLE ONLY public."AlbumNotification"
    ADD CONSTRAINT "AlbumNotification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AlbumPhoto"
    ADD CONSTRAINT "AlbumPhoto_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Album"
    ADD CONSTRAINT "Album_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."AvatarAsset"
    ADD CONSTRAINT "AvatarAsset_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BotGroupCandidate"
    ADD CONSTRAINT "BotGroupCandidate_finalProofHash_key" UNIQUE ("finalProofHash");

ALTER TABLE ONLY public."BotGroupCandidate"
    ADD CONSTRAINT "BotGroupCandidate_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BotGroupCandidate"
    ADD CONSTRAINT "BotGroupCandidate_receiptCodeHash_key" UNIQUE ("receiptCodeHash");

ALTER TABLE ONLY public."BotGroupChallenge"
    ADD CONSTRAINT "BotGroupChallenge_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BotGroupChallenge"
    ADD CONSTRAINT "BotGroupChallenge_publicCodeHash_key" UNIQUE ("publicCodeHash");

ALTER TABLE ONLY public."BotGroupState"
    ADD CONSTRAINT "BotGroupState_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BotGroup"
    ADD CONSTRAINT "BotGroup_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BotManagementAudit"
    ADD CONSTRAINT "BotManagementAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BotManagementObservation"
    ADD CONSTRAINT "BotManagementObservation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BotManagementPublication"
    ADD CONSTRAINT "BotManagementPublication_pkey" PRIMARY KEY (version);

ALTER TABLE ONLY public."BotManagementSendRecord"
    ADD CONSTRAINT "BotManagementSendRecord_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BotManagementState"
    ADD CONSTRAINT "BotManagementState_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."BotManagementTest"
    ADD CONSTRAINT "BotManagementTest_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DailyAudit"
    ADD CONSTRAINT "DailyAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DailyCheckin"
    ADD CONSTRAINT "DailyCheckin_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DailyCommand"
    ADD CONSTRAINT "DailyCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DailyComment"
    ADD CONSTRAINT "DailyComment_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DailyLike"
    ADD CONSTRAINT "DailyLike_pkey" PRIMARY KEY ("postId", "accountId");

ALTER TABLE ONLY public."DailyMedia"
    ADD CONSTRAINT "DailyMedia_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DailyNotification"
    ADD CONSTRAINT "DailyNotification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."DailyPost"
    ADD CONSTRAINT "DailyPost_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."EnvironmentProbe"
    ADD CONSTRAINT "EnvironmentProbe_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."FixedTeam"
    ADD CONSTRAINT "FixedTeam_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."GuestContactMessage"
    ADD CONSTRAINT "GuestContactMessage_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."KnowledgeArticleInteraction"
    ADD CONSTRAINT "KnowledgeArticleInteraction_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."KnowledgeArticleRead"
    ADD CONSTRAINT "KnowledgeArticleRead_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."KnowledgeArticle"
    ADD CONSTRAINT "KnowledgeArticle_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."KnowledgeAudit"
    ADD CONSTRAINT "KnowledgeAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."KnowledgeCategory"
    ADD CONSTRAINT "KnowledgeCategory_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."KnowledgeComment"
    ADD CONSTRAINT "KnowledgeComment_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."KnowledgeContribution"
    ADD CONSTRAINT "KnowledgeContribution_pkey" PRIMARY KEY ("articleId", "accountId");

ALTER TABLE ONLY public."KnowledgeImage"
    ADD CONSTRAINT "KnowledgeImage_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."KnowledgeNotification"
    ADD CONSTRAINT "KnowledgeNotification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."KnowledgeVersion"
    ADD CONSTRAINT "KnowledgeVersion_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."LocalQcRecord"
    ADD CONSTRAINT "LocalQcRecord_pkey" PRIMARY KEY (namespace, slot);

ALTER TABLE ONLY public."LocalQcRun"
    ADD CONSTRAINT "LocalQcRun_pkey" PRIMARY KEY (namespace);

ALTER TABLE ONLY public."LotteryAccountFact"
    ADD CONSTRAINT "LotteryAccountFact_pkey" PRIMARY KEY (sequence);

ALTER TABLE ONLY public."LotteryAccountStatus"
    ADD CONSTRAINT "LotteryAccountStatus_pkey" PRIMARY KEY ("accountId");

ALTER TABLE ONLY public."LotteryCommand"
    ADD CONSTRAINT "LotteryCommand_pkey" PRIMARY KEY ("lotteryId", "actorId", key);

ALTER TABLE ONLY public."LotteryEligibilityControl"
    ADD CONSTRAINT "LotteryEligibilityControl_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."LotteryEntry"
    ADD CONSTRAINT "LotteryEntry_pkey" PRIMARY KEY ("lotteryId", "accountId");

ALTER TABLE ONLY public."LotteryNotification"
    ADD CONSTRAINT "LotteryNotification_pkey" PRIMARY KEY ("eventKey");

ALTER TABLE ONLY public."Lottery"
    ADD CONSTRAINT "Lottery_creatorId_idempotencyKey_key" UNIQUE ("creatorId", "idempotencyKey");

ALTER TABLE ONLY public."Lottery"
    ADD CONSTRAINT "Lottery_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MediaBudgetState"
    ADD CONSTRAINT "MediaBudgetState_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MediaCosObject"
    ADD CONSTRAINT "MediaCosObject_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MediaDailyBudget"
    ADD CONSTRAINT "MediaDailyBudget_pkey" PRIMARY KEY ("accountId", day);

ALTER TABLE ONLY public."MediaRetirementIntent"
    ADD CONSTRAINT "MediaRetirementIntent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MediaStorageCredit"
    ADD CONSTRAINT "MediaStorageCredit_pkey" PRIMARY KEY ("componentId");

ALTER TABLE ONLY public."MediaStoredComponent"
    ADD CONSTRAINT "MediaStoredComponent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."MediaUploadReceipt"
    ADD CONSTRAINT "MediaUploadReceipt_pkey" PRIMARY KEY (scope, "operationKey");

ALTER TABLE ONLY public."MemberProfile"
    ADD CONSTRAINT "MemberProfile_pkey" PRIMARY KEY ("accountId");

ALTER TABLE ONLY public."MessageNotification"
    ADD CONSTRAINT "MessageNotification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OfficialEventAudit"
    ADD CONSTRAINT "OfficialEventAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OfficialEventCommand"
    ADD CONSTRAINT "OfficialEventCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OfficialEventImage"
    ADD CONSTRAINT "OfficialEventImage_id_eventId_key" UNIQUE (id, "eventId");

ALTER TABLE ONLY public."OfficialEventImage"
    ADD CONSTRAINT "OfficialEventImage_identity_key" UNIQUE ("eventId", fingerprint, "sourceUrl");

ALTER TABLE ONLY public."OfficialEventImage"
    ADD CONSTRAINT "OfficialEventImage_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OfficialEvent"
    ADD CONSTRAINT "OfficialEvent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."OfficialSyncRun"
    ADD CONSTRAINT "OfficialSyncRun_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."PublicSiteSettings"
    ADD CONSTRAINT "PublicSiteSettings_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialBindingAudit"
    ADD CONSTRAINT "QqOfficialBindingAudit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialBindingKey"
    ADD CONSTRAINT "QqOfficialBindingKey_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialBinding"
    ADD CONSTRAINT "QqOfficialBinding_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialCandidate"
    ADD CONSTRAINT "QqOfficialCandidate_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialChallenge"
    ADD CONSTRAINT "QqOfficialChallenge_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialDelivery"
    ADD CONSTRAINT "QqOfficialDelivery_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialInbound"
    ADD CONSTRAINT "QqOfficialInbound_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialMessage"
    ADD CONSTRAINT "QqOfficialMessage_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialNonce"
    ADD CONSTRAINT "QqOfficialNonce_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QqOfficialSignupCode"
    ADD CONSTRAINT "QqOfficialSignupCode_pkey" PRIMARY KEY (code);

ALTER TABLE ONLY public."QuickLinkCommand"
    ADD CONSTRAINT "QuickLinkCommand_actorId_idempotencyKey_key" UNIQUE ("actorId", "idempotencyKey");

ALTER TABLE ONLY public."QuickLinkCommand"
    ADD CONSTRAINT "QuickLinkCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."QuickLinkState"
    ADD CONSTRAINT "QuickLinkState_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ResourceCategory"
    ADD CONSTRAINT "ResourceCategory_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."ResourceLink"
    ADD CONSTRAINT "ResourceLink_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."SiteAnnouncementCommand"
    ADD CONSTRAINT "SiteAnnouncementCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."SiteAnnouncementState"
    ADD CONSTRAINT "SiteAnnouncementState_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."SiteAnnouncement"
    ADD CONSTRAINT "SiteAnnouncement_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."SiteHelpStepProgress"
    ADD CONSTRAINT "SiteHelpStepProgress_pkey" PRIMARY KEY ("accountId", "lessonId", version, "stepId");

ALTER TABLE ONLY public."TeamApplication"
    ADD CONSTRAINT "TeamApplication_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamCommand"
    ADD CONSTRAINT "TeamCommand_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamFeedback"
    ADD CONSTRAINT "TeamFeedback_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamMembership"
    ADD CONSTRAINT "TeamMembership_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamNotification"
    ADD CONSTRAINT "TeamNotification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamParticipationChange"
    ADD CONSTRAINT "TeamParticipationChange_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamSeat"
    ADD CONSTRAINT "TeamSeat_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamSessionLeave"
    ADD CONSTRAINT "TeamSessionLeave_memberId_key" UNIQUE ("memberId");

ALTER TABLE ONLY public."TeamSessionLeave"
    ADD CONSTRAINT "TeamSessionLeave_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamSessionMember"
    ADD CONSTRAINT "TeamSessionMember_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamSessionSubstitute"
    ADD CONSTRAINT "TeamSessionSubstitute_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."TeamSession"
    ADD CONSTRAINT "TeamSession_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."VerificationCode"
    ADD CONSTRAINT "VerificationCode_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."WishCommand"
    ADD CONSTRAINT "WishCommand_pkey" PRIMARY KEY ("wishId", "actorId", "idempotencyKey");

ALTER TABLE ONLY public."WishComment"
    ADD CONSTRAINT "WishComment_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."WishComment"
    ADD CONSTRAINT "WishComment_wishId_authorId_idempotencyKey_key" UNIQUE ("wishId", "authorId", "idempotencyKey");

ALTER TABLE ONLY public."WishComment"
    ADD CONSTRAINT "WishComment_wishId_id_key" UNIQUE ("wishId", id);

ALTER TABLE ONLY public."WishConversion"
    ADD CONSTRAINT "WishConversion_activityId_key" UNIQUE ("activityId");

ALTER TABLE ONLY public."WishConversion"
    ADD CONSTRAINT "WishConversion_pkey" PRIMARY KEY ("wishId");

ALTER TABLE ONLY public."WishInterest"
    ADD CONSTRAINT "WishInterest_pkey" PRIMARY KEY ("wishId", "accountId");

ALTER TABLE ONLY public."WishMedia"
    ADD CONSTRAINT "WishMedia_ownerId_batchId_batchIndex_key" UNIQUE ("ownerId", "batchId", "batchIndex");

ALTER TABLE ONLY public."WishMedia"
    ADD CONSTRAINT "WishMedia_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."WishNotification"
    ADD CONSTRAINT "WishNotification_eventKey_key" UNIQUE ("eventKey");

ALTER TABLE ONLY public."WishNotification"
    ADD CONSTRAINT "WishNotification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Wish"
    ADD CONSTRAINT "Wish_activityId_key" UNIQUE ("activityId");

ALTER TABLE ONLY public."Wish"
    ADD CONSTRAINT "Wish_authorId_idempotencyKey_key" UNIQUE ("authorId", "idempotencyKey");

ALTER TABLE ONLY public."Wish"
    ADD CONSTRAINT "Wish_pkey" PRIMARY KEY (id);

-- ==================== 索引 ====================

CREATE INDEX "AccountAudit_action_createdAt_id_idx" ON public."AccountAudit" USING btree (action, "createdAt", id);

CREATE INDEX "AccountAudit_createdAt_id_idx" ON public."AccountAudit" USING btree ("createdAt", id);

CREATE INDEX "AccountLifecycleAudit_createdAt_id_idx" ON public."AccountLifecycleAudit" USING btree ("createdAt", id);

CREATE INDEX "AccountLifecycleAudit_targetAccountId_createdAt_id_idx" ON public."AccountLifecycleAudit" USING btree ("targetAccountId", "createdAt", id);

CREATE UNIQUE INDEX "AccountLifecycleCommand_actorId_idempotencyKey_key" ON public."AccountLifecycleCommand" USING btree ("actorId", "idempotencyKey");

CREATE INDEX "AccountRateEvent_key_createdAt_idx" ON public."AccountRateEvent" USING btree (key, "createdAt");

CREATE INDEX "AccountSession_accountId_revokedAt_idx" ON public."AccountSession" USING btree ("accountId", "revokedAt");

CREATE INDEX "AccountSession_expiresAt_idx" ON public."AccountSession" USING btree ("expiresAt");

CREATE UNIQUE INDEX "AccountSession_tokenHash_key" ON public."AccountSession" USING btree ("tokenHash");

CREATE INDEX "Account_createdAt_id_idx" ON public."Account" USING btree ("createdAt", id);

CREATE INDEX "Account_due_activity_decay_idx" ON public."Account" USING btree ("activityDecayAt", id) WHERE ("activityPoints" >= 3);

CREATE UNIQUE INDEX "Account_gameServer_displayName_key" ON public."Account" USING btree ("gameServer" COLLATE "C", "displayName" COLLATE "C");

CREATE UNIQUE INDEX "Account_localQcNamespace_localQcSlot_key" ON public."Account" USING btree ("localQcNamespace", "localQcSlot");

CREATE UNIQUE INDEX "Account_phone_key" ON public."Account" USING btree (phone);

CREATE UNIQUE INDEX "ActivityAttendanceAppeal_one_pending" ON public."ActivityAttendanceAppeal" USING btree ("registrationId") WHERE (status = 'PENDING'::text);

CREATE INDEX "ActivityAttendanceAppeal_registrationId_createdAt_id_idx" ON public."ActivityAttendanceAppeal" USING btree ("registrationId", "createdAt", id);

CREATE INDEX "ActivityAttendanceAppeal_status_createdAt_id_idx" ON public."ActivityAttendanceAppeal" USING btree (status, "createdAt", id);

CREATE UNIQUE INDEX "ActivityCommand_activityId_actorId_idempotencyKey_key" ON public."ActivityCommand" USING btree ("activityId", "actorId", "idempotencyKey");

CREATE INDEX "ActivityCommand_activityId_createdAt_idx" ON public."ActivityCommand" USING btree ("activityId", "createdAt");

CREATE UNIQUE INDEX "ActivityCompletion_activityId_accountId_key" ON public."ActivityCompletion" USING btree ("activityId", "accountId");

CREATE UNIQUE INDEX "ActivityCompletion_registrationId_key" ON public."ActivityCompletion" USING btree ("registrationId");

CREATE UNIQUE INDEX "ActivityMockDelivery_eventId_key" ON public."ActivityMockDelivery" USING btree ("eventId");

CREATE UNIQUE INDEX "ActivityOutbox_eventKey_key" ON public."ActivityOutbox" USING btree ("eventKey");

CREATE INDEX "ActivityOutbox_recipientId_channel_messageReadAt_createdAt_id_i" ON public."ActivityOutbox" USING btree ("recipientId", channel, "messageReadAt", "createdAt", id);

CREATE INDEX "ActivityOutbox_recipientId_createdAt_idx" ON public."ActivityOutbox" USING btree ("recipientId", "createdAt");

CREATE UNIQUE INDEX "ActivityPenaltyAppeal_accountId_submissionKey_key" ON public."ActivityPenaltyAppeal" USING btree ("accountId", "submissionKey");

CREATE UNIQUE INDEX "ActivityPenaltyAppeal_decidedById_decisionKey_key" ON public."ActivityPenaltyAppeal" USING btree ("decidedById", "decisionKey");

CREATE UNIQUE INDEX "ActivityPenaltyAppeal_one_pending" ON public."ActivityPenaltyAppeal" USING btree ("penaltyId") WHERE (status = 'PENDING'::text);

CREATE INDEX "ActivityPenaltyAppeal_penaltyId_sequence_idx" ON public."ActivityPenaltyAppeal" USING btree ("penaltyId", sequence);

CREATE INDEX "ActivityPenaltyAppeal_status_createdAt_sequence_idx" ON public."ActivityPenaltyAppeal" USING btree (status, "createdAt", sequence);

CREATE INDEX "ActivityPenalty_accountId_createdAt_idx" ON public."ActivityPenalty" USING btree ("accountId", "createdAt");

CREATE UNIQUE INDEX "ActivityPenalty_eventKey_key" ON public."ActivityPenalty" USING btree ("eventKey");

CREATE INDEX "ActivityRegistration_accountId_createdAt_idx" ON public."ActivityRegistration" USING btree ("accountId", "createdAt");

CREATE UNIQUE INDEX "ActivityRegistration_active_account_key" ON public."ActivityRegistration" USING btree ("activityId", "accountId") WHERE (status = 'ACTIVE'::text);

CREATE INDEX "ActivityRegistration_activityId_accountId_idx" ON public."ActivityRegistration" USING btree ("activityId", "accountId");

CREATE UNIQUE INDEX "ActivityRegistration_attendancePenaltyId_key" ON public."ActivityRegistration" USING btree ("attendancePenaltyId");

CREATE INDEX "ActivityRegistration_pending_attendance_idx" ON public."ActivityRegistration" USING btree ("activityId", id) INCLUDE ("accountId") WHERE ((status = 'ACTIVE'::text) AND ("attendanceStatus" IS NULL) AND ("attendanceRecordedAt" IS NULL) AND ("attendancePenaltyId" IS NULL));

CREATE UNIQUE INDEX "ActivityRegistration_seatId_activityId_key" ON public."ActivityRegistration" USING btree ("seatId", "activityId");

CREATE UNIQUE INDEX "ActivityRegistration_seatId_key" ON public."ActivityRegistration" USING btree ("seatId");

CREATE INDEX "ActivityScoreChange_accountId_createdAt_idx" ON public."ActivityScoreChange" USING btree ("accountId", "createdAt");

CREATE INDEX "ActivityScoreChange_accountId_messageReadAt_createdAt_id_idx" ON public."ActivityScoreChange" USING btree ("accountId", "messageReadAt", "createdAt", id);

CREATE UNIQUE INDEX "ActivityScoreChange_completionId_key" ON public."ActivityScoreChange" USING btree ("completionId");

CREATE UNIQUE INDEX "ActivityScoreChange_eventKey_key" ON public."ActivityScoreChange" USING btree ("eventKey");

CREATE UNIQUE INDEX "ActivityScoreChange_penaltyId_key" ON public."ActivityScoreChange" USING btree ("penaltyId");

CREATE UNIQUE INDEX "ActivityScoreChange_sequence_key" ON public."ActivityScoreChange" USING btree (sequence);

CREATE UNIQUE INDEX "ActivitySeat_id_activityId_key" ON public."ActivitySeat" USING btree (id, "activityId");

CREATE INDEX "ActivitySeries_state_createdAt_idx" ON public."ActivitySeries" USING btree (state, "createdAt");

CREATE INDEX "ActivityShareAudit_shareId_createdAt_id_idx" ON public."ActivityShareAudit" USING btree ("shareId", "createdAt", id);

CREATE INDEX "ActivityShareMedia_shareId_createdAt_id_idx" ON public."ActivityShareMedia" USING btree ("shareId", "createdAt", id);

CREATE INDEX "ActivityShare_activityId_createdAt_id_idx" ON public."ActivityShare" USING btree ("activityId", "createdAt", id);

CREATE INDEX "ActivityShare_featuredAt_id_idx" ON public."ActivityShare" USING btree ("featuredAt", id);

CREATE INDEX "Activity_autoAbsenceEnabledAt_endsAt_id_idx" ON public."Activity" USING btree ("endsAt", id) WHERE (("autoAbsenceEnabledAt" IS NOT NULL) AND (scene = 'GAME'::public."ActivityScene") AND (mode = 'SINGLE'::public."ActivityMode") AND ("cancelledAt" IS NULL));

CREATE UNIQUE INDEX "Activity_organizerId_idempotencyKey_key" ON public."Activity" USING btree ("organizerId", "idempotencyKey");

CREATE UNIQUE INDEX "Activity_seriesId_periodNumber_key" ON public."Activity" USING btree ("seriesId", "periodNumber");

CREATE INDEX "Activity_startsAt_id_idx" ON public."Activity" USING btree ("startsAt", id);

CREATE INDEX "AdminManagementAudit_kind_createdAt_id_idx" ON public."AdminManagementAudit" USING btree (kind, "createdAt", id);

CREATE UNIQUE INDEX "AdminManagementCommand_actorId_idempotencyKey_key" ON public."AdminManagementCommand" USING btree ("actorId", "idempotencyKey");

CREATE INDEX "AlbumAudit_albumId_createdAt_id_idx" ON public."AlbumAudit" USING btree ("albumId", "createdAt", id);

CREATE UNIQUE INDEX "AlbumCategory_primary_label_key" ON public."AlbumCategory" USING btree ("primary", label);

CREATE INDEX "AlbumCategory_primary_position_id_idx" ON public."AlbumCategory" USING btree ("primary", "position", id);

CREATE INDEX "AlbumCommentMedia_albumId_commentId_removedAt_idx" ON public."AlbumCommentMedia" USING btree ("albumId", "commentId", "removedAt");

CREATE INDEX "AlbumComment_albumId_photoId_createdAt_id_idx" ON public."AlbumComment" USING btree ("albumId", "photoId", "createdAt", id);

CREATE UNIQUE INDEX "AlbumComment_authorId_submissionKey_key" ON public."AlbumComment" USING btree ("authorId", "submissionKey");

CREATE UNIQUE INDEX "AlbumComment_id_albumId_key" ON public."AlbumComment" USING btree (id, "albumId");

CREATE UNIQUE INDEX "AlbumNotification_recipientId_commentId_key" ON public."AlbumNotification" USING btree ("recipientId", "commentId");

CREATE INDEX "AlbumNotification_recipientId_readAt_createdAt_id_idx" ON public."AlbumNotification" USING btree ("recipientId", "readAt", "createdAt", id);

CREATE INDEX "AlbumPhoto_albumId_createdAt_id_idx" ON public."AlbumPhoto" USING btree ("albumId", "createdAt", id);

CREATE INDEX "AlbumPhoto_albumId_periodActivityId_createdAt_id_idx" ON public."AlbumPhoto" USING btree ("albumId", "periodActivityId", "createdAt", id);

CREATE UNIQUE INDEX "AlbumPhoto_albumId_uploaderId_batchId_batchIndex_key" ON public."AlbumPhoto" USING btree ("albumId", "uploaderId", "batchId", "batchIndex");

CREATE INDEX "AlbumPhoto_feature_pool_order_idx" ON public."AlbumPhoto" USING btree ("featuredPool", "featuredSelectedAt", id);

CREATE INDEX "AlbumPhoto_featuredAt_removedAt_id_idx" ON public."AlbumPhoto" USING btree ("featuredAt", "removedAt", id);

CREATE UNIQUE INDEX "AlbumPhoto_original_upload_scope_key" ON public."AlbumPhoto" USING btree (COALESCE("uploadAlbumId", "albumId"), "uploaderId", "batchId", "batchIndex");

CREATE INDEX "AlbumPhoto_uploaderId_createdAt_id_idx" ON public."AlbumPhoto" USING btree ("uploaderId", "createdAt", id);

CREATE UNIQUE INDEX "Album_activityId_key" ON public."Album" USING btree ("activityId");

CREATE INDEX "Album_createdAt_id_idx" ON public."Album" USING btree ("createdAt", id);

CREATE INDEX "Album_primary_categoryId_createdAt_id_idx" ON public."Album" USING btree ("primary", "categoryId", "createdAt", id);

CREATE UNIQUE INDEX "Album_seriesId_key" ON public."Album" USING btree ("seriesId");

CREATE INDEX "AvatarAsset_accountId_idx" ON public."AvatarAsset" USING btree ("accountId");

CREATE UNIQUE INDEX "BotGroupCandidate_challengeId_appId_botId_groupOpenId_memberOpe" ON public."BotGroupCandidate" USING btree ("challengeId", "appId", "botId", "groupOpenId", "memberOpenId");

CREATE INDEX "BotGroupChallenge_accountId_expiresAt_idx" ON public."BotGroupChallenge" USING btree ("accountId", "expiresAt");

CREATE UNIQUE INDEX "BotGroup_appId_botId_groupOpenId_key" ON public."BotGroup" USING btree ("appId", "botId", "groupOpenId");

CREATE UNIQUE INDEX "BotManagementAudit_actorId_idempotencyKey_key" ON public."BotManagementAudit" USING btree ("actorId", "idempotencyKey");

CREATE INDEX "BotManagementAudit_createdAt_id_idx" ON public."BotManagementAudit" USING btree ("createdAt", id);

CREATE INDEX "BotManagementSendRecord_eventAt_id_idx" ON public."BotManagementSendRecord" USING btree ("eventAt", id);

CREATE UNIQUE INDEX "BotManagementTest_receiptDigest_key" ON public."BotManagementTest" USING btree ("receiptDigest");

CREATE INDEX "BotManagementTest_status_createdAt_idx" ON public."BotManagementTest" USING btree (status, "createdAt");

CREATE INDEX "DailyAudit_postId_createdAt_idx" ON public."DailyAudit" USING btree ("postId", "createdAt");

CREATE UNIQUE INDEX "DailyCheckin_accountId_day_key" ON public."DailyCheckin" USING btree ("accountId", day);

CREATE UNIQUE INDEX "DailyCommand_actorId_submissionKey_key" ON public."DailyCommand" USING btree ("actorId", "submissionKey");

CREATE UNIQUE INDEX "DailyComment_id_postId_key" ON public."DailyComment" USING btree (id, "postId");

CREATE INDEX "DailyComment_postId_createdAt_id_idx" ON public."DailyComment" USING btree ("postId", "createdAt", id);

CREATE INDEX "DailyMedia_commentId_position_idx" ON public."DailyMedia" USING btree ("commentId", "position");

CREATE UNIQUE INDEX "DailyMedia_ownerId_batchId_batchIndex_key" ON public."DailyMedia" USING btree ("ownerId", "batchId", "batchIndex");

CREATE INDEX "DailyMedia_postId_position_idx" ON public."DailyMedia" USING btree ("postId", "position");

CREATE UNIQUE INDEX "DailyNotification_eventKey_key" ON public."DailyNotification" USING btree ("eventKey");

CREATE INDEX "DailyNotification_recipientId_deletedAt_readAt_createdAt_idx" ON public."DailyNotification" USING btree ("recipientId", "deletedAt", "readAt", "createdAt");

CREATE INDEX "DailyPost_authorId_createdAt_id_idx" ON public."DailyPost" USING btree ("authorId", "createdAt", id);

CREATE INDEX "DailyPost_createdAt_id_idx" ON public."DailyPost" USING btree ("createdAt", id);

CREATE UNIQUE INDEX "FixedTeam_creatorId_idempotencyKey_key" ON public."FixedTeam" USING btree ("creatorId", "idempotencyKey");

CREATE INDEX "FixedTeam_recruitmentCompletedAt_state_createdAt_idx" ON public."FixedTeam" USING btree ("recruitmentCompletedAt", state, "createdAt");

CREATE INDEX "FixedTeam_state_createdAt_id_idx" ON public."FixedTeam" USING btree (state, "createdAt", id);

CREATE INDEX "GuestContactMessage_status_createdAt_id_idx" ON public."GuestContactMessage" USING btree (status, "createdAt", id);

CREATE UNIQUE INDEX "GuestContactMessage_submissionKey_key" ON public."GuestContactMessage" USING btree ("submissionKey");

CREATE INDEX "Invitation_createdAt_id_idx" ON public."Invitation" USING btree ("createdAt", id);

CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON public."Invitation" USING btree ("tokenHash");

CREATE UNIQUE INDEX "Invitation_usedById_key" ON public."Invitation" USING btree ("usedById");

CREATE UNIQUE INDEX "KnowledgeArticleInteraction_articleId_accountId_key" ON public."KnowledgeArticleInteraction" USING btree ("articleId", "accountId");

CREATE INDEX "KnowledgeArticleInteraction_articleId_collectedAt_idx" ON public."KnowledgeArticleInteraction" USING btree ("articleId", "collectedAt");

CREATE INDEX "KnowledgeArticleInteraction_articleId_likedAt_idx" ON public."KnowledgeArticleInteraction" USING btree ("articleId", "likedAt");

CREATE UNIQUE INDEX "KnowledgeArticleRead_articleId_sessionKey_key" ON public."KnowledgeArticleRead" USING btree ("articleId", "sessionKey");

CREATE UNIQUE INDEX "KnowledgeArticle_authorId_submissionKey_key" ON public."KnowledgeArticle" USING btree ("authorId", "submissionKey");

CREATE INDEX "KnowledgeArticle_categoryId_createdAt_id_idx" ON public."KnowledgeArticle" USING btree ("categoryId", "createdAt", id);

CREATE UNIQUE INDEX "KnowledgeCategory_label_key" ON public."KnowledgeCategory" USING btree (label);

CREATE INDEX "KnowledgeComment_articleId_createdAt_id_idx" ON public."KnowledgeComment" USING btree ("articleId", "createdAt", id);

CREATE UNIQUE INDEX "KnowledgeComment_authorId_submissionKey_key" ON public."KnowledgeComment" USING btree ("authorId", "submissionKey");

CREATE INDEX "KnowledgeImage_articleId_idx" ON public."KnowledgeImage" USING btree ("articleId");

CREATE UNIQUE INDEX "KnowledgeImage_uploaderId_batchId_batchIndex_key" ON public."KnowledgeImage" USING btree ("uploaderId", "batchId", "batchIndex");

CREATE UNIQUE INDEX "KnowledgeNotification_commentId_recipientId_key" ON public."KnowledgeNotification" USING btree ("commentId", "recipientId");

CREATE INDEX "KnowledgeNotification_recipientId_createdAt_id_idx" ON public."KnowledgeNotification" USING btree ("recipientId", "createdAt", id);

CREATE UNIQUE INDEX "KnowledgeVersion_articleId_number_key" ON public."KnowledgeVersion" USING btree ("articleId", number);

CREATE INDEX "LotteryAccountFact_asof_idx" ON public."LotteryAccountFact" USING btree ("accountId", "effectiveAt" DESC, sequence DESC);

CREATE UNIQUE INDEX "LotteryNotification_messageId_key" ON public."LotteryNotification" USING btree ("messageId");

CREATE INDEX "LotteryNotification_pending_idx" ON public."LotteryNotification" USING btree ("simulatedAt", "createdAt");

CREATE INDEX "LotteryNotification_recipient_created_idx" ON public."LotteryNotification" USING btree ("recipientId", "createdAt", "messageId");

CREATE INDEX "Lottery_state_drawAt_idx" ON public."Lottery" USING btree (state, "drawAt");

CREATE UNIQUE INDEX "MediaCosObject_region_bucket_objectKey_key" ON public."MediaCosObject" USING btree (region, bucket, "objectKey");

CREATE UNIQUE INDEX "MediaCosObject_scope_objectId_part_key" ON public."MediaCosObject" USING btree (scope, "objectId", part);

CREATE UNIQUE INDEX "MediaRetirementIntent_componentId_key" ON public."MediaRetirementIntent" USING btree ("componentId");

CREATE UNIQUE INDEX "MediaRetirementIntent_id_componentId_key" ON public."MediaRetirementIntent" USING btree (id, "componentId");

CREATE UNIQUE INDEX "MediaStorageCredit_intentId_componentId_key" ON public."MediaStorageCredit" USING btree ("intentId", "componentId");

CREATE UNIQUE INDEX "MediaStorageCredit_intentId_key" ON public."MediaStorageCredit" USING btree ("intentId");

CREATE UNIQUE INDEX "MediaStoredComponent_namespace_objectKey_generation_part_key" ON public."MediaStoredComponent" USING btree (namespace, "objectKey", generation, part);

CREATE INDEX "MediaStoredComponent_receiptScope_receiptOperationKey_idx" ON public."MediaStoredComponent" USING btree ("receiptScope", "receiptOperationKey");

CREATE INDEX "MediaUploadReceipt_accountId_day_idx" ON public."MediaUploadReceipt" USING btree ("accountId", day);

CREATE UNIQUE INDEX "MediaUploadReceipt_attemptId_key" ON public."MediaUploadReceipt" USING btree ("attemptId");

CREATE UNIQUE INDEX "MediaUploadReceipt_objectIdentity_key" ON public."MediaUploadReceipt" USING btree ("objectIdentity");

CREATE INDEX "MediaUploadReceipt_reservation_candidates_idx" ON public."MediaUploadReceipt" USING btree ("reservationProtocol", state, "persistenceStartedAt", "createdAt", scope, "operationKey");

CREATE UNIQUE INDEX "MemberProfile_avatarId_key" ON public."MemberProfile" USING btree ("avatarId");

CREATE UNIQUE INDEX "MessageNotification_eventKey_key" ON public."MessageNotification" USING btree ("eventKey");

CREATE INDEX "MessageNotification_recipientId_deletedAt_createdAt_id_idx" ON public."MessageNotification" USING btree ("recipientId", "deletedAt", "createdAt", id);

CREATE INDEX "MessageNotification_recipientId_readAt_deletedAt_idx" ON public."MessageNotification" USING btree ("recipientId", "readAt", "deletedAt");

CREATE INDEX "OfficialEventAudit_eventId_createdAt_id_idx" ON public."OfficialEventAudit" USING btree ("eventId", "createdAt", id);

CREATE UNIQUE INDEX "OfficialEventCommand_eventId_actorId_idempotencyKey_key" ON public."OfficialEventCommand" USING btree ("eventId", "actorId", "idempotencyKey");

CREATE UNIQUE INDEX "OfficialEvent_sourceKey_externalId_key" ON public."OfficialEvent" USING btree ("sourceKey", "externalId");

CREATE INDEX "OfficialEvent_status_createdAt_id_idx" ON public."OfficialEvent" USING btree (status, "createdAt", id);

CREATE INDEX "OfficialEvent_status_startsAt_endsAt_idx" ON public."OfficialEvent" USING btree (status, "startsAt", "endsAt");

CREATE UNIQUE INDEX "OfficialSyncRun_actorId_idempotencyKey_key" ON public."OfficialSyncRun" USING btree ("actorId", "idempotencyKey");

CREATE INDEX "OfficialSyncRun_createdAt_id_idx" ON public."OfficialSyncRun" USING btree ("createdAt", id);

CREATE INDEX "QqOfficialBindingKey_accountId_expiresAt_idx" ON public."QqOfficialBindingKey" USING btree ("accountId", "expiresAt");

CREATE UNIQUE INDEX "QqOfficialBindingKey_keyHash_key" ON public."QqOfficialBindingKey" USING btree ("keyHash");

CREATE UNIQUE INDEX "QqOfficialBinding_appId_botId_groupOpenId_accountId_key" ON public."QqOfficialBinding" USING btree ("appId", "botId", "groupOpenId", "accountId");

CREATE UNIQUE INDEX "QqOfficialBinding_appId_botId_groupOpenId_memberOpenId_key" ON public."QqOfficialBinding" USING btree ("appId", "botId", "groupOpenId", "memberOpenId");

CREATE UNIQUE INDEX "QqOfficialCandidate_challengeId_appId_botId_groupOpenId_mem_key" ON public."QqOfficialCandidate" USING btree ("challengeId", "appId", "botId", "groupOpenId", "memberOpenId");

CREATE UNIQUE INDEX "QqOfficialCandidate_finalProofHash_key" ON public."QqOfficialCandidate" USING btree ("finalProofHash");

CREATE UNIQUE INDEX "QqOfficialCandidate_receiptCodeHash_key" ON public."QqOfficialCandidate" USING btree ("receiptCodeHash");

CREATE INDEX "QqOfficialChallenge_accountId_expiresAt_idx" ON public."QqOfficialChallenge" USING btree ("accountId", "expiresAt");

CREATE UNIQUE INDEX "QqOfficialChallenge_publicCodeHash_key" ON public."QqOfficialChallenge" USING btree ("publicCodeHash");

CREATE INDEX "QqOfficialDelivery_activityId_status_idx" ON public."QqOfficialDelivery" USING btree ("activityId", status);

CREATE UNIQUE INDEX "QqOfficialDelivery_eventKey_key" ON public."QqOfficialDelivery" USING btree ("eventKey");

CREATE INDEX "QqOfficialDelivery_status_dueAt_idx" ON public."QqOfficialDelivery" USING btree (status, "dueAt");

CREATE UNIQUE INDEX "QqOfficialInbound_appId_botId_groupOpenId_eventKey_key" ON public."QqOfficialInbound" USING btree ("appId", "botId", "groupOpenId", "eventKey");

CREATE UNIQUE INDEX "QqOfficialMessage_appId_botId_groupOpenId_refIdx_key" ON public."QqOfficialMessage" USING btree ("appId", "botId", "groupOpenId", "refIdx");

CREATE UNIQUE INDEX "QqOfficialMessage_deliveryId_key" ON public."QqOfficialMessage" USING btree ("deliveryId");

CREATE UNIQUE INDEX "QqOfficialNonce_nonceHash_key" ON public."QqOfficialNonce" USING btree ("nonceHash");

CREATE UNIQUE INDEX "QqOfficialSignupCode_appId_botId_groupOpenId_activityId_key" ON public."QqOfficialSignupCode" USING btree ("appId", "botId", "groupOpenId", "activityId");

CREATE UNIQUE INDEX "ResourceCategory_name_key" ON public."ResourceCategory" USING btree (name);

CREATE INDEX "ResourceLink_categoryId_name_id_idx" ON public."ResourceLink" USING btree ("categoryId", name, id);

CREATE UNIQUE INDEX "ResourceLink_iconBudgetComponentId_key" ON public."ResourceLink" USING btree ("iconBudgetComponentId");

CREATE INDEX "ResourceLink_position_id_idx" ON public."ResourceLink" USING btree ("position", id);

CREATE UNIQUE INDEX "SiteAnnouncementCommand_actorId_idempotencyKey_key" ON public."SiteAnnouncementCommand" USING btree ("actorId", "idempotencyKey");

CREATE INDEX "SiteAnnouncement_active_createdAt_id_idx" ON public."SiteAnnouncement" USING btree (active, "createdAt", id);

CREATE INDEX "SiteAnnouncement_createdAt_id_idx" ON public."SiteAnnouncement" USING btree ("createdAt", id);

CREATE INDEX "SiteAnnouncement_deletedAt_active_createdAt_id_idx" ON public."SiteAnnouncement" USING btree ("deletedAt", active, "createdAt", id);

CREATE INDEX "TeamApplication_accountId_createdAt_idx" ON public."TeamApplication" USING btree ("accountId", "createdAt");

CREATE INDEX "TeamApplication_teamId_state_createdAt_idx" ON public."TeamApplication" USING btree ("teamId", state, "createdAt");

CREATE UNIQUE INDEX "TeamCommand_teamId_actorId_idempotencyKey_key" ON public."TeamCommand" USING btree ("teamId", "actorId", "idempotencyKey");

CREATE UNIQUE INDEX "TeamFeedback_sessionId_timeVersion_accountId_key" ON public."TeamFeedback" USING btree ("sessionId", "timeVersion", "accountId");

CREATE INDEX "TeamMembership_accountId_state_idx" ON public."TeamMembership" USING btree ("accountId", state);

CREATE UNIQUE INDEX "TeamMembership_active_account_key" ON public."TeamMembership" USING btree ("teamId", "accountId") WHERE (state = 'ACTIVE'::text);

CREATE UNIQUE INDEX "TeamMembership_seatId_key" ON public."TeamMembership" USING btree ("seatId");

CREATE UNIQUE INDEX "TeamMembership_seatId_teamId_key" ON public."TeamMembership" USING btree ("seatId", "teamId");

CREATE INDEX "TeamMembership_teamId_accountId_state_idx" ON public."TeamMembership" USING btree ("teamId", "accountId", state);

CREATE UNIQUE INDEX "TeamNotification_eventKey_key" ON public."TeamNotification" USING btree ("eventKey");

CREATE INDEX "TeamNotification_recipientId_channel_messageReadAt_createdA_idx" ON public."TeamNotification" USING btree ("recipientId", channel, "messageReadAt", "createdAt", id);

CREATE INDEX "TeamParticipationChange_memberId_revision_idx" ON public."TeamParticipationChange" USING btree ("memberId", revision);

CREATE INDEX "TeamParticipationChange_substituteId_revision_idx" ON public."TeamParticipationChange" USING btree ("substituteId", revision);

CREATE UNIQUE INDEX "TeamParticipationChange_teamId_revision_key" ON public."TeamParticipationChange" USING btree ("teamId", revision);

CREATE UNIQUE INDEX "TeamSeat_id_teamId_key" ON public."TeamSeat" USING btree (id, "teamId");

CREATE UNIQUE INDEX "TeamSeat_teamId_position_key" ON public."TeamSeat" USING btree ("teamId", "position");

CREATE UNIQUE INDEX "TeamSessionMember_sessionId_timeVersion_position_key" ON public."TeamSessionMember" USING btree ("sessionId", "timeVersion", "position");

CREATE UNIQUE INDEX "TeamSessionSubstitute_active_account_key" ON public."TeamSessionSubstitute" USING btree ("sessionId", "timeVersion", "accountId") WHERE (("endedAt" IS NULL) AND ("accountId" IS NOT NULL));

CREATE UNIQUE INDEX "TeamSessionSubstitute_active_position_key" ON public."TeamSessionSubstitute" USING btree ("sessionId", "timeVersion", "position") WHERE ("endedAt" IS NULL);

CREATE INDEX "TeamSessionSubstitute_sessionId_timeVersion_position_idx" ON public."TeamSessionSubstitute" USING btree ("sessionId", "timeVersion", "position");

CREATE INDEX "TeamSession_teamId_startsAt_id_idx" ON public."TeamSession" USING btree ("teamId", "startsAt", id);

CREATE INDEX "VerificationCode_phone_createdAt_idx" ON public."VerificationCode" USING btree (phone, "createdAt");

CREATE INDEX "WishComment_wishId_createdAt_id_idx" ON public."WishComment" USING btree ("wishId", "createdAt", id);

CREATE INDEX "WishInterest_wishId_active_updatedAt_idx" ON public."WishInterest" USING btree ("wishId", active, "updatedAt");

CREATE INDEX "WishMedia_wishId_commentId_idx" ON public."WishMedia" USING btree ("wishId", "commentId");

CREATE INDEX "WishNotification_recipientId_createdAt_id_idx" ON public."WishNotification" USING btree ("recipientId", "createdAt", id);

CREATE INDEX "Wish_createdAt_id_idx" ON public."Wish" USING btree ("createdAt" DESC, id DESC);

-- ==================== 触发器 ====================

CREATE TRIGGER "AccountLifecycleAudit_append_only" BEFORE DELETE OR UPDATE ON public."AccountLifecycleAudit" FOR EACH ROW EXECUTE FUNCTION public."accountLifecycleAppendOnly"();

CREATE TRIGGER "AccountLifecycleCommand_append_only" BEFORE DELETE OR UPDATE ON public."AccountLifecycleCommand" FOR EACH ROW EXECUTE FUNCTION public."accountLifecycleAppendOnly"();

CREATE TRIGGER "AdminManagementAudit_append_only" BEFORE DELETE OR UPDATE ON public."AdminManagementAudit" FOR EACH ROW EXECUTE FUNCTION public."adminManagementAppendOnly"();

CREATE TRIGGER "AdminManagementCommand_append_only" BEFORE DELETE OR UPDATE ON public."AdminManagementCommand" FOR EACH ROW EXECUTE FUNCTION public."adminManagementAppendOnly"();

CREATE TRIGGER "AlbumCommentMedia_permanent_mount" BEFORE INSERT OR DELETE OR UPDATE ON public."AlbumCommentMedia" FOR EACH ROW EXECUTE FUNCTION public.artzoo_preserve_album_comment_mount();

CREATE TRIGGER "KnowledgeImage_permanent_mount" BEFORE INSERT OR DELETE OR UPDATE ON public."KnowledgeImage" FOR EACH ROW EXECUTE FUNCTION public.artzoo_preserve_knowledge_mount();

CREATE TRIGGER "LotteryAccount_capture" AFTER INSERT OR UPDATE OF membership, "displayName" ON public."Account" FOR EACH ROW EXECUTE FUNCTION public.lottery_capture_account();

CREATE TRIGGER "LotteryControl_immutable" BEFORE DELETE OR UPDATE ON public."LotteryEligibilityControl" FOR EACH ROW EXECUTE FUNCTION public.lottery_history_immutable();

CREATE TRIGGER "LotteryFact_immutable" BEFORE DELETE OR UPDATE ON public."LotteryAccountFact" FOR EACH ROW EXECUTE FUNCTION public.lottery_history_immutable();

CREATE TRIGGER "LotteryStatus_capture" AFTER UPDATE ON public."LotteryAccountStatus" FOR EACH ROW EXECUTE FUNCTION public.lottery_capture_status();

CREATE TRIGGER "LotteryStatus_lock" BEFORE UPDATE ON public."LotteryAccountStatus" FOR EACH ROW EXECUTE FUNCTION public.lottery_lock_status_account();

CREATE TRIGGER "LotteryStatus_no_delete" BEFORE DELETE ON public."LotteryAccountStatus" FOR EACH ROW EXECUTE FUNCTION public.lottery_history_immutable();

CREATE TRIGGER "Lottery_immutable" BEFORE UPDATE ON public."Lottery" FOR EACH ROW EXECUTE FUNCTION public.lottery_immutable();

CREATE TRIGGER "MediaCosObject_immutable" BEFORE INSERT OR DELETE OR UPDATE ON public."MediaCosObject" FOR EACH ROW EXECUTE FUNCTION public."guardMediaCosObject"();

CREATE TRIGGER "MediaUploadReceipt_lottery_mount_fact" BEFORE INSERT OR DELETE OR UPDATE ON public."MediaUploadReceipt" FOR EACH ROW EXECUTE FUNCTION public.artzoo_preserve_lottery_mount_fact();

CREATE TRIGGER "OfficialEventAudit_append_only" BEFORE DELETE OR UPDATE ON public."OfficialEventAudit" FOR EACH ROW EXECUTE FUNCTION public.preserve_official_audit();

CREATE TRIGGER "OfficialEventCommand_append_only" BEFORE DELETE OR UPDATE ON public."OfficialEventCommand" FOR EACH ROW EXECUTE FUNCTION public.preserve_official_audit();

CREATE TRIGGER "OfficialEventImage_retained" BEFORE DELETE OR UPDATE ON public."OfficialEventImage" FOR EACH ROW EXECUTE FUNCTION public.preserve_official_event_image();

CREATE TRIGGER "OfficialEvent_original_immutable" BEFORE DELETE OR UPDATE ON public."OfficialEvent" FOR EACH ROW EXECUTE FUNCTION public.preserve_official_event_original();

CREATE TRIGGER "ResourceLink_icon_budget_invalidate" BEFORE INSERT OR UPDATE OF "iconBytes", "iconVersion" ON public."ResourceLink" FOR EACH ROW EXECUTE FUNCTION public.artzoo_clear_quick_icon_budget_binding();

CREATE TRIGGER activity_share_audit_append_only BEFORE DELETE OR UPDATE ON public."ActivityShareAudit" FOR EACH ROW EXECUTE FUNCTION public.activity_share_append_only();

CREATE TRIGGER activity_share_command_append_only BEFORE DELETE OR UPDATE ON public."ActivityShareCommand" FOR EACH ROW EXECUTE FUNCTION public.activity_share_append_only();

CREATE TRIGGER local_qc_record_append_only BEFORE DELETE OR UPDATE ON public."LocalQcRecord" FOR EACH ROW EXECUTE FUNCTION public.local_qc_ledger_append_only();

CREATE TRIGGER local_qc_run_append_only BEFORE DELETE OR UPDATE ON public."LocalQcRun" FOR EACH ROW EXECUTE FUNCTION public.local_qc_ledger_append_only();

-- ==================== 外键 ====================

ALTER TABLE ONLY public."AccountAudit"
    ADD CONSTRAINT "AccountAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AccountAudit"
    ADD CONSTRAINT "AccountAudit_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES public."Invitation"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AccountAudit"
    ADD CONSTRAINT "AccountAudit_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AccountLifecycleAudit"
    ADD CONSTRAINT "AccountLifecycleAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AccountLifecycleAudit"
    ADD CONSTRAINT "AccountLifecycleAudit_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AccountLifecycleCommand"
    ADD CONSTRAINT "AccountLifecycleCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AccountLifecycleCommand"
    ADD CONSTRAINT "AccountLifecycleCommand_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AccountSession"
    ADD CONSTRAINT "AccountSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityAttendanceAppeal"
    ADD CONSTRAINT "ActivityAttendanceAppeal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityAttendanceAppeal"
    ADD CONSTRAINT "ActivityAttendanceAppeal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityAttendanceAppeal"
    ADD CONSTRAINT "ActivityAttendanceAppeal_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES public."ActivityRegistration"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityCommand"
    ADD CONSTRAINT "ActivityCommand_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityCommand"
    ADD CONSTRAINT "ActivityCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityCompletion"
    ADD CONSTRAINT "ActivityCompletion_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityCompletion"
    ADD CONSTRAINT "ActivityCompletion_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityCompletion"
    ADD CONSTRAINT "ActivityCompletion_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES public."ActivityRegistration"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityMockDelivery"
    ADD CONSTRAINT "ActivityMockDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES public."ActivityOutbox"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityOutbox"
    ADD CONSTRAINT "ActivityOutbox_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityOutbox"
    ADD CONSTRAINT "ActivityOutbox_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityOutbox"
    ADD CONSTRAINT "ActivityOutbox_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES public."ActivityRegistration"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityPenaltyAppeal"
    ADD CONSTRAINT "ActivityPenaltyAppeal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityPenaltyAppeal"
    ADD CONSTRAINT "ActivityPenaltyAppeal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityPenaltyAppeal"
    ADD CONSTRAINT "ActivityPenaltyAppeal_penaltyId_fkey" FOREIGN KEY ("penaltyId") REFERENCES public."ActivityPenalty"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityPenalty"
    ADD CONSTRAINT "ActivityPenalty_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityPenalty"
    ADD CONSTRAINT "ActivityPenalty_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityPenalty"
    ADD CONSTRAINT "ActivityPenalty_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES public."ActivityRegistration"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityRegistration"
    ADD CONSTRAINT "ActivityRegistration_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityRegistration"
    ADD CONSTRAINT "ActivityRegistration_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityRegistration"
    ADD CONSTRAINT "ActivityRegistration_attendancePenaltyId_fkey" FOREIGN KEY ("attendancePenaltyId") REFERENCES public."ActivityPenalty"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityRegistration"
    ADD CONSTRAINT "ActivityRegistration_seatId_activityId_fkey" FOREIGN KEY ("seatId", "activityId") REFERENCES public."ActivitySeat"(id, "activityId") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityScoreChange"
    ADD CONSTRAINT "ActivityScoreChange_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityScoreChange"
    ADD CONSTRAINT "ActivityScoreChange_completionId_fkey" FOREIGN KEY ("completionId") REFERENCES public."ActivityCompletion"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityScoreChange"
    ADD CONSTRAINT "ActivityScoreChange_penaltyId_fkey" FOREIGN KEY ("penaltyId") REFERENCES public."ActivityPenalty"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivitySeat"
    ADD CONSTRAINT "ActivitySeat_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityShareAudit"
    ADD CONSTRAINT "ActivityShareAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityShareAudit"
    ADD CONSTRAINT "ActivityShareAudit_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES public."ActivityShare"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityShareCommand"
    ADD CONSTRAINT "ActivityShareCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityShareCommand"
    ADD CONSTRAINT "ActivityShareCommand_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES public."ActivityShare"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityShareMedia"
    ADD CONSTRAINT "ActivityShareMedia_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityShareMedia"
    ADD CONSTRAINT "ActivityShareMedia_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES public."ActivityShare"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityShare"
    ADD CONSTRAINT "ActivityShare_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."ActivityShare"
    ADD CONSTRAINT "ActivityShare_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."Activity"
    ADD CONSTRAINT "Activity_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."Activity"
    ADD CONSTRAINT "Activity_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES public."ActivitySeries"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AdminManagementAudit"
    ADD CONSTRAINT "AdminManagementAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AdminManagementAudit"
    ADD CONSTRAINT "AdminManagementAudit_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AdminManagementCommand"
    ADD CONSTRAINT "AdminManagementCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumAudit"
    ADD CONSTRAINT "AlbumAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumAudit"
    ADD CONSTRAINT "AlbumAudit_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public."Album"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumAudit"
    ADD CONSTRAINT "AlbumAudit_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES public."AlbumPhoto"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumCommand"
    ADD CONSTRAINT "AlbumCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumCommentMedia"
    ADD CONSTRAINT "AlbumCommentMedia_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public."Album"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumCommentMedia"
    ADD CONSTRAINT "AlbumCommentMedia_commentId_albumId_fkey" FOREIGN KEY ("commentId", "albumId") REFERENCES public."AlbumComment"(id, "albumId") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumCommentMedia"
    ADD CONSTRAINT "AlbumCommentMedia_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumComment"
    ADD CONSTRAINT "AlbumComment_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public."Album"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumComment"
    ADD CONSTRAINT "AlbumComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumComment"
    ADD CONSTRAINT "AlbumComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public."AlbumComment"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumComment"
    ADD CONSTRAINT "AlbumComment_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES public."AlbumPhoto"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumLike"
    ADD CONSTRAINT "AlbumLike_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumLike"
    ADD CONSTRAINT "AlbumLike_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES public."AlbumPhoto"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumNotification"
    ADD CONSTRAINT "AlbumNotification_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public."Album"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumNotification"
    ADD CONSTRAINT "AlbumNotification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."AlbumComment"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumNotification"
    ADD CONSTRAINT "AlbumNotification_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES public."AlbumPhoto"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumNotification"
    ADD CONSTRAINT "AlbumNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumPhoto"
    ADD CONSTRAINT "AlbumPhoto_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public."Album"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumPhoto"
    ADD CONSTRAINT "AlbumPhoto_periodActivityId_fkey" FOREIGN KEY ("periodActivityId") REFERENCES public."Activity"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumPhoto"
    ADD CONSTRAINT "AlbumPhoto_uploadAlbumId_fkey" FOREIGN KEY ("uploadAlbumId") REFERENCES public."Album"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."AlbumPhoto"
    ADD CONSTRAINT "AlbumPhoto_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."Album"
    ADD CONSTRAINT "Album_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."Album"
    ADD CONSTRAINT "Album_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES public."AlbumCategory"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."Album"
    ADD CONSTRAINT "Album_coverPhotoId_fkey" FOREIGN KEY ("coverPhotoId") REFERENCES public."AlbumPhoto"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."Album"
    ADD CONSTRAINT "Album_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."Album"
    ADD CONSTRAINT "Album_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES public."ActivitySeries"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."AvatarAsset"
    ADD CONSTRAINT "AvatarAsset_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."BotGroupCandidate"
    ADD CONSTRAINT "BotGroupCandidate_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES public."BotGroupChallenge"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."BotGroupChallenge"
    ADD CONSTRAINT "BotGroupChallenge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."BotGroup"
    ADD CONSTRAINT "BotGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."BotManagementAudit"
    ADD CONSTRAINT "BotManagementAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."BotManagementPublication"
    ADD CONSTRAINT "BotManagementPublication_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."BotManagementTest"
    ADD CONSTRAINT "BotManagementTest_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."BotManagementTest"
    ADD CONSTRAINT "BotManagementTest_version_fkey" FOREIGN KEY (version) REFERENCES public."BotManagementPublication"(version) ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyAudit"
    ADD CONSTRAINT "DailyAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyAudit"
    ADD CONSTRAINT "DailyAudit_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."DailyComment"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyAudit"
    ADD CONSTRAINT "DailyAudit_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."DailyPost"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyCheckin"
    ADD CONSTRAINT "DailyCheckin_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyCommand"
    ADD CONSTRAINT "DailyCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyComment"
    ADD CONSTRAINT "DailyComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyComment"
    ADD CONSTRAINT "DailyComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public."DailyComment"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyComment"
    ADD CONSTRAINT "DailyComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."DailyPost"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyLike"
    ADD CONSTRAINT "DailyLike_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyLike"
    ADD CONSTRAINT "DailyLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."DailyPost"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyMedia"
    ADD CONSTRAINT "DailyMedia_commentId_postId_fkey" FOREIGN KEY ("commentId", "postId") REFERENCES public."DailyComment"(id, "postId") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyMedia"
    ADD CONSTRAINT "DailyMedia_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyMedia"
    ADD CONSTRAINT "DailyMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."DailyPost"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyNotification"
    ADD CONSTRAINT "DailyNotification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."DailyComment"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyNotification"
    ADD CONSTRAINT "DailyNotification_postId_fkey" FOREIGN KEY ("postId") REFERENCES public."DailyPost"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyNotification"
    ADD CONSTRAINT "DailyNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."DailyPost"
    ADD CONSTRAINT "DailyPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."FixedTeam"
    ADD CONSTRAINT "FixedTeam_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."GuestContactMessage"
    ADD CONSTRAINT "GuestContactMessage_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeArticleInteraction"
    ADD CONSTRAINT "KnowledgeArticleInteraction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeArticleInteraction"
    ADD CONSTRAINT "KnowledgeArticleInteraction_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."KnowledgeArticle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeArticleRead"
    ADD CONSTRAINT "KnowledgeArticleRead_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."KnowledgeArticle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeArticle"
    ADD CONSTRAINT "KnowledgeArticle_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeArticle"
    ADD CONSTRAINT "KnowledgeArticle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES public."KnowledgeCategory"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeAudit"
    ADD CONSTRAINT "KnowledgeAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeAudit"
    ADD CONSTRAINT "KnowledgeAudit_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."KnowledgeArticle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeComment"
    ADD CONSTRAINT "KnowledgeComment_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."KnowledgeArticle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeComment"
    ADD CONSTRAINT "KnowledgeComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeComment"
    ADD CONSTRAINT "KnowledgeComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public."KnowledgeComment"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeContribution"
    ADD CONSTRAINT "KnowledgeContribution_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeContribution"
    ADD CONSTRAINT "KnowledgeContribution_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."KnowledgeArticle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeImage"
    ADD CONSTRAINT "KnowledgeImage_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."KnowledgeArticle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeImage"
    ADD CONSTRAINT "KnowledgeImage_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."KnowledgeComment"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeImage"
    ADD CONSTRAINT "KnowledgeImage_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeNotification"
    ADD CONSTRAINT "KnowledgeNotification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."KnowledgeComment"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeNotification"
    ADD CONSTRAINT "KnowledgeNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeVersion"
    ADD CONSTRAINT "KnowledgeVersion_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES public."KnowledgeArticle"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."KnowledgeVersion"
    ADD CONSTRAINT "KnowledgeVersion_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryAccountFact"
    ADD CONSTRAINT "LotteryAccountFact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryAccountFact"
    ADD CONSTRAINT "LotteryAccountFact_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryAccountStatus"
    ADD CONSTRAINT "LotteryAccountStatus_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryAccountStatus"
    ADD CONSTRAINT "LotteryAccountStatus_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryCommand"
    ADD CONSTRAINT "LotteryCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryCommand"
    ADD CONSTRAINT "LotteryCommand_lotteryId_fkey" FOREIGN KEY ("lotteryId") REFERENCES public."Lottery"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryEntry"
    ADD CONSTRAINT "LotteryEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryEntry"
    ADD CONSTRAINT "LotteryEntry_lotteryId_fkey" FOREIGN KEY ("lotteryId") REFERENCES public."Lottery"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryNotification"
    ADD CONSTRAINT "LotteryNotification_lotteryId_fkey" FOREIGN KEY ("lotteryId") REFERENCES public."Lottery"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."LotteryNotification"
    ADD CONSTRAINT "LotteryNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."Lottery"
    ADD CONSTRAINT "Lottery_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."MediaRetirementIntent"
    ADD CONSTRAINT "MediaRetirementIntent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES public."MediaStoredComponent"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."MediaStorageCredit"
    ADD CONSTRAINT "MediaStorageCredit_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES public."MediaStoredComponent"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."MediaStorageCredit"
    ADD CONSTRAINT "MediaStorageCredit_intentId_fkey" FOREIGN KEY ("intentId", "componentId") REFERENCES public."MediaRetirementIntent"(id, "componentId") ON DELETE RESTRICT;

ALTER TABLE ONLY public."MediaStoredComponent"
    ADD CONSTRAINT "MediaStoredComponent_baseline_fkey" FOREIGN KEY ("baselineStateId") REFERENCES public."MediaBudgetState"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."MediaStoredComponent"
    ADD CONSTRAINT "MediaStoredComponent_receipt_fkey" FOREIGN KEY ("receiptScope", "receiptOperationKey") REFERENCES public."MediaUploadReceipt"(scope, "operationKey") ON DELETE RESTRICT;

ALTER TABLE ONLY public."MemberProfile"
    ADD CONSTRAINT "MemberProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."MemberProfile"
    ADD CONSTRAINT "MemberProfile_avatarId_fkey" FOREIGN KEY ("avatarId") REFERENCES public."AvatarAsset"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."MessageNotification"
    ADD CONSTRAINT "MessageNotification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."MessageNotification"
    ADD CONSTRAINT "MessageNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."OfficialEventAudit"
    ADD CONSTRAINT "OfficialEventAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."OfficialEventAudit"
    ADD CONSTRAINT "OfficialEventAudit_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES public."OfficialEvent"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."OfficialEventCommand"
    ADD CONSTRAINT "OfficialEventCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."OfficialEventCommand"
    ADD CONSTRAINT "OfficialEventCommand_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES public."OfficialEvent"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."OfficialEventImage"
    ADD CONSTRAINT "OfficialEventImage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES public."OfficialEvent"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."OfficialEvent"
    ADD CONSTRAINT "OfficialEvent_imageId_id_fkey" FOREIGN KEY ("imageId", id) REFERENCES public."OfficialEventImage"(id, "eventId") ON DELETE RESTRICT;

ALTER TABLE ONLY public."OfficialSyncRun"
    ADD CONSTRAINT "OfficialSyncRun_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."QqOfficialBindingAudit"
    ADD CONSTRAINT "QqOfficialBindingAudit_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."QqOfficialBindingKey"
    ADD CONSTRAINT "QqOfficialBindingKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."QqOfficialBinding"
    ADD CONSTRAINT "QqOfficialBinding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."QqOfficialCandidate"
    ADD CONSTRAINT "QqOfficialCandidate_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES public."QqOfficialChallenge"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."QqOfficialChallenge"
    ADD CONSTRAINT "QqOfficialChallenge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."QqOfficialDelivery"
    ADD CONSTRAINT "QqOfficialDelivery_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."QuickLinkCommand"
    ADD CONSTRAINT "QuickLinkCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ResourceLink"
    ADD CONSTRAINT "ResourceLink_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES public."ResourceCategory"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."ResourceLink"
    ADD CONSTRAINT "ResourceLink_iconBudgetComponentId_fkey" FOREIGN KEY ("iconBudgetComponentId") REFERENCES public."MediaStoredComponent"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."SiteAnnouncementCommand"
    ADD CONSTRAINT "SiteAnnouncementCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."SiteAnnouncement"
    ADD CONSTRAINT "SiteAnnouncement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."SiteAnnouncement"
    ADD CONSTRAINT "SiteAnnouncement_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."SiteHelpStepProgress"
    ADD CONSTRAINT "SiteHelpStepProgress_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamApplication"
    ADD CONSTRAINT "TeamApplication_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamApplication"
    ADD CONSTRAINT "TeamApplication_seatId_teamId_fkey" FOREIGN KEY ("seatId", "teamId") REFERENCES public."TeamSeat"(id, "teamId") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamApplication"
    ADD CONSTRAINT "TeamApplication_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."FixedTeam"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamCommand"
    ADD CONSTRAINT "TeamCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamCommand"
    ADD CONSTRAINT "TeamCommand_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."FixedTeam"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamFeedback"
    ADD CONSTRAINT "TeamFeedback_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamFeedback"
    ADD CONSTRAINT "TeamFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public."TeamSession"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamMembership"
    ADD CONSTRAINT "TeamMembership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamMembership"
    ADD CONSTRAINT "TeamMembership_seatId_teamId_fkey" FOREIGN KEY ("seatId", "teamId") REFERENCES public."TeamSeat"(id, "teamId") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamMembership"
    ADD CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."FixedTeam"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamNotification"
    ADD CONSTRAINT "TeamNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamNotification"
    ADD CONSTRAINT "TeamNotification_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."FixedTeam"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamParticipationChange"
    ADD CONSTRAINT "TeamParticipationChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamParticipationChange"
    ADD CONSTRAINT "TeamParticipationChange_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES public."TeamSessionMember"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamParticipationChange"
    ADD CONSTRAINT "TeamParticipationChange_substituteId_fkey" FOREIGN KEY ("substituteId") REFERENCES public."TeamSessionSubstitute"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamParticipationChange"
    ADD CONSTRAINT "TeamParticipationChange_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."FixedTeam"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSeat"
    ADD CONSTRAINT "TeamSeat_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."FixedTeam"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSessionLeave"
    ADD CONSTRAINT "TeamSessionLeave_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES public."TeamSessionMember"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSessionLeave"
    ADD CONSTRAINT "TeamSessionLeave_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSessionMember"
    ADD CONSTRAINT "TeamSessionMember_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSessionMember"
    ADD CONSTRAINT "TeamSessionMember_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES public."TeamMembership"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSessionMember"
    ADD CONSTRAINT "TeamSessionMember_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public."TeamSession"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSessionSubstitute"
    ADD CONSTRAINT "TeamSessionSubstitute_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSessionSubstitute"
    ADD CONSTRAINT "TeamSessionSubstitute_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSessionSubstitute"
    ADD CONSTRAINT "TeamSessionSubstitute_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public."TeamSession"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."TeamSession"
    ADD CONSTRAINT "TeamSession_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES public."FixedTeam"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."VerificationCode"
    ADD CONSTRAINT "VerificationCode_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES public."Invitation"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishCommand"
    ADD CONSTRAINT "WishCommand_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishCommand"
    ADD CONSTRAINT "WishCommand_wishId_fkey" FOREIGN KEY ("wishId") REFERENCES public."Wish"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishComment"
    ADD CONSTRAINT "WishComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishComment"
    ADD CONSTRAINT "WishComment_wishId_fkey" FOREIGN KEY ("wishId") REFERENCES public."Wish"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishComment"
    ADD CONSTRAINT "WishComment_wishId_parentId_fkey" FOREIGN KEY ("wishId", "parentId") REFERENCES public."WishComment"("wishId", id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishConversion"
    ADD CONSTRAINT "WishConversion_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishConversion"
    ADD CONSTRAINT "WishConversion_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishConversion"
    ADD CONSTRAINT "WishConversion_wishId_fkey" FOREIGN KEY ("wishId") REFERENCES public."Wish"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishInterest"
    ADD CONSTRAINT "WishInterest_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishInterest"
    ADD CONSTRAINT "WishInterest_wishId_fkey" FOREIGN KEY ("wishId") REFERENCES public."Wish"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishMedia"
    ADD CONSTRAINT "WishMedia_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishMedia"
    ADD CONSTRAINT "WishMedia_wishId_commentId_fkey" FOREIGN KEY ("wishId", "commentId") REFERENCES public."WishComment"("wishId", id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishMedia"
    ADD CONSTRAINT "WishMedia_wishId_fkey" FOREIGN KEY ("wishId") REFERENCES public."Wish"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishNotification"
    ADD CONSTRAINT "WishNotification_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishNotification"
    ADD CONSTRAINT "WishNotification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES public."WishComment"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishNotification"
    ADD CONSTRAINT "WishNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."WishNotification"
    ADD CONSTRAINT "WishNotification_wishId_fkey" FOREIGN KEY ("wishId") REFERENCES public."Wish"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."Wish"
    ADD CONSTRAINT "Wish_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public."Activity"(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public."Wish"
    ADD CONSTRAINT "Wish_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."Account"(id) ON DELETE RESTRICT;

-- ==================== 初始数据 ====================

-- 知识库分区：只写入代码认可的 6 个（apps/web/components/knowledge/category-options.ts）。
-- 旧迁移还写入过"生活杂谈"和"建议和 BUG 反馈"两个旧名字，新站不再需要（站长 2026-11-11 决定去掉）。
INSERT INTO public."KnowledgeCategory" (id, label, active, revision)
SELECT gen_random_uuid()::text, label, true, 0
  FROM (VALUES ('日常杂谈'), ('同人创作'), ('剧情讨论'), ('游戏记录'), ('举手提问'), ('建议和BUG反馈')) AS sections(label);

-- 抽奖资格的启用时刻：取执行本迁移的时刻，之后不可修改（由触发器保护）。
INSERT INTO public."LotteryEligibilityControl" (id, "enabledAt") VALUES (1, public.lottery_eligibility_now());

-- 快捷链接的全局版本号。
INSERT INTO public."QuickLinkState" (id, revision) VALUES ('global', 0);

COMMIT;
