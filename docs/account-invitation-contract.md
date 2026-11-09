# 第二段账号与邀请共享契约（v1.3）

2026-10-13 最终状态：本契约实现及当天追加改进已获用户人工验收通过（`Sentinel_ba06f3381e848191b0f0d2fa83138bac`），真实短信注册与找回已验证。以下早期实施约束和作者分工保留为契约历史；当前验收及下一阶段以[进度记录](account-invitation-progress.md)为准，第三段仍未启动。本次状态更新不扩张已确认的功能契约。

2026-10-13。依据 Page `page_5d5ef4ec2a7481918cc9f3bbf836a3d3` 当前352，及用户后续确认 `Sentinel_6544c76d3ce4819183bf8e31063016f8`：正式成员、朋友、管理员（含超级管理员）均为登录起30天，到期重新登录。该后续确认覆盖Page中管理员期限尚未确定的旧句。本文是两路作者与整合者的实施接口；变更需先通知整合者，不能各自发明字段。

## 归属与范围

- 服务端作者：`packages/domain/src`、`packages/db`（**不含依赖 manifests**）、`apps/web/server/auth`、下述账号/邀请API、后端测试。共享类型由该作者实际写入 `packages/domain/src/account-contract.ts` 并从 index.ts 导出。数据库schema、迁移由此作者单一写入。
- UI作者：新增 `apps/web/components/account`、`components/invitation`、`app/login/page.tsx`、`app/invite/[token]/page.tsx`、`app/admin/invitations/page.tsx`、`app/admin/accounts/page.tsx`。页面可各配专属CSS module，不写公共CSS。
- 整合者：`site-header.tsx`、`providers.tsx`、`layout.tsx`、`page.tsx`、`globals.css`、公共后台入口 `app/admin/page.tsx`、新增 `components/site-shell.tsx`、`components/auth-session.tsx`、所有package.json/pnpm-lock及依赖安装、跨模块整合/本地服务。
- 不做第三段的成员资料、头像上传、名册、个人主页。无账号停用/恢复操作：其执行职责未定且连带业务尚未实现。不实现管理员授予/撤销管理UI，但服务端身份结构与权限守卫区分超级管理员，绝不通过公开注册授予管理职责。

## 共享类型与响应

所有JSON时间为UTC ISO8601字符串。ID为不透明string。手机号始终string，密码/验证码不得写浏览器持久存储、日志或响应。身份和管理职责严格分离：

```ts
export type Membership = 'MEMBER' | 'FRIEND';
export type AdminRole = 'NONE' | 'ADMIN' | 'SUPER_ADMIN';
export interface AccountSummary {
  id: string;
  phoneMasked: string;
  displayName: string | null; // 游戏昵称；新注册必填，同服务器精确唯一
  gameRegion: string | null; // 新注册必填，旧账号保留 null
  gameServer: string | null;
  membership: Membership;
  adminRole: AdminRole;
}
export interface SessionSnapshot {
  user: AccountSummary | null;
  expiresAt: string | null;
  capabilities: { manageInvitations: boolean; manageMembership: boolean };
}
export interface ApiError {
  code: string;
  message: string;
  fieldErrors?: Record<string, string>;
  retryAfterSeconds?: number;
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
export type InvitationStatus = 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';
export interface InvitationSummary {
  id: string;
  membership: Membership;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  linkAvailable: boolean; // 仅表示有密文/密钥配置且邀请有效；不含 token
  createdBy: { id: string; displayName: string | null };
}
export interface PageResult<T> { items: T[]; nextCursor: string | null; }
export interface AuthConfig {
  password: { minLength: 6; maxLength: 30 };
  verification: { length: 6; expiresInSeconds: 300; resendAfterSeconds: 60 };
  sessionDays: 30;
  phone: { ready: boolean; defaultRegion: string | null; hint: string };
  sms: { mode: 'unconfigured' | 'mock' | 'aliyun'; available: boolean };
}
```

HTTP：成功200（创建201）；输入400；未认证401；无权403；资源不存在404；冲突409；无效/已失效邀请410；限流429（同时Retry-After）；未配置/服务不可用503。业务错误必须明确中文原因及字段错误；登录账号不存在/密码不匹配统一 `INVALID_CREDENTIALS`。敏感接口 `Cache-Control: no-store`。不向客户端返回堆栈、密码hash、验证码、会话token、手机号明文名单。

