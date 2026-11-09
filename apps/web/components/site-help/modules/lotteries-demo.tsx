'use client';
import dayjs from 'dayjs';
import LotteryBrowser from '../../lottery/lottery-browser';
import LotteryDetail from '../../lottery/lottery-detail';
import LotteryPublisher from '../../lottery/lottery-publisher';
import { LOTTERY_DEMO_ID } from './lotteries-fixtures';

export const LOTTERY_HELP_STEPS = [
  {
    key: 'lottery-filter',
    title: '切换抽奖分类',
    description: '在进行中与已完成之间切换，查看对应状态的抽奖。',
    selector: '.lottery-browser-content .collection-tabs'
  },
  {
    key: 'lottery-search',
    title: '搜索抽奖标题',
    description: '输入标题搜索抽奖，清空搜索后恢复当前分类的列表。',
    selector: '.lottery-browser-content .collection-search'
  },
  {
    key: 'lottery-card',
    title: '查看一场抽奖',
    description: '从这张卡片的标题进入详情，卡片同时展示抽奖类型、参与方式、资格范围和奖品摘要。',
    selector: '.lottery-grid .lottery-summary-title'
  },
  {
    key: 'lottery-detail-prizes',
    title: '查看奖品详情',
    description: '详情中的奖品区域展示每项奖品的描述和份数。',
    selector: '.lottery-detail-content .lottery-summary-prizes'
  },
  {
    key: 'lottery-participation',
    title: '我的参与',
    description: '在这里查看本人参与状态。普通抽奖主动报名；月签到抽奖按设置的月份和签到门槛自动纳入。',
    selector: '.lottery-my-participation'
  },
  {
    key: 'lottery-progress',
    title: '查看开奖进度',
    description: '这里展示已发布、参与或统计进行中，以及预定开奖等实际阶段。',
    selector: '.lottery-progress'
  },
  {
    key: 'lottery-publish-info',
    title: '填写基本信息',
    description:
      '正式成员或管理员可发起抽奖，填写标题、类型和资格范围。普通抽奖固定主动参加，月签到抽奖固定按条件自动纳入。',
    selector: '.lottery-form-group:first-child'
  },
  {
    key: 'lottery-publish-time',
    title: '设置开奖时间',
    description: '选择开奖日期和时间，页面按北京时间显示。',
    selector: '.lottery-form-group:nth-child(2)'
  },
  {
    key: 'lottery-publish-prizes',
    title: '编辑奖品',
    description: '填写这项奖品的描述和份数，按需选择图片；中奖人数由奖品总份数计算。',
    selector: '.lottery-prize-field:first-child'
  },
  {
    key: 'lottery-publish-preview',
    title: '核对实时预览',
    description: '右侧这张预览卡同步显示抽奖信息和奖品摘要，核对内容后再决定是否发布。',
    selector: '.lottery-preview .lottery-summary-card'
  }
] as const;

/** Only mounted inside the isolated guide host with its closed fixture fetch adapter. */
export default function LotteriesDemo({ current }: { current: number }) {
  if (current <= 2) return <LotteryBrowser />;
  if (current <= 5) return <LotteryDetail id={LOTTERY_DEMO_ID} />;
  return (
    <LotteryPublisher
      demoValues={{
        title: '周末相聚的小礼物',
        kind: 'ORDINARY',
        mode: 'MANUAL',
        audience: 'MEMBER',
        minDays: null,
        prizes: [{ name: '冒险纪念小礼物', quantity: 2 }],
        drawDate: dayjs('2030-11-02T20:00:00')
      }}
    />
  );
}

export { lotteryDemoResponse } from './lotteries-fixtures';
