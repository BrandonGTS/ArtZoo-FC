import { BEIJING_OFFSET_MS } from './beijing-time.js';
import { invalid } from './account-contract.js';
import { isMemberId } from './member-contract.js';
export type LotteryKind = 'ORDINARY' | 'MONTHLY';
export type LotteryMode = 'MANUAL' | 'AUTO';
export type LotteryAudience = 'MEMBER' | 'MEMBER_FRIEND';
export function isLotteryPrizeImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^\/api\/lotteries\/media\/([^/]+)\/([^/]+)$/.exec(value);
  return Boolean(parts && isMemberId(parts[1]!) && isMemberId(parts[2]!));
}
export type Prize = { name: string; quantity: number; imageUrl?: string };
export type LotteryInput = {
  idempotencyKey: string;
  title: string;
  kind: LotteryKind;
  mode: LotteryMode;
  audience: LotteryAudience;
  month: string | null;
  minDays: number | null;
  prizes: Prize[];
  drawAt: string;
};
export type Identity = {
  id: string;
  displayName: string | null;
  membership: 'MEMBER' | 'FRIEND';
  active: boolean;
};
export type Winner = { accountId: string; gameNickname: string; prize: string };
export type DrawResult = {
  drawnAt: string;
  processedAt: string;
  participants: number;
  winners: Winner[];
  unassigned: number;
};
export type LotteryView = Omit<LotteryInput, 'idempotencyKey'> & {
  canModerate?: boolean;
  revision?: number;
  id: string;
  creator: { id: string; displayName: string | null };
  createdAt: string;
  state: 'OPEN' | 'DRAWN' | 'CANCELLED';
  result: (Omit<DrawResult, 'winners'> & { winners: { gameNickname: string; prize: string }[] }) | null;
  isCreator: boolean;
  serverNow: string;
  mine: {
    gameNickname: string;
    membership: string;
    eligible: boolean;
    reason: string | null;
    count: number | null;
    prize: string | null;
    state: 'NONE' | 'ACTIVE' | 'WITHDRAWN';
    source: 'MANUAL' | 'AUTO' | null;
    joinedAt: string | null;
  };
};
export const scopeLabel = (audience: LotteryAudience) =>
  audience === 'MEMBER' ? '正式成员' : '正式成员与朋友';
export const modeLabel = (mode: LotteryMode) => (mode === 'MANUAL' ? '主动参加' : '条件自动纳入');
export const prizeCount = (prizes: Prize[]) => prizes.reduce((sum, p) => sum + p.quantity, 0);
export const beijingMonth = (date: Date) =>
  new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 7);
