# apps/web/components 与 apps/web/app：页面、样式、交互

站长要亲自把关网站设计。凡是会改变视觉效果的改动，都必须先说明，并附上修改前后的对比（截图或文字描述），等站长确认后再动手。

## 动手前

- 先读 `docs/design/ui-guidelines.md` 里和这次改动相关的章节，找到对应的基准组件。
- 列表控件用 `collection-controls.tsx`，菜单用 `operation-menu.tsx`，评论用 `discussion-comments.tsx`，弹窗用 `ui/paper-modal.tsx`，提示用 `use-feedback-message.ts`。不要重复造轮子。

## 样式

- 主题颜色、字号、圆角统一走 AntD 的 token 和现有的 CSS 变量，不要写死颜色值。
- 新写的样式使用 CSS Module（`*.module.css`），不要再新增全局 CSS 文件。
- 不要新增 `!important`，脚本会检查它的总数，只允许减少。
- 危险操作（删除、处罚、不可恢复的操作）沿用站点已经确认过的危险样式，不要直接用 AntD 的默认红色按钮。

## 数据与交互

- 请求数据统一使用 `components/shared/use-api-resource.ts` 和 `components/account/api.ts` 里的 `accountRequest`。不要直接调用 `fetch`。
- 加载中、空数据、出错这三种状态都要有对应的显示。
- 富文本编辑器这类较重的组件，用 `next/dynamic` 按需加载。
- 时间显示统一使用 `packages/domain` 的 `beijing-time`。

## 可访问性与适配

- 只有图标的按钮要加 `aria-label`。不要去掉键盘焦点的可见样式。纯装饰的图片用 `alt=""`。
- 每次改动都要检查三个宽度下的整页效果：桌面、390px、320px。要看整页，不能只看改动的那一块。
