# ArtZoo 架构

本文介绍代码怎么分层、一个请求怎么流转、关键数据规则落在哪里、后台任务做什么，以及有哪些配置开关。所有内容都对照代码版本 `fa643541` 核对过。

业务规则（例如退出扣几分）不在本文范围内，请看 `rules/`。

---

## 一、模块

| 位置 | 职责 | 依赖 |
|---|---|---|
| `apps/web` | Next.js 页面、全部 API 接口、服务端业务逻辑与鉴权 | domain、db、media |
| `apps/worker` | 独立的后台进程，每 30 秒运行一轮维护任务 | domain、db、media |
| `packages/domain` | 前后端共用的类型、校验、错误码、北京时间等规则 | 无 |
| `packages/db` | Prisma 数据库结构与迁移、数据库连接、各类维护任务、抽奖资格、QQ 投递队列 | domain |
| `packages/media` | 图片解码、去除元数据、本地存储、孤儿图片清理 | domain、db |
| `plugins/astrbot_plugin_artzoo` | QQ 机器人插件（Python），通过带签名的接口和网站通信 | 独立运行 |

### `apps/web` 内部的分层

- `app/api/**/route.ts`：只负责把请求转给对应模块，不写业务逻辑。
- `server/<模块>/http.ts`：校验请求来源、读取请求体、检查登录、限流、把错误转成 HTTP 响应。
- `server/<模块>/service.ts`：业务规则、权限与归属判断、数据库事务。

这是各模块约定俗成的写法，并不是框架强制的结构。新增功能时，参照同一个模块里已有的代码来写。

### 页面路由分组

括号目录不会出现在网址里。

| 位置 | 作用 |
|---|---|
| `app/layout.tsx` | 根布局：AntD 样式注册、全站 Provider；默认不允许搜索引擎收录 |
| `app/(site)/layout.tsx` | 站点外框：背景、公告栏、"跳到正文"链接 |
| `app/(site)/(public)/` | 不需要登录的页面：首页、资源、精选、登录、邀请注册 |
| `app/(site)/(protected)/` | 需要登录的页面：活动、相册、日常、知识库、抽奖、心愿、成员、固定队、个人中心、后台 |
| `app/help-demo` | 使用引导的演示页，不在上面任何分组里 |

`(protected)` 分组的布局只负责读取会话、把会话传给前端，**它本身不会拦截未登录的访问**。真正的拦截靠每个页面自己调用 `server/auth/page-guards.ts` 里的守卫函数：

- `requirePageAccount`：要求已登录。
- `requirePageAdministrator`：要求是管理员。
- `requirePageSuperAdministrator`：要求是超级管理员。

目前这一组下的 50 个页面都调用了守卫。

---

## 二、请求怎么流转

```mermaid
flowchart LR
  B[浏览器] --> C[反向代理 Caddy]
  C --> R[route.ts]
  R --> H[模块 http.ts<br/>来源校验 / 登录 / 限流]
  H --> S[模块 service.ts<br/>权限 / 业务规则 / 事务]
  S --> D[packages/domain]
  S --> P[packages/db] --> G[(PostgreSQL)]
  S --> M[packages/media] --> F[(本地磁盘)]
  W[worker] --> P
  W --> M
  Q[QQ 插件] -->|签名请求| H
```

以写操作（POST/PUT/PATCH/DELETE）为例，`http.ts` 会按顺序做以下几件事：

1. **来源校验**：调用 `validateOrigin`（在 `server/auth/http.ts`），以下条件必须全部满足：
   - `Origin` 等于站点配置的地址；
   - 请求头带有 `x-artzoo-request: 1`；
   - `Sec-Fetch-Site` 不是 `cross-site`；
   - `Content-Type` 是 `application/json`。

   上传接口使用各模块自己的同类校验函数。
2. **读取请求体**：每个模块都有大小上限，比如账号模块是 8 KB。
3. **读取会话**：从 Cookie 中取出 token，到数据库查会话，并检查账号是否已被停用。
4. **限流**：来源 IP 由 `resolveRequestSource` 确定。
5. **调用 service**：在 service 里判断权限和归属，然后执行事务。

`/api/health` 是唯一不经过上述流程的接口。

### 登录、会话与权限

