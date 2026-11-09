import { createHash } from 'node:crypto';
import type { QcTarget, QcBindings } from './core';

export const LOCAL_QC_NAMESPACE = 'artzoo-local-qc-v1';
export const LOCAL_QC_LABEL = '[虚构QC-V1]';
export const LOCAL_QC_SLOTS = ['member-a', 'member-b', 'friend', 'admin'] as const;
export type LocalQcSlot = (typeof LOCAL_QC_SLOTS)[number];
export type LocalQcBindings = Readonly<QcBindings>;
export interface LocalQcDataOptions {
  target?: QcTarget;
  originalDirectory: string;
  derivedDirectory: string;
  /** First-run anchor only. A replay always uses the immutable persisted anchor. */
  anchor?: Date;
}
export interface LocalQcFileReceipt {
  path: string;
  sha256: string;
  bytes: number;
  state: 'published' | 'staged';
}
export interface LocalQcDataResult {
  namespace: string;
  anchor: string;
  manifestHash: string;
  replayed: boolean;
  records: readonly { slot: string; kind: string; entityId: string; digest: string }[];
  files: readonly LocalQcFileReceipt[];
}
export class LocalQcDataError extends Error {
  constructor(
    readonly code: string,
    readonly slots: readonly string[] = [],
    readonly files: readonly LocalQcFileReceipt[] = []
  ) {
    super(code);
    this.name = 'LocalQcDataError';
  }
}
// A versioned, non-secret specification. Changing any content/relationship requires a new version;
// the existing namespace is intentionally NOT silently upgraded.
export const LOCAL_QC_DATA_MANIFEST = Object.freeze({
  version: 'local-qc-v1-data-1',
  namespace: LOCAL_QC_NAMESPACE,
  label: LOCAL_QC_LABEL,
  accounts: LOCAL_QC_SLOTS,
  activityDays: [35, 32, 36, 43, 37],
  teamSessionDays: [39, 40],
  activities: 5,
  series: 1,
  registrations: 4,
  teams: 2,
  teamSessions: 2,
  albums: 1,
  photos: 1,
  knowledge: 1,
  daily: 1,
  wishes: 2,
  lotteries: 13,
  lotteryState: 'CANCELLED',
  lotteryMode: 'MANUAL',
  resourceCategories: 1,
  resourceLinks: 1,
  featuredTextShares: 1,
  featuredPhotos: 0,
  messages: { knowledge: 3, daily: 2, wish: 2, unread: 6, read: 1 },
  checkins: 0,
  officialEvents: 0,
  geometry: 'svg-640x400-v1',
  resourceOrigin: 'http://localhost:3100'
});

function normalized(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (/^(phone|phoneMasked|passwordHash|tokenHash|token|sessionToken|secret|password)$/i.test(key))
        throw new LocalQcDataError('QC_UNSAFE_SNAPSHOT_FIELD');
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = normalized(child);
    }
    return result;
  }
  return value;
}
export const localQcCanonical = (value: unknown) => JSON.stringify(normalized(value));
export const localQcDigest = (value: unknown) =>
  createHash('sha256').update(localQcCanonical(value)).digest('hex');
export function localQcId(slot: string): string {
  if (!/^[a-z0-9][a-z0-9:._-]{0,150}$/.test(slot)) throw new LocalQcDataError('QC_INVALID_LOGICAL_SLOT');
  const bytes = createHash('sha256')
    .update(LOCAL_QC_NAMESPACE + '\0' + slot)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function validateLocalQcBindings(value: LocalQcBindings): void {
  if (
    !value ||
    Object.keys(value).length !== 4 ||
    LOCAL_QC_SLOTS.some(
      (slot) =>
        typeof value[slot] !== 'string' ||
        !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value[slot]) ||
        value[slot].length !== 36
    ) ||
    new Set(LOCAL_QC_SLOTS.map((slot) => value[slot])).size !== 4
  )
    throw new LocalQcDataError('QC_INVALID_BINDINGS');
}
