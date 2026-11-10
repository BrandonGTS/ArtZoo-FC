# plugins/astrbot_plugin_artzoo：QQ 机器人插件

## 与网站通信

- 插件和网站之间的每个请求，都要用 HMAC-SHA256 签名。签名内容包括时间戳、nonce、请求方法、请求路径，以及请求体的哈希。
- 比对签名时使用 `hmac.compare_digest`，不要用 `==`。
- 只允许通过 HTTPS 访问网站，不跟随重定向，也不走代理。
- 通信密钥从环境变量，或权限为 0400/0600 的私有文件中读取。不要写进代码，也不要写进日志。

## 发送消息

- **测试中不得发送真实的 QQ 消息。** 一律使用 mock。
- 如果发送结果不确定（超时、断线），把这条消息标记为未知状态，**不要重发**，以免群里收到重复消息。
- 各个群之间的配置互相独立；对已经停用的群，什么都不能发送。

## SDK

- `sdk.py` 依赖 qq-botpy 的内部实现，并通过哈希锁定了 SDK 的版本。要升级 SDK，必须先由站长同意，再按插件 README 里的步骤重新生成哈希。

## 测试

运行命令：

```bash
pnpm test:plugin   # 等同于 python3 -B -m unittest discover -s tests/qq-plugin
```

测试在 `tests/qq-plugin/`，需要 Python 3.11 以上，只用标准库，不联网。CI 每次都会运行。
