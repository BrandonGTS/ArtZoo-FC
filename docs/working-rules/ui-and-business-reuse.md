# 设计与业务复用细则

这是根AGENTS指定的**按需必读规则**，不是进度或待修台账。进行相关UI/交互/共享组件或业务改动前，先读对应章节及最新模块确认。规则从原AGENTS迁出，不授权批量重构；“已实现/尚未通用封装”等源码说明需与本轮实际代码核对，不能据旧描述冒称当前运行状态。完整原始措辞及来源行号保留在[覆盖清单](../archive/20261027/agents-rules-map.json)。

## 业务权威来源与最新覆盖

- 相册/游客联系：先读[相册整合](../album-integration-progress.md)、[唯一台账](../first-release-readiness-progress.md)最新确认；唯一visibility，公开上传必要告知不删，匿名仅有效入选派生图，撤权后旧URL失效，不能开放整册/原图。游客留言的必填、频控、幂等和仅管理员读取保持，普通失败/未知需保留原请求。
- 活动/队伍：游戏单次报名截止为开始前30分钟；长期仅首次成团前公开报名，线下手选截止。普通单次签到仅组织者[开始,结束)，二次确认、截止新opt-in自动处罚及申诉以[QC31最终规则](../archive/20261025/qc-20261025-signin-auto-absence-delivery.md)为准，不恢复旧撤销/手动未到场按钮，不扩长期/固定队。固定队CD为北京时间周二16:00，所有权不等于占席；参与记录不套普通单次处罚。[长期编辑](../ordinary-edits-progress.md)、[固定队生命周期](../team-lifecycle-progress.md)及后续台账优先于旧批次表述。
- 抽奖：下述MANUAL/AUTO、未来统计月、退出不恢复等约束需结合[月签到抽奖](../lottery-monthly-update.md)和[发布恢复](../lottery-publication-fixes.md)读取，保持原幂等请求/结果固定，不补抽或改历史结果。
- 日常/公告/游客：以[日常详情正式修复](../archive/20261026/daily-detail-controls-20261026-production.md)、[完整正式发布](../archive/20261026/production-full-release-20261026.md)及当前契约为准；游客留言纯文字，作者自删和治理分离，必填理由仅用于原治理能力，历史权限不扩大。
- QQ：先读[机器人管理发布](../archive/20261027/bot-management-20261027-production.md)、[权限拒绝持久恢复](../archive/20261027/qq-provider-permission-20261027-production.md)及[最新等价审查](../archive/20261027/bot-management-equivalent-audit-20261027.md)。保留超管端到端权限、双向群证明、group-scoped身份/ref、每群启停/锚点、签名、预算/去重/UNKNOWN及恢复审计；模板纯值、动态提醒、多群和测试发送不得删减。真实采用不伪报、测试发送由本人确认，不补发历史。

## 设计与交互复用基准

### 1. 卡片动效：仅以首页和日常交流已验收卡片为基准

共享实现为[HomeCardSurface / HOME_CARD_MOTION](../../apps/web/components/home-card-surface.tsx)，样式为[home-card-surface.css](../../apps/web/components/home-card-surface.css)的`.home-card-surface`和`.home-card-motion`。基准调用：`/`的[HomeActivityCard](../../apps/web/components/home-activities.tsx)使用默认`regular`；首页日常动态和`/daily`列表共同使用[DailyHomeCard](../../apps/web/components/daily/daily-home-card.tsx)，分别传`flat`、`feed`。不要从月历调用或效果反推已验收参数。


**详情页不继承列表卡片动效：**详情页的信息卡、讨论卡及关联内容卡默认不继承列表卡片的入场弹摆、浮动、倾斜、鼠标跟随等卡片动效。复用时将视觉外观、信息结构、点击功能与动效分离：复用纸卡/Tag/图标/字段/链接，不因复用组件把运动包装一起带入详情。`HomeCardSurface`本身包含运动与整卡激活行为，不能将直接包裹它当成纯样式复用，也不能把临时交互暂停误当成详情默认静态方案而影响原点击能力；尚无对应分离封装时，在后续获准开发中按需组合/提取，不虚称已经实现。

[心愿详情](../../apps/web/components/wishes/wish-detail.tsx)的**全部卡片**禁用上述动效，包括信息、讨论及关联活动等卡片；关联活动卡只复用第3项首页“近期可参与活动”卡片的样式、信息和点击能力，保持原跳转及内部控件可操作，不带入首页卡片运动。首页、[成员名册](../../apps/web/components/members/member-directory.tsx)、[心愿列表](../../apps/web/components/wishes/wish-browser.tsx)仍按已验收首页/日常基准进行尺寸适配动效；适配遵守下述实际参数及已实现/后续原则的区别，不改首页已确认基准，也不扩改其他已验收页面。

