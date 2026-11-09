import { SITE_HELP_LESSONS, type SiteHelpLessonId, type SiteHelpProgress } from '@artzoo/domain';
export type HelpAudience = { signedIn: boolean; member: boolean; administrator: boolean };
export type HelpStep = { key: string; title: string; description: string; selector: string };
export type HelpLesson = {
  lessonId: SiteHelpLessonId;
  version: number;
  title: string;
  path: string;
  steps: HelpStep[];
};
export function helpAudience(user?: { membership?: string; adminRole?: string } | null): HelpAudience {
  return {
    signedIn: Boolean(user),
    member: user?.membership === 'MEMBER',
    administrator: user?.adminRole === 'ADMIN' || user?.adminRole === 'SUPER_ADMIN'
  };
}
const content: Record<SiteHelpLessonId, { title: string; path: string; steps: HelpStep[] }> = {
  home: {
    title: '首页',
    path: '/',
    steps: [
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
    ]
  },
  albums: {
    title: '相册',
    path: '/albums',
    steps: [
      {
        key: 'album-create',
        title: '创建一本相册',
        description: '填写相册名称、分类、上传权限与可见范围。上传权限默认仅创建者上传。',
        selector: '.album-editor-modal .ant-modal-container'
      },
      {
        key: 'album-menu',
        title: '相册右上角的管理菜单',
        description: '从三角菜单修改相册、进入批量操作，或按当前权限删除相册。',
        selector: '.operation-menu-popup[aria-label="相册管理操作"]'
      },
      {
        key: 'album-bulk',
        title: '批量处理照片',
        description: '选择需要处理的照片，使用批量删除；完成后退出批量操作。',
        selector: '.album-detail-bulk-actions'
      },
      {
        key: 'album-photo-tools',
        title: '缩放与切换照片',
        description: '使用照片下方工具栏放大、缩小、按原始尺寸查看或适应窗口，并用左右箭头切换照片。',
        selector: '.album-photo-toolbar'
      },
      {
        key: 'album-photo-thumbnails',
        title: '从缩略图选择照片',
        description: '下方缩略图展示这本相册的照片，选中其中一张即可切换查看。',
        selector: '.album-photo-filmstrip'
      },
      {
        key: 'album-photo-information',
        title: '照片信息与操作',
        description: '这里显示上传者、区服与上传时间，右侧三角菜单显示当前账号可用的照片操作。',
        selector: '.album-photo-author'
      },
      {
        key: 'album-photo-comments',
        title: '照片评论入口',
        description: '从照片信息区下方的评论入口填写留言，与大家交流这张照片。',
        selector: '.album-photo-discussion .daily-bottom-composer'
      }
    ]
  },
  daily: {
    title: '日常交流',
    path: '/daily',
    steps: [
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
    ]
  },
  activities: {
    title: '正式活动',
    path: '/activities',
    steps: [
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
    ]
  },
  wishes: {
    title: '心愿板',
    path: '/wishes',
    steps: [
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
    ]
  },
  lotteries: {
    title: '抽奖',
    path: '/lotteries',
    steps: [
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
    ]
  },
  knowledge: {
    title: '内容分享',
    path: '/knowledge',
    steps: [
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
    ]
  }
};
export const HELP_LESSONS: HelpLesson[] = SITE_HELP_LESSONS.map((lesson) => ({
  ...content[lesson.lessonId],
  lessonId: lesson.lessonId,
  version: lesson.version,
  steps: lesson.stepIds.map((id) => content[lesson.lessonId].steps.find((step) => step.key === id)!)
}));
export function completedHelpSteps(lesson: HelpLesson, progress: SiteHelpProgress | null): string[] {
  const completed =
    progress?.lessons.find((row) => row.lessonId === lesson.lessonId && row.version === lesson.version)
      ?.completedStepIds ?? [];
  return lesson.steps.filter((step) => completed.includes(step.key)).map((step) => step.key);
}
export function firstUnfinishedHelpStep(lesson: HelpLesson, progress: SiteHelpProgress | null): number {
  const completed = completedHelpSteps(lesson, progress),
    index = lesson.steps.findIndex((step) => !completed.includes(step.key));
  return index < 0 ? 0 : index;
}
