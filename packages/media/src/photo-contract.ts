import { AccountError } from '@artzoo/domain';
export const PHOTO_RULES = {
  maxBytes: 30 * 1024 * 1024,
  maxBatch: 10,
  maxPixels: 40_000_000,
  maxDecodedPixels: 80_000_000,
  maxFrames: 300
} as const;
export function bad(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