现有尺寸由布局及内容决定，没有固定卡片宽高比：首页活动卡的`.activity-grid`在[globals.css](../../apps/web/app/globals.css)为三等列、gap16，在[home-activities.css](../../apps/web/components/home-activities.css)1120/760px窗口断点降为二/一列，卡体padding24、min-height218、同排等高；首页日常位于`.home-secondary`的2fr列（另一列1fr，gap24，600px以下单列）；日常列表为`.daily-flow`单列、正文与图片完整展示，高度随内容增长。日常卡的[daily.css](../../apps/web/components/daily/daily.css)规定article min-height152、卡体padding24（600px以下20），这不是固定总高度，也不能用来代替运行时测量。首页预览与列表的内容裁切差异继续保留。

以下是**已实现映射**，仅适用于实际接入并允许上述动效的首页/列表卡片，不要求详情卡接入；每次鼠标进入/移动从静止外框`getBoundingClientRect()`取得实际`W/H`（px），不测已变换纸面，以免反馈抖动。指针坐标归一化为`x/y∈[-1,1]`；令`L=max(W,H)`：

| 当前profile / 基准 | 旋转缩放s | 入场角振幅 | 跟随目标角 | 位移目标 |
| --- | --- | --- | --- | --- |
| regular / 首页近期活动 | 1 | 0.8° | -x×1.25° | tx=-x×4px，ty=-y×3px-2px |
| flat / 首页日常预览 | 1 | 0.35° | -x×1.25° | 同上 |
| feed / 日常列表短卡及长卡 | min(1,320/L) | 0.35°×s | -x×1.25°×s | 同上，平移不按尺寸缩放 |

320是现有长边缩放常量，不是宽高比阈值。feed在L≤320时s=1，L>320按长边反比收小旋转；宽度大于高度时，正文加长但H仍≤W，s不会再变化，H超过W后才随高度继续减小。regular/flat没有运行时尺寸缩放；不存在长宽比分档、自动profile选择或自适应平移算法。长宽比只通过W/H及其最大值影响feed，不得写成另一套已经实现的算法。

共同参数保持：stiffness190、damping20；入场给竖直速度`vy-=75`（不是上移75px），角振荡420ms内2次、振幅随`1-progress`衰减；每帧dt最多0.032秒，静止阈值0.025。最终渲染平移分别限制在±7px/±9px、角度±2.8°，transform-origin为center。只在mouse、可hover、精细指针且未要求减少动态时触发；减少动态/粗指针/无hover无该动效。重复进入重启有限入场包络，不累计旋转冲量。

移出外框或pointercancel将目标归零并由弹簧恢复，完全静止后清除transform/will-change；不要在内部头像、链接、按钮或图片hover时重置、重新入场或突然归位。真正进入交互暂停状态才立即reset：首页日常为回复区展开；feed为回复展开、编辑、discussionLocked或editLocked。保留原点击隔离/选择文字/拖动/修饰键行为：feed的`navigation='links'`不增加整卡空白跳转，首页原可点卡片保持其行为。

**后续适配原则，非新增已实现算法：**新尺寸先量实际W/H及长宽比，按相近已验收形态选择既有profile；旋转造成的边缘位移随卡片尺寸增大，尤其长宽比极端时不能只比较角度。以实测边缘位移和交互稳定性决定获准范围内的参数适配，不凭空新增阈值，不改现有基准参数。按本次动效改动的实际影响选择必要定向检查，包括短/长内容和相关窄宽度、空白→头像→按钮→空白连续hover、真正移出恢复、回复/编辑暂停、反复进入不累积、减少动态/触屏无hover及点击不误导航；只检查本次实际影响，不借此新增全站整改。

### 2. 日常动态：复用完整组件、内部样式和交互链

基准为首页日常动态与`/daily`已验收列表。[DailyHomeCard](../../apps/web/components/daily/daily-home-card.tsx)是两页实际共用卡片；[DailySection](../../apps/web/components/daily/daily-section.tsx)与[DailyFeed](../../apps/web/components/daily/daily-feed.tsx)负责各自容器/取数。沿用`variant='home'/'feed'`处理首页预览裁切与列表完整正文/全部图片，保护首页尺寸；不能只拷贝纸卡外观。

