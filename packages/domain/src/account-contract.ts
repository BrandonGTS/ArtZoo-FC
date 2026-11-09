import { GAME_SERVER_REGIONS } from './ff14-game-servers.js';
export { GAME_SERVER_REGIONS, GAME_SERVER_SOURCE } from './ff14-game-servers.js';
export type Membership = 'MEMBER' | 'FRIEND';
export type AdminRole = 'NONE' | 'ADMIN' | 'SUPER_ADMIN';
export interface AccountSummary {
  id: string;
  phoneMasked: string;
  displayName: string | null;
  membership: Membership;
  adminRole: AdminRole;
  gameRegion: string | null;
  gameServer: string | null;
}
export interface SessionSnapshot {
  user: AccountSummary | null;
  expiresAt: string | null;
  capabilities: { manageInvitations: boolean; manageMembership: boolean };
}
export interface ApiError {
  code: string;
  message: string;
  fieldErrors?: Record<string, string>;
  retryAfterSeconds?: number;
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
export type InvitationUsageMode = 'SINGLE' | 'MULTIPLE';
export type InvitationStatus = 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';
export interface InvitationSummary {
  id: string;
  membership: Membership;
  usageMode: InvitationUsageMode;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  linkAvailable: boolean;
  createdBy: { id: string; displayName: string | null };
}
export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}
export interface NumberedPageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
export interface AuthConfig {
  password: { minLength: 8; maxLength: 30 };
  verification: { length: 6; expiresInSeconds: 300; resendAfterSeconds: 60 };
  sessionDays: 30;
  phone: { ready: boolean; defaultRegion: string | null; hint: string };
  sms: { mode: 'unconfigured' | 'mock' | 'aliyun'; available: boolean };
}
export interface AuditSummary {
  id: string;
  action: string;
  actor: AccountSummary;
  targetAccountId: string | null;
  invitationId: string | null;
  beforeMembership: Membership | null;
  afterMembership: Membership | null;
  reason: string | null;
  createdAt: string;
}
export type VerificationPurpose = 'REGISTER' | 'RESET_PASSWORD';
export const ACCOUNT_RULES = {
  passwordMin: 8,
  passwordMax: 30,
  codeSeconds: 300,
  resendSeconds: 60,
  codeAttempts: 5,
  hourlySends: 5,
  dailySends: 10,
  sessionDays: 30
} as const;
export class AccountError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly fieldErrors?: Record<string, string>,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'AccountError';
  }
}
export function invalid(field: string, message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400, { [field]: message });
}
export function textInput(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid(field, '请填写有效内容');
  return value;
}
export function validatePassword(password: unknown, confirmPassword: unknown): string {
  const value = textInput(password, 'password', 30);
  if (!/^[\x20-\x7e]{8,30}$/.test(value)) invalid('password', '密码需为8–30位数字、英文字母或符号');
  if (value !== confirmPassword) invalid('confirmPassword', '两次输入的密码不一致');
  return value;
}
/** Trim outer whitespace only; preserve case, inner whitespace and Unicode code points.
 * Registration uniqueness is the exact (gameServer, displayName) pair. */
export function validateGameNickname(value: unknown): string {
  if (typeof value !== 'string') invalid('displayName', '请填写游戏昵称');
  const nickname = value.trim();
  if (!nickname || Array.from(nickname).length > 30 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) {
    invalid('displayName', '游戏昵称需为1–30个字符，不能包含控制或不可见格式字符');
  }
  return nickname;
}
export function membershipInput(value: unknown, field = 'membership'): Membership {
  if (value !== 'MEMBER' && value !== 'FRIEND') invalid(field, '请选择正式成员或朋友');
  return value;
}
export function reasonInput(value: unknown): string {
  const reason = textInput(value, 'reason', 1000).trim();
  if (!reason) invalid('reason', '请填写操作原因');
  return reason;
}
export function canAdminister(role: AdminRole): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}
/** UI availability and server authorization share the same role/target rule.
 * Server callers must use current, locked account rows, never client summaries. */
export function canChangeAccountMembership(
  actor: Pick<AccountSummary, 'id' | 'adminRole'> | null | undefined,
  target: Pick<AccountSummary, 'id' | 'adminRole'>
): boolean {
  if (!actor || !canAdminister(actor.adminRole)) return false;
  return actor.adminRole === 'SUPER_ADMIN' || (actor.id !== target.id && target.adminRole !== 'SUPER_ADMIN');
}
export function anonymousSession(): SessionSnapshot {
  return { user: null, expiresAt: null, capabilities: { manageInvitations: false, manageMembership: false } };
}

/** Exact official membership; do not silently trim or rewrite location values. */
export function validateGameServer(
  region: unknown,
  server: unknown
): { gameRegion: string; gameServer: string } {
  if (
    typeof region !== 'string' ||
    typeof server !== 'string' ||
    !GAME_SERVER_REGIONS.some((item) => item.region === region && item.servers.includes(server))
  ) {
    invalid('gameLocation', '请选择有效的大区 / 服务器');
  }
  return { gameRegion: region, gameServer: server };
}
