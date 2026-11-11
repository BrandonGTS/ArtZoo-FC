# packages/db：数据库结构、迁移、后台任务

## 迁移

- **已有的迁移文件不许修改或删除。** 要改结构，就新建一个迁移。脚本会自动检查这一点。确实需要重写迁移的，必须由站长在 PR 上加标签放行。
- 新建迁移的方法：先修改 `schema.prisma`，再运行 `prisma migrate dev --create-only` 生成 SQL，检查生成的内容，需要的话手工修改。不要使用 `db push`。
- 部分唯一索引、CHECK 约束、触发器这类规则，`schema.prisma` 里写不出来，只能写在迁移的 SQL 里。每加一条，都要在 `schema.prisma` 对应的 model 旁边加一行注释，说明这条约束的名字和作用。否则后来的人看不到它。
- 时间字段一律使用 `@db.Timestamptz(3)`。
- 大表改列类型时，按三步走：先新增一列，再回填数据，最后切换使用新列。不要直接 `ALTER COLUMN TYPE`，那样会长时间锁表。
- 新的迁移必须在一个空的 PostgreSQL 上从头跑通，并且 `prisma migrate diff` 检查没有差异。
- 结构快照 `prisma/schema-snapshot.txt` 记录了跑完全部迁移后的完整结构（含约束、触发器、函数和初始数据）。改了迁移就运行 `pnpm db:snapshot --write` 更新它，和迁移放在同一个提交里；数据库测试会检查两者一致。

## 写代码

- 数据库客户端只通过 `getDatabase()` 获取，不要自己 `new PrismaClient`。
- 写原生 SQL 时，使用带参数的模板写法：``tx.$queryRaw`... ${值}` ``。不要新增 `$queryRawUnsafe` 或 `$executeRawUnsafe`，脚本会检查它们的数量。
- 需要随机数时，使用 `node:crypto`。

## 后台任务（worker 调用的维护函数）

- 每一条数据都要单独 try/catch。某一条出错，计入失败数量，然后继续处理下一条。
- 每个处理步骤也要各自独立，一个步骤失败，不能影响其他步骤执行。
- 日志只记录步骤名、记录 id、`error.name` 和错误码。不要记录错误的 message 或数据内容。
- 每次处理的数据量要设上限（`take`）。不要一次把整张表读出来。
