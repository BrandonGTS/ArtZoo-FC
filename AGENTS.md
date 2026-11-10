# ArtZoo 协作规则（给 AI 助手）

《最终幻想 XIV》公会 ArtZoo 的网站。pnpm workspace：Next.js App Router、React、TypeScript、Ant Design、Prisma、PostgreSQL；QQ 插件使用 Python。依赖的确切版本以 `pnpm-lock.yaml` 为准。

## 先读什么

1. 站长已经做出的决定记在 `docs/DECISIONS.md`。与它冲突的做法一律不做；如果发现它和代码不一致，先报告。
2. 要修改下面这些目录时，先读该目录里的 `AGENTS.md`：

| 目录 | 内容 |
|---|---|
| `apps/web/server/` | API 与服务端业务的通用写法 |
| `apps/web/server/auth/` | 登录、会话、短信、限流（高风险） |
| `apps/web/components/`、`apps/web/app/` | 页面、样式、交互（规则文件在 `apps/web/components/AGENTS.md`） |
| `packages/db/` | 数据库结构、迁移、后台任务 |
| `packages/media/` | 图片处理与存储 |
| `plugins/astrbot_plugin_artzoo/` | QQ 机器人插件 |

3. 架构见 `docs/ARCHITECTURE.md`，业务规则见 `docs/rules/`（账号、活动、心愿、删除与治理），界面规范见 `docs/design/ui-guidelines.md`。尚未定论的问题统一列在 `docs/PLAN.md` 第四节：站长决定之前不要擅自"修好"它们，也不要在其他文档里另建待办清单。

## 角色分工

- 站长负责所有决定，并亲自执行所有命令。AI 负责解释、在本地修改代码、给出命令。AI 不连接、不登录、不操作任何服务器。
- 每条命令都要写清楚：在哪台机器、哪个目录执行；做什么；有什么风险；怎么确认成功；出错了怎么退回。
- 会删除数据、执行迁移、重启或替换线上服务的命令，开头标【危险】，并且单独成一步。
- 不读取、不输出、不索要任何密码、密钥或 token。

## 每次任务

- 只做站长这次要求的范围，不顺手重构，不扩大范围。
- 一个任务在一个分支上完成，通过 PR 合并。PR 按照 `.github/pull_request_template.md` 填写。
- 结束时必须列出三件事：改了哪些文件；站长需要运行哪些命令来验证；有什么没做或没验证。
- 讨论中产生了新的决定，提醒站长把它记进 `docs/DECISIONS.md`。不要自行写入"站长已决定"。

## 自动检查（CI 会执行，不通过就不能合并）

提交前在本地运行，并报告每一项的实际结果：

```bash
node scripts/check-rules.mjs --base origin/main   # 仓库规则
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build
```

- `check-rules.mjs` 检查的规则包括：命名不得带工单号、发布号、日期；证据文件不得提交；文档和规则文件的长度；不得写入本机路径；测试不得读取源码；服务端不得使用 `Math.random`；原生 SQL 和 `!important` 的数量只能减少；已有迁移只能新增、不能修改；依赖变化需要确认；单次新增产品代码不超过 1000 行。
- 检查不通过时，修改代码，不要修改检查本身。只有站长明确同意后，才能修改 `scripts/check-rules.mjs`、`scripts/rules-baseline.json`、`.github/`、ESLint 配置；基线里的数字只能往小改。
- 依赖变化、迁移重写、超过 1000 行的大改动，需要站长在 PR 上加标签放行（`deps-approved`、`migration-rewrite-approved`、`large-change-approved`）。AI 不得自行加这些标签，也不得绕过检查。
- 任何结论都必须来自对当前代码实际运行的结果。不得引用历史版本、旧记录或"之前通过过"作为依据。

## 不能被自动检查、需要自觉遵守的

- 新增子系统，或者预计新增超过 1000 行产品代码时，先写设计说明（问题、方案、规模），站长同意后再动手。
- 测试要验证行为，每个功能至少覆盖一条成功路径和一条被拒绝的路径。
- 每次改动最多新增或修改一份文档。执行证据放在本机 `.local/` 或 PR 描述里，不写进仓库。