复用[DailyComments](../../apps/web/components/daily/daily-comments.tsx)、[DailyInlineReply](../../apps/web/components/daily/daily-inline-reply.tsx)、[DailyReplyComposer](../../apps/web/components/daily/daily-reply-composer.tsx)的评论树、回复对象、独立输入区、发布状态及成功后收起当前子回复/失败保留草稿行为；复用[DailyComposer](../../apps/web/components/daily/daily-composer.tsx)的发布/编辑和`variant='feed'`工具栏，以及[MentionInput](../../apps/web/components/daily/mention-input.tsx)、[DailyToolbarIcon](../../apps/web/components/daily/daily-toolbar-icon.tsx)、[DailyActionIcon](../../apps/web/components/daily/daily-action-icon.tsx)。图片、@成员、表情顺序和上传/预览/选择/禁用/结果不确定时重试均沿现有实现；发布动态、发表回复和点赞需使用原命令链[useDailyCommand](../../apps/web/components/daily/use-command.ts)，不另写仅视觉相同的替身。

样式依据[daily.css](../../apps/web/components/daily/daily.css)的`.daily-home-*`、`.daily-feed-*`、`.daily-inline-reply`、`.daily-composer-footer-compact`、`.daily-emoji-picker`和`.daily-mention-popup`，包括嵌套缩进及窄输入区适配。[DailyPostMenu](../../apps/web/components/daily/daily-post-menu.tsx)/[DailyDeleteMenu](../../apps/web/components/daily/daily-delete-menu.tsx)是右上角菜单和确认入口。仅作者可编辑自己的动态，管理员不得修改他人动态；当前feed接入修改，首页已有菜单展示保持，不因复用自动扩入口。作者删除自己的动态/评论，管理员沿现有违规处理入口、必填原因和审计，不扩大权限。删除评论连同其后代退出展示，旁支保留；不能恢复旧墓碑分支。权限与软删除由[DailyService](../../apps/web/server/daily/service.ts)及[契约](../../apps/web/server/daily/contract.ts)裁定，保留canEdit/canDelete/canModerate、revision、重复提交保护及现有通知范围，不把前端隐藏当作服务端授权。

### 3. 活动摘要：以首页“近期可参与活动”卡片为基准

基准是`/`的[HomeActivityCard / HomeActivityFactIcon](../../apps/web/components/home-activities.tsx)及[home-activities.css](../../apps/web/components/home-activities.css)：`.home-activity-title`、`.home-activity-fact`、`.home-activity-time`、`.home-activity-count`、`.home-activity-participants`。类型Tag在前、标题在后同一行垂直居中（gap8），Tag不压缩，标题24px/34px、无下划线，长标题/窄屏合理换行；事实行icon20px、不压缩，与文字gap8，对齐与间距沿基准。同类信息使用相同icon：期次用`HomeActivityFactIcon(period)`，具体副本用`duty`，地点用`location`，日期时间用`apps/web/public/artzoo/icons/calendar-days.svg`，人数用`apps/web/public/artzoo/icons/users.svg`。字段及摘要时间呈现按已确认业务选择，不为补齐图标硬加字段，不把我的活动两栏已确认时间格式改成首页格式。

Tag直接复用[ActivityTypeTag](../../apps/web/components/activities/activity-type-tag.tsx)和[getActivityTypeAppearance](../../apps/web/components/activities/activity-type-appearance.ts)的scene/mode映射：普通单次colorPrimary、线下单次colorInfo、普通长期colorError、线下长期colorWarning，均实底白字；不把普通单次绿色套给全部类型，也不新增固定队/状态Tag映射。该标题行原则继续用于活动详情、我参与的、我发布的等既有同类展示，不用于发布表单类型选择；我发布的状态保留原同行位置。`ActivityTypeTag`、`ActivityAvatars`已有共享封装；`HomeActivityCard`及事实SVG仍为文件内函数，不能虚称所有摘要页已共用它们，后续按需提取时保持已验收首页效果；详情页关联活动复用这里的样式/信息/点击能力时，按第1项明确排除卡片动效。

### 4. 分类切换：以相册列表文字Tabs为基准

凡后续获准开发需要子分类/分类切换时，采用`/albums`的[AlbumBrowser / BrowserContent](../../apps/web/components/albums/album-browser.tsx)内AntD `Tabs type='line'`结构及[albums.css](../../apps/web/components/albums/albums.css)列表专用选择器：`.album-browser-filterbar`、`.album-browser-tabs`、`.album-browser-tabs-header`、`.album-browser-tabs-indicator`。文字700加粗、本站heading/primary配色；1px浅长线贯穿本页内容区域且不超出，选中短线4px高/2px圆角、宽度随实际选中文字，不能含Tab横向padding或固定28/72px。当前tab横向padding0、`indicator={{align:'center'}}`，52px导航行、长线top49.5px及短线底部位置使两线中心同为行内50px；适配行高/换行时维护中心对齐，不盲抄绝对top。

