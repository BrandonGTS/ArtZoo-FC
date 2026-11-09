# apps/web/server：API 与服务端业务

本目录下每个业务模块都按同一种结构组织：

- `app/api/**/route.ts` 只负责转发请求，不写业务逻辑。
- `<模块>/http.ts` 负责请求校验、身份认证、限流和错误映射。
- `<模块>/service.ts` 负责业务逻辑和数据库事务。

新增接口时，先在同一模块，或者最相近的模块里找一个现成接口照着写，不要另起一套写法。

## 写操作（POST / PUT / PATCH / DELETE）必须依次做到

1. **校验请求来源。** JSON 请求调用 `validateOrigin`（在 `auth/http.ts`）。上传请求使用对应模块现成的校验函数，例如 `validatePhotoRequest`。
2. **读取会话。** 在读取请求体之前就确认已经登录。
3. **限流。** 来源统一用 `resolveRequestSource(request)` 获取，不要自己去解析请求头。
4. **在 service 里检查权限和归属。** 普通成员只能修改自己的内容。管理员操作要区分 `ADMIN` 和 `SUPER_ADMIN`。修改之前，在加锁之后重新读取一次数据，再做判断。

## 事务与并发

- 写事务统一使用 `ReadCommitted`，并沿用现有的 `maxWait` / `timeout` 设置。
- 同一个对象的并发修改，用 `lock(tx, '类型:id')` 串行化；只读路径使用 `lockShared`。这两个函数都在 `auth/service.ts`。
- 事务里不要做网络请求，也不要读写大文件。
- 涉及唯一性的业务规则（报名、签到等），数据库层面还有约束兜底。不要以为删掉代码里的检查就没事了，也不要绕开数据库约束。

## 错误、日志与时间

- 业务错误抛 `AccountError`，带上错误码和中文提示。
- 意料之外的错误交给 `logUnexpectedHttpError` 处理。日志里不能出现请求体、手机号、token、错误的 message 或 stack。
- 涉及北京时间的计算，统一使用 `packages/domain` 里的 `beijing-time`，不要手写 `+8` 小时。

## 测试要求

每个新接口至少要有这三条测试：成功路径、未登录或无权限被拒、操作别人的数据被拒。