错误code至少：`GAME_NICKNAME_TAKEN`、`VALIDATION_ERROR`、`INVALID_CREDENTIALS`、`UNAUTHENTICATED`、`FORBIDDEN`、`INVITATION_INVALID`、`INVITATION_USED`、`INVITATION_REVOKED`、`INVITATION_EXPIRED`、`PHONE_ALREADY_REGISTERED`、`CODE_INVALID`、`CODE_EXPIRED`、`CODE_EXHAUSTED`、`RATE_LIMITED`、`SMS_UNAVAILABLE`、`PHONE_REGION_UNCONFIRMED`、`CONFLICT`、`SERVICE_UNAVAILABLE`。UI未知code仍显示message；失败不假报成功，不额外添加“重试”按钮。

## HTTP接口（相对同源）

| Method + path | 请求 | 成功data |
|---|---|---|
| GET /api/auth/config | 无 | AuthConfig |
| GET /api/auth/session | 无 | SessionSnapshot；无会话/过期返回user:null、expiresAt:null、两项capability:false，不是401 |
| POST /api/auth/login | { phone, password } | SessionSnapshot，服务端设置cookie |
| POST /api/auth/logout | {} | { loggedOut:true }；撤销当前会话并清cookie，无会话时幂等成功 |
| POST /api/auth/verification-codes | { purpose:'REGISTER'\|'RESET_PASSWORD', phone, invitationToken?:string } | { expiresAt, resendAvailableAt }；REGISTER必须给有效邀请 |
| POST /api/auth/register | { invitationToken, displayName, gameRegion, gameServer, phone, code, password, confirmPassword } | { registered:true, requiresLogin:true }；201，完成后返回登录，不自动建立会话 |
| POST /api/auth/reset-password | { phone, code, password, confirmPassword } | { reset:true, requiresLogin:true }；撤销该账号全部会话，清当前cookie |
| POST /api/auth/change-password | { currentPassword, password, confirmPassword } | { changed:true, requiresLogin:true }；需登录，撤销全部会话；本段实现服务端规则/测试，独立账号安全入口未定，不新增UI入口 |
| GET /api/invitations/[token] | URL一次性邀请token | { membership, expiresAt }；只暴露注册必需信息，失效返回相应410 |
| GET /api/admin/invitations?cursor=&limit=20 | 管理员，limit最大100 | PageResult<InvitationSummary>，按createdAt/id倒序 |
| POST /api/admin/invitations | { membership, expiresAt } | { invitation:InvitationSummary, invitePath:string }；201，invitePath如 /invite/opaque-token，只在创建时返回完整链接 |
| POST /api/admin/invitations/[id]/revoke | { reason:string } | { invitation:InvitationSummary }；需管理权限，已撤销幂等返回，已使用/过期不能伪装撤销成功 |
| GET /api/admin/accounts?cursor=&limit=20&query= | 管理员，query可为空 | PageResult<AccountSummary>；本段最小身份维护列表，不是成员名册；不暴露手机号明文 |
| PATCH /api/admin/accounts/[id]/membership | { membership, reason, expectedMembership } | { account:AccountSummary }；原身份不匹配返回409；不得改管理职责 |
| GET /api/admin/audit?cursor=&limit=20 | 管理员 | PageResult<{id, action, actor:AccountSummary, targetAccountId:string\|null, invitationId:string\|null, beforeMembership:Membership\|null, afterMembership:Membership\|null, reason:string\|null, createdAt:string}> |

GET list参数cursor缺省或空表示首页；limit不是业务账号数量上限。日期只要求未来有效UTC时间，不从Figma样例推导天数上限。reason应去首尾空白且非空，长度上限1000作为输入保护。普通ADMIN不得调整本人或超级管理员的MEMBER/FRIEND身份；服务端在锁定账号及会话后，按当前身份重新判权（REV1104-SEC-07 用户已确认），前端同步禁用对应操作。SUPER_ADMIN既有参与身份调整范围保持。管理身份调整写入actor、before/after、时间与原因的审计；邀请创建/撤销也留可追溯记录。审计仅管理区可访问。