名称/数量由业务提供，不固定4项或4字；不能改成填充式分段按钮。保持选中、hover、键盘切换及窄屏可用状态。当前是相册页面内结构和作用域CSS，尚无通用分类组件；后续按需封装/适配，不直接更改相册基准或全站套用相册页面类名。

**2026-10-21 用户QC补充规范：**一级及子分类须完整复用上述已验收相册基准，包含字号、相对页标题的位置和间距、选中短线以及切换时短线移动动画，不能只复制静态外观。实际依据是`.albums-content`的标题/筛选垂直间距及`.album-browser-tabs`的字号、行高、行距和AntD原生ink-bar切换；已有共享[CollectionFilters](../../apps/web/components/collection-controls.tsx)/[collection-controls.css](../../apps/web/components/collection-controls.css)应沿此基准修正，检查最终computed及切换过程，避免全站样式覆盖字号或关闭动画。保留文字实际宽度、短长线中心对齐、窄屏与键盘行为；不为适配成员名册/心愿板而重设计已验收相册页。

### 5. 搜索框：以相册搜索为基准

全站后续获准开发搜索时复用[AlbumBrowser](../../apps/web/components/albums/album-browser.tsx)的AntD `Input.Search`外观和原默认/hover/focus/输入/清空/禁用等适用状态，主题继承[Providers](../../apps/web/components/providers.tsx)，局部样式参考[albums.css](../../apps/web/components/albums/albums.css)的`.album-browser-search`、`.album-search-clear`。非空输入显示本站深色醒目`×`（24×24点击区域、hover primary），空输入隐藏；使用`allowClear`的clearIcon和onClear，不另做一直可见/只有视觉的清空按钮。

输入草稿`query`与已提交条件`search`的区别、点击搜索/回车提交、清空同时清除输入和实际搜索条件并回到首批结果沿现有交互；其余分类过滤保持。placeholder/aria-label可按场景替换，搜索范围由业务定义；宽度/换行按容器适配，不强制所有页面为相册360px或仅搜索名称。当前尚无独立共享搜索封装，后续按需提取，不能只复制样式漏掉清空后的数据刷新，也不扩大数据可见性或通知。

### 6. 活动完整信息：以活动详情的“活动详情”卡片为基准

基准为`/activities/[id]`的[ActivityDetailContent](../../apps/web/components/activities/activity-detail.tsx)中`ActivityPaper.activity-detail-copy`，基础纸卡来自[ActivityPaper](../../apps/web/components/activities/activity-ui.tsx)。沿用[activities.css](../../apps/web/components/activities/activities.css)的`.activity-facts`（dl/dt/dd、标签列72px、行内gap12/行间gap8）、`.activity-description`、`.activity-detail-title`，及[activity-detail-refinement.css](../../apps/web/components/activities/activity-detail-refinement.css)的`.activity-detail-fact-group`、`.activity-detail-field-label`等：组内gap12、分组间1px线/padding-top24、组标题16px/26px加粗、长值自然换行。

以现有“基本信息、时间信息、活动安排、参与要求”和按业务出现的期次分组呈现分类及字段；普通/线下/长期各自按既有契约选择字段，保留具体副本/副本类型/队伍构成、组织者、地点/集合说明/人数、完整北京时间及说明等对应格式。分组说明由[splitActivityDescription](../../apps/web/components/activities/activity-description.ts)及[ActivitySeriesPeriods](../../apps/web/components/activities/activity-series-controls.tsx)处理，不复制摘要卡字段省略来代替完整信息。此为第3项摘要之外的完整信息样式，不能将摘要icon行硬套全部详情字段。`ActivityPaper`已共享，分组内容仍在详情组件内，按需复用而非宣称已有完整字段通用渲染器。

### 7. 队伍构成与报名：以活动详情队伍构成卡片为基准

