# 测试

## 怎么运行

```bash
pnpm prepare:code   # 先生成代码（只在依赖或数据库结构变化后需要）
pnpm test           # 单元测试：不连网络、不连数据库，几十秒跑完
pnpm test:pg        # 数据库测试：需要一个本机的一次性 PostgreSQL
pnpm test:plugin    # QQ 插件（Python）测试：需要 Python 3.11 以上，只用标准库
```

数据库测试需要先在本机启动一个**临时的** PostgreSQL（用完即删，和正式数据完全无关）：

```bash
docker run --rm -d --name artzoo-test-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=postgres postgres:17.11-bookworm
ARTZOO_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm test:pg
docker stop artzoo-test-pg
```

只运行某个目录或文件：`node scripts/run-tests.mjs tests/auth`。

数据库结构快照（同样需要上面的测试库）：

```bash
ARTZOO_TEST_DATABASE_URL=... pnpm db:snapshot          # 检查：迁移结果是否和 packages/db/prisma/schema-snapshot.txt 一致
ARTZOO_TEST_DATABASE_URL=... pnpm db:snapshot --write  # 更新：改了迁移后重新生成快照，和迁移一起提交
```

CI 每次都会在当前提交上运行全部单元测试和数据库测试。

## 目录与约定

| 位置                                | 内容                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `tests/_shared/loader.mjs`          | 让 Node 直接运行 TypeScript 源码；默认禁止导入真实数据库入口                                  |
| `tests/_shared/no-network.mjs`      | 单元测试中禁止任何真实网络连接                                                                |
| `tests/_shared/database.mjs`        | 数据库测试：每个文件新建一个空库、跑完全部迁移、用完删除；只允许连本机                        |
| `tests/_shared/schema-snapshot.mjs` | 把数据库结构整理成稳定的文本快照，供 `tests/db/schema-snapshot.pg` 和 `pnpm db:snapshot` 使用 |
| `tests/<模块>/setup.mjs`            | 该目录需要的替身（例如把连接数据库的模块换成假的）                                            |
| `tests/<模块>/support/`             | 该目录的测试辅助文件                                                                          |
| `*.test.mjs`                        | 单元测试                                                                                      |
| `*.pg.test.mjs`                     | 数据库测试                                                                                    |
| `tests/qq-plugin/test_*.py`         | QQ 插件的 Python 测试（unittest），用 `pnpm test:plugin` 运行                                 |

- 测试按产品模块放目录，名称里不写工单号、日期、版本号。
- 测试要调用代码、断言行为，不读取源码文本做匹配。
- 测试一律使用替身，**不发真实短信、不发 QQ 消息、不连正式库**。QQ 插件测试同样不联网，所有发送都是假的。
- 一个功能至少覆盖：成功、被拒绝（没登录 / 没权限 / 别人的数据）、关键边界。
- 结果不能依赖机器快慢。例如 QQ 通知入队时，产品会把等锁花掉的真实毫秒数加到计划时间上；入队后马上领取的测试要给入队传固定时钟（最后一个参数 `() => now`），或者把测试时钟推进到计划时间，否则在慢机器上会偶尔领不到。
- 失败时 `run-tests.mjs` 只打印失败用例（`not ok` 行及其错误信息），不再截取输出末尾。

## 关键功能与测试对照

关键功能清单见 `docs/PLAN.md`。

