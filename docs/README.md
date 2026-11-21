# 文档索引

这里列出仓库里的所有文档：每份讲什么、什么时候需要读。

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [PLAN.md](PLAN.md) | 功能清单；新站路线与各阶段状态；**所有待定问题和技术改进的唯一清单** | 想了解全貌、进度，或者想知道还有什么没定 |
| [DECISIONS.md](DECISIONS.md) | 站长已经做出的决定 | 动手做任何事之前；和它冲突的做法一律不做 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 系统组成、代码分层、请求怎么处理、数据规则落在哪里、后台任务、运行与部署结构、配置项 | 改代码之前，尤其是跨模块的改动 |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 发版、回退、启停、备份与恢复、搭建新站点、报错处理（会随发布包一起交付） | 在服务器上做任何操作之前 |
| [HOME_WSL_SETUP.md](HOME_WSL_SETUP.md) | 家庭 Windows + 两个 WSL 的一次性环境配置与撤销 | 新装或重建家庭部署电脑时 |
| [adr/](adr/) | 重要技术设计的取舍记录（并发协调、抽奖、QQ 发送、媒体文件身份） | 想改锁、抽奖、QQ 发送、媒体删除这类核心机制之前 |
| [TASK_TEMPLATE.md](TASK_TEMPLATE.md) | 给 AI 布置任务用的模板 | 每次布置任务时 |
| [rules/accounts.md](rules/accounts.md) | 身份与角色、邀请、注册、登录、资料、停用、管理员任免、QQ 绑定 | 改账号或权限相关功能之前 |
| [rules/activities.md](rules/activities.md) | 单次、长期、线下活动，报名退出，到场登记，处罚点数，申诉，通知 | 改活动相关功能之前 |
| [rules/wishes.md](rules/wishes.md) | 心愿的发布、兴趣、留言、转活动、删除 | 改心愿功能之前 |
| [rules/content-moderation.md](rules/content-moderation.md) | 各类内容由谁删除、违规删除流程、审计记录 | 改删除或治理功能之前 |
| [design/ui-guidelines.md](design/ui-guidelines.md) | 配色、字体、卡片、列表控件、菜单、反馈、文案、无障碍的规范和基准组件 | 改页面、控件或样式之前 |

目录之外还有两份说明：测试见 `tests/README.md`，QQ 插件见 `plugins/astrbot_plugin_artzoo/README.md`。

## 维护约定

- **只写现在的状态**：文档描述的是代码当前的行为和当前的规则。历史过程、验收记录、执行证据都不写进来，需要追溯时看 git 提交记录和 PR，或者去只读的旧仓库查。方案比较这类设计取舍写成 ADR。
- **待办只记一处**：待定问题和技术改进只写在 PLAN 第四、五节，其他文档不另列清单。
- **文档和代码对不上时**：不要自己判断哪边是对的，先报告给站长，由站长决定改文档还是改代码。
- **操作步骤只写在 DEPLOYMENT**：ARCHITECTURE 讲结构和原因，DEPLOYMENT 讲怎么操作，同一件事不在两处各写一遍。
- **每份文档不超过 100 KB**：超过这个大小，CI 会报错。
