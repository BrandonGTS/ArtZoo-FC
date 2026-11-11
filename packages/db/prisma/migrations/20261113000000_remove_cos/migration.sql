-- 阶段 4：删除 COS（腾讯云对象存储）。新站的媒体文件只存放在服务器本地磁盘（docs/DECISIONS.md 第 2 条）。
-- 跑完后运行 pnpm db:snapshot 应与 packages/db/prisma/schema-snapshot.txt 一致。

BEGIN;

-- 1. COS 位置记录表和它的不可修改保护函数。新站从未写入过这张表。
DROP TABLE "MediaCosObject";
DROP FUNCTION "guardMediaCosObject"();

-- 2. 上传回执的存储范围里去掉已删除功能"公开活动分享"的名称（该功能在上一个迁移里已删除）。
ALTER TABLE "MediaUploadReceipt" DROP CONSTRAINT "MediaUploadReceipt_reservation_protocol_shape";
ALTER TABLE "MediaUploadReceipt" ADD CONSTRAINT "MediaUploadReceipt_reservation_protocol_shape" CHECK (
  "reservationProtocol" IS NULL
  OR (
    "reservationProtocol" = 'prewrite-expiry-v1'
    AND scope IN ('avatar', 'album-photo', 'album-comment', 'knowledge', 'daily', 'wish', 'lottery-image', 'official-image')
    AND "attemptId" IS NOT NULL
    AND "objectIdentity" IS NOT NULL
  )
);

COMMIT;
