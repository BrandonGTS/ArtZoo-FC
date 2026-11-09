import {
  normalizeQqSignupCode,
  ACTIVITY_JOBS,
  AccountError,
  dutyPresetSeats,
  qqPresetSeatLabels,
  type RegisterActivityInput
} from '@artzoo/domain';
import type { ActivityRegistrationRow } from '../activities/service';

export type QqSignupCommand =
  | { kind: 'OFFLINE' }
  | {
      kind: 'GAME';
      group: 'A' | 'B' | 'C' | null;
      label: string;
      job: string;
    };
const website =
  '请前往网站操作。游戏报名格式：4人 报名 T 骑士／H 白魔；8人 报名 MT 骑士／H1 白魔；24人 报名 A队 T 骑士／H1 白魔（须带队伍）；支持对应D席位。线下活动：报名';
function unsupported(): never {
  throw new AccountError('VALIDATION_ERROR', website, 400);
}

// Each alias maps to exactly one canonical website job. No fuzzy matching or model inference.
const aliases: Readonly<Record<string, string>> = {
  白魔: '白魔法师',
  黑魔: '黑魔法师',
  赤魔: '赤魔法师',
  召唤: '召唤师',
  暗骑: '暗黑骑士',
  绝枪: '绝枪战士',
  占星: '占星术士',
  龙骑: '龙骑士',
  诗人: '吟游诗人',
  机工: '机工士',
  钐镰: '钐镰客',
  蝰蛇: '蝰蛇剑士',
  绘灵: '绘灵法师'
};
export function parseQqSignup(content: string): QqSignupCommand {
  if (typeof content !== 'string' || content.length > 100) return unsupported();
  const text = content.trim();
  if (text === '报名') return { kind: 'OFFLINE' };
  const match = /^报名(?:\s+([ABC])队)?\s+(MT|ST|T|H[12]?|D[1-5])\s+(\S+)$/iu.exec(text);
  if (!match) return unsupported();
  const job = ACTIVITY_JOBS.find((item) => item.name === match[3])?.name ?? aliases[match[3]!];
  if (!job || !ACTIVITY_JOBS.some((item) => item.name === job)) return unsupported();
  return {
    kind: 'GAME',
    group: (match[1]?.toUpperCase() as 'A' | 'B' | 'C' | undefined) ?? null,
    label: match[2]!.toUpperCase(),
    job
  };
}

export function qqSignupInput(row: ActivityRegistrationRow, command: QqSignupCommand): RegisterActivityInput {
  if (row.scene === 'OFFLINE') {
    if (command.kind !== 'OFFLINE') return unsupported();
    return { seatId: null, job: null };
  }
  if (command.kind !== 'GAME' || row.category !== 'DUNGEON') return unsupported();
  const snapshot = row.dutySnapshot as { partyComposition?: unknown } | null;
  const composition = snapshot?.partyComposition;
  if (composition !== 'LIGHT' && composition !== 'FULL' && composition !== 'ALLIANCE') return unsupported();
  const preset = dutyPresetSeats(composition);
  if (
    row.seats.length !== preset.length ||
    row.seats.some((seat, index) => seat.position !== index || seat.groupKey !== preset[index]?.groupKey)
  )
    return unsupported();
  if ((composition === 'ALLIANCE') !== (command.group !== null)) return unsupported();
  const labels = qqPresetSeatLabels(composition);
  // Old sent examples used MT for the sole tank and H1 for the LIGHT healer.
  // Retain only these unambiguous aliases; FULL T / ALLIANCE H stay invalid.
  const label =
    composition !== 'FULL' && command.label === 'MT'
      ? 'T'
      : composition === 'LIGHT' && command.label === 'H1'
        ? 'H'
        : command.label;
  const candidates = preset.flatMap((seat, position) =>
    seat.groupKey === command.group && labels[position] === label ? [row.seats[position]!] : []
  );
  if (candidates.length !== 1) return unsupported();
  return { seatId: candidates[0]!.id, job: command.job };
}

/** Extract only an exact public locator; never infer an activity from malformed seats/jobs. */
export function parseQqSignupLocator(content: string): string | null {
  if (typeof content !== 'string' || content.length > 110) return unsupported();
  const match = /^报名\s+(\S+)([\s\S]*)$/.exec(content.trim());
  return match ? normalizeQqSignupCode(match[1]) : null;
}

/** Full grammar is checked only after authenticated activity resolution and cancellation guard. */
export function parseQqSignupTarget(content: string): {
  activityCode: string | null;
  command: QqSignupCommand;
} {
  const activityCode = parseQqSignupLocator(content);
  const match = activityCode ? /^报名\s+\S+([\s\S]*)$/.exec(content.trim()) : null;
  return { activityCode, command: parseQqSignup(match ? '报名' + match[1]! : content) };
}