| 优先级 | 功能                  | 测试文件                                                                                                                                                      | 守住的行为（举例）                                                                                                                             |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 登录与会话            | `auth/service-rules`、`auth/rate-limits`、`auth/auth-regression`、`auth/password-change-expiry`、`auth/concurrency.pg`                                        | 统一的"手机号或密码不正确"；停用账号不能登录；改密、重置后所有旧会话失效；锁等待后重新核对权限                                                 |
| P0     | 注册与邀请            | `auth/service-rules`、`auth/invitation-usage`、`auth/invitation-usage.pg`、`auth/admin-and-invitations`、`auth/invitation-cipher`                             | 无效 / 已用 / 已撤销 / 过期邀请被拒；两个连接同时注册时单次邀请只成功一次；验证码一次性、5 次错误作废；同服昵称唯一                            |
| P0     | 写请求防护            | `auth/http-policy`、`auth/http-write-quota`、`write-guards/*`、`public-endpoints/guest-and-avatar`                                                            | 错误来源、缺 `x-artzoo-request`、错误类型的写请求被拒；先校验来源和登录再计额度；只信任可信代理传来的最后一段 IP；错误日志不泄露请求内容       |
| P0     | 手机号与短信          | `auth/phone-input`、`auth/client-api`、`auth/aliyun-sms`、`auth/http-sms-config`、`auth/sms-provider.pg`、`auth/concurrency.pg`                               | 只收大陆手机号；发送频率与全站日预算（并发下也不超）；未注册号码找回不发短信但响应一致；短信签名正确且日志不泄露密钥                           |
| P0     | 超管初始化与配置      | `auth/owner-initialization`、`auth/configuration`                                                                                                             | 只能初始化一次超级管理员；短信等配置缺失时安全失败                                                                                             |
| P0     | 权限：后台管理        | `admin/admin-management.pg`、`admin/account-lifecycle.pg`、`auth/account-changes`                                                                             | 只有超级管理员能任免管理员、停用账号；不能对自己和其他超管操作；停用连带取消活动、报名、队伍关系和会话；审计只追加                             |
| P0     | 权限：内容归属        | `content/*`                                                                                                                                                   | 普通删除只能删自己的；违规删除只有管理员能做且必须填理由；不能删别人的评论；"仅作者上传"的相册别人传不了；评论图片只能挂在自己的评论上         |
| P0     | 活动发起与报名        | `activities/activities.pg`、`activities/http`、`activities/domain`、`activities/registration-and-edits`、`activities/duty-service`、`activities/publishing-*` | 朋友不能发起；每人每活动一份有效报名；最后一个席位并发只有一人成功；不能报别的活动的席位；截止时间精确到毫秒；换位与职业要求；写入失败整体回滚 |
| P0     | 活动退出、取消与管理  | `activities/management-service`、`activities/management-contract`、`activities/activities.pg`                                                                 | 2 小时、4 小时扣分边界；缺人无责取消；只有发起者能修改和取消；跨过边界时不会悄悄扣分；3 点限制；改期规则                                       |
| P0     | 长期与线下活动        | `activities/offline-series-*`、`activities/series-*`                                                                                                          | 线下截止与人数；长期活动首期招募、成团、自动取消、单期协商取消                                                                                 |
| P1     | 活动列表与历史        | `activities/history`、`activities/home-upcoming`、`activities/my-activities`、`activities/description`                                                        | 操作历史只给发起者看全部；首页近期活动筛选；我的活动当前 / 历史划分                                                                            |
| P1     | 积分与限制            | `scoring/standing`、`scoring/completion`、`scoring/completion.pg`、`scoring/auto-absence`、`scoring/auto-absence.pg`                                          | 3 点进入限制、每 7 天减 1 点；正常完成减 1 点且只结算一次；结束后未登记自动记缺席扣 2 点，与签到并发时持锁者胜出                               |
| P1     | 到场登记              | `scoring/attendance-*`、`scoring/attendance.pg`                                                                                                               | 只有发起者在活动时间内登记；缺席扣 2 点、时间内改回到场撤销                                                                                    |
| P1     | 申诉                  | `scoring/penalty-appeals*`                                                                                                                                    | 7 天期限；同时只有一条待处理；驳回后换理由可再申诉；批准后撤销处罚并按流水重算                                                                 |
| P1     | 抽奖                  | `lottery/lottery.pg`、`lottery/eligibility-at-draw-time.pg`、`lottery/durability.pg`、`lottery/cutoff.pg`、`lottery/*`                                        | 开奖只执行一次、结果不可修改；资格按设定开奖时刻判断；通知失败不重抽；洗牌均匀（1 万次抽样）；发起与参加权限                                   |
| P1     | 图片上传与处理        | `media/photo-processor`、`media/daily-processor`、`media/metadata-*`、`media/pipeline-integration`、`media/bitmap*`、`media/upload-gate`                      | 只接受白名单格式；超像素的"解压炸弹"被拒；去除 EXIF/GPS；BMP 在独立线程解码；全站上传并发上限                                                  |
| P1     | 图片读取与头像        | `media/avatar`、`media/avatar-http`、`media/knowledge-image-upload`、`lottery/list-media`                                                                     | 头像格式与尺寸；只能挂载自己上传的图片；上传重放与并发只留一份；会话过期回滚并删除新文件；回执拒绝符号链接与硬链接                             |
| P1     | 后台任务              | `worker/maintenance`、`worker/worker`、`worker/pool-health`、`worker/transaction-retry`                                                                       | 单条出错不影响其他条目和步骤；日志只记白名单字段；停止信号正常退出；连接池与健康检查；只对声明可重放的事务重试                                 |
| P0     | QQ 机器人：桥接安全   | `qq/bridge-security`、`qq/bridge-http`、`qq/binding-key-http`、`qq/qq-official.pg`                                                                            | 签名覆盖时间、随机数、路径和正文；60 秒时间窗；同一随机数只能用一次（并发下也只成功一次）；未配置密钥时直接拒绝且不碰数据库                    |
| P0     | QQ 机器人：不重复发送 | `qq/notifications`、`qq/qq-official.pg`、`qq-plugin/test_sender`、`qq-plugin/test_rate_receipt`、`qq-plugin/test_direction_limits`                            | 超时、断线、部分回执一律记为"结果不确定"，永不自动重发；只有确认未发出的失败才有限重试（最多 3 次）；过期租约、旧令牌不能重复投递              |
| P1     | QQ 机器人：绑定与报名 | `qq/binding-key.pg`、`qq/signup-*`、`qq/signup-code*.pg`、`qq/qq-official.pg`                                                                                 | 一次性密钥 5 分钟过期、重新生成后旧密钥作废；QQ 身份与网站账号一一对应；群内报名只认绑定的人、最后一个席位并发只有一人成功                     |
| P1     | QQ 机器人：管理后台   | `qq/bot-management.pg`、`qq/bot-policy`、`qq/bot-*`、`qq-plugin/*`                                                                                            | 只有超级管理员能读写和发布；配置摘要网站与插件一致；插件确认版本前不算生效；暂停后不领取也不发送                                               |
| P1     | 固定队                | `teams/teams.pg`、`teams/contract`、`teams/recruitment-contract`、`teams/weekly-batch-contract`、`teams/team-cycle`                                           | 只有正式成员能创建；只有创建者能管理；朋友申请不占位；同一席位并发审批只有一人成功；每周二 16:00（北京时间）切换周期                           |
| P1     | 心愿                  | `wishes/wishes.pg`、`wishes/contract`、`wishes/home-sample`                                                                                                   | 只有作者能修改、删除；评论并发与重放；转为活动时不能借用别人的活动；首页抽样不重复                                                             |
| P1     | 日常                  | `content/daily.pg`、`content/daily-comment-media`                                                                                                             | 只有作者能编辑、删除；评论与提及通知去重；图片归属不能被盗用；管理员删除必须填理由                                                             |
| P1     | 知识库                | `content/knowledge.pg`、`content/knowledge-*`                                                                                                                 | 匿名不能看；只有作者能改设置和删除；审核记录只有管理员能看；富文本只接受白名单内容                                                             |
| P1     | 相册                  | `content/albums.pg`、`content/albums-*`                                                                                                                       | "仅作者上传"只有作者能传；图片读取权限；点赞查询次数固定                                                                                       |
| P0     | 数据库结构            | `db/schema-snapshot.pg`                                                                                                                                       | 跑完全部迁移后的结构与保存的快照逐行一致：检查约束、带条件的唯一索引、触发器、函数和初始数据都不能悄悄丢失或改变                               |