基准为[ActivityDetailContent](../../apps/web/components/activities/activity-detail.tsx)的`ActivityPaper.activity-detail-participation`：`.activity-registration-grid`、`.activity-registration-seat`、`.activity-registration-seat-empty/-occupied`、`.activity-seat-label`、`.activity-detail-seat-icon`，以及报名/换位Modal `activity-detail-registration-modal`、`.activity-registration-target`、`.activity-registration-job-grid`、`.activity-detail-confirm-actions`。样式来自[activities.css](../../apps/web/components/activities/activities.css)及[activity-detail-refinement.css](../../apps/web/components/activities/activity-detail-refinement.css)，空位/占用/选中/禁用、成员资料链接、职业文字及48px席位icon沿基准，职业/职责复用[RequirementIcon / requirementLabel](../../apps/web/components/activities/activity-ui.tsx)。按现有类型选择席位或线下报名入口，不将发布表单的[SeatPicker](../../apps/web/components/activities/seat-picker.tsx)误当详情报名组件。

保留选空席位→原确认报名/确认换席位、符合席位要求的职业选择、提交中锁定、状态变更重新取数、换位预期席位/版本和结果不确定时原请求重试；普通单次退出复用[ActivityManagementControls](../../apps/web/components/activities/activity-management-controls.tsx)，线下/长期退出复用[ActivityOrdinaryManagementControls](../../apps/web/components/activities/activity-ordinary-management-controls.tsx)。退出释放席位并保留历史，已取消/截止/开场及成团状态的展示和权限沿原逻辑；确认中的处罚/时间跨界重确认保持，不把单次退出条件套给线下或长期。

逻辑依据是[ActivityService](../../apps/web/server/activities/service.ts)、[management.ts](../../apps/web/server/activities/management.ts)、[ordinary-management.ts](../../apps/web/server/activities/ordinary-management.ts)、[活动契约](../../packages/domain/src/activity-contract.ts)、[普通单次管理规则](../activity-management-rules.md)及最新已确认补充，不在设计复用中重新定义时间、权限、计分或通知。共享的是现有辅助/管理组件；整个队伍构成/报名表单尚内联在详情文件，后续按需组合，不能声称已独立封装或复制一份绕过服务端校验。

### 8. 分页：以日常交流底部分页为基准

所有后续获准开发的列表分页复用`/daily`的[DailyFeed / OwnedFeed](../../apps/web/components/daily/daily-feed.tsx)内`nav.daily-page-navigation`和[daily.css](../../apps/web/components/daily/daily.css)同名规则：中间只读当前页/总页数（700、24px/40px），左右44×44文本按钮内26×26 SVG，stroke3且端点/转角round；无边框/填充底/阴影，hover/active使用primary，禁用secondary且opacity0.35，保留键盘focus-visible。桌面gap24、600px以下gap18，页码居中，不添加页码输入跳转或额外页号列表。

保留上一页/下一页可访问名称、中间aria-live、加载时禁用、首末页禁用和业务页码校正；空结果、删除使末页变空、发布后位置等由页面数据逻辑处理，不能仅复制控件使页码失真。每页数量由页面业务确定，日常每页10条不构成全站限制，也不为本规范立即替换现有加载方式。当前分页仍在DailyFeed内，没有独立通用分页组件；后续按需封装并维持已验收日常控件和排序规则。


### 9. 弹出菜单与删除确认（2026-10-21 用户QC补充规范）

弹出菜单危险操作采用站点已确认警告配色，沿[Providers](../../apps/web/components/providers.tsx)的Menu危险项token及已验收日常三角菜单实现，不额外添加操作项边框或阴影。本轮相册删除、单张照片删除及批量照片删除均无需输入原因，仅做二次确认；保留删除后果、批量数量、提交中锁定及原服务端权限/版本检查。此项不移除其他明确要求业务原因的流程，例如日常违规治理，不扩大删除权限或追溯清理历史数据。确认Modal负责用户确认后果，不能代替操作结果消息。

#### 危险与警示操作的统一样式

