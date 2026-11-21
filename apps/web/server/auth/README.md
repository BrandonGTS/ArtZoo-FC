# 账号服务实现说明

本目录负责登录、会话、注册与邀请、短信验证码、找回和修改密码、限流，以及首位超管初始化。改这里的代码前先读本文和同目录的 `AGENTS.md`（必须遵守的安全约束）。业务规则见 `docs/rules/accounts.md`，整体结构见 `docs/ARCHITECTURE.md` 第四节。

## 文件

| 文件                                                                                                        | 内容                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `service.ts`                                                                                                | `AccountService`：注册、登录、会话、验证码、邀请、限流；事务封装和锁（`lock`、`lockShared`） |
| `http.ts`                                                                                                   | 写请求来源校验 `validateOrigin`、请求体读取（上限 8 KiB）、Cookie、错误响应                  |
| `request-source.ts`                                                                                         | 限流用的来源 IP（`resolveRequestSource`）                                                    |
| `security.ts`                                                                                               | 按部署环境决定站点地址、Cookie 名称和是否 `Secure`                                           |
| `page-guards.ts`、`request-session.ts`                                                                      | 页面守卫与按请求缓存的会话                                                                   |
| `crypto.ts`                                                                                                 | scrypt 哈希、随机 token、6 位验证码                                                          |
| `ports.ts`                                                                                                  | 手机号策略（只支持中国大陆）和短信发送接口；未配置短信时的 `unavailableSms`                  |
| `sms-config.ts`、`aliyun-sms.ts`                                                                            | 短信配置校验和阿里云号码认证服务适配器                                                       |
| `invitation-cipher.ts`                                                                                      | 邀请链接的加密与解密                                                                         |
| `active-targets.ts`                                                                                         | 选择成员类操作里"目标账号必须存在且未停用"的检查                                             |
| `runtime.ts`                                                                                                | 按环境变量组装 `AccountService`                                                              |
| `initialize-super-admin.ts`、`owner-initialization-console.ts`、`owner-init-cli.mjs`、`owner-cli-policy.ts` | 首位超管初始化                                                                               |

## 手机号与短信

- 只接受中国大陆手机号：11 位、`1[3-9]` 开头，可带 `+86` 或 `0086` 前缀，空格和连字符会被去掉；数据库统一存成 `+86` 开头的形式。
- 短信由 `sms-config.ts` 按环境变量加载，没有 dotenv 读取，也没有测试用的绕过开关。`ARTZOO_SMS_PROVIDER` 未配置时使用 `unavailableSms`，发码接口一律返回 503。
- 只支持阿里云号码认证服务 `aliyun-pnvs`（PNVS `SendSmsVerifyCode`）：HTTPS POST、V3 签名（ACS3-HMAC-SHA256）、10 秒超时、不跟随重定向、不重试、不记录供应商的错误内容。验证码在本地生成并核验，注册和重置模板编号固定为 `100001`、`100003`；发给供应商时去掉 `+86`。
- 测试只用注入的假发送器，不发真实短信。

## 验证码

- 发送前先在数据库里提交一条预约，再调用供应商；供应商失败也占用额度，避免结果不确定时多发。新码会作废这个号码所有用途的旧码。
- 同一手机号（注册和找回共用）：两次至少间隔 60 秒，滚动 1 小时最多 5 条，滚动 24 小时最多 10 条。
- 全站每天（北京时间）最多 `AUTH_SMS_DAILY_LIMIT` 条（默认 200），超出返回 503；发送失败和下面的虚拟预约都算。
- 验证码有效期 5 分钟，输错 5 次作废。验证码只在发送适配器里短暂存在，不进入响应或日志；注册用的验证码绑定邀请。
- **找回密码**：号码没注册时只记一条立即失效的预约，不调用供应商，对外的响应和间隔限制与已注册号码相同。找回接口的响应时间统一补足到至少 1 秒，减少明显的时间差；供应商慢或失败时仍可能不同，不承诺恒定时间。

## 密码、会话与邀请

- 密码和验证码都用 scrypt（N=32768、r=8、p=3，128 位随机盐，256 位输出）哈希，比对用 `timingSafeEqual`；手机号不存在时用假哈希跑完整比对。
- 会话 token 和邀请 token 都是 256 位随机数，数据库只存 SHA-256 摘要。会话有效期 30 天；每次请求都从数据库读取最新的账号状态和角色。密码版本号防止"验证密码"和"创建会话"之间发生改密竞态。
- 邀请另存一份用 `ARTZOO_INVITATION_KEY` 加密（AES-256-GCM）的密文，管理员才能再次查看链接；密钥缺失或格式不对时，生成和查看邀请都返回 503。