export function monthBounds(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) invalid('month', '请选择签到月份');
  const [year, m] = month.split('-').map(Number);
  if (year! < 2020 || year! > 2100) invalid('month', '签到月份无效');
  return {
    start: new Date(`${month}-01T00:00:00+08:00`),
    end: new Date(Date.UTC(year!, m!, 1) - BEIJING_OFFSET_MS),
    days: new Date(Date.UTC(year!, m!, 0)).getUTCDate()
  };
}
/** Available natural sign-in days, including today, in the selected Beijing month. */
export function monthlyLotteryWindow(month: string, now: Date) {
  const bounds = monthBounds(month);
  const today = new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  return {
    firstAvailableDay: month > currentMonth ? bounds.start : new Date(`${today}T00:00:00+08:00`),
    maxDays:
      month < currentMonth
        ? 0
        : month === currentMonth
          ? bounds.days - Number(today.slice(8, 10)) + 1
          : bounds.days
  };
}
/** N available sign-in dates finish at the following Beijing midnight, not N*24h after publication. */
export function earliestMonthlyDrawAt(month: string, minDays: number, now: Date) {
  return new Date(monthlyLotteryWindow(month, now).firstAvailableDay.getTime() + minDays * 86400000);
}
export function commandKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) invalid('idempotencyKey', '操作标识无效');
  return value;
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    invalid(field, `请填写1–${max}字`);
  return value.trim();
}
export function validateLottery(
  body: Record<string, unknown>,
  now: Date,
  validateTiming = true
): LotteryInput {
  if (
    Object.keys(body).some(
      (k) =>
        ![
          'idempotencyKey',
          'title',
          'kind',
          'mode',
          'audience',
          'month',
          'minDays',
          'prizes',
          'drawAt'
        ].includes(k)
    )
  )
    invalid('form', '抽奖设置包含无效字段');
  const idempotencyKey = commandKey(body.idempotencyKey),
    title = text(body.title, 'title', 80);
  if (body.kind !== 'ORDINARY' && body.kind !== 'MONTHLY') invalid('kind', '请选择抽奖类型');
  if (body.mode !== 'MANUAL' && body.mode !== 'AUTO') invalid('mode', '请选择参与方式');
  // Recovery parsing retains historical payloads. New-publication validation runs
  // only after the locked prior-key lookup in LotteryService.create.
  if (validateTiming && body.mode !== (body.kind === 'MONTHLY' ? 'AUTO' : 'MANUAL'))
    invalid('mode', body.kind === 'MONTHLY' ? '月签到抽奖固定为条件自动纳入' : '普通抽奖固定为主动参加');
  if (body.audience !== 'MEMBER' && body.audience !== 'MEMBER_FRIEND') invalid('audience', '请选择身份范围');
  if (!Array.isArray(body.prizes) || !body.prizes.length || body.prizes.length > 20)
    invalid('prizes', '请填写1–20项奖品');
  const prizes = body.prizes.map((p) => {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).some((k) => !['name', 'quantity', 'imageUrl'].includes(k))
    )
      invalid('prizes', '奖品格式无效');
    const { name, quantity, imageUrl } = p as Record<string, unknown>;
    if (imageUrl !== undefined && !isLotteryPrizeImageUrl(imageUrl)) invalid('prizes', '奖品图片地址无效');
    if (!Number.isSafeInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 1000)
      invalid('prizes', '每项奖品份数需为1–1000');
    return {
      name: text(name, 'prizes', 80),
      quantity: Number(quantity),
      ...(imageUrl ? { imageUrl: imageUrl as string } : {})
    };
  });
  if (prizeCount(prizes) > 1000) invalid('prizes', '奖品总份数最多1000');
  if (typeof body.drawAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(body.drawAt))
    invalid('drawAt', '请填写北京时间开奖日期和时间');
  const drawAt = new Date(body.drawAt);
  if (
    !Number.isFinite(drawAt.getTime()) ||
    (validateTiming && drawAt <= now) ||
    new Date(drawAt.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 19) !== body.drawAt.slice(0, 19)
  )
    invalid('drawAt', '请选择未来有效的开奖时间');
  let month: string | null = null,
    minDays: number | null = null;
  if (body.kind === 'MONTHLY') {
    month = typeof body.month === 'string' ? body.month : '';
    const bounds = monthBounds(month);
    if (!Number.isSafeInteger(body.minDays) || Number(body.minDays) < 1 || Number(body.minDays) > bounds.days)
      invalid('minDays', `签到天数需为1–${bounds.days}`);
    minDays = Number(body.minDays);
    if (validateTiming) {
      const window = monthlyLotteryWindow(month, now);
      if (!window.maxDays) invalid('month', '请选择当前或未来签到月份');
      if (minDays > window.maxDays)
        invalid('minDays', `该月剩余可签到${window.maxDays}天，签到天数需为1–${window.maxDays}`);
      const earliest = earliestMonthlyDrawAt(month, minDays, now);
      if (drawAt < earliest)
        invalid(
          'drawAt',
          `请留足${minDays}个签到日，最早可于北京时间${new Date(earliest.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10)} 00:00开奖`
        );
    }
  } else if (body.month != null || body.minDays != null) invalid('month', '普通抽奖不设置签到门槛');
  return {
    idempotencyKey,
    title,
    kind: body.kind,
    mode: body.mode,
    audience: body.audience,
    month,
    minDays,
    prizes,
    drawAt: body.drawAt
  };
}
export function eligibility(
  input: Pick<LotteryInput, 'kind' | 'audience' | 'minDays'>,
  identity: Identity,
  count: number | null
) {
  if (!identity.active) return '账号已停用';
  if (input.audience === 'MEMBER' && identity.membership !== 'MEMBER') return '本场仅限正式成员';
  if (input.kind === 'MONTHLY' && (count === null || count < input.minDays!))
    return `签到未满 ${input.minDays} 天`;
  return null;
}
/** Fisher–Yates, uniform people and prize units; no score/check-in weighting. */
export function selectWinners(
  people: Identity[],
  prizes: Prize[],
  randomInt: (max: number) => number
): Winner[] {
  function shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }
  const pool = shuffle([...new Map(people.map((p) => [p.id, p])).values()]);
  const units = shuffle(prizes.flatMap((p) => Array.from({ length: p.quantity }, () => p.name)));
  return pool
    .slice(0, units.length)
    .map((p, i) => ({ accountId: p.id, gameNickname: p.displayName || '成员', prize: units[i]! }));
}