表中文件名省略了 `.test.mjs` 后缀，`.pg` 表示数据库测试。

### 验证测试确实能发现问题

在本地临时改坏产品代码，确认对应测试会失败（改动未提交）：

| 故意改坏                                        | 发现它的测试                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| 去掉 `x-artzoo-request` 请求头校验              | `auth/http-write-quota`、`write-guards/write-quota`、`auth/service-rules`          |
| 来源 IP 改取 `X-Forwarded-For` 第一段（可伪造） | `auth/rate-limits`、`public-endpoints/guest-and-avatar`                            |
| 验证码允许输错 50 次                            | `auth/service-rules`                                                               |
| 登录区分"账号不存在"和"密码错误"                | `auth/rate-limits`、`auth/service-rules`                                           |
| 重置密码后不作废旧会话                          | `auth/service-rules`                                                               |
| 手机号放宽到 10/11/12 开头                      | `auth/http-policy`、`auth/phone-input`                                             |
| 单次邀请用过后仍可注册                          | `auth/admin-and-invitations`、`auth/invitation-usage`、`auth/service-rules`        |
| 短信日预算多放行一条                            | `auth/concurrency.pg`                                                              |
| 限流不加锁（并发下超额）                        | `auth/concurrency.pg`                                                              |
| 退出扣分边界从 2 小时改成 1 小时                | `activities/management-service`                                                    |
| 取消扣分边界从 4 小时改成 3 小时                | `activities/management-service`                                                    |
| 达到 3 点仍可报名                               | `activities/management-service`                                                    |
| 报名截止从开始前 30 分钟改成 10 分钟            | `activities/activities.pg`                                                         |
| 已被占用的席位还能报名                          | `activities/activities.pg`                                                         |
| 去掉"同一活动只能一份有效报名"检查              | `activities/activities.pg`                                                         |
| 非发起者也能修改 / 取消活动                     | `activities/management-service`                                                    |
| 朋友也能发起活动                                | `activities/activities.pg`                                                         |
| 普通管理员也能任免管理员                        | `admin/admin-management.pg`                                                        |
| 超管可以停用自己 / 其他超管                     | `admin/account-lifecycle.pg`                                                       |
| 普通删除不检查是否本人                          | `content/deletion-intent`、`content/albums-permissions`、`content/albums-comments` |
| 违规删除不要求理由                              | `content/deletion-intent`、`content/albums-*`、`content/knowledge-interactions`    |
| 知识库非作者也能删除文章                        | `content/deletion-intent`                                                          |
| 相册"仅作者上传"对所有人开放                    | `content/albums-permissions`                                                       |
| 正常完成不减分                                  | `scoring/completion`                                                               |
| 自然减点周期从 7 天改成 3 天                    | `scoring/standing`、`scoring/completion`、`scoring/attendance-contract`            |
| 自动缺席只扣 1 点                               | `scoring/auto-absence`、`scoring/auto-absence.pg`                                  |
| 处罚申诉期限改成 30 天                          | `scoring/penalty-appeals`                                                          |
| 已开奖的抽奖还能再开一次                        | `lottery/lottery.pg`                                                               |
| 洗牌算法不洗（结果可预测）                      | `lottery/lottery.pg`                                                               |
| 去掉 EXIF 剥离                                  | `media/metadata-strip`、`media/photo-processor`、`media/daily-processor`           |
| 去掉图片像素上限                                | `media/photo-processor`                                                            |
| 不检查文件扩展名                                | `media/photo-processor`                                                            |
| 后台任务单条出错就中断整轮                      | `worker/maintenance`                                                               |
| QQ 签名时间窗从 60 秒放宽到 10 分钟             | `qq/bridge-security`                                                               |
| QQ 签名不再覆盖请求正文                         | `qq/bridge-security`                                                               |
| 用过的随机数（nonce）仍放行（可重放）           | `qq/qq-official.pg`                                                                |
| 网站把"发送结果不确定"当作可安全重试            | `qq/notifications`、`qq/qq-official.pg`                                            |
| 插件允许结果不确定的消息再次发送                | `qq-plugin`（test_sender 等）                                                      |
| 过期的 QQ 绑定密钥还能用                        | `qq/binding-key.pg`                                                                |
| 重新生成后，作废的旧绑定密钥还能用              | `qq/binding-key.pg`                                                                |
| 机器人管理：普通管理员也能操作                  | `qq/bot-management.pg`                                                             |
| 固定队：朋友也能创建                            | `teams/teams.pg`                                                                   |
| 固定队：非创建者也能管理                        | `teams/teams.pg`                                                                   |
| 心愿：非作者也能修改                            | `wishes/wishes.pg`                                                                 |
| 日常：非作者也能编辑                            | `content/daily.pg`                                                                 |
| 知识库：非作者也能改文章设置                    | `content/knowledge-editor`、`content/knowledge.pg`                                 |
| 知识库：非管理员也能看审核记录                  | `content/knowledge.pg`                                                             |
| 相册"仅作者上传"对所有人开放（数据库层）        | `content/albums.pg`                                                                |
| 迁移里去掉一条检查约束（处罚点数规则）          | `db/schema-snapshot.pg`                                                            |
| 检查约束里的数字改了（迟退扣 1 点改成 2 点）    | `db/schema-snapshot.pg`                                                            |
| 带条件的唯一索引去掉条件（每人一份有效报名）    | `db/schema-snapshot.pg`                                                            |
| 去掉一个触发器（账号生命周期只追加）            | `db/schema-snapshot.pg`                                                            |
| 触发器函数的内容改了（报错改成只提示）          | `db/schema-snapshot.pg`                                                            |
| 去掉一条迁移写入的初始数据（快捷链接状态行）    | `db/schema-snapshot.pg`                                                            |