## 锁、事务与限流

- 手机号锁 `phone:<号码>` 在注册、发码、登录、重置密码之间共享；邀请锁在使用和撤销之间共享。注册在一个事务里创建账号并消费邀请和验证码，出错整体回滚。验证码输错时先提交尝试次数，再抛出错误。
- 限流记录存在数据库里，不靠进程内计数。默认上限（15 分钟窗口）：写操作每账号 60、每来源 300、全站 10000；登录每来源 30、每手机号加来源 10、每手机号 50。可分别用 `AUTH_WRITE_ACCOUNT_LIMIT`、`AUTH_WRITE_SOURCE_LIMIT`、`AUTH_WRITE_GLOBAL_LIMIT`、`AUTH_LOGIN_SOURCE_LIMIT`、`AUTH_LOGIN_PHONE_SOURCE_LIMIT`、`AUTH_LOGIN_PHONE_LIMIT` 覆盖（1–10000；生产部署不传这些变量）。修改密码固定每账号 15 分钟 10 次。
- 多个限流桶在同一事务里按固定顺序加锁、全部检查后一起记账，不会只扣一部分。只有这种纯限流事务在死锁或序列化冲突时最多再重试 2 次，其他事务不重放。
- 账号桶用服务端查到的会话分桶，不信任客户端自报的账号。上传接口在确认登录后、读取文件前先检查额度，解析成功后才正式记账。
- 来源 IP 只在 `ARTZOO_TRUSTED_PROXY=caddy` 时取 `X-Forwarded-For` 最右边一段（IPv4 按单个地址，IPv6 按 /64），格式异常时退回共享桶 `untrusted-source`。部署时由 web 专用的代理覆盖文件开启，并用 HTTPS 检查确认 Caddy 会覆盖伪造的转发头（`docs/DEPLOYMENT.md` 5.6）。

## 部署环境与 Cookie

- `ARTZOO_DEPLOYMENT_ENV` 只能是 `production`、`local` 或不设置；其他值返回 503。
- `production`（或未设置但 `NODE_ENV=production`）：`ARTZOO_PUBLIC_ORIGIN` 必须是精确的 https 地址（不带结尾斜杠），Cookie 名 `__Host-artzoo-session`，带 `Secure`。
- `local`：站点地址只能是 `localhost`、`127.0.0.1` 或 `[::1]`；http 时 Cookie 名 `artzoo-session`、不带 `Secure`，https 时同正式环境。不根据 `X-Forwarded-For` 判断是不是本地。
- 写请求必须同源、`application/json`、带 `X-ArtZoo-Request: 1`，并拒绝 `Sec-Fetch-Site: cross-site`。Cookie 都是 `HttpOnly`、`SameSite=Lax`、`Path=/`。代理的访问日志不能记录邀请路径、请求体或 Cookie。

## 首位超管初始化

- `initialize-super-admin.ts` 是事务函数：使用全局初始化锁；已经有超管、或这个手机号已有账号时都拒绝，不覆盖、不提权；创建超管和审计记录在同一事务里。它不被任何 HTTP 路由引用。
- `owner-init-cli.mjs`（`pnpm account:initialize-owner`）是交互入口：要求无参数、真实 TTY、不在 SSH 会话里，并且 `ARTZOO_DEPLOYMENT_ENV=local`、`ARTZOO_PUBLIC_ORIGIN=http://localhost:3100`。依次确认本人手机号、参与身份和确认语，密码隐藏输入两次，不经过命令行参数、环境变量、文件或日志。
- 部署时由维护脚本的 `owner` 命令在 tools 容器里以上述 local 环境运行这个入口，步骤见 `docs/DEPLOYMENT.md` 5.4。

## 认证记录清理

worker 每天清理一次（需 `ARTZOO_SECURITY_CLEANUP_ENABLED=1`，生产的 worker 已开启）：超过 24 小时的限流记录、过期或作废超过 7 天的会话和验证码；每批最多 1000 条，每轮最多 10000 条。账号、审计、业务数据和媒体不在清理范围内。

## 参考

- [阿里云 PNVS SendSmsVerifyCode](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)
- [阿里云 V3 请求结构与签名](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature)
