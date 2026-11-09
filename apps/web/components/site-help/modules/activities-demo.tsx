'use client';
import dayjs from 'dayjs';
import ActivityBrowser from '../../activities/activity-browser';
import { ActivityPublisherContent } from '../../activities/activity-publisher';
import { ACTIVITY_GUIDE_DAY, ACTIVITY_GUIDE_DUTY, ACTIVITY_GUIDE_TEMPLATE } from './activities-fixtures';

export const ACTIVITY_HELP_STEPS = [
  {
    key: 'official-calendar',
    title: '识别官方活动状态',
    description: '日期上的颜色标记对应当前进行、即将开始和即将结束的官方活动。',
    selector: '.official-calendar-legend'
  },
  {
    key: 'official-arrangement',
    title: '查看官方活动安排',
    description: '所选日期的官方活动在这里展示名称、起止时间和摘要，可从活动卡查看原文。',
    selector: '.activity-day-aside .official-day-card'
  },
  {
    key: 'member-calendar',
    title: '成员发起的正式活动',
    description: '这类日期卡片展示成员发起的活动名称和开始时间，打开后可查看时间、人数和详情入口。',
    selector: '.activity-calendar-event'
  },
  {
    key: 'publish-information',
    title: '填写活动名称',
    description: '填写清楚的活动名称，它也会同步显示在右侧预览和关联相册名称中。',
    selector: '[data-help-target=activity-publish-name]'
  },
  {
    key: 'publish-type',
    title: '选择活动类型与模式',
    description: '选择游戏内或线下活动，再按活动安排选择单次或普通长期模式。',
    selector: '[data-help-target=activity-publish-type]'
  },
  {
    key: 'publish-duty',
    title: '选择具体副本',
    description: '先选择副本类型，再选择具体副本；队伍编制会依据所选副本确定。',
    selector: '[data-help-target=activity-publish-duty]'
  },
  {
    key: 'publish-time',
    title: '填写活动时间',
    description: '开始和预定结束时间使用北京时间。游戏内活动报名截止会自动设为开始前30分钟。',
    selector: '[data-help-target=activity-publish-time]'
  },
  {
    key: 'publish-arrangement',
    title: '说明活动安排',
    description: '写明本次活动的流程和集合安排，让参与者提前了解。',
    selector: '[data-help-target=activity-publish-arrangement]'
  },
  {
    key: 'publish-requirements',
    title: '说明参与要求',
    description: '补充参与前需要准备的事项和要求。',
    selector: '[data-help-target=activity-publish-requirements]'
  },
  {
    key: 'publish-composition',
    title: '设置席位要求',
    description: '队伍构成按副本编制展示；从一个席位选择允许的职能或具体职业。',
    selector: '.activity-publisher-composition .activity-seat-trigger'
  },
  {
    key: 'publish-preview',
    title: '核对活动预览',
    description: '预览卡随填写内容更新，发布前核对标题、时间、人数和队伍构成。',
    selector: '.activity-publisher-summary'
  },
  {
    key: 'publish-album',
    title: '关联活动相册',
    description: '需要记录活动照片时，勾选创建并关联活动相册，名称会根据活动名称生成。',
    selector: '.activity-album-fields .ant-checkbox-wrapper'
  }
];

const sample = {
  values: {
    scene: 'GAME' as const,
    mode: 'SINGLE' as const,
    category: 'DUNGEON' as const,
    title: '周末一起冒险',
    description: '一起体验副本，熟悉流程后再出发。',
    requirements: '请提前准备好装备，并按约定时间集合。',
    dutyType: ACTIVITY_GUIDE_DUTY.type,
    dutyId: ACTIVITY_GUIDE_DUTY.id,
    capacity: 8,
    startsAt: dayjs('2026-10-31T20:00:00'),
    endsAt: dayjs('2026-10-31T22:00:00'),
    createAlbum: true
  },
  template: ACTIVITY_GUIDE_TEMPLATE
};
/** All visual structure comes from the real calendar and publish form. */
export default function ActivitiesDemo({ current }: { current: number }) {
  return current < 3 ? (
    <ActivityBrowser initialDay={ACTIVITY_GUIDE_DAY} />
  ) : (
    <ActivityPublisherContent guideSample={sample} />
  );
}
