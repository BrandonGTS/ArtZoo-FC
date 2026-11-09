import { AccountError, membershipInput, validatePassword } from '@artzoo/domain';
import type { PrismaClient } from '@artzoo/db';
import { hashSecret } from './crypto';
import { lock } from './service';
import type { PhonePolicy } from './ports';

export type OwnerInitializationContext = 'local-console' | 'production-console';
/** Explicit operator workflow only. Never import this module from an HTTP route. */
export async function initializeSuperAdministrator(
  db: PrismaClient,
  phonePolicy: PhonePolicy,
  input: {
    phone: string;
    password: string;
    confirmPassword: string;
    membership: unknown;
    confirmation: 'INITIALIZE_CONFIRMED_OWNER';
  },
  auditContext: OwnerInitializationContext = 'local-console'
) {
  if (!['local-console', 'production-console'].includes(auditContext))
    throw new AccountError('FORBIDDEN', '初始化来源无效', 403);
  if (input.confirmation !== 'INITIALIZE_CONFIRMED_OWNER')
    throw new AccountError('FORBIDDEN', '需由用户本人确认初始化', 403);
  if (!phonePolicy.ready) throw new AccountError('PHONE_REGION_UNCONFIRMED', phonePolicy.hint, 503);
  const phone = phonePolicy.normalize(input.phone);
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new AccountError('VALIDATION_ERROR', '手机号无效');
  const membership = membershipInput(input.membership);
  const passwordHash = await hashSecret(validatePassword(input.password, input.confirmPassword));
  return db.$transaction(
    async (tx) => {
      await lock(tx, 'bootstrap-super-administrator');
      await lock(tx, `phone:${phone}`);
      if (await tx.account.count({ where: { adminRole: 'SUPER_ADMIN' } }))
        throw new AccountError('CONFLICT', '超级管理员已初始化，不能重复运行', 409);
      if (await tx.account.findUnique({ where: { phone } }))
        throw new AccountError('CONFLICT', '该手机号已有账号，不自动提权或覆盖密码', 409);
      const account = await tx.account.create({
        data: { phone, passwordHash, membership, adminRole: 'SUPER_ADMIN' }
      });
      await tx.accountAudit.create({
        data: {
          action: 'SUPER_ADMIN_INITIALIZED',
          actorId: account.id,
          targetAccountId: account.id,
          reason:
            auditContext === 'production-console'
              ? '用户本人通过受控生产控制台初始化流程指定'
              : '用户本人通过受控本地初始化流程指定'
        }
      });
      return { accountId: account.id };
    },
    { maxWait: 5000, timeout: 15000 }
  );
}
