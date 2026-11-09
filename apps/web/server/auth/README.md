# 账号服务交付与安全配置

本段按 `docs/account-invitation-contract.md` v1 实现；此目录不提供生产 mock 开关。

## 尚未连接的外部条件

- 用户已确认仅中国大陆手机号。`runtime.ts` 使用 `mainlandChinaPhone`：11位1[3-9]号码、可选+86或0086前缀，首尾空白和ASCII空格/连字符可归一化，数据库统一+86形式，拒绝其他地区。`unconfirmedPhone` 仅保留为失败关闭策略的测试/扩展边界，不在当前应用使用。
- 正常应用现通过 `sms-config.ts` 加载显式配置；未配置仍使用 `unavailableSms`，不会发送短信。`aliyun-sms.ts` 提供 PNVS SendSmsVerifyCode 适配器（HTTPS POST、V3 ACS3-HMAC-SHA256 签名、10秒超时、禁止重定向、AutoRetry=0、不重试、不记录供应商错误）；仅接受经大陆策略归一化的号码，发给供应商时移除+86。仅 web 加载可选 `.local/sms.env`，仅接受 provider=aliyun-pnvs，注册/重置模板分别为100001/100003，发送本地六位验证码与min=5；旧aliyun与单模板字段明确失败。必须用户亲自填写完整配置；配置和初始化步骤见 [家庭配置手顺](../../../../docs/local-account-setup.md)。加载不会自动发送，真实发送留用户另行手动验收。SmsSender 是注入边界，公开接口不返回验证码。测试仅使用 NODE_ENV=test 下的注入接收器。
- 凭证不能通过聊天、CLI 参数、提交文件或日志传递；本任务不读取真实配置、初始化账号或发送短信。
- 正式部署写接口要求 `ARTZOO_PUBLIC_ORIGIN` 是精确的 HTTPS origin（不含尾随斜线），未配置失败关闭。生产构建用于本地Docker验收时，整合者显式配置 `ARTZOO_DEPLOYMENT_ENV=local`、`ARTZOO_PUBLIC_ORIGIN=http://localhost:3100`；仅允许localhost/127.0.0.1/[::1]这三个loopback hostname，且Origin必须与配置的协议、主机、端口完全一致。local HTTP用artzoo-session和Secure=false，local HTTPS用__Host-artzoo-session和Secure=true。未知部署标识、local非loopback、非法origin均失败关闭。未显式local的production构建仍强制HTTPS/__Host/Secure；`ARTZOO_DEPLOYMENT_ENV=production`在任何构建模式下均强制正式策略。仅构建模式为开发且无部署标识时允许原有开发来源行为。不得信任X-Forwarded-For来推断本地环境。

## 事务与安全实现

使用 PostgreSQL 事务级 advisory lock，手机号锁跨注册、发码、登录建会话和密码重置共享；邀请锁跨消费和撤销共享。注册同时创建账号并消费两个凭证，事务错误完整回滚。验证码错误作为事务结果返回，提交尝试次数后才向上层抛出业务错误。数据库额外约束手机号、邀请使用人和 token 摘要唯一。

密码与短验证码使用 Node 原生 scrypt（N=32768,r=8,p=3，随机128位盐，256位输出，恒时比较）。短验证码不使用可快速穷举的裸SHA摘要。会话与邀请采用256位随机token，只持久化SHA-256摘要。密码版本阻断验证密码与创建会话之间的改密竞态。所有身份绝对30天；请求实时读取数据库职责。

验证码预留记录在发送前提交，跨用途共享60秒、滚动小时5次及滚动24小时10次。供应商失败也占额度，避免供应商不确定结果导致多发；失败记录无效，旧码不会恢复。新码替换手机号全部用途的旧码。验证码只在发送适配器内短暂存在，不进入响应或日志。注册目的绑定邀请。

限流由数据库持久化，不靠进程内计数。默认写入每账号60次、每来源300次、全局10000次/15分钟；登录每来源30次、手机号+来源10次、单手机号50次/15分钟。依次通过 AUTH_WRITE_ACCOUNT_LIMIT、AUTH_WRITE_SOURCE_LIMIT、AUTH_WRITE_GLOBAL_LIMIT、AUTH_LOGIN_SOURCE_LIMIT、AUTH_LOGIN_PHONE_SOURCE_LIMIT、AUTH_LOGIN_PHONE_LIMIT 覆盖，合法范围1–10000。多个业务桶在同一事务内按固定顺序加锁、全部检查后一起预约，拒绝不部分扣额；全局熔断仍是共享锁热点，不声称完全消除串行化。改密10次/15分钟固定。只有 rate/rateMany 的纯数据库额度事务允许死锁/序列化冲突额外重试最多2次，其余业务事务默认不重放。

