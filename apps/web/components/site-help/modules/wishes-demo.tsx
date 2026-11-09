'use client';

import WishBrowser from '../../wishes/wish-browser';
import WishPublisher from '../../wishes/wish-publisher';
import { WISH_DEMO_PUBLISH_VALUES } from './wishes-fixtures';

export const WISH_HELP_STEPS = [
  {
    key: 'wish-browse',
    title: '浏览心愿卡片',
    description: '每张心愿卡片展示想玩的内容、感兴趣人数和方便时间，点击标题可查看详情。',
    selector: '.wish-grid .wish-card'
  },
  {
    key: 'wish-filters',
    title: '按心愿类型查找',
    description: '切换类型，查看坐骑收集、高难挑战、探索冒险等不同主题的心愿。',
    selector: '.wishes-content .collection-filterbar .ant-tabs-nav'
  },
  {
    key: 'wish-search',
    title: '搜索感兴趣的心愿',
    description: '输入关键词搜索心愿标题和内容，清空后恢复当前类型的列表。',
    selector: '.wishes-content .collection-search'
  },
  {
    key: 'wish-interest',
    title: '我也想一起参加',
    description: '对感兴趣的心愿选择“我也想”；已表达兴趣后可取消。自己的心愿显示“我的心愿”。',
    selector: '.wish-grid .wish-card-interest'
  },
  {
    key: 'wish-publish-info',
    title: '填写心愿基本信息',
    description: '正式成员可填写标题、选择心愿类型，并说明想玩的内容。',
    selector: '.wish-publisher-fields .activity-form-section:first-child'
  },
  {
    key: 'wish-publish-time',
    title: '说明方便参加的时间',
    description: '填写方便一起活动的时间，帮助感兴趣的同伴协调安排。',
    selector: '.wish-publisher-time'
  },
  {
    key: 'wish-publish-preview',
    title: '检查心愿卡片预览',
    description: '这里同步显示标题、类型、内容和方便时间。确认信息后，可从预览卡片底部发布心愿。',
    selector: '.wish-publisher-preview'
  }
] as const;

/** The same production pages, with fixture transport supplied by the isolated guide host. */
export default function WishesDemo({ current }: { current: number }) {
  return current >= 4 ? <WishPublisher defaultValues={WISH_DEMO_PUBLISH_VALUES} /> : <WishBrowser />;
}