- **覆盖与语义**：所有新增或修改的危险/警示操作均适用，包括普通独立按钮、菜单项及Modal内的确认按钮。按操作后果选择原有危险或警示语义，分别复用站点已确认的对应样式与token，不全部改成同一种颜色，不自行指定未确认色值。危险与警示不能只靠颜色区分，保留明确操作名称、必要后果提示及可访问名称。
- **按形态复用**：先查[Providers](../../apps/web/components/providers.tsx)及对应共享组件和已确认调用。菜单复用[OperationMenu](../../apps/web/components/operation-menu.tsx)与[菜单CSS](../../apps/web/components/operation-menu.css)，并核对Providers的Menu危险项token；独立按钮沿已确认的实体/文字按钮形态和Button语义token；弹窗确认按钮沿对应业务已确认的确认样式，不能把菜单项的透明、无边框形式强加给实体按钮，也不能只加`danger`就认定外观已适配。Menu、Button及Modal各有作用范围，不能假设一处token配置自动覆盖其他形态。
- **装饰与焦点**：不直接沿用未经适配的组件库默认外观，不自行叠加阴影、描边或渐变；实体按钮原有已确认边框、弹层/弹窗容器原有外观保留，不以去除额外装饰为由一律清零。保留各控件的可见键盘焦点、键盘操作、可访问名称和禁用语义，不把必要焦点提示当作多余阴影删除。[既有表单焦点实现](../../apps/web/components/control-focus-provider.tsx)仅覆盖其支持的表单控件，按钮与菜单另核自己的focus-visible，不假定该Provider统一覆盖。
- **实现现状与缺口**：[日常确认按钮](../../apps/web/components/daily/daily-post-menu.tsx)及[daily.css](../../apps/web/components/daily/daily.css)已有局部危险按钮去阴影处理；这不等于全站独立危险/警示按钮或Modal确认按钮已有统一封装。先核实际共享封装和调用，缺少相应形态/语义的已确认实现时，指出缺口，在获得该实现范围授权后统一封装/适配；不得虚称已经实现，不借规范更新修改应用代码或全站扫改。
- **检查与业务保护**：在获准UI改动的实际页面检查默认、首次hover、active、disabled、loading、focus/键盘focus-visible及弹窗打开后的对应状态，核最终样式，不能仅凭token名称或静态截图判通过。loading检查提交锁与本站既定等待视觉，不新增旋转加载视觉。保留二次确认、适用的必填业务原因、权限/版本检查、提交锁与防重复；取消不提交，样式复用不删减确认语义或扩大操作权限。

### 10. 操作反馈：统一活动创建时的AntD浮动消息（2026-10-21 用户QC补充规范）

错误、警示、成功等操作反馈统一复用[useFeedbackMessage](../../apps/web/components/use-feedback-message.ts)，基准调用是[ActivityPublisher](../../apps/web/components/activities/activity-publisher.tsx)。使用Ant Design Message浮动组件，按语义选择状态，沿用上方居中、top24、5秒或点击消失、hover不延时及站点主题外观；新增所需语义时在该共享封装中最小扩展，保持既有成功/错误样式。不要自行制作红色内联错误、Alert或另一套结果反馈样式。保留表单自身必要的字段校验与确认Modal，二次确认和结果反馈分开。真实权限/公开告知门槛失败应显示原原因，不能以统一消息为由配置告知、解除门槛或扩大公开范围。

## 通用交互与报名边界

1. **统一三角操作菜单（2026-10-22第二轮用户最新覆盖）**：全站操作三角菜单完整复用正式活动信息卡的入口、弹层、普通/警告操作按钮颜色与排版及默认/首次hover/展开/选中/禁用/键盘focus状态。鼠标hover展开，保留触屏点击、键盘打开/关闭和外部/Escape关闭；开关与aria-expanded同步，菜单内部操作不冒泡打开整卡。此项替代此前click-only约定，不恢复到仅点击。危险操作仍保留二次确认和适用业务原因，内部操作项不另画额外边框阴影，不因视觉复用扩权。奖品详情折叠三角、分页箭头和表单选择控件不属于操作菜单，不改为hover折叠。
2. **浏览器输入记忆**：全站普通表单及独立输入默认`autocomplete="off"`，包括验证码；账号和密码保留正确的`username`、`current-password`、`new-password`语义。业务搜索建议、成员/职业选择建议、编辑回填和结果不确定时草稿保护不受影响。不删除浏览器历史，不修改安全策略，不承诺浏览器/密码管理器必定服从；验证码不再使用`one-time-code`提示。
3. **统一等待视觉**：顶部常驻全宽4px站点绿色线，其下约2px不定百分比加载条只表示用户主动跳转、搜索、提交等等待；并发主动操作全部结束才收起，成功/失败/取消/卸载正确清理。后台轮询不触发，不显示假精确进度。按钮/操作不再额外显示旋转加载视觉，但防重复提交、请求锁、权限和禁用语义必须保留；不可用状态不使用短暂红色禁止cursor。失败沿用第10项统一消息，不重复轰炸。
4. **分页空位**：明确总页数小于等于1时不渲染分页或外部占位；不改变每页数量、排序和服务端分页。只有hasMore的接口不得伪造总页数；首批且无下一批时隐藏，后续批次仍保留返回能力。
5. **本轮页面特例**：列表动效只按第1项适配；抽奖宽卡随奖品展开尺寸适配，发布抽奖/心愿实时预览为静态，详情卡仍无卡片动效。固定队列表构成席位采用无填充边框，不推广到详情；固定队招募详情与“我的队伍”排期工作区分开。关联相册自动名称“活动关联 - 当前活动名”仅用于新发布，不追改旧相册名称、归类或历史数据。


