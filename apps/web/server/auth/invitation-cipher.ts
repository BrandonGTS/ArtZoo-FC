import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AccountError } from '@artzoo/domain';
import { tokenDigest } from './crypto';

export interface InvitationCipher {
  seal(token: string, id: string, digest: string): string;
  open(envelope: string, id: string, digest: string): string;
}
export function invitationLinkUnavailable(): AccountError {
  return new AccountError('INVITATION_LINK_UNAVAILABLE', '邀请链接暂不可用，请管理员检查独立密钥配置', 503);
}
/** Separate, user-provisioned key. Never derive from database/SMS/session secrets. */
export function loadInvitationCipher(env: Record<string, string | undefined>): InvitationCipher | undefined {
  const value = env.ARTZOO_INVITATION_KEY;
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) return undefined;
  const aad = (id: string, digest: string) =>
    Buffer.from(JSON.stringify(['artzoo-invitation', 1, id, digest]));
  return {
    seal(token, id, digest) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(id, digest));
      const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return [
        'v1',
        nonce.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url')
      ].join('.');
    },
    open(envelope, id, digest) {
      try {
        // Exact envelope lengths prevent ambiguous parsing and unbounded allocations.
        if (!/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$/.test(envelope))
          throw Error('Invalid envelope');
        const [, nonce, tag, ciphertext] = envelope.split('.');
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce!, 'base64url'));
        decipher.setAAD(aad(id, digest));
        decipher.setAuthTag(Buffer.from(tag!, 'base64url'));
        const token = Buffer.concat([
          decipher.update(Buffer.from(ciphertext!, 'base64url')),
          decipher.final()
        ]).toString('utf8');
        if (!/^[A-Za-z0-9_-]{43}$/.test(token) || tokenDigest(token) !== digest) throw Error('Invalid token');
        return token;
      } catch {
        // Never propagate cryptographic errors, key material, envelope or plaintext.
        throw invitationLinkUnavailable();
      }
    }
  };
}