## 认证、会话与安全边界

- 所有身份含管理职责均使用**绝对30天**，从本次登录起算，不滑动续期。多设备可并存；退出仅当前；改密/找回原子撤销所有设备。
- 数据库持久会话；随机高熵token仅cookie传输，数据库保存不可逆摘要；cookie HttpOnly、SameSite=Lax、Path=/，HTTPS时Secure（生产必须）；不把认证token交前端或存localStorage。
- 所有写接口执行同源Origin检查，并要求 `Content-Type: application/json` 与 `X-ArtZoo-Request: 1`；客户端统一 `credentials:'same-origin'`。不允许跨站表单提交绕过。开发localhost例外仅Secure属性，不放宽来源校验。
- 后端每次访问依据有效会话和数据库当前身份判权，不能信任客户端capabilities。MEMBER/FRIEND均可登录；ADMIN/SUPER_ADMIN均可管理邀请及参与身份；只有SUPER_ADMIN具备未来管理职责变更资格，本段不开放该接口。
- 新设置密码为8–30字符（REV1104-SEC-08 用户已确认），数字/英文字母/符号，不强制组合；现有6或7位密码账号仍可按原密码登录，不强制重设；禁止默默trim/改变密码，允许密码管理器、粘贴与自动填充。confirmPassword服务端也比对。采用安全的带盐密码哈希，参数与实现由后端给出并测试，勿新增需要生成的持久密钥配置。
- 手机号地区未确认时不得硬编码中国手机号正则或从旧站读取；AuthConfig.phone暴露ready与说明，未配置的相关写接口返回PHONE_REGION_UNCONFIRMED。契约phone为原始输入string，具体归一化及可用地区由后续用户确认落实；数据库唯一性作用于规范化手机号。
- 验证码6位数字、300秒、60秒重发；新码替旧码；同码连续错5次作废；成功只消费一次；**同一规范化手机号所有purpose合计**滚动1小时5次、滚动24小时10次。注册验证码绑定手机号、purpose与邀请，不可跨用途/邀请使用；手机号发送节流跨purpose共享。
- 注册事务须同时校验并原子消费邀请、验证码，插入唯一手机号账号；并发只成功一次，失败不能留下半账号或已消费邀请。校验失败的尝试计数与发送限频不能因业务回滚丢失。
- 登录失败和异常来源另做服务端限流；后端文档化可配置阈值并测试。不记录原始password/code/token。
- 自动测试使用注入的mock短信和受控时间，无真实短信；mock验证码只存在测试接收器，不能通过公开API/日志泄露。未配置的正常应用环境诚实返回SMS_UNAVAILABLE，不假报发送成功。真实阿里云凭据与本人超管初始化留用户安全操作；本轮不读取/生成/持久化凭据。
- 首个超级管理员仅受控本地初始化流程指定用户本人；没有“第一个注册者自动超管”。可以交付初始化程序与说明，本轮不得执行真实初始化。追加迁移保留数据，禁止reset/db push代替审计迁移。

## 公共壳与组件接线（整合者/UI作者边界）

整合者新增：
```ts
// apps/web/components/auth-session.tsx
export function AuthSessionProvider(props:{children:React.ReactNode}):React.ReactNode;
export function useAuthSession(): {
  session: SessionSnapshot | null; // null仅加载/无法判定，不能当真实游客假报成功
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  openLogin(returnTo?:string): void;
  logout(): Promise<boolean>;
};
// apps/web/components/site-shell.tsx
export default function SiteShell(props:{children:React.ReactNode}):React.ReactNode;
```

SiteShell复用已验收背景和SiteHeader，不再套另一份RootLayout/Providers。账号与邀请专属页面使用此壳。公共provider以GET session查询身份，真实登录后刷新；不要求UI作者自行在顶部造第二份登录状态。后台外壳仍显示对应实际管理职责，未实现后台模块明确未开放。

