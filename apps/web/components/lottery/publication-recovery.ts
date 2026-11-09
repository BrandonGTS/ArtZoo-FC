import { validateLottery, type LotteryInput } from '../../server/lottery/contract';

export type PublicationAttempt = { owner: string; body: LotteryInput; uncertain: boolean };
export const PUBLICATION_UNKNOWN = '上次发布结果尚未确认，已保留原内容，请重试本次发布。';
export const publicationStorageKey = (owner: string) => `artzoo:lottery-publication:v1:${owner}`;

// A reload must retain the same payload/key. Store no token, phone or recipient data.
export function readPublicationAttempt(owner: string): PublicationAttempt | null {
  const raw = sessionStorage.getItem(publicationStorageKey(owner));
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    if (saved.owner !== owner) throw new Error('Different owner');
    return { owner, body: validateLottery(saved.body, new Date(), false), uncertain: true };
  } catch {
    sessionStorage.removeItem(publicationStorageKey(owner));
    return null;
  }
}
export function savePublicationAttempt(attempt: PublicationAttempt) {
  sessionStorage.setItem(
    publicationStorageKey(attempt.owner),
    JSON.stringify({ owner: attempt.owner, body: attempt.body })
  );
}
export function clearPublicationAttempt(owner: string) {
  sessionStorage.removeItem(publicationStorageKey(owner));
}
export function publicationRemainsUnknown(
  wasUnknown: boolean,
  code: string,
  fieldErrors?: Record<string, string>
) {
  // With a frozen, validated body, these timing failures occur only after create's
  // locked prior-key lookup found no row. A late original request cannot then create it.
  if (wasUnknown && code === 'VALIDATION_ERROR' && (fieldErrors?.drawAt || fieldErrors?.month)) return false;
  if (wasUnknown) return true; // Auth/rate errors before replay do not resolve an earlier commit.
  return ![
    'VALIDATION_ERROR',
    'FORBIDDEN',
    'UNAUTHENTICATED',
    'CONFLICT',
    'RATE_LIMITED',
    'NOT_FOUND'
  ].includes(code);
}
