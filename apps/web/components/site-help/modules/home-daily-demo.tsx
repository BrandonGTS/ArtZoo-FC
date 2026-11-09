'use client';
import { useEffect } from 'react';
import HomeContent from '../../home-content';
import DailyFeed from '../../daily/daily-feed';

export const HOME_HELP_STEPS = [
  {
    key: 'navigation',
    title: '从导航找到内容',
    description: '从导航进入相册、日常交流、活动和内容分享。',
    selector: '[data-help-target=navigation]'
  },
  {
    key: 'home-activities',
    title: '近期可参与活动',
    description: '从活动卡片查看安排、参与要求和报名入口。',
    selector: '[data-help-target=home-activities]'
  },
  {
    key: 'home-daily',
    title: '大家的近况',
    description: '这里预览日常动态，进入日常交流查看完整内容。',
    selector: '[data-help-target=home-daily]'
  },
  {
    key: 'home-wishes',
    title: '一起实现心愿',
    description: '看看大家想一起玩的内容。',
    selector: '[data-help-target=home-wishes]'
  },
  {
    key: 'personal',
    title: '个人菜单',
    description: '从头像菜单查看个人主页、我的活动和消息；访客可从这里登录。',
    selector: '[data-help-target=personal]'
  },
  {
    key: 'quick',
    title: '常用网站',
    description: '快捷入口汇集常用网站，支持搜索和翻页。',
    selector: '[data-help-target=quick]'
  }
] as const;
export const DAILY_HELP_STEPS = [
  {
    key: 'daily-compose',
    title: '分享一点近况',
    description: '在这里编辑想要分享的近况。',
    selector: '[data-help-target=daily-compose]'
  },
  {
    key: 'daily-tools',
    title: '配图、提及与表情',
    description: '使用工具栏补充图片、提及成员或添加表情。',
    selector: '[data-help-target=daily-tools]'
  },
  {
    key: 'daily-feed',
    title: '浏览最新动态',
    description: '阅读大家的动态，打开回复区参与交流。',
    selector: '[data-help-target=daily-feed]'
  }
] as const;
const targets = {
  home: {
    navigation: 'nav[aria-label="主要导航"]',
    'home-activities': 'section[aria-labelledby="activities-heading"] .home-activity-card',
    'home-daily': 'section[aria-label="日常动态"] .daily-home-card',
    'home-wishes': 'section[aria-labelledby="wishes-heading"] .wish-card',
    personal: 'header .personal-entry',
    quick: 'button[aria-label="快捷入口"]'
  },
  daily: {
    'daily-compose': '.daily-publisher',
    // Real compact tools use display:contents; the existing footer is the measurable
    // region containing the exact toolbar and its native submit action.
    'daily-tools': '.daily-publisher .daily-composer-footer',
    'daily-feed': 'section[aria-label="最新动态"] .daily-home-card'
  }
} as const;

/** The parent demo host supplies the real SiteShell and isolated transport.
 * These are the production content components, not parallel guide markup.
 */
export default function HomeDailyDemo({
  lessonId,
  current
}: {
  lessonId: 'home' | 'daily';
  current: number;
}) {
  useEffect(() => {
    const marked = new Map<HTMLElement, string | null>();
    const mark = () => {
      for (const [key, selector] of Object.entries(targets[lessonId])) {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) continue;
        if (!marked.has(element)) marked.set(element, element.getAttribute('data-help-target'));
        if (element.getAttribute('data-help-target') !== key) element.setAttribute('data-help-target', key);
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const [element, previous] of marked) {
        if (previous === null) element.removeAttribute('data-help-target');
        else element.setAttribute('data-help-target', previous);
      }
    };
  }, [lessonId, current]);
  return lessonId === 'home' ? <HomeContent /> : <DailyFeed />;
}