UI作者新增：
```ts
// apps/web/components/account/account-dialog-host.tsx
export default function AccountDialogHost(props:{
  open:boolean;
  returnTo:string;
  onClose():void;
  onAuthenticated():Promise<void>;
}):React.ReactNode;
```
Host内部管理登录/找回两个模态视图，初始登录；登录成功先await onAuthenticated再关闭，并按安全returnTo导航。只允许returnTo为 /、/admin、/admin/invitations、/admin/accounts，其余回 /，防开放重定向。登录无注册入口；邀请只从 /invite/[token] 进入。/login?returnTo=... 页面通过useAuthSession.openLogin打开Host（关闭返回首页），注册成功打开登录。后端需在 `apps/web/server/auth/page-guards.ts` 导出：
```ts
export async function requirePageAdministrator(returnTo:string):Promise<AccountSummary>;
```
无认证redirect到 /login?returnTo=编码路径；已认证无管理权进入明确403/无权状态，不再冒充未登录。UI专属管理页与整合者admin/page.tsx共用此服务端守卫；API仍单独判权。

消息、签到、个人资料/主页等第三段或后续功能保留真实未开放说明。游客显示已确认Figma游客登录入口；真实登录才显示实际身份的头像占位/个人菜单（第二段无头像业务，禁止捏造头像姓名）。管理入口仅真实管理员可见。

## 视觉与验收

真实Figma只读：文件jR5jiwJ9dAiBd6oraJVT8O。账号代表页503:5438（登录464宽、400×40输入/按钮）；注册715:9170；找回715:9574；表单337:2535。UI作者加载figma-design-to-code后读取真实当前设计/截图，不只按本文猜图。后台页按Page既有对应图稿核对，保持第一段字体/背景/Logo/导航、菜单高亮与窄宽响应。

提交失败保留普通输入，不持久化password/code；字段错误定位；处理中防重复；加载失败只原因，不新增重试按钮；未接通短信必须独立披露，mock不等于真实业务验收。共享依赖目前无新增；任何新包需求先报整合者，其他作者不得改manifest/lockfile或自行安装。

后台作者测试应覆盖期限、并发消费、重复手机号、验证码5次错误/重发/失效/限频、权限、会话注销/全部撤销、审计和非破坏性迁移。UI检查1024/1440/中间宽与手机基本访问，加载/错误/长输入/重复动作。全工作区lint/typecheck/build由整合者最终运行；真实SMS与本人初始化缺失如实列为人工完整流程阻塞，不标记第二段验收完成。

## v1.1 整合补充（2026-10-13）

- 用户已明确仅支持中国大陆手机号（确认 Sentinel_74843693bdd48191935209c7ab31788f），取代本文件所有“地区未定”的临时阻断。地区固定 CN / +86，前端不提供国际区号选择；服务端严格验证并将等价大陆号码统一存为 E.164，短信仍不得真实发送，未配置返回 SMS_UNAVAILABLE。具体输入规范与边界以服务端中国大陆策略及其测试为共同实现依据。
- 本地 Docker 为生产构建，显式使用 ARTZOO_DEPLOYMENT_ENV=local、ARTZOO_PUBLIC_ORIGIN=http://localhost:3100。local origin 必须为规范精确地址且主机只允许 localhost / 127.0.0.1 / [::1]；HTTP 使用 artzoo-session 非 Secure，HTTPS 使用 __Host-artzoo-session + Secure。
- 未显式 local 的生产运行仍必须 HTTPS 与 __Host/Secure；未知环境标识、非 loopback local 或非法 origin 均失败关闭。Origin、JSON、X-ArtZoo-Request:1 和 cross-site 校验保持，不信任客户端转发头。
- 这些非秘密标识只写本地 compose 的 web 环境，不读取或修改真实 .env；手机号地区确认不等于短信凭证配置或首位超管初始化完成。

## v1.2 家庭管理体验补充（2026-10-13；冲突时以本节为准）

