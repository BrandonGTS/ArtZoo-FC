# ADR-0003：外部发送不确定时保留 UNKNOWN 并禁止盲重发

日期：2026-11-05

状态：现状记录（源码基线 `1df5504`；未新增用户决策）

## 背景与现行选择

QQ 已收到消息但响应丢失时，网站和插件无法凭超时判断“没有发送”。当前采用网站[领取/开始/回执协议](../../packages/db/src/qq-official-notifications.ts) 与插件[持久发送账本](../../plugins/astrbot_plugin_artzoo/sender.py)：在 SDK 调用前持久预留，每个受控发送只调用一次，不确定结果留 UNKNOWN，后续只重试 ACK 而非重新发送。

插件复用现有认证客户端，通过[固定 SDK 适配器](../../plugins/astrbot_plugin_artzoo/sdk.py) 校验版本、类和源码，禁用重定向和隐式发送重试。完整普通 message id 与 group-scoped ref 缺一都不能假报完整成功；绑定、引用和群权限不能跨 app/bot/group 猜测或复用。

## 后果与保护

保守停止可能需要人工核对，但避免在断线时自动重复群消息。现有[拒绝恢复审计](../../plugins/astrbot_plugin_artzoo/production_policy.py) 只处理精确、经外部证据确认且指纹未变的拒绝，保留原历史；不是全局清 UNKNOWN。晚到或新不确定结果仍要保护。存在明确的 SAFE_PRE_SEND 证据时按现有窄规则恢复，与已发生或不确定 SDK 调用分开。

SQLite 账本必须随插件升级保留，不能删除、压缩或用旧备份覆盖以“恢复可发送”。预算、启用锚点、群停启、签名和最后发送复验都保留；测试发送及实际权限调整需要单独授权，不能由技术整改推导。

## 验证依据与局限

协议及本地测试方法见[插件 README](../../plugins/astrbot_plugin_artzoo/README.md)，既有恢复事实见[权限拒绝发布回执](../archive/20261027/qq-provider-permission-20261027-production.md)。这些是来源，不是本文新做的真实发送。mock 测试不证明运营商/QQ 平台权限或客户端视觉；本次未外发消息或改动账本。
