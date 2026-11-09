'use client';
import KnowledgeBrowser from '../../knowledge/browser';
import KnowledgeEditor from '../../knowledge/editor';
import KnowledgeDetail from '../../knowledge/detail';
import { KNOWLEDGE_DEMO_EDITOR, KNOWLEDGE_DEMO_ID } from './knowledge-fixtures';

export const KNOWLEDGE_HELP_STEPS = [
  {
    key: 'knowledge-filters',
    title: '按分区和标题查找',
    description: '切换分区浏览不同主题，也可以按标题搜索感兴趣的分享。',
    selector: '.knowledge-browser-filters'
  },
  {
    key: 'knowledge-card',
    title: '打开一篇分享',
    description: '分享卡片显示分区、标题和作者，打开卡片即可阅读完整内容。',
    selector: '.knowledge-list[aria-busy="false"] .knowledge-summary-paper'
  },
  {
    key: 'knowledge-fields',
    title: '填写标题和分区',
    description: '先为分享填写清楚的标题，再选择合适的分区。',
    selector: '.knowledge-editor-fields'
  },
  {
    key: 'knowledge-toolbar',
    title: '使用正文工具',
    description: '使用工具栏调整文字排版，按需要插入图片、链接、列表等内容。',
    selector: '.knowledge-rich-toolbar-v2'
  },
  {
    key: 'knowledge-body-edit',
    title: '编写正文',
    description: '在正文区域写下想分享的内容，完成后检查标题、分区和正文再发表。',
    selector: '.knowledge-rich-input p:first-child'
  },
  {
    key: 'knowledge-author',
    title: '查看作者信息',
    description: '这里显示作者、区服和发表时间，方便了解这篇分享来自谁。',
    selector: '.knowledge-detail-person'
  },
  {
    key: 'knowledge-body-read',
    title: '阅读分享正文',
    description: '分享的完整内容在正文区域呈现，按作者的排版阅读即可。',
    selector: '.knowledge-detail-body .knowledge-body'
  },
  {
    key: 'knowledge-actions',
    title: '分享、收藏和点赞',
    description: '从这组按钮复制分享链接、收藏内容或为喜欢的分享点赞。',
    selector: '.knowledge-detail-tools'
  },
  {
    key: 'knowledge-comments',
    title: '评论与回复',
    description: '在评论区阅读大家的想法，也可以针对一条评论继续回复。',
    selector: '.knowledge-discussion-paper .daily-comment-list > .daily-comment:first-child'
  }
] as const;

/** Each topic focuses an existing small region in a real page component.
 * Keep the editor/detail mounted across their adjacent topics; no parallel UI.
 */
export default function KnowledgeDemo({ current }: { current: number }) {
  if (current >= 2 && current <= 4)
    return <KnowledgeEditor key="guide-publish" demo={KNOWLEDGE_DEMO_EDITOR} />;
  if (current >= 5) return <KnowledgeDetail key="guide-detail" id={KNOWLEDGE_DEMO_ID} />;
  return <KnowledgeBrowser key="guide-overview" />;
}