- 注册 displayName 语义为「游戏昵称」，前后端同一规则：trim 后1–30个 Unicode 码点；拒绝原值中的控制/不可见格式/换行分隔字符；同服务器精确昵称唯一，跨服务器允许同名。现有 null/昵称原样保留，不增加资料编辑或姓名字段。
- GET /api/admin/accounts?query= 仅按昵称字面子串、不区分大小写搜索；空白 query 返回空数组且不查询账号列表；不按手机号查找。反斜杠、%、_ 转义，不能借 SQL 通配符枚举。
- GET /api/admin/audit?scope=membership&page=1&pageSize=10 返回 {items,page,pageSize,total}，只包含 MEMBERSHIP_CHANGED。服务端在 RepeatableRead 一致快照内先过滤再 count/take/skip；pageSize 1–100，page 1–1000000，超出最后一页回落最后有效页。scope=invitation 可单独读邀请审计；身份页面不用它。旧 cursor/limit 审计契约由此替代。
- POST /api/admin/invitations 创建时必须有独立邀请密钥。保存随机 token 的 SHA-256 供兑换及 AES-256-GCM 密文供恢复；随机96-bit nonce、128-bit tag，AAD绑定版本/邀请id/token摘要。数据库不会保存明文 token。配置来自用户本机 ARTZOO_INVITATION_KEY（规范base64、32字节），禁止复用数据库/SMS/会话秘密。
- POST /api/admin/invitations/[id]/link，body {}，当次检查登录管理员和邀请仍有效，返回 {invitePath}；同源/JSON/请求头/写限频与 no-store/no-referrer 同其他敏感接口。列表只有 linkAvailable 布尔值，不返回hash、密文或token。展开单行才读取，收起后卸载明文状态；不写浏览器持久存储。缺密钥/错密钥/损坏密文返回固定 INVITATION_LINK_UNAVAILABLE，不泄露具体密码学异常。
- POST /api/admin/invitations/[id]/remove，body {reason}，返回 {removed:true}。所有状态均可软移除，重复操作幂等；removedAt非空后立即无法兑换/取链接且列表隐藏，同时失效未消费验证码，并写 INVITATION_REMOVED 审计。使用/原撤销事实、账号与会话保持。原revoke端点仅作旧调用兼容，界面不再提供。
- 已有开发测试邀请码按用户明确授权统一软移除；不恢复hash-only旧链接，不轮换旧token，不硬删除。维护脚本仅处理 tokenCiphertext=null 且 removedAt=null，全部邀请锁先获取再修改验证码，审计失败整体回滚。清理脚本必须显式local/localhost门禁且恰有一位已初始化本人超管；不创建超管。
- 配置缺失不影响普通登录/短信/旧链接原有校验，但新建及恢复链接失败关闭。用户密钥配置完成、迁移与服务更新后才能称本功能可用。密钥丢失的邀请不能恢复；禁止擅自重新生成覆盖现有密钥。


## v1.3 国服服务器身份（2026-10-13）

- 用户确认同一个服务器昵称必须唯一。手机号仍是账号标识，登录/重置密码规则不变，不新增第三段角色认证、改名/转服或资料完善功能。
- 注册使用一个“大区 / 服务器”级联控件，提交 gameRegion 和 gameServer。前后端复用官方字典；服务端严格检查服务器属于所选大区，未知值/缺一项均 400 VALIDATION_ERROR，fieldErrors.gameLocation。
- 昵称仅 trim 首尾空白；保留大小写、内部空白、全半角及 Unicode 序列，不执行 lower/NFC 等角色名改写。相同服务器下按精确字符判重；冲突返回 409 GAME_NICKNAME_TAKEN，fieldErrors.displayName。搜索仍仅按昵称，结果另列大区/服务器。
- PostgreSQL 唯一索引为 (gameServer COLLATE "C", displayName COLLATE "C")；事务内再按相同组合加 advisory lock 并预检。冲突不消费验证码或邀请。gameRegion/gameServer 成对为空或成对非空，非空时要求昵称；旧账号保持 null，不推断、不强制补填，登录与会话保持可用。
- 字典来源：[国服服务器状态页面](https://ff.web.sdo.com/web8/index.html#/servers)实际使用的[公开接口](https://ff14act.web.sdo.com/api/serverStatus/getServerStatus)。核对 2026-10-13T15:09:54.502828Z；4区28服。接口无更新时间及稳定数字ID，因此记录核对时间并使用官方名称，不推测ID。游戏角色新建受限不代表不能登记该服既有角色。
- 字典固定于 packages/domain/src/ff14-game-servers.ts；更新须重新核对官网并评估改名/服务器调整对既有身份的影响，不在运行时联网替换。
