# ArtZoo 仓库计划摘要

ArtZoo 面向《最终幻想 XIV》公会的成员协作与社区交流。仓库计划入口采用本摘要，归纳模块目标、既定范围和长期维护方向；产品计划及历史保留在 [Space 开发计划与历史记录](https://chatgpt.com/space/page_5d5ef4ec2a7481918cc9f3bbf836a3d3)，具体批次、问题与验收结论统一查[唯一 QC 台账](first-release-readiness-progress.md)。

## 模块目标与范围

| 模块 | 目标与既定范围 | 规则与实现来源 |
| --- | --- | --- |
| 账号与成员 | 提供可信的注册、登录、个人资料与成员协作入口，保持参与身份、管理角色及账号生命周期的权限边界 | [账号契约](account-invitation-contract.md)、[账号生命周期](account-lifecycle-progress.md) |
| 活动与固定队 | 支持发布、席位报名、排期、签到及后续管理；普通单次、长期、线下和固定队沿各自的截止、计分与通知规则执行 | [活动管理规则](activity-management-rules.md)、[普通管理](ordinary-management-progress.md)、[长期管理](series-management-progress.md)、[队伍生命周期](team-lifecycle-progress.md) |
| 社区内容与媒体 | 支持相册与精选、日常交流、分享与资源、心愿和抽奖等既定内容，保持原图、派生图、公开投影及历史资格的边界 | [模块来源索引](continuous-development.md#模块目标与当前实现)、[业务权威来源与最新覆盖](working-rules/ui-and-business-reuse.md#业务权威来源与最新覆盖) |
| 官方活动 | 汇总官方活动、审核补时间并展示月历；同步与发布沿既有审核及启用范围执行 | [官方活动来源](continuous-development.md#模块目标与当前实现)、[官方活动规则](official-events-progress.md) |
| 后台与 QQ 联动 | 由独立 worker 承担获准后台任务，AstrBot 插件协作完成绑定、明确席位报名和活动通知；保持群隔离、发送去重及 UNKNOWN 保护 | [架构导览](ARCHITECTURE.md#后台任务与外部边界)、[QQ 规则与覆盖来源](working-rules/ui-and-business-reuse.md#业务权威来源与最新覆盖)、[发送不确定性 ADR](adr/0003-qq-uncertain-delivery.md) |

表中目标沿用既有产品范围。已取消功能保留原决定；缺人招募提醒及相关改期细则继续暂缓，后续范围按具体确认推进，见[后续队列与依赖](continuous-development.md#后续队列与依赖)和[历史决定与验证边界](continuous-development.md#历史决定与验证边界)。

## 长期维护方向

- 保持 Web 服务端鉴权、domain 共享契约、db 数据访问、media 媒体处理、独立 worker 与 QQ 插件的职责，按[架构导览](ARCHITECTURE.md)和已有 ADR 演进。
- 复用已确认的页面、控件和业务规则；查询、媒体、前端加载与资源优化由实际反馈驱动，保留已有正确性和可见范围，依据见[模块来源索引](continuous-development.md)与[复用细则](working-rules/ui-and-business-reuse.md)。
- 通过追加迁移、旧新程序兼容验证和可恢复的发布流程维护数据一致性；时间类型、约束和历史数据处理按具体风险与目标单独评估，见[贡献指南](../CONTRIBUTING.md#数据与迁移规范)。
- 随获准改动维护定向测试、架构与来源文档，保留历史证据和兼容入口；开发与交付流程见[贡献指南](../CONTRIBUTING.md)，操作条件见[开发指南](development.md)。

这些方向用于说明持续维护原则，具体功能、执行批次与操作权限以当次确认及对应记录为准。

## 如何判断进展

| 维度 | 判断依据 |
| --- | --- |
| 规划 | Space 中的产品目标与明确决定；建议或暂缓事项不自动成为执行任务 |
| 实现 | [模块来源索引](continuous-development.md)指向的代码、规则和相应验证记录 |
| 验收 | [唯一 QC 台账](first-release-readiness-progress.md)中针对具体编号或冻结批次的用户明确确认 |
| 部署 | [记录目录](records-index.md)中的对应环境发布回执；本地检查、代码提交或 Git 同步分别记录 |

本摘要只维护目标、范围与来源。动态计数、候选版本和部署状态按上述入口核实；源码、模块契约与后续明确确认共同决定具体边界，不从旧文档的“下一步”恢复任务。
