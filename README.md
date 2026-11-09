# ArtZoo

这是《最终幻想 XIV》公会 ArtZoo 的网站，主要功能包括：

- 成员与账号管理
- 活动与固定队
- 相册、日常、知识库、心愿、抽奖等社区内容
- QQ 机器人联动

## 环境要求

- Node.js 24（具体版本见 `.node-version`）
- pnpm 12.9.1
- Python 3（用于 QQ 插件和一些辅助脚本）

## 常用命令

```bash
pnpm install --frozen-lockfile   # 按 lockfile 安装依赖
pnpm prepare:code                # 生成 Prisma 客户端，编译共享包
pnpm typecheck                   # 类型检查
pnpm lint                        # 代码规范检查
pnpm build                       # 构建生产版本
pnpm dev:web                     # 本地开发，访问 http://localhost:3100
```

## 目录

```text
apps/web/          页面、API、服务端业务与鉴权
apps/worker/       后台任务进程
packages/domain/   共享规则与类型
packages/db/       数据访问、Prisma schema 与迁移
packages/media/    图片处理
plugins/           QQ 机器人插件（Python）
docs/              架构、业务规则与设计规范
```

## 说明

- 本仓库由旧仓库 `artzoo-next` 整理而来，新站从空库起步。
- 媒体文件存储在服务器本地磁盘。
- AI 助手的协作规则见 `AGENTS.md`。
