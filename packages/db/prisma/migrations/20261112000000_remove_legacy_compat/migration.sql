-- 阶段 4：删除只为兼容旧站数据而存在的数据库结构。
--
-- 新站从空数据库起步（docs/DECISIONS.md），下面这些结构在新站里永远是空的或永远取同一个值，
-- 对应的代码已在同一个提交里删除。每一段说明删的是什么、原来做什么用。
-- 跑完后运行 pnpm db:snapshot 应与 packages/db/prisma/schema-snapshot.txt 一致。

BEGIN;

-- 1. 本地 QC 工具（server/local-qc/ 已删除）：QC 账号标记和两张 QC 台账表。
DROP TABLE "LocalQcRecord";
DROP TABLE "LocalQcRun";
DROP FUNCTION local_qc_ledger_append_only();
DROP INDEX "Account_localQcNamespace_localQcSlot_key";
ALTER TABLE "Account" DROP CONSTRAINT "Account_local_qc_marker_check";
ALTER TABLE "Account" DROP COLUMN "localQcNamespace", DROP COLUMN "localQcSlot";

-- 2. 邀请：新站的每个邀请创建时都加密保存了链接，"没有密文的旧邀请"不再存在。
ALTER TABLE "Invitation" ALTER COLUMN "tokenCiphertext" SET NOT NULL;

-- 3. QQ 绑定旧协议：绑定只剩一次性密钥这一种方式，不再需要协议版本和旧的公开码挑战表。
ALTER TABLE "QqOfficialBinding" DROP COLUMN "protocolVersion";
DROP TABLE "QqOfficialCandidate";
DROP TABLE "QqOfficialChallenge";

-- 4. 心愿：旧的第二段正文已合并进 body；分类在新站发布时必填。
ALTER TABLE "Wish" DROP CONSTRAINT "Wish_wantedContent_check";
ALTER TABLE "Wish" DROP COLUMN "wantedContent";
ALTER TABLE "Wish" DROP CONSTRAINT "Wish_category_check";
ALTER TABLE "Wish" ALTER COLUMN "category" SET NOT NULL;
ALTER TABLE "Wish" ADD CONSTRAINT "Wish_category_check"
  CHECK (category IN ('MOUNT', 'CHALLENGE', 'CRAFT_GATHER', 'EXPLORE', 'ACHIEVEMENT', 'OTHER'));

-- 5. 活动"功能上线时刻"：只用来区分功能上线前的旧活动和旧处罚。
--    自动缺席扫描原来用的部分索引带着 "autoAbsenceEnabledAt" 条件，换成不带它的同一个索引。
DROP INDEX "Activity_autoAbsenceEnabledAt_endsAt_id_idx";
--    线下活动形状检查里有一条 "completionEnabledAt" IS NULL，删列会连带删掉整条检查，所以先删再按原样（去掉这一条）重建。
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_offline_shape_check";
CREATE INDEX "Activity_game_single_open_endsAt_id_idx" ON "Activity" ("endsAt", id)
  WHERE scene = 'GAME' AND mode = 'SINGLE' AND "cancelledAt" IS NULL;
ALTER TABLE "Activity"
  DROP COLUMN "managementEnabledAt",
  DROP COLUMN "attendanceEnabledAt",
  DROP COLUMN "autoAbsenceEnabledAt",
  DROP COLUMN "completionEnabledAt";
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_offline_shape_check" CHECK (
  scene <> 'OFFLINE'
  OR (
    mode = 'SINGLE' AND category = 'SOCIAL' AND location IS NOT NULL
    AND "registrationClosesAt" IS NOT NULL AND "registrationClosesAt" <= "startsAt"
    AND "dutyId" IS NULL AND "dutySnapshot" IS NULL
  )
);
ALTER TABLE "ActivityPenalty" DROP COLUMN "appealEnabledAt";

-- 6. 长期活动的两种处罚（站长 2026-11-11 决定放弃，PLAN 待定 #3）：从未产生过，从允许的处罚原因里去掉。
ALTER TABLE "ActivityPenalty" DROP CONSTRAINT "ActivityPenalty_points_check";
ALTER TABLE "ActivityPenalty" ADD CONSTRAINT "ActivityPenalty_points_check"
  CHECK ((reason = 'LATE_WITHDRAWAL' AND points = 1) OR (reason IN ('LATE_CANCELLATION', 'NO_SHOW') AND points = 2));

-- 7. 公开活动分享（站长 2026-11-11 决定删除，PLAN 待定 #1）：整个功能的四张表和它们的只追加保护函数。
--    图片存储范围里的 activity-share / activity-shares 名称和 COS 一起在下一次清理中处理。
DROP TABLE "ActivityShareCommand";
DROP TABLE "ActivityShareAudit";
DROP TABLE "ActivityShareMedia";
DROP TABLE "ActivityShare";
DROP FUNCTION activity_share_append_only();

-- 8. 公开 QQ 设置（站长 2026-11-11 决定清理，PLAN 待定 #6）：设置表和管理记录里的 QQ 字段。
--    管理记录只剩"管理员资格变更"一种。删 QQ 两列会连带删掉引用它们的检查，所以先删检查再重建。
DROP TABLE "PublicSiteSettings";
ALTER TABLE "AdminManagementAudit" DROP CONSTRAINT "AdminManagementAudit_kind_check";
ALTER TABLE "AdminManagementAudit" DROP COLUMN "beforeQq", DROP COLUMN "afterQq";
ALTER TABLE "AdminManagementAudit" ADD CONSTRAINT "AdminManagementAudit_kind_check" CHECK (
  kind = 'ADMIN_ROLE_CHANGED'
  AND "targetAccountId" IS NOT NULL AND "beforeRole" IS NOT NULL AND "afterRole" IS NOT NULL
  AND "beforeRole" <> "afterRole"
  AND "beforeRole" IN ('NONE', 'ADMIN') AND "afterRole" IN ('NONE', 'ADMIN')
);
ALTER TABLE "AdminManagementCommand" DROP CONSTRAINT "AdminManagementCommand_kind_check";
ALTER TABLE "AdminManagementCommand" ADD CONSTRAINT "AdminManagementCommand_kind_check"
  CHECK (kind = 'ADMIN_ROLE_CHANGED');

COMMIT;
