import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
function derive(value: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(value, salt, 32, options, (error, result) => (error ? reject(error) : resolve(result)))
  );
}
export async function hashSecret(value: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1$${salt}$${(await derive(value, salt)).toString('hex')}`;
}
export async function verifySecret(value: string, encoded: string): Promise<boolean> {
  const [version, salt, hash, extra] = encoded.split('$');
  if (
    version !== 'scrypt-v1' ||
    !salt ||
    !hash ||
    extra ||
    !/^[a-f0-9]{32}$/.test(salt) ||
    !/^[a-f0-9]{64}$/.test(hash)
  )
    return false;
  return timingSafeEqual(await derive(value, salt), Buffer.from(hash, 'hex'));
}
export const opaqueToken = (): string => randomBytes(32).toString('base64url');
export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex');
export const verificationCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, '0');
// Same expensive verification path for a missing account; this is not a usable credential.
export const DUMMY_PASSWORD_HASH = `scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(64)}`;
