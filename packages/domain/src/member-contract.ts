import { invalid, validateGameNickname, validateGameServer, type Membership } from './account-contract.js';

export interface AvatarSummary {
  id: string;
  url: string;
  smallUrl: string;
  width: number;
  height: number;
}
export interface MemberSummary {
  id: string;
  displayName: string | null;
  gameRegion: string | null;
  gameServer: string | null;
  membership: Membership;
  avatar: AvatarSummary | null;
  bio: string;
  registeredAt?: string;
}
export interface MemberProfile extends MemberSummary {
  commonJobs: string[];
  preferredPlaystyles: string[];
  revision: number;
}
export interface MemberList {
  items: MemberSummary[];
}
export interface ProfileInput {
  displayName: string;
  gameRegion: string;
  gameServer: string;
  bio: string;
  commonJobs: string[];
  preferredPlaystyles: string[];
  revision: number;
}
export interface AvatarCrop {
  x: number;
  y: number;
  size: number;
}
export const AVATAR_RULES = {
  maxBytes: 10_000_000,
  maxPixels: 24_000_000,
  maxDimension: 8192,
  outputSize: 512,
  smallSize: 128
} as const;
export function isMemberId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function profileRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    invalid('revision', '资料版本无效，请刷新后再试');
  return value;
}
function tags(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    invalid(field, '请填写有效标签');
  const values = value.map((item: string) => item.trim()).filter(Boolean);
  if (values.some((item) => /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(item)))
    invalid(field, '标签不能包含控制或不可见格式字符');
  return [...new Set(values)];
}
export function validateMemberProfile(body: Record<string, unknown>): ProfileInput {
  const fields = [
    'displayName',
    'gameRegion',
    'gameServer',
    'bio',
    'commonJobs',
    'preferredPlaystyles',
    'revision'
  ];
  if (Object.keys(body).some((key) => !fields.includes(key))) invalid('profile', '资料包含不允许修改的字段');
  if (typeof body.bio !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.bio))
    invalid('bio', '请填写有效自我介绍');
  return {
    displayName: validateGameNickname(body.displayName),
    ...validateGameServer(body.gameRegion, body.gameServer),
    bio: body.bio.trim(),
    commonJobs: tags(body.commonJobs, 'commonJobs'),
    preferredPlaystyles: tags(body.preferredPlaystyles, 'preferredPlaystyles'),
    revision: profileRevision(body.revision)
  };
}

/** Only internal, implemented destinations can be used after authentication. */
export function safeAccountReturnTo(value: string): string {
  if (
    [
      '/admin/quick-links',
      '/admin/activity-shares/new',
      '/admin/announcements',
      '/admin/contact-requests',
      '/admin/roles',
      '/admin/public-settings',
      '/admin/official-events',
      '/',
      '/resources',
      '/admin/resources',
      '/daily',
      '/knowledge',
      '/knowledge/new',
      '/admin/knowledge-categories',
      '/admin',
      '/admin/invitations',
      '/admin/accounts',
      '/admin/attendance-appeals',
      '/admin/penalty-appeals',
      '/me/activity-penalties',
      '/me/messages',
      '/me/profile',
      '/members',
      '/activities',
      '/activities/new',
      '/me/activities',
      '/teams',
      '/teams/new',
      '/me/teams',
      '/me/teams/history',
      '/albums',
      '/featured',
      '/admin/featured',
      '/admin/album-categories'
    ].includes(value)
  )
    return value;
  if (/^\/admin\/activity-shares\/[0-9a-f-]{36}$/i.test(value) && isMemberId(value.split('/')[3]!))
    return value;
  if (
    /^\/admin\/activity-shares\/new\?activityId=[0-9a-f-]{36}$/i.test(value) &&
    isMemberId(value.split('=')[1]!)
  )
    return value;
  if (value.startsWith('/albums/')) {
    const [path, query] = value.split('?');
    if (!isMemberId(path!.slice('/albums/'.length))) return '/';
    if (query === undefined) return value;
    const params = new URLSearchParams(query),
      entries = [...params.entries()];
    if (
      entries.length === 1 &&
      entries.every(
        ([key, id]) =>
          (['periodActivityId', 'photoId'].includes(key) && isMemberId(id)) ||
          (key === 'comments' && id === '1')
      ) &&
      !value.includes('#')
    )
      return value;
    return '/';
  }
  if (
    ['/lotteries', '/lotteries/new'].includes(value) ||
    (value.startsWith('/lotteries/') && isMemberId(value.slice('/lotteries/'.length)))
  )
    return value;
  if (
    ['/wishes', '/wishes/new'].includes(value) ||
    /^\/wishes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/(?:activity|edit)|\?commentId=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(
      value
    )
  )
    return value;
  if (value.startsWith('/daily/') && isMemberId(value.slice('/daily/'.length))) return value;
  if (value.startsWith('/teams/') && isMemberId(value.slice('/teams/'.length))) return value;
  if (value.startsWith('/members/') && isMemberId(value.slice('/members/'.length))) return value;
  if (value.startsWith('/activities/') && isMemberId(value.slice('/activities/'.length))) return value;
  if (/^\/knowledge\/[0-9a-f-]{36}(?:\/edit)?$/i.test(value) && isMemberId(value.split('/')[2]!))
    return value;
  return '/';
}