6. **活动报名与截止（2026-10-22用户重申）**：游戏内单次活动的报名截止自动设为开始前30分钟。游戏内长期活动只有首期首次成团前的一次公开报名，截止自动设为首期开始前30分钟；成团后锁定并沿用成员名单，后续期次没有新报名环节，不逐期重开报名。线下活动的报名截止由发起者手动选择，沿既有校验，不套用游戏自动前30分钟。H7自动勾选开始日星期仅处理重复排期，不改变上述报名规则。后续记录保留registrationClosesAt等日期字段不表示业务上开放报名，核对时必须同时查前端入口、系列状态与服务端报名守卫；不得把截止改为全部手选或以生成期次为由新增各期报名。依据用户重申消息Sentinel_3f7033ce7d1081918e50ba228de56fff；此前“全部手选／后续各期报名”的建议已撤回，不能当成待决规则或实施依据。

## 删除治理与抽奖等业务例外

1. **普通自删与管理员治理分离**：只在原本已存在管理员删除权限的地方，于三角操作菜单最底部显示“违规删除”，沿用既有治理理由、审计、通知与计分边界。普通作者可删除本人内容的原权限不变，普通自删只二次确认、无需原因；管理员本人具备普通作者删除资格时可选择普通自删或既有治理操作，不能只因isAdmin强制普通自删填原因。管理员对他人或依据治理权限删除仍校验角色与必填理由；协作稿既有作者删除限制保留。服务端从真实身份、目标及所选操作校验，不能信任客户端mode绕过权限/原因，不扩大原无管理员删除能力的地方。消息删除同样先二次确认，取消不发删除请求，不新增理由。
2. **抽奖类型与参与方式**：新发布普通抽奖固定MANUAL，月签到抽奖固定AUTO，前端只读随类型同步，服务端拒绝错配。AUTO不允许首次手动加入，也不允许退出后手动重新加入或恢复自动参与；退出记录保留，自动维护不得加回。普通MANUAL既有报名/退出规则保持。历史抽奖不重写；已发起/结果不确定的原请求必须保留原幂等键与内容，不能通过重新规范化或丢弃恢复记录造成重复发布，不补历史通知或改变已公布结果。
3. **月签到设置**：只允许未来统计月份，当前月及过去月份禁止，前端月份禁选/提交校验/消息与后端“统计月开始前设置”一致。N按所选统计月份实际日数限制，含大小月和闰年，前后端校验一致，无默认N；不以发布当月天数代替统计月，不放宽当月中途发布。保持月底统计/次月开奖、含第N天、每人最多一份、均等随机及原资格规则，不新增权重或自动生成下一月。
4. **分页位置**：总页数<=1继续无分页/无占位。上一页/下一页更新数据后尽量把分页控件保持在点击时的viewport位置，尊重实际文档可滚动边界，不把分页永久fixed、不用大量空白维持高度，不改变原页容量/排序/权限。保留首末页、防重复与失败处理。
5. **本轮复用与局部布局**：抽奖标题搜索only，服务端先过滤再计数分页，仍每页5条和原分类/排序；内容分享搜索与分类同行。抽奖基本/时间字段标签在上控件在下，奖品仍图片+名称+份数横向组合、各字段标签在其控件上。固定队列表构成/需求独立撑满卡片可用宽，保留2x4、最多8需求一行、纯边框和固定卡高。心愿仅移除指定两条标题下分割线，不改正式活动基准。奖品详情仍点击折叠，只修首次hover闪框。点赞仅让目标按钮反馈/锁定，不让相邻回复图标无关闪动，不解除防重复。顶部4px常驻绿线有无滚动条均满viewport且不横溢，等待条原语义保持。全站日期/纯月份选择器中文化，保持存储值、时区、截止和排期规则。

首次hover/点击瞬态问题必须有本次实际浏览器证据；未复现要准确说明，不能用静态图代替。业务写入测试保持隔离，检查与交付使用本次确认的范围和冻结编号；真实外发、Git同步和部署分别服从当次授权，不沿用旧批次禁止或批准。

## 共享实时时钟组件规范

所有需要显示实时北京时间的位置统一复用 apps/web/components/activities/beijing-clock.tsx 的 BeijingClock，不另写页面专用时钟。默认使用 --artzoo-body-font（沿用已确认英文/数字 Patrick Hand、中文 Xiaolai 映射）、14px 字号、22px 行高、--artzoo-secondary 颜色，与 activity-note 小字一致；标签和数字共用该字体体系，不使用额外系统或等宽字体，不为等宽数字更换字体。

