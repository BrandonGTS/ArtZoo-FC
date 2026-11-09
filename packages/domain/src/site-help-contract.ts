import { AccountError } from './account-contract.js';

export const SITE_HELP_LEGACY_LESSONS = [
  {
    lessonId: 'home',
    version: 1,
    stepIds: ['navigation', 'home-activities', 'home-daily', 'home-wishes', 'personal', 'quick']
  },
  { lessonId: 'albums', version: 1, stepIds: ['album-categories', 'album-search', 'album-browse'] },
  { lessonId: 'daily', version: 1, stepIds: ['daily-compose', 'daily-tools', 'daily-feed'] },
  { lessonId: 'activities', version: 1, stepIds: ['calendar-month', 'calendar-grid', 'calendar-official'] },
  {
    lessonId: 'knowledge',
    version: 1,
    stepIds: ['knowledge-categories', 'knowledge-search', 'knowledge-publish']
  }
] as const;
const SITE_HELP_PREVIOUS_LESSONS = [
  {
    lessonId: 'home',
    version: 1,
    stepIds: ['navigation', 'home-activities', 'home-daily', 'home-wishes', 'personal', 'quick']
  },
  { lessonId: 'albums', version: 2, stepIds: ['album-create', 'album-menu', 'album-bulk', 'album-photo'] },
  { lessonId: 'daily', version: 1, stepIds: ['daily-compose', 'daily-tools', 'daily-feed'] },
  {
    lessonId: 'activities',
    version: 2,
    stepIds: [
      'official-calendar',
      'member-calendar',
      'publish-information',
      'publish-composition',
      'publish-preview',
      'publish-album'
    ]
  },
  {
    lessonId: 'wishes',
    version: 1,
    stepIds: ['wish-browse', 'wish-filters', 'wish-interest', 'wish-publish']
  },
  {
    lessonId: 'lotteries',
    version: 1,
    stepIds: ['lottery-browser', 'lottery-participation', 'lottery-publish-info', 'lottery-publish-prizes']
  },
  {
    lessonId: 'knowledge',
    version: 2,
    stepIds: ['knowledge-overview', 'knowledge-editor', 'knowledge-detail']
  }
] as const;
export const SITE_HELP_LESSONS = [
  {
    lessonId: 'home',
    version: 1,
    stepIds: ['navigation', 'home-activities', 'home-daily', 'home-wishes', 'personal', 'quick']
  },
  {
    lessonId: 'albums',
    version: 3,
    stepIds: [
      'album-create',
      'album-menu',
      'album-bulk',
      'album-photo-tools',
      'album-photo-thumbnails',
      'album-photo-information',
      'album-photo-comments'
    ]
  },
  { lessonId: 'daily', version: 1, stepIds: ['daily-compose', 'daily-tools', 'daily-feed'] },
  {
    lessonId: 'activities',
    version: 3,
    stepIds: [
      'official-calendar',
      'official-arrangement',
      'member-calendar',
      'publish-information',
      'publish-type',
      'publish-duty',
      'publish-time',
      'publish-arrangement',
      'publish-requirements',
      'publish-composition',
      'publish-preview',
      'publish-album'
    ]
  },
  {
    lessonId: 'wishes',
    version: 2,
    stepIds: [
      'wish-browse',
      'wish-filters',
      'wish-search',
      'wish-interest',
      'wish-publish-info',
      'wish-publish-time',
      'wish-publish-preview'
    ]
  },
  {
    lessonId: 'lotteries',
    version: 2,
    stepIds: [
      'lottery-filter',
      'lottery-search',
      'lottery-card',
      'lottery-detail-prizes',
      'lottery-participation',
      'lottery-progress',
      'lottery-publish-info',
      'lottery-publish-time',
      'lottery-publish-prizes',
      'lottery-publish-preview'
    ]
  },
  {
    lessonId: 'knowledge',
    version: 3,
    stepIds: [
      'knowledge-filters',
      'knowledge-card',
      'knowledge-fields',
      'knowledge-toolbar',
      'knowledge-body-edit',
      'knowledge-author',
      'knowledge-body-read',
      'knowledge-actions',
      'knowledge-comments'
    ]
  }
] as const;
export const SITE_HELP_COMPATIBLE_LESSONS = [
  ...SITE_HELP_LESSONS,
  ...[...SITE_HELP_LEGACY_LESSONS, ...SITE_HELP_PREVIOUS_LESSONS].filter(
    (old) =>
      !SITE_HELP_LESSONS.some(
        (current) => current.lessonId === old.lessonId && current.version === old.version
      )
  )
];
export type SiteHelpLessonId = (typeof SITE_HELP_LESSONS)[number]['lessonId'];
export interface SiteHelpLessonProgress {
  lessonId: SiteHelpLessonId;
  version: number;
  completedStepIds: string[];
}
export interface SiteHelpProgress {
  lessons: SiteHelpLessonProgress[];
}
export interface SiteHelpStepCommand {
  lessonId: SiteHelpLessonId;
  version: number;
  stepId: string;
}
export function siteHelpStepCommand(value: unknown): SiteHelpStepCommand {
  const invalid = (): never => {
    throw new AccountError('VALIDATION_ERROR', '帮助课程或步骤无效，请刷新后重试', 400);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 3 ||
    Object.keys(body).some((key) => !['lessonId', 'version', 'stepId'].includes(key))
  )
    invalid();
  const lesson = SITE_HELP_COMPATIBLE_LESSONS.find(
    (item) => item.lessonId === body.lessonId && item.version === body.version
  );
  if (
    !lesson ||
    body.version !== lesson.version ||
    typeof body.stepId !== 'string' ||
    !(lesson.stepIds as readonly string[]).includes(body.stepId)
  )
    return invalid();
  return { lessonId: lesson.lessonId, version: lesson.version, stepId: body.stepId as string };
}