### 测试中保留的旧兼容行为

阶段 4 的两次清理已删除对应代码和用例（旧 6–7 位密码、旧邀请清理命令、功能上线时刻、公开 QQ 设置、QQ 旧绑定流程、插件事故恢复函数、COS 等）。仍然保留的：

- 名称带 legacy / historical 的其他用例（如 `activities/home-upcoming`、`activities/duty-service`、`content/daily*`、`content/albums-*`、`content/knowledge-*`、`qq/bot-*`、`qq-plugin/test_management`、`qq-plugin/test_sender`）。它们对应的代码不在阶段 4 第一次清理的清单里，有的是在拒绝旧格式（应当保留），有的是在兼容旧数据（可以删）。核实任务见 `docs/PLAN.md` 第五节 T12。

### 从旧仓库迁移时修正或放弃的测试

- 相册评论、知识库图片上传两个测试的替身补上了"图片是否已进入待清理流程"的查询（产品代码后来新增的），断言未改。
- QQ 通知、机器人管理的数据库测试：投递表后来加了"必须对应真实活动"的外键，补上合成活动；正式模式领取投递要求插件近 2 分钟内报告就绪，补上这条上报记录；消息正文后来追加了"活动编号 / 报名示例"，改为分别核对模板部分和追加部分。
- 心愿数据库测试补了一条"只有作者能修改、删除"的用例（改坏验证时发现原测试没覆盖）。
- 放弃（D 批）：旧的 QQ 公开码绑定流程测试（产品已改为一次性密钥，由 `qq/binding-key.pg` 覆盖）；需要真浏览器或先启动整个网站的测试（`*-browser`、`*-chrome`、`*-http`）；把界面组件源码读进来再运行的界面测试（以后引入组件测试工具时统一重做）；校验插件配置文件内容、比对 `main.py` 源码的用例；只验证旧数据迁移的测试。
- 放弃：与某个历史提交逐字对比的抽奖算法测试、读取源码文本做断言的用例、依赖历史版本证明文件的媒体并发测试，以及只对旧数据有意义的"功能上线前的旧活动 / 旧处罚"用例。
