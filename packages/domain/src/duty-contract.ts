import { invalid } from './account-contract.js';
import type { SeatRequirement } from './activity-contract.js';

export const DUTY_TYPE_LABELS = {
  ULTIMATE: '绝境战',
  SAVAGE: '零式',
  VARIANT: '多变迷宫',
  TRIAL: '歼灭战',
  EXTREME: '歼殛战',
  ALLIANCE_RAID: '团队任务',
  RAID: '大型任务',
  DUNGEON: '迷宫探索',
  UNREAL: '幻巧战',
  OTHER: '其他'
} as const;
export type DutyType = keyof typeof DUTY_TYPE_LABELS;
export type CatalogDutyType = Exclude<DutyType, 'OTHER'>;
export const DUTY_TYPES = Object.entries(DUTY_TYPE_LABELS).map(([value, label]) => ({
  value: value as DutyType,
  label
}));
export const PARTY_COMPOSITION_LABELS = {
  LIGHT: '轻锐小队（4人）',
  FULL: '满编小队（8人）',
  ALLIANCE: '团队（24人）',
  CUSTOM: '其他（自定义人数）'
} as const;
export type PartyComposition = keyof typeof PARTY_COMPOSITION_LABELS;
export type DutyGroupKey = 'A' | 'B' | 'C';
export interface DutySeatTemplate {
  groupKey: DutyGroupKey | null;
  requirement: SeatRequirement;
}
export interface DutyCatalogEntry {
  id: string;
  name: string;
  type: CatalogDutyType;
  capacity: number;
  defaultSeats: readonly DutySeatTemplate[];
  enabled: boolean;
  entryRevision: number;
  partyComposition: Exclude<PartyComposition, 'CUSTOM'>;
}
export interface DutyCatalogList {
  catalogVersion: string;
  items: readonly DutyCatalogEntry[];
}
export type DutySelection =
  | { type: CatalogDutyType; dutyId: string }
  | { type: 'OTHER'; name: string; partyComposition: PartyComposition };
export type DutySelectionInput = DutySelection;
export interface DutySnapshot {
  id: string | null;
  name: string;
  type: DutyType;
  capacity: number;
  partyComposition: PartyComposition;
  catalogVersion: string | null;
  entryRevision: number | null;
  finalSeats: DutySeatTemplate[];
}
export function isCatalogDutyType(value: unknown): value is CatalogDutyType {
  return typeof value === 'string' && value !== 'OTHER' && Object.hasOwn(DUTY_TYPE_LABELS, value);
}
export function dutyPresetSeats(composition: PartyComposition): DutySeatTemplate[] {
  const party = (
    tanks: number,
    healers: number,
    damage: number,
    groupKey: DutyGroupKey | null
  ): DutySeatTemplate[] =>
    (['TANK', 'HEALER', 'DAMAGE'] as const).flatMap((role, i) =>
      Array.from({ length: [tanks, healers, damage][i] ?? 0 }, () => ({
        groupKey,
        requirement: { kind: 'ROLE' as const, role }
      }))
    );
  if (composition === 'LIGHT') return party(1, 1, 2, null);
  if (composition === 'FULL') return party(2, 2, 4, null);
  if (composition === 'ALLIANCE') return (['A', 'B', 'C'] as const).flatMap((group) => party(1, 2, 5, group));
  return [];
}
export function validateDutySelection(value: unknown): DutySelection {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('dutySelection', '请选择副本类型和具体副本');
  const selection = value as Record<string, unknown>;
  const exact = (keys: string[]) => {
    if (Object.keys(selection).some((key) => !keys.includes(key)))
      invalid('dutySelection', '包含不允许提交的字段');
  };
  if (selection.type === 'OTHER') {
    exact(['type', 'name', 'partyComposition']);
    if (
      typeof selection.name !== 'string' ||
      !selection.name.trim() ||
      selection.name.length > 100 ||
      /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(selection.name)
    )
      invalid('dutySelection', '请填写100字以内的副本名称');
    if (
      typeof selection.partyComposition !== 'string' ||
      !Object.hasOwn(PARTY_COMPOSITION_LABELS, selection.partyComposition)
    )
      invalid('dutySelection', '请选择有效编制');
    return {
      type: 'OTHER',
      name: selection.name.trim(),
      partyComposition: selection.partyComposition as PartyComposition
    };
  }
  exact(['type', 'dutyId']);
  if (!isCatalogDutyType(selection.type)) invalid('dutySelection', '副本类型无效');
  if (typeof selection.dutyId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(selection.dutyId))
    invalid('dutySelection', '请选择有效副本');
  return { type: selection.type, dutyId: selection.dutyId };
}