- **两套身份互相独立**：参与身份 `membership` 分为正式成员（MEMBER）和朋友（FRIEND）；管理角色 `adminRole` 分为 NONE、ADMIN、SUPER_ADMIN。不能从参与身份推出管理权限。
- **密码**：用 scrypt 哈希保存，比对时用 `timingSafeEqual`。如果手机号不存在，也会拿一个假哈希完整比对一遍，让响应时间和存在时一样。
- **会话**：token 随机生成，数据库里只存它的哈希，有效期 30 天。改密码或重置密码后，该账号的所有会话都会作废。
- **Cookie**：始终带 `HttpOnly` 和 `SameSite=Lax`。
  - 生产环境要求站点地址是 https，Cookie 名为 `__Host-artzoo-session`，并带 `Secure`。
  - 本地开发时只允许 localhost 访问，Cookie 名为 `artzoo-session`。
  - `ARTZOO_DEPLOYMENT_ENV` 只能是 `production` 或 `local`，填其他值时服务直接返回 503。
- **邀请链接**：数据库保存 token 的摘要。如果配置了 `ARTZOO_INVITATION_KEY`，还会额外保存一份 AES-256-GCM 加密的密文，这样管理员之后还能再次查看这条链接。
- **短信**：`ARTZOO_SMS_PROVIDER` 默认是 `unconfigured`，这时发短信的接口返回 503。目前只支持阿里云号码认证服务（`aliyun-pnvs`）。
- **页面守卫与接口鉴权要分开看**：前端把按钮隐藏，不等于有了权限控制。每个接口都必须在服务端自己检查。

### 限流

限流记录保存在数据库表 `AccountRateEvent` 里，按 15 分钟一个窗口计数：

| 桶 | 上限 |
|---|---|
| 同一来源的写操作 | 300 次 |
| 同一账号的写操作 | 60 次 |
| 全站写操作 | 10000 次 |
| 同一手机号 + 同一来源的登录 | 10 次 |
| 同一手机号的登录 | 50 次 |

"来源"由 `server/auth/request-source.ts` 决定：

- 只有在 `ARTZOO_TRUSTED_PROXY=caddy` 时，才读取 `X-Forwarded-For` 的**最后一段**作为来源。IPv4 按单个地址计算，IPv6 按 /64 网段计算。
- 其他情况下，所有人都算作同一个来源 `untrusted-source`，**全站共用一个桶**。

所以，生产环境如果放在 Caddy 后面，必须设置 `ARTZOO_TRUSTED_PROXY=caddy`；新部署方式也要确保代理会覆盖 `X-Forwarded-For`。如果新部署不使用 Caddy，需要修改这个文件。

### 安全响应头

定义在 `apps/web/security-headers.ts`，对所有页面生效：

