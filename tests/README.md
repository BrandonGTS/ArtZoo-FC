# 测试

## 怎么运行

```bash
pnpm prepare:code   # 先生成代码（只在依赖或数据库结构变化后需要）
pnpm test           # 单元测试：不连网络、不连数据库，几十秒跑完
pnpm test:pg        # 数据库测试：需要一个本机的一次性 PostgreSQL
```

数据库测试需要先在本机启动一个**临时的** PostgreSQL（用完即删，和正式数据完全无关）：

```bash
docker run --rm -d --name artzoo-test-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=postgres postgres:17.11-bookworm
ARTZOO_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm test:pg
docker stop artzoo-test-pg
```

只运行某个目录或文件：`node scripts/run-tests.mjs tests/auth`。

CI 每次都会在当前提交上运行全部单元测试和数据库测试。

## 目录与约定

| 位置                           | 内容                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| `tests/_shared/loader.mjs`     | 让 Node 直接运行 TypeScript 源码；默认禁止导入真实数据库入口           |
| `tests/_shared/no-network.mjs` | 单元测试中禁止任何真实网络连接                                         |
| `tests/_shared/database.mjs`   | 数据库测试：每个文件新建一个空库、跑完全部迁移、用完删除；只允许连本机 |
| `tests/<模块>/setup.mjs`       | 该目录需要的替身（例如把连接数据库的模块换成假的）                     |
| `tests/<模块>/support/`        | 该目录的测试辅助文件                                                   |
| `*.test.mjs`                   | 单元测试                                                               |
| `*.pg.test.mjs`                | 数据库测试                                                             |

- 测试按产品模块放目录，名称里不写工单号、日期、版本号。
- 测试要调用代码、断言行为，不读取源码文本做匹配。
- 测试一律使用替身，**不发真实短信、不发 QQ 消息、不连正式库**。
- 一个功能至少覆盖：成功、被拒绝（没登录 / 没权限 / 别人的数据）、关键边界。

## 关键功能与测试对照

关键功能清单见 `docs/PLAN.md`。下表随每批测试补充。

| 优先级 | 功能             | 测试文件                                                                                                                                                                                | 守住的行为（举例）                                                                                                                         |
| ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P0     | 登录与会话       | `auth/service-rules.test.mjs`、`auth/rate-limits.test.mjs`、`auth/auth-regression.test.mjs`、`auth/concurrency.pg.test.mjs`                                                             | 统一的"手机号或密码不正确"；停用账号不能登录；改密、重置后所有旧会话失效；锁等待后重新核对权限                                             |
| P0     | 注册与邀请       | `auth/service-rules.test.mjs`、`auth/invitation-usage.test.mjs`、`auth/invitation-usage.pg.test.mjs`、`auth/admin-and-invitations.test.mjs`、`auth/invitation-cipher.test.mjs`          | 无效 / 已用 / 已撤销 / 过期邀请被拒；两个连接同时注册时单次邀请只成功一次；验证码一次性、5 次错误作废；同服昵称唯一                        |
| P0     | 写请求防护       | `auth/http-policy.test.mjs`、`auth/http-write-quota.test.mjs`、`write-guards/write-quota.test.mjs`、`public-endpoints/guest-and-avatar.test.mjs`、`write-guards/error-logging.test.mjs` | 错误来源、缺 `x-artzoo-request`、错误类型的写请求被拒；各模块写接口先校验再计额度；只信任可信代理传来的最后一段 IP；错误日志不泄露请求内容 |
| P0     | 手机号与短信     | `auth/phone-input.test.mjs`、`auth/client-api.test.mjs`、`auth/aliyun-sms.test.mjs`、`auth/http-sms-config.test.mjs`、`auth/sms-provider.pg.test.mjs`、`auth/concurrency.pg.test.mjs`   | 只收大陆手机号；发送频率与全站日预算（并发下也不超）；未注册号码找回不发短信但响应一致；短信适配器签名正确且日志不泄露密钥                 |
| P0     | 超管初始化与配置 | `auth/owner-initialization.test.mjs`、`auth/configuration.test.mjs`                                                                                                                     | 只能初始化一次超级管理员；短信等配置缺失时安全失败                                                                                         |

### 验证测试确实能发现问题

在本地临时改坏产品代码，确认对应测试会失败（改动未提交）：

| 故意改坏                                        | 发现它的测试                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| 去掉 `x-artzoo-request` 请求头校验              | `auth/http-write-quota`、`write-guards/write-quota`、`auth/service-rules`   |
| 来源 IP 改取 `X-Forwarded-For` 第一段（可伪造） | `auth/rate-limits`、`public-endpoints/guest-and-avatar`                     |
| 验证码允许输错 50 次                            | `auth/service-rules`                                                        |
| 登录区分"账号不存在"和"密码错误"                | `auth/rate-limits`、`auth/service-rules`                                    |
| 重置密码后不作废旧会话                          | `auth/service-rules`                                                        |
| 手机号放宽到 10/11/12 开头                      | `auth/http-policy`、`auth/phone-input`                                      |
| 单次邀请用过后仍可注册                          | `auth/admin-and-invitations`、`auth/invitation-usage`、`auth/service-rules` |
| 短信日预算多放行一条                            | `auth/concurrency.pg`                                                       |
| 限流不加锁（并发下超额）                        | `auth/concurrency.pg`                                                       |

### 测试中保留的旧兼容行为

以下用例测试的是阶段 4 计划删除的兼容逻辑，删除那部分代码时一并删除这些用例：

- `auth/concurrency.pg.test.mjs`："existing-six-and-seven-character-passwords-authenticate"（旧 6–7 位密码仍可登录）。
- `auth/admin-and-invitations.test.mjs`：两条 "legacy cleanup" 用例（旧邀请清理命令）。