来源提取集中在 request-source.ts：ARTZOO_TRUSTED_PROXY 未严格等于 caddy 时仍用 untrusted-source，不信任客户端自填IP。显式开启后只读取 X-Forwarded-For 最右端，合法IPv4归一化，IPv6按/64分桶，异常回退共享桶。开启必须先验证实际固定Caddy版本会忽略不可信客户端转发头、没有额外trusted_proxies配置，且后端只能从该代理连接。当前本地候选没有取得生产精确版本证据，因此生产模板变量默认空，不能直接宣称可信链已验收。

找回密码对未注册号码只记录立即失效的预约，不调用短信供应商，不留下可使用验证码，对外成功响应、60秒重发及原单号滚动限频与已注册相同。AUTH_SMS_DAILY_LIMIT默认200，按北京时间自然日计算，事务公共锁内按预约统计，供应商失败及虚拟预约保守占额；超额503 SMS_UNAVAILABLE。用户已选择简单同步方案：已注册/未知号码的找回响应共同补足至少1秒；注册不额外等待。供应商仍用原10秒超时，较慢调用可能使已注册路径超过1秒，失败仍保留原503处理。因此只降低明显快速返回差异，不承诺恒时或完全防枚举。未知号仍不真实发送；不新增异步任务、调度或迁移。测试通过注入等待端口避免真实等待，正常runtime不配置该端口。

Worker按日清理认证临时记录：限流事件超过24小时、会话已过期或作废超过7天、验证码过期超过7天；每批最多1000条、每轮最多10000条。账号、审计、业务和媒体不在此范围。维护失败独立记录，不改变计分/通知判定，不补历史消息或处罚；真实环境启用须走独立发布流程。

所有写接口需要同源 Origin、application/json、X-ArtZoo-Request:1，并拒绝Sec-Fetch-Site:cross-site。请求体限制8KiB。Cookie为HttpOnly/SameSite=Lax/Path=/；实际正式部署使用__Host前缀和Secure。不得在代理访问日志中记录邀请路径、请求体或Cookie；链接页也应由整合者设置Referrer-Policy:no-referrer。

### 请求解析与来源信任边界

同源、请求头及原有体积/JSON校验顺序保持；上传和既有受控JSON入口在鉴权后、读体前检查额度与独立解析预算，合法体解析后才原子扣业务额度。真实会话的账号桶由服务端会话查出，不能用客户自报账号分桶；头像和游客留言写入也接入来源/全局及可用账号桶，原模块专用额度保留。可信代理尚未核验时，共享来源仍可能被合法格式的恶意匿名请求消耗，不宣称已经解决分布式滥用。多级代理、IPv6和共享NAT需在正式切换前验收；本批只实现并隔离验证，不自动修改运行环境或放宽CSRF。

## 迁移交给整合者

新增初始账号迁移由 schema 离线 diff 生成，仅创建表、枚举、索引和外键；包括原骨架 EnvironmentProbe 占位表，不删除/重命名现有对象。数据库若已存在该表或同名业务表，先核对迁移历史并制定基线，不能盲目执行。不要使用 db push、migrate reset 或删除数据来解决。

顺序：复核 SQL 与目标库迁移状态 → 用户安全配置连接 → 由整合者在授权目标库执行 `pnpm --filter @artzoo/db exec prisma migrate deploy` → generate/build → 隔离测试库运行事务集成测试 → 整合端到端验证。此作者只执行离线 generate/validate，不执行 migrate deploy。

## 首位超管安全初始化（本轮不执行）

`initialize-super-admin.ts` 提供受控本地事务函数，`owner-initialization-console.ts` 提供 `runOwnerInitialization(db, phonePolicy)` 交互流程：仅本地TTY，确认本人手机号、参与身份及指定确认语，密码两次隐藏输入，不在命令行参数/环境/文件/日志传递密码。两者均无顶层自动执行，不被HTTP引用。新增 `pnpm account:initialize-owner` CLI，先检查 local+localhost:3100、TTY、无参数和非 SSH，再连接既有数据库并调用此入口。须在目标库、迁移和用户操作时间确认后由用户本人运行；步骤见上述家庭配置手顺。事务函数要求 INITIALIZE_CONFIRMED_OWNER；使用全局初始化锁；存在超管则拒绝；手机号已有账号也拒绝，不覆盖或提权。创建超管与审计同一事务。本轮没有调用初始化函数。

## 验证边界

源码单测使用注入时间、短信接收器和事务内存替身，验证业务路径与错误后的回滚/计数。内存替身不能证明 PostgreSQL 锁语义、外键或真实并发隔离；这些必须在整合者授权的独立测试库验证。尚无真实短信或本人初始化，不可标记全流程验收通过。

阿里云适配器参考：[PNVS SendSmsVerifyCode](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)、[V3签名与官方固定向量](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature)。业务参数遵循官方SDK放入query，空请求体参与签名；绝不记录完整URL、签名头或原始响应。HTTP成功、Code=OK且Success=true才表示提交成功。自定义验证码始终由本地核验，供应商Model不会影响本地规则。隔离测试覆盖官方固定签名向量、两用途HTTP/config/service/PNVS链路、超时/响应/无重试/脱敏；实际账号权限、赠送签名和投递仍待用户另行受控验收。
