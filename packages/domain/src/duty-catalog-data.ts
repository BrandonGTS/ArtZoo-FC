import type { DutyCatalogEntry, DutySeatTemplate } from './duty-contract.js';

// Approved mainland-China duty catalog. Names are copied from the reviewed source:
// Library libfile_e23cc9e9835c81919aeba7a09c353ca7, artzoo-duty-mapping-review.md.
// Supplement: Library libfile_56574013f3808191a361dc0901c9d312.
// Supplement names/defaults use the provided Huiji public search-index review,
// with selected official cross-checks; individual pages were not all read directly.
// Category membership and defaults follow the user's 2026-10-14 decisions.
// IDs below are permanent literals: preserve them when renaming or moving an entry.
// Bump catalog version and entryRevision for edits; disable retired entries.
export const DUTY_CATALOG_VERSION = '2026-10-14.2';

const LIGHT_PARTY: readonly DutySeatTemplate[] = [
  { groupKey: null, requirement: { kind: 'ROLE', role: 'TANK' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'HEALER' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'DAMAGE' } }
];
const FULL_PARTY: readonly DutySeatTemplate[] = [
  { groupKey: null, requirement: { kind: 'ROLE', role: 'TANK' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'TANK' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'HEALER' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'HEALER' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: null, requirement: { kind: 'ROLE', role: 'DAMAGE' } }
];
const ANY_FOUR: readonly DutySeatTemplate[] = [
  { groupKey: null, requirement: { kind: 'ANY' } },
  { groupKey: null, requirement: { kind: 'ANY' } },
  { groupKey: null, requirement: { kind: 'ANY' } },
  { groupKey: null, requirement: { kind: 'ANY' } }
];
const ALLIANCE: readonly DutySeatTemplate[] = [
  { groupKey: 'A', requirement: { kind: 'ROLE', role: 'TANK' } },
  { groupKey: 'A', requirement: { kind: 'ROLE', role: 'HEALER' } },
  { groupKey: 'A', requirement: { kind: 'ROLE', role: 'HEALER' } },
  { groupKey: 'A', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'A', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'A', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'A', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'A', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'B', requirement: { kind: 'ROLE', role: 'TANK' } },
  { groupKey: 'B', requirement: { kind: 'ROLE', role: 'HEALER' } },
  { groupKey: 'B', requirement: { kind: 'ROLE', role: 'HEALER' } },
  { groupKey: 'B', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'B', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'B', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'B', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'B', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'C', requirement: { kind: 'ROLE', role: 'TANK' } },
  { groupKey: 'C', requirement: { kind: 'ROLE', role: 'HEALER' } },
  { groupKey: 'C', requirement: { kind: 'ROLE', role: 'HEALER' } },
  { groupKey: 'C', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'C', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'C', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'C', requirement: { kind: 'ROLE', role: 'DAMAGE' } },
  { groupKey: 'C', requirement: { kind: 'ROLE', role: 'DAMAGE' } }
];

export const DUTY_CATALOG_DATA: readonly DutyCatalogEntry[] = [
  // ULTIMATE
  {
    id: 'duty-cn-0001',
    name: '巴哈姆特绝境战',
    type: 'ULTIMATE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0002',
    name: '究极神兵绝境战',
    type: 'ULTIMATE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0003',
    name: '亚历山大绝境战',
    type: 'ULTIMATE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0004',
    name: '幻想龙诗绝境战',
    type: 'ULTIMATE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0005',
    name: '欧米茄绝境验证战',
    type: 'ULTIMATE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0006',
    name: '光暗未来绝境战',
    type: 'ULTIMATE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0007',
    name: '妖星乱舞绝境战',
    type: 'ULTIMATE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  // SAVAGE
  {
    id: 'duty-cn-0008',
    name: '巴哈姆特零式大迷宫 入侵之章1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0009',
    name: '巴哈姆特零式大迷宫 入侵之章2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0010',
    name: '巴哈姆特零式大迷宫 入侵之章3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0011',
    name: '巴哈姆特零式大迷宫 入侵之章4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0012',
    name: '亚历山大零式机神城 启动之章1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0013',
    name: '亚历山大零式机神城 启动之章2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0014',
    name: '亚历山大零式机神城 启动之章3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0015',
    name: '亚历山大零式机神城 启动之章4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0016',
    name: '亚历山大零式机神城 律动之章1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0017',
    name: '亚历山大零式机神城 律动之章2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0018',
    name: '亚历山大零式机神城 律动之章3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0019',
    name: '亚历山大零式机神城 律动之章4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0020',
    name: '亚历山大零式机神城 天动之章1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0021',
    name: '亚历山大零式机神城 天动之章2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0022',
    name: '亚历山大零式机神城 天动之章3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0023',
    name: '亚历山大零式机神城 天动之章4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0024',
    name: '欧米茄零式时空狭缝 德尔塔幻境1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0025',
    name: '欧米茄零式时空狭缝 德尔塔幻境2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0026',
    name: '欧米茄零式时空狭缝 德尔塔幻境3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0027',
    name: '欧米茄零式时空狭缝 德尔塔幻境4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0028',
    name: '欧米茄零式时空狭缝 西格玛幻境1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0029',
    name: '欧米茄零式时空狭缝 西格玛幻境2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0030',
    name: '欧米茄零式时空狭缝 西格玛幻境3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0031',
    name: '欧米茄零式时空狭缝 西格玛幻境4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0032',
    name: '欧米茄零式时空狭缝 阿尔法幻境1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0033',
    name: '欧米茄零式时空狭缝 阿尔法幻境2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0034',
    name: '欧米茄零式时空狭缝 阿尔法幻境3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0035',
    name: '欧米茄零式时空狭缝 阿尔法幻境4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0036',
    name: '伊甸零式希望乐园 觉醒之章1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0037',
    name: '伊甸零式希望乐园 觉醒之章2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0038',
    name: '伊甸零式希望乐园 觉醒之章3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0039',
    name: '伊甸零式希望乐园 觉醒之章4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0040',
    name: '伊甸零式希望乐园 共鸣之章1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0041',
    name: '伊甸零式希望乐园 共鸣之章2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0042',
    name: '伊甸零式希望乐园 共鸣之章3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0043',
    name: '伊甸零式希望乐园 共鸣之章4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0044',
    name: '伊甸零式希望乐园 再生之章1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0045',
    name: '伊甸零式希望乐园 再生之章2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0046',
    name: '伊甸零式希望乐园 再生之章3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0047',
    name: '伊甸零式希望乐园 再生之章4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0048',
    name: '零式万魔殿 边境之狱1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0049',
    name: '零式万魔殿 边境之狱2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0050',
    name: '零式万魔殿 边境之狱3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0051',
    name: '零式万魔殿 边境之狱4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0052',
    name: '零式万魔殿 炼净之狱1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0053',
    name: '零式万魔殿 炼净之狱2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0054',
    name: '零式万魔殿 炼净之狱3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0055',
    name: '零式万魔殿 炼净之狱4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0056',
    name: '零式万魔殿 荒天之狱1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0057',
    name: '零式万魔殿 荒天之狱2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0058',
    name: '零式万魔殿 荒天之狱3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0059',
    name: '零式万魔殿 荒天之狱4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0060',
    name: '阿卡狄亚零式登天斗技场 轻量级1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0061',
    name: '阿卡狄亚零式登天斗技场 轻量级2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0062',
    name: '阿卡狄亚零式登天斗技场 轻量级3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0063',
    name: '阿卡狄亚零式登天斗技场 轻量级4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0064',
    name: '阿卡狄亚零式登天斗技场 中量级1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0065',
    name: '阿卡狄亚零式登天斗技场 中量级2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0066',
    name: '阿卡狄亚零式登天斗技场 中量级3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0067',
    name: '阿卡狄亚零式登天斗技场 中量级4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0068',
    name: '阿卡狄亚零式登天斗技场 重量级1',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0069',
    name: '阿卡狄亚零式登天斗技场 重量级2',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0070',
    name: '阿卡狄亚零式登天斗技场 重量级3',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0071',
    name: '阿卡狄亚零式登天斗技场 重量级4',
    type: 'SAVAGE',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  // VARIANT
  {
    id: 'duty-cn-0072',
    name: '多变迷宫 希拉狄哈水道',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0073',
    name: '多变迷宫 六根山',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0074',
    name: '多变迷宫 阿罗阿罗岛',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0075',
    name: '多变迷宫 商客奇谭',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0076',
    name: '异闻希拉狄哈水道',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0077',
    name: '零式异闻希拉狄哈水道',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0078',
    name: '异闻六根山',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0079',
    name: '零式异闻六根山',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0080',
    name: '异闻阿罗阿罗岛',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0081',
    name: '零式异闻阿罗阿罗岛',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0082',
    name: '深读商客奇谭',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0083',
    name: '异闻商客奇谭',
    type: 'VARIANT',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  // TRIAL
  {
    id: 'duty-cn-0084',
    name: '伊弗利特讨伐战',
    type: 'TRIAL',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0085',
    name: '泰坦讨伐战',
    type: 'TRIAL',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0086',
    name: '迦楼罗讨伐战',
    type: 'TRIAL',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0087',
    name: '究极神兵破坏作战',
    type: 'TRIAL',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0088',
    name: '那布里亚勒斯讨伐战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0089',
    name: '死化奇美拉讨伐战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0090',
    name: '海德拉讨伐战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0091',
    name: '大桥上的决斗',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0092',
    name: '艾玛吉娜杯斗技大会决赛',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0093',
    name: '无限城的死斗',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0094',
    name: '伊弗利特歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0095',
    name: '迦楼罗歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0096',
    name: '泰坦歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0097',
    name: '莫古力贤王歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0098',
    name: '利维亚桑歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0099',
    name: '拉姆歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0100',
    name: '希瓦歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0101',
    name: '奥丁歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0102',
    name: '罗波那歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0103',
    name: '俾斯麦歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0104',
    name: '圆桌骑士歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0105',
    name: '尼德霍格征龙战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0106',
    name: '萨菲洛特歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0107',
    name: '索菲娅歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0108',
    name: '祖尔宛歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0109',
    name: '须佐之男歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0110',
    name: '吉祥天女歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0111',
    name: '神龙歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0112',
    name: '月读歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0113',
    name: '保镖歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0114',
    name: '火龙狩猎战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0115',
    name: '白虎镇魂战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0116',
    name: '朱雀镇魂战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0117',
    name: '青龙镇魂战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0118',
    name: '缇坦妮雅歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0119',
    name: '无瑕灵君歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0120',
    name: '哈迪斯歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0121',
    name: '红宝石神兵破坏作战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0122',
    name: '光之战士歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0123',
    name: '绿宝石神兵破坏作战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0124',
    name: '钻石神兵捕获作战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0125',
    name: '佐迪亚克歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0126',
    name: '海德林歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0127',
    name: '终结之战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0128',
    name: '巴尔巴莉希娅歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0129',
    name: '卢比坎特歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0130',
    name: '高贝扎歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0131',
    name: '泽罗姆斯歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0132',
    name: '阿修罗歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0133',
    name: '艳翼蛇鸟歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0134',
    name: '佐拉加歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0135',
    name: '永恒女王歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0136',
    name: '泽莲尼娅歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0137',
    name: '永远之暗歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0138',
    name: '护锁刃龙狩猎战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0139',
    name: '格莱杨拉波尔歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0140',
    name: '恩欧歼灭战',
    type: 'TRIAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  // EXTREME
  {
    id: 'duty-cn-0141',
    name: '究极神兵假想作战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0142',
    name: '迦楼罗歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0143',
    name: '泰坦歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0144',
    name: '伊弗利特歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0145',
    name: '莫古力贤王歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0146',
    name: '利维亚桑歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0147',
    name: '拉姆歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0148',
    name: '希瓦歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0149',
    name: '俾斯麦歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0150',
    name: '罗波那歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0151',
    name: '圆桌骑士幻想歼灭战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0152',
    name: '尼德霍格传奇征龙战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0153',
    name: '萨菲洛特歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0154',
    name: '索菲娅歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0155',
    name: '祖尔宛歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0156',
    name: '须佐之男歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0157',
    name: '吉祥天女歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0158',
    name: '神龙梦幻歼灭战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0159',
    name: '月读幽夜歼灭战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0160',
    name: '火龙上位狩猎战',
    type: 'EXTREME',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0161',
    name: '白虎诗魂战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0162',
    name: '朱雀诗魂战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0163',
    name: '青龙诗魂战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0164',
    name: '缇坦妮雅歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0165',
    name: '无瑕灵君歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0166',
    name: '哈迪斯孤念歼灭战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0167',
    name: '红宝石神兵狂想作战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0168',
    name: '博兹雅堡垒追忆战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0169',
    name: '光之战士幻耀歼灭战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0170',
    name: '绿宝石神兵狂想作战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0171',
    name: '钻石神兵狂想作战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0172',
    name: '佐迪亚克暝暗歼灭战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0173',
    name: '海德林晖光歼灭战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0174',
    name: '终极之战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0175',
    name: '巴尔巴莉希娅歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0176',
    name: '卢比坎特歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0177',
    name: '高贝扎歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0178',
    name: '泽罗姆斯歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0179',
    name: '艳翼蛇鸟歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0180',
    name: '佐拉加歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0181',
    name: '永恒女王忆想歼灭战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0182',
    name: '泽莲尼娅歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0183',
    name: '永远之暗悲惶歼灭战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0184',
    name: '护锁刃龙上位狩猎战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0185',
    name: '格莱杨拉波尔歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0186',
    name: '恩欧歼殛战',
    type: 'EXTREME',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  // ALLIANCE_RAID
  {
    id: 'duty-cn-0187',
    name: '水晶塔 古代人迷宫',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0188',
    name: '水晶塔 希尔科斯塔',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0189',
    name: '水晶塔 暗之世界',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0190',
    name: '魔航船虚无方舟',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0191',
    name: '禁忌城邦玛哈',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0192',
    name: '影之国',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0193',
    name: '失落之都拉巴纳斯塔',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0194',
    name: '封闭圣塔黎铎拉纳大灯塔',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0195',
    name: '乐欲之所瓯博讷修道院',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0196',
    name: '复制工厂废墟',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0197',
    name: '人偶军事基地',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0198',
    name: '希望之炮台：“塔”',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0199',
    name: '灿烂神域阿格莱亚',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0200',
    name: '喜悦神域欧芙洛绪涅',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0201',
    name: '荣华神域塔利亚',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0202',
    name: '朱诺：第一巡行',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0203',
    name: '桑多利亚：第二巡行',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0204',
    name: '温达斯：第三巡行',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: ALLIANCE,
    enabled: true,
    entryRevision: 1
  },
  // RAID
  {
    id: 'duty-cn-0205',
    name: '巴哈姆特大迷宫 邂逅之章1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0206',
    name: '巴哈姆特大迷宫 邂逅之章2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0207',
    name: '巴哈姆特大迷宫 邂逅之章3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0208',
    name: '巴哈姆特大迷宫 邂逅之章4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0209',
    name: '巴哈姆特大迷宫 邂逅之章5',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0210',
    name: '巴哈姆特大迷宫 入侵之章1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0211',
    name: '巴哈姆特大迷宫 入侵之章2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0212',
    name: '巴哈姆特大迷宫 入侵之章3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0213',
    name: '巴哈姆特大迷宫 入侵之章4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0214',
    name: '巴哈姆特大迷宫 真源之章1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0215',
    name: '巴哈姆特大迷宫 真源之章2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0216',
    name: '巴哈姆特大迷宫 真源之章3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0217',
    name: '巴哈姆特大迷宫 真源之章4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0218',
    name: '亚历山大机神城 启动之章1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0219',
    name: '亚历山大机神城 启动之章2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0220',
    name: '亚历山大机神城 启动之章3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0221',
    name: '亚历山大机神城 启动之章4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0222',
    name: '亚历山大机神城 律动之章1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0223',
    name: '亚历山大机神城 律动之章2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0224',
    name: '亚历山大机神城 律动之章3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0225',
    name: '亚历山大机神城 律动之章4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0226',
    name: '亚历山大机神城 天动之章1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0227',
    name: '亚历山大机神城 天动之章2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0228',
    name: '亚历山大机神城 天动之章3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0229',
    name: '亚历山大机神城 天动之章4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0230',
    name: '欧米茄时空狭缝 德尔塔幻境1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0231',
    name: '欧米茄时空狭缝 德尔塔幻境2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0232',
    name: '欧米茄时空狭缝 德尔塔幻境3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0233',
    name: '欧米茄时空狭缝 德尔塔幻境4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0234',
    name: '欧米茄时空狭缝 西格玛幻境1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0235',
    name: '欧米茄时空狭缝 西格玛幻境2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0236',
    name: '欧米茄时空狭缝 西格玛幻境3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0237',
    name: '欧米茄时空狭缝 西格玛幻境4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0238',
    name: '欧米茄时空狭缝 阿尔法幻境1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0239',
    name: '欧米茄时空狭缝 阿尔法幻境2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0240',
    name: '欧米茄时空狭缝 阿尔法幻境3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0241',
    name: '欧米茄时空狭缝 阿尔法幻境4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0242',
    name: '伊甸希望乐园 觉醒之章1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0243',
    name: '伊甸希望乐园 觉醒之章2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0244',
    name: '伊甸希望乐园 觉醒之章3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0245',
    name: '伊甸希望乐园 觉醒之章4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0246',
    name: '伊甸希望乐园 共鸣之章1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0247',
    name: '伊甸希望乐园 共鸣之章2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0248',
    name: '伊甸希望乐园 共鸣之章3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0249',
    name: '伊甸希望乐园 共鸣之章4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0250',
    name: '伊甸希望乐园 再生之章1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0251',
    name: '伊甸希望乐园 再生之章2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0252',
    name: '伊甸希望乐园 再生之章3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0253',
    name: '伊甸希望乐园 再生之章4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0254',
    name: '万魔殿 边境之狱1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0255',
    name: '万魔殿 边境之狱2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0256',
    name: '万魔殿 边境之狱3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0257',
    name: '万魔殿 边境之狱4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0258',
    name: '万魔殿 炼净之狱1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0259',
    name: '万魔殿 炼净之狱2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0260',
    name: '万魔殿 炼净之狱3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0261',
    name: '万魔殿 炼净之狱4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0262',
    name: '万魔殿 荒天之狱1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0263',
    name: '万魔殿 荒天之狱2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0264',
    name: '万魔殿 荒天之狱3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0265',
    name: '万魔殿 荒天之狱4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0266',
    name: '阿卡狄亚登天斗技场 轻量级1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0267',
    name: '阿卡狄亚登天斗技场 轻量级2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0268',
    name: '阿卡狄亚登天斗技场 轻量级3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0269',
    name: '阿卡狄亚登天斗技场 轻量级4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0270',
    name: '阿卡狄亚登天斗技场 中量级1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0271',
    name: '阿卡狄亚登天斗技场 中量级2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0272',
    name: '阿卡狄亚登天斗技场 中量级3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0273',
    name: '阿卡狄亚登天斗技场 中量级4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0274',
    name: '阿卡狄亚登天斗技场 重量级1',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0275',
    name: '阿卡狄亚登天斗技场 重量级2',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0276',
    name: '阿卡狄亚登天斗技场 重量级3',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0277',
    name: '阿卡狄亚登天斗技场 重量级4',
    type: 'RAID',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  // UNREAL
  {
    id: 'duty-cn-0278',
    name: '神龙幻巧战',
    type: 'UNREAL',
    capacity: 8,
    partyComposition: 'FULL',
    defaultSeats: FULL_PARTY,
    enabled: true,
    entryRevision: 1
  },
  // DUNGEON — approved ordinary and deep-dungeon supplement (stable appended IDs).
  {
    id: 'duty-cn-0279',
    name: '天然要害沙斯塔夏溶洞',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0280',
    name: '地下灵殿塔姆·塔拉墓园',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0281',
    name: '封锁坑道铜铃铜山',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0282',
    name: '魔兽领域日影地修炼所',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0283',
    name: '监狱废墟托托·拉克千狱',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0284',
    name: '名门府邸静语庄园',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0285',
    name: '休养胜地布雷福洛克斯野营地',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0286',
    name: '古代遗迹喀恩埋没圣堂',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0287',
    name: '流沙迷宫樵鸣洞',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0288',
    name: '对龙城塞石卫塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0289',
    name: '山中战线泽梅尔要塞',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0290',
    name: '毒雾洞窟黄金谷',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0291',
    name: '神灵圣域放浪神古神殿',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0292',
    name: '神兵要塞帝国南方堡',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0293',
    name: '最终决战天幕魔导城',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0294',
    name: '邪教驻地无限城古堡',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0295',
    name: '领航明灯天狼星灯塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0296',
    name: '骚乱坑道铜铃铜山',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0297',
    name: '恶灵府邸静语庄园',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0298',
    name: '腐坏遗迹无限城市街古迹',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0299',
    name: '剑斗领域日影地修炼所',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0300',
    name: '纷争要地布雷福洛克斯野营地',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0301',
    name: '财宝传说破舰岛',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0302',
    name: '惨剧灵殿塔姆·塔拉墓园',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0303',
    name: '激战城塞石卫塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0304',
    name: '凛冽洞天披雪大冰壁',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0305',
    name: '逆转要害沙斯塔夏溶洞',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0306',
    name: '苏醒遗迹喀恩埋没圣堂',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0307',
    name: '幻龙残骸密约之塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0308',
    name: '武装圣域放浪神古神殿',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0309',
    name: '邪念妖地无限城古堡',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0310',
    name: '冰雪废堡暮卫塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0311',
    name: '天山绝顶索姆阿尔灵峰',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0312',
    name: '邪龙王座龙巢神殿',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0313',
    name: '圣教中枢伊修加德教皇厅',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0314',
    name: '学识宝库迦巴勒幻想图书馆',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0315',
    name: '血战苍穹魔科学研究所',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0316',
    name: '空中神域不获岛',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0317',
    name: '博物战舰无限回廊',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0318',
    name: '草木庭园圣茉夏娜植物园',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0319',
    name: '地脉灵灯天狼星灯塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0320',
    name: '星海空间颠倒塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0321',
    name: '神圣遗迹无限城市街古迹',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0322',
    name: '天龙宫殿忆罪宫',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0323',
    name: '黑涡传说破舰岛',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0324',
    name: '险峻峡谷塞尔法特尔溪谷',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0325',
    name: '秘本宝库迦巴勒幻想图书馆',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0326',
    name: '坚牢铁壁巴埃萨长城',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0327',
    name: '天山深境索姆阿尔灵峰',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0328',
    name: '漂流海域妖歌海',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0329',
    name: '海底宫殿紫水宫',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0330',
    name: '试炼行路巴儿达木霸道',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0331',
    name: '解放决战多玛王城',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0332',
    name: '巨炮要塞帝国白山堡',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0333',
    name: '鏖战红莲阿拉米格',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0334',
    name: '恶党孤城黄金阁',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0335',
    name: '修行古刹星导寺',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0336',
    name: '沉没神殿斯卡拉遗迹',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0337',
    name: '红玉火山狱之盖',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0338',
    name: '疯狂战舰无限回廊',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0339',
    name: '风水灵庙岩燕庙',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0340',
    name: '死亡大地终末焦土',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0341',
    name: '污染庭园圣茉夏娜植物园',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0342',
    name: '国境防线基姆利特暗区',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0343',
    name: '遇袭集落水滩村',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0344',
    name: '水妖幻园多恩美格禁园',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0345',
    name: '文明古迹奇坦那神影洞',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0346',
    name: '避暑离宫马利卡大井',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0347',
    name: '伪造天界格鲁格火山',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0348',
    name: '末日暗影亚马乌罗提',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0349',
    name: '异界遗构希尔科斯孪晶塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0350',
    name: '创造机构阿尼德罗学院',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0351',
    name: '魔法宫殿宇宙宫',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0352',
    name: '黑风海底阿尼德罗追忆馆',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0353',
    name: '暗影决战诺弗兰特',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0354',
    name: '魔术工房玛托雅工作室',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0355',
    name: '黄金平原帕戈尔赞草原',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0356',
    name: '异形楼阁佐特塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0357',
    name: '魔导神门巴别塔',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0358',
    name: '末日树海万相森国',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0359',
    name: '创造环境极北造物院',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0360',
    name: '星海深幽寻因星晶镜',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0361',
    name: '最终幻想末世终迹',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0362',
    name: '乐园都市笑笑镇',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0363',
    name: '电脑梦境斯提格玛四',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0364',
    name: '近东秘宝阿尔扎达尔海底遗迹群',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0365',
    name: '异界孤城特罗亚宫廷',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0366',
    name: '雪山奥窟冥魂石洞',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0367',
    name: '间歇灵泉哈姆岛',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0368',
    name: '异界深渊月面地下溪谷',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0369',
    name: '丛林竞流生息河岸',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0370',
    name: '通天绝壁沃刻佐莫山',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0371',
    name: '神圣禁地深空天坑',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0372',
    name: '前哨基地先锋营',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0373',
    name: '魂魄工厂创生设施',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0374',
    name: '忆中金曦亚历山德里亚',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0375',
    name: '荒野秘境仙人刺谷',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0376',
    name: '噩梦乐园迷途鬼区',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0377',
    name: '废弃据点玉韦亚瓦塔实验站',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0378',
    name: '王城古迹永护塔底',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0379',
    name: '永久幽界中央终端',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0380',
    name: '遗忘行路雾之迹',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0381',
    name: '军工要地克吕提俄斯魔导工厂',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: LIGHT_PARTY,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0382',
    name: '死者宫殿',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0383',
    name: '天之御柱',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0384',
    name: '正统优雷卡',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0385',
    name: '朝圣交错路',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0386',
    name: '卓异的悲寂歼灭战',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  },
  {
    id: 'duty-cn-0387',
    name: '卓异的悲寂深想战',
    type: 'DUNGEON',
    capacity: 4,
    partyComposition: 'LIGHT',
    defaultSeats: ANY_FOUR,
    enabled: true,
    entryRevision: 1
  }
];
