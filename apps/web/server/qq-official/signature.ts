import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AccountError } from '@artzoo/domain';
export function qqSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  path: string,
  raw: string
): string {
  const digest = createHash('sha256').update(raw).digest('hex');
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\nPOST\n${path}\n${digest}`)
    .digest('hex');
}
export function verifyQqSignature(
  headers: Headers,
  path: string,
  raw: string,
  secret: string,
  now: Date
): { nonce: string; expiresAt: Date } {
  const timestamp = headers.get('x-artzoo-timestamp') ?? '',
    nonce = headers.get('x-artzoo-nonce') ?? '',
    signature = headers.get('x-artzoo-signature') ?? '';
  if (
    !/^\d{10}$/.test(timestamp) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    Math.abs(now.getTime() - Number(timestamp) * 1000) > 60_000
  )
    throw new AccountError('FORBIDDEN', 'Bridge认证无效', 403);
  const expected = qqSignature(secret, timestamp, nonce, path, raw);
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')))
    throw new AccountError('FORBIDDEN', 'Bridge认证无效', 403);
  return { nonce, expiresAt: new Date(now.getTime() + 120_000) };
}
