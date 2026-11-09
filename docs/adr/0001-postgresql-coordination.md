# ADR-0001：在 PostgreSQL 事务内协调共享业务

日期：2026-11-05

状态：现状记录（源码基线 `1df5504`；未新增用户决策）

## 背景与现行选择

Web 和独立 worker 都会更新活动、资格和通知；单个 Node 进程内锁不能协调多个进程。现有实现把业务记录和相关幂等意图放进 PostgreSQL 事务，使用约定的事务级 advisory lock、行锁和数据库约束共同协调。[账号服务](../../apps/web/server/auth/service.ts) 共享手机号/邀请锁；[活动维护](../../packages/db/src/activity-maintenance.ts) 与交互服务使用相应业务锁；[通知领取](../../packages/db/src/qq-official-notifications.ts) 通过行锁、租约和 fence 防止过期 owner 派发。

[AGENTS](../../AGENTS.md) 保持既定 PG/Prisma 栈，不默认引入 Redis 或任务框架。本文记录已有事务协调方式，不声称历史曾正式比较所有外部锁系统，也不把“不引 Redis”扩展成永远禁止的产品决定。

## 后果与保护

同一数据库提交使部分业务状态和意图可以原子落地，但长事务和热点锁会等待。改动须检查锁键、顺序、共享/独占模式及锁后会话、资格、截止和版本复验；不能把多次 await 之前缓存的许可当最终许可。

[限流重试工具](../../packages/db/src/transaction-retry.ts) 仅服务已审的窄事务场景，不能据此自动重放所有带外部副作用的业务事务。[抽奖维护](../../packages/db/src/lottery-maintenance.ts) 的账号 fence 有自己的 NOWAIT/回滚协议，也不能随意换锁。数据库健康检查复用业务池；故障不能靠新建无限连接池掩盖。

## 验证依据与局限

事务语义需真实隔离 PG 验证，入口及 fresh 目标守卫见[PG说明](../../tests/README-pg.md)。历史发布结果见[固定回执](../rev1105-production.md)，不代表本文执行了新测试或实时生产采样。是否优化全账号 fence、长事务和查询开销仍按各原审查项目单独推进，本文不宣布其完成。
