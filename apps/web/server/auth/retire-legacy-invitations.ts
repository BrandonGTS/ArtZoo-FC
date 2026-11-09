import type { PrismaClient } from '@artzoo/db';
import { lock } from './service';

/** One-time, user-authorized home-development cleanup. Never touches accounts or sessions. */
export async function retireLegacyInvitations(db: PrismaClient, now = new Date()) {
  return db.$transaction(
    async (tx) => {
      await lock(tx, 'maintenance:retire-legacy-invitations');
      const owners = await tx.account.findMany({
        where: { adminRole: 'SUPER_ADMIN' },
        select: { id: true },
        take: 2
      });
      if (owners.length !== 1) throw Error('A single initialized owner is required');
      const candidates = await tx.invitation.findMany({
        where: { tokenCiphertext: null, removedAt: null },
        orderBy: { id: 'asc' },
        take: 1001
      });
      if (candidates.length > 1000) throw Error('Maintenance scope exceeds safe batch limit');
      // Acquire the entire ordered invitation lock set before touching any code rows.
      // sendCode may invalidate a phone's codes across invitations; avoid row/lock inversion.
      for (const candidate of candidates) await lock(tx, `invitation:${candidate.tokenHash}`);
      let removed = 0,
        invalidatedCodes = 0;
      for (const candidate of candidates) {
        const current = await tx.invitation.findUniqueOrThrow({ where: { id: candidate.id } });
        if (current.removedAt || current.tokenCiphertext) continue;
        await tx.invitation.update({ where: { id: current.id }, data: { removedAt: now } });
        invalidatedCodes += (
          await tx.verificationCode.updateMany({
            where: { invitationId: current.id, consumedAt: null, invalidatedAt: null },
            data: { invalidatedAt: now }
          })
        ).count;
        await tx.accountAudit.create({
          data: {
            action: 'INVITATION_REMOVED',
            actorId: owners[0]!.id,
            invitationId: current.id,
            reason: '本人授权清理开发测试旧邀请码（本地维护）',
            createdAt: now
          }
        });
        removed++;
      }
      return { removed, invalidatedCodes };
    },
    { maxWait: 5000, timeout: 30000 }
  );
}