保持无背景、无边框、无图标的纯文本形式；compact 仅改变日期是否显示及稳定宽度，不改变文字规范。允许固定数字区域宽度和 tabular-nums 防止秒更新影响周边布局。页面仅控制位置、间距、对齐及响应式换行，不覆盖字体、字号、颜色、行高或增加装饰；新增引用须遵守同一默认规范。修改共享样式时运行 tests/single-activity/beijing-clock.test.mjs，并检查所有引用，保留已确认位置和实时更新逻辑。

## 我的活动卡片时间展示规范

活动类型Tag、标题行和摘要图标规范统一见上方“已验收设计与交互复用规范”第3项，避免重复维护或把单次绿色错误套给其他类型。以下两栏时间展示差异继续保留。

我的活动卡片按用户最新两张截图：我参与的显示月日与起止时段两行；我发布的显示月日与起止时段同一行。卡片不显示年份或单独结束日期，起止时段保留 HH:mm - HH:mm（两侧空格及半角连字符）。这仅简化卡片摘要，不改变完整时间数据、详情和跨日业务判断。检查须覆盖两栏实际组件的渲染结果，不只测试未接入页面的格式化函数。

## 共享操作反馈组件规范

短时操作成功 / 失败反馈统一复用 apps/web/components/use-feedback-message.ts 的 useFeedbackMessage（官方 AntD Message），调用处挂载 contextHolder 以继承现有 theme；不另写页面专用消息组件。当前接入范围为报名 / 换位成功，以及本人资料 / 头像原有成功失败反馈；表单校验、持续状态、显式确认和业务 guard 不因替换短消息而删除。

默认时长统一为 5 秒，pauseOnHover=false，悬停不暂停倒计时。每条消息使用唯一 key；点击只通过 messageApi.destroy(key) 关闭该条，不使用无 key 的全量清除。页面调用不自行改变时长、悬停行为或关闭范围。

默认位于视口固定顶部 24px 并水平居中，宽 280px、最大宽 calc(100vw - 32px)、最小高度 48px；图标 20px、图文间距 8px。复用既有 theme 的字体、圆角、前景色、阴影和文字参数：当前圆角 12px，文本 16px / 26px 居中；成功背景 #E5EEDB / 前景 #326846，失败背景 #F7E4DC / 前景 #A34335。长文允许自然换行，窄屏不得超出视口。页面不覆盖该共享默认规范。

视觉依据为 Figma jR5jiwJ9dAiBd6oraJVT8O 的 421:3443（成功 / 失败子节点 421:3462、421:3484）。接口以项目安装的 Ant Design 6.6.5 类型与源码及项目 CLI 核实，不因官网文档版本更高而自动升级。共享行为变更须检查现有接入点并验证 5 秒计时、悬停不停、按 key 点击关闭及页面业务校验仍保持；设计截图不替代实际浏览器视觉验收。

## 事务时间与单次活动管理

本轮退出、发起者修改与取消，以及遵守既定规则必需的最小处罚/3点限制/7天减分、缺人继续决定和未决定自动取消，按 docs/activity-management-rules.md 及开发确认清单 sequence 368 实施。原业务表与用户 Sentinel_bc66a1fe9d808191ab33928e4f6181d4 新确认优先：预定开始后禁止退出、取消与任何修改；截止未满员且未选继续可无责取消，已选继续后再取消走普通4小时规则。

生命周期以获得事务锁后的可信当前时间判定；原报名/换位入口时间规则保持。退出/取消确认必须显式说明本次处罚，时间/状态跨边界时客户端和服务端都要求重确认，不能用冻结的无责提示执行有罚操作。保留报名历史和既有退出处罚，不隐式删成员；活动、报名、换位和后台状态共享锁与版本。账号锁保留权限/身份重验证，并采用与通知外键引用兼容的 NO KEY UPDATE。

## 页面必要文案

网站不展示实现范围、尚未接入功能、开发进度或内部业务边界等解释性小字，例如“仅处理已有到场结果的更正……其他类型申诉尚未接入”。页面仅保留帮助用户完成操作所必需的提示、明确确认、校验和错误原因；不要把实现说明或交付范围直接放进产品界面。2026-10-16 当次仅删除用户指出的到场申诉说明属于历史修订范围；后续在已授权范围内遵守同一文案规范，保留必要业务提示、校验和处罚确认。