- `default-src 'self'`
- `script-src 'self' 'unsafe-inline'`（没有使用 nonce）
- `img-src 'self' data: blob:`
- `frame-ancestors 'self'`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`

### 错误与日志

- **业务错误**：抛出 `AccountError`，带错误码、中文提示和 HTTP 状态码。
- **意料之外的错误**：由 `server/http-error-log.ts` 的 `logUnexpectedHttpError` 输出一行 JSON 日志，只记录路由名、错误名和错误码。不记录 message、stack、请求体、手机号或 token。
- **Next 自身的请求错误**：通过 `instrumentation.ts` 也走同一个函数。

---

## 三、数据库

### 连接

- 数据库客户端只能通过 `getDatabase()`（在 `packages/db/src/index.ts`）获取，它在进程内只创建一次。
- 连接池参数在 `packages/db/src/pool-health.ts`：

| 参数 | 值 |
|---|---|
| 连接数上限 | `PG_POOL_MAX`，默认 web 10、worker 3 |
| 获取连接超时 | 3 秒 |
| 单条语句超时 | 15 秒 |
| 等锁超时 | 10 秒 |
| 事务空闲超时 | 30 秒 |
| `application_name` | `artzoo-web` / `artzoo-worker` |
| 会话时区 | 强制 UTC |

- `/api/health` 复用同一个连接池做 3 秒探测，只返回 `{ ok: true/false }`。

### 事务与锁

- **写事务**：统一使用 `ReadCommitted` 隔离级别，`maxWait` 5 秒，`timeout` 15 秒。**只读的列表和快照**多数使用 `RepeatableRead`。
- **锁**：同一对象的并发修改，用 `lock(tx, '类型:id')` 串行处理，底层是 PostgreSQL 的 `pg_advisory_xact_lock`；只读路径用 `lockShared`。这两个函数定义在 `apps/web/server/auth/service.ts`。`packages/db` 里的维护任务各自有一份私有的同名函数，使用同一个哈希命名空间。
- **重试**：`packages/db/src/transaction-retry.ts` 遇到死锁或序列化冲突时会自动重试，但调用方必须显式声明"这个事务可以安全地重放"。目前只有限流使用了它。
- 设计取舍见 [ADR-0001](adr/0001-postgresql-coordination.md)。

### 只写在迁移 SQL 里的规则

有些规则 `schema.prisma` 表达不了，只能写在迁移的 SQL 里。改动下表中的任何一项，都要先找到对应的 SQL 看清楚：

| 规则 | 实现 |
|---|---|
| 每人在同一个活动里，最多只有一条有效报名 | 部分唯一索引 `ActivityRegistration_active_account_key`（`WHERE status='ACTIVE'`）。固定队有同类的 `TeamMembership_active_account_key` |
| 报名的席位必须属于这个活动或这支队伍 | 复合外键 `ActivityRegistration_seatId_activityId_fkey`、`TeamMembership_seatId_teamId_fkey`、`TeamApplication_seatId_teamId_fkey` |
| 积分每次变动都留流水，不重复计分 | 表 `ActivityScoreChange`：`eventKey` 唯一，处罚和完成记录各自唯一，并记录变动前后的值。`packages/db/src/activity-standing.ts` 先锁住账号行，再更新积分 |
| 已发布的抽奖参数和开奖结果不能改 | 触发器 `Lottery_immutable`，加上"已开奖时必须有结果"的 CHECK 约束。函数定义在初始迁移 `20261111000000_init` 里，其中包含"违规删除"这一种允许的变更 |
| 抽奖资格依据开奖那一刻的历史记录 | 表 `LotteryAccountFact` 等，配有一组禁止修改、禁止删除的触发器。详见 [ADR-0002](adr/0002-immutable-lottery-results.md) |

### 规模与约定

- 127 个 model、16 个 enum。旧站的 68 个迁移已在阶段 3 合并为一个初始迁移 `20261111000000_init`；完整结构（含上表这些规则）另记在 `packages/db/prisma/schema-snapshot.txt`，数据库测试会检查两者一致。
- 所有时间字段都是 `timestamptz`。
- 外键默认是 `Restrict`，删除业务数据时，多数情况用"删除标记"代替真正的物理删除。

---

## 四、后台任务（worker）

入口是 `apps/worker/src/index.ts`，每 30 秒运行一轮。每一步单独执行：某一步失败会被记录到 `failedSteps`，下一步照常执行。

| 步骤 | 做什么 | 开关 |
|---|---|---|
| activity | 处罚点数自然减免；缺人的活动到点自动取消；长期活动的首期成团或取消；自动记未到场；活动正常完成后减分 | 始终运行 |
| lottery | 把符合资格的人自动纳入抽奖；到时间开奖；补发没有发出去的结果通知 | 始终运行 |
| officialEvents | 采集官方活动，放进待审核列表 | `ARTZOO_OFFICIAL_SYNC_ENABLED=1`，默认关；采集间隔固定 24 小时 |
| mediaReservations | 清理已经过期的图片上传预留 | `ARTZOO_MEDIA_BUDGET_ENABLED=1`，默认关 |
| mediaOrphans | 删除没有挂到任何内容上的图片 | 预算开关和 `ARTZOO_MEDIA_CLEANUP_EXECUTE=1` 都打开才运行，默认关 |
| cleanup | 每天一次：删除 1 天前的限流记录，以及过期或作废超过 7 天的会话和验证码 | `ARTZOO_SECURITY_CLEANUP_ENABLED=1`，默认关 |

- **停止**：收到 SIGINT 或 SIGTERM 后，worker 会先等当前这一轮跑完，再断开数据库连接，然后退出。
- **运行参数**：`--once` 只运行一轮；`--require-db` 表示没有配置数据库时直接报错退出。
- **QQ 消息不由 worker 发送**：由 QQ 插件主动来网站领取，见第六节。

---

## 五、图片与文件

- **存储位置**：只用服务器本地磁盘，见 `DECISIONS.md` 第 2 条。
  - 生产环境默认写到 `/app/storage/original/<类别>`（原图）和 `/app/storage/derived/<类别>`（缩略图、预览图）。每个类别都可以用 `ARTZOO_<类别>_ORIGINAL_DIR` / `_DERIVED_DIR` 单独指定。
  - 头像目录用 `ARTZOO_AVATAR_DIR` 指定，必须是绝对路径。**生产环境一定要设置它**，否则会退回到仓库下的 `.local/avatars`。
- **COS 代码**：代码里还保留着腾讯云 COS 的实现，只有设置 `ARTZOO_MEDIA_STORAGE=cos` 才会启用，默认是 `local`。这部分会在第 4 阶段删除，在那之前不要扩展它。
- **上传并发**：`withUploadSlot` 控制同时上传的请求数，用 `ARTZOO_UPLOAD_CONCURRENCY` 设置，范围 1–8，默认 2，超过时返回 503。`withPhotoSlot` 控制同时进行的图片解码，固定为 2。
- **校验与处理**：
  - 按文件头判断格式，不接受 SVG。
  - sharp 处理时设置了像素上限和超时。
  - 单张照片最大 30 MB，头像最大 10 MB。
- **去除元数据**：原图保存前，用 `packages/media/src/metadata-strip.ts` 去掉 EXIF、GPS 等信息，只保留图片方向。
- **读取**：每次读取图片都要先经过业务权限检查。私有图片的响应头是 `Cache-Control: no-store`。
- **上传配额**：开启 `ARTZOO_MEDIA_BUDGET_ENABLED` 后才生效，默认全站总量 10 GB，每天 2 GB（按北京时间计算日期）。

---

## 六、QQ 机器人

- **网站这一侧**（`server/qq-official`、`server/bot-management`、`packages/db/src/qq-official-notifications.ts`）负责：账号绑定、在群里报名时的事务处理、通知排队、签名校验。
- **插件这一侧**（`plugins/astrbot_plugin_artzoo`）定时向网站领取待发送的消息，调用 QQ 发送，然后把结果回报给网站。
- **防止重复发送**：
  - 领取消息时有 30 秒租约和版本号（fence）。
  - 插件在本地 SQLite 账本里记录每一次发送。
  - 如果发送结果不确定，标记为 UNKNOWN，**不会自动重发**。

  详见 [ADR-0003](adr/0003-qq-uncertain-delivery.md)。
- **通信安全**：所有请求都使用 HMAC-SHA256 签名，并带时间窗口和 nonce 去重。密钥是 `ARTZOO_QQ_BRIDGE_SECRET`。
- **默认关闭**：`ARTZOO_QQ_MODE` 默认未设置。真实发送需要同时满足多项配置，见第八节。

---

## 七、公开页面与搜索引擎

- **robots**（`app/robots.ts`）：只允许搜索引擎收录首页和资源页，以及它们需要用到的静态资源，其他页面一律禁止收录。注意 robots 只是告诉搜索引擎别收录，并不是访问控制。
- **分享卡片（OG）信息**：`server/public-metadata` 只为游客本来就能看到的精选照片生成。它以游客身份读取数据，不带任何会话；读取失败时，返回不允许收录的通用信息。站点地址只读 `ARTZOO_PUBLIC_ORIGIN`。

---

## 八、配置开关一览

| 变量 | 默认 | 说明 |
|---|---|---|
| `ARTZOO_DEPLOYMENT_ENV` | 无 | 只能是 `production` 或 `local` |
| `ARTZOO_PUBLIC_ORIGIN` | 无 | 站点地址，生产环境必须是 https |
| `ARTZOO_TRUSTED_PROXY` | 空 | 生产环境放在 Caddy 后面时，设为 `caddy` |
| `ARTZOO_INVITATION_KEY` | 无 | 不设置就无法生成邀请链接 |
| `ARTZOO_SMS_PROVIDER` | `unconfigured` | 设为 `aliyun-pnvs` 才能发送短信 |
| `ARTZOO_AVATAR_DIR` | 仓库下的 `.local/avatars` | 生产环境必须设置为绝对路径 |
| `ARTZOO_UPLOAD_CONCURRENCY` | 2 | 同时上传的请求数，范围 1–8 |
| `ARTZOO_MEDIA_STORAGE` | `local` | 新站保持 `local` |
| `ARTZOO_MEDIA_BUDGET_ENABLED` | 关 | 上传配额 |
| `ARTZOO_MEDIA_CLEANUP_EXECUTE` | 关 | 真正删除孤儿图片 |
| `ARTZOO_SECURITY_CLEANUP_ENABLED` | 关 | 每天清理过期的认证记录 |
| `ARTZOO_OFFICIAL_SYNC_ENABLED` | 关 | 自动采集官方活动 |
| `ARTZOO_QQ_MODE` | 未设置，即关闭 | `simulation`（只能在本地使用）或 `live`。`live` 模式还需要真实发送开关、测试群确认、APP_ID / BOT_ID / 群 openid、启用时间等多项配置，详见 `packages/db/src/qq-official-config.ts` |
| `ARTZOO_QQ_BRIDGE_SECRET` | 无 | 网站和插件之间通信用的签名密钥 |
| `PG_POOL_MAX` | web 10 / worker 3 | 数据库连接数上限 |

第 5 阶段写部署配置时，会按本表逐项确定新站的取值。

---

## 九、即将变化的部分

阶段 3（合并迁移）、阶段 4（删除兼容代码和 COS）、阶段 5（新部署）完成后，本文相应章节会同步更新。各阶段的具体备忘见 [PLAN.md](PLAN.md) 第三节。
