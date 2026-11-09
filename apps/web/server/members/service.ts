import type { Prisma } from '@artzoo/db';
import {
  AccountError,
  invalid,
  isMemberId,
  membershipInput,
  validateMemberProfile,
  type MemberList,
  type MemberProfile,
  type MemberSummary
} from '@artzoo/domain';
import { tokenDigest } from '../auth/crypto';
import { AccountService, gameNicknameTaken, isGameNicknameConstraint, lock } from '../auth/service';

// Select public fields at the database boundary; never spread an Account into a member DTO.
export const memberSelect = {
  id: true,
  displayName: true,
  gameRegion: true,
  gameServer: true,
  membership: true,
  createdAt: true,
  profile: {
    select: {
      bio: true,
      commonJobs: true,
      preferredPlaystyles: true,
      revision: true,
      avatar: { select: { id: true, width: true, height: true } }
    }
  }
} as const satisfies Prisma.AccountSelect;
export type PublicMember = Prisma.AccountGetPayload<{ select: typeof memberSelect }>;

export function memberSummary(account: PublicMember): MemberSummary {
  const asset = account.profile?.avatar;
  return {
    id: account.id,
    displayName: account.displayName,
    gameRegion: account.gameRegion,
    gameServer: account.gameServer,
    membership: account.membership,
    bio: account.profile?.bio ?? '',
    registeredAt: account.createdAt.toISOString(),
    avatar: asset
      ? {
          id: asset.id,
          url: `/api/avatars/${asset.id}`,
          smallUrl: `/api/avatars/${asset.id}?size=small`,
          width: asset.width,
          height: asset.height
        }
      : null
  };
}
export function memberProfile(account: PublicMember): MemberProfile {
  return {
    ...memberSummary(account),
    commonJobs: account.profile?.commonJobs ?? [],
    preferredPlaystyles: account.profile?.preferredPlaystyles ?? [],
    revision: account.profile?.revision ?? 0
  };
}
function memberMissing(): AccountError {
  return new AccountError('NOT_FOUND', '成员不存在', 404);
}

export class MemberService {
  constructor(readonly auth: AccountService) {}

  async getOwn(token?: string | null): Promise<MemberProfile> {
    return this.auth.transaction(async (tx) => {
      const session = await this.auth.requireAccount(tx, token);
      const account = await tx.account.findUnique({ where: { id: session.accountId }, select: memberSelect });
      if (!account) throw memberMissing();
      return memberProfile(account);
    });
  }

  async updateOwn(body: Record<string, unknown>, token?: string | null): Promise<MemberProfile> {
    const input = validateMemberProfile(body);
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`member-profile:${actor.accountId}`, 60, 900);
    return this.auth
      .transaction(async (tx) => {
        // Match credential-write lock ordering, then serialize every profile/avatar change.
        await lock(tx, `phone:${actor.account.phone}`);
        await lock(tx, `member-profile:${actor.accountId}`);
        const currentSession = await this.auth.requireAccount(tx, token);
        if (currentSession.accountId !== actor.accountId)
          throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
        await lock(tx, `game-name:${tokenDigest(JSON.stringify([input.gameServer, input.displayName]))}`);
        const current = await tx.account.findUnique({ where: { id: actor.accountId }, select: memberSelect });
        if (!current) throw memberMissing();
        if ((current.profile?.revision ?? 0) !== input.revision) {
          throw new AccountError('CONFLICT', '资料已更新，请刷新后重新编辑', 409);
        }
        const duplicate = await tx.account.findFirst({
          where: {
            gameServer: input.gameServer,
            displayName: input.displayName,
            id: { not: actor.accountId }
          },
          select: { id: true }
        });
        if (duplicate) throw gameNicknameTaken();
        await tx.account.update({
          where: { id: actor.accountId },
          data: {
            displayName: input.displayName,
            gameRegion: input.gameRegion,
            gameServer: input.gameServer
          }
        });
        const profile = {
          bio: input.bio,
          commonJobs: input.commonJobs,
          preferredPlaystyles: input.preferredPlaystyles
        };
        await tx.memberProfile.upsert({
          where: { accountId: actor.accountId },
          create: { accountId: actor.accountId, ...profile, revision: 1 },
          update: { ...profile, revision: { increment: 1 } }
        });
        const updated = await tx.account.findUnique({ where: { id: actor.accountId }, select: memberSelect });
        if (!updated) throw memberMissing();
        // A nickname lock or write SQL may have waited past expiry or logout.
        // Re-read this session after the final SQL so rejection rolls back every write.
        const finalSession = await this.auth.requireAccount(tx, token);
        if (finalSession.id !== actor.id || finalSession.accountId !== actor.accountId) {
          throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
        }
        return memberProfile(updated);
      })
      .catch((error: unknown) => {
        // The database's C-collation unique index remains the final race guard.
        if (isGameNicknameConstraint(error)) throw gameNicknameTaken();
        throw error;
      });
  }

  async list(url: URL, token?: string | null): Promise<MemberList> {
    return this.auth.transaction(async (tx) => {
      await this.auth.requireAccount(tx, token);
      const query = url.searchParams.get('query')?.trim() ?? '';
      if (query.length > 100) invalid('query', '搜索内容过长');
      const rawMembership = url.searchParams.get('membership');
      const membership = rawMembership ? membershipInput(rawMembership) : undefined;
      const items = await tx.account.findMany({
        where: {
          ...(membership ? { membership } : {}),
          ...(query
            ? { displayName: { contains: query.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' as const } }
            : {})
        },
        select: memberSelect,
        // Stable presentation order only; all matching members remain reachable without pagination UI.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      });
      return { items: items.map(memberSummary) };
    });
  }

  async getMember(id: string, token?: string | null): Promise<MemberProfile> {
    return this.auth.transaction(async (tx) => {
      await this.auth.requireAccount(tx, token);
      if (!isMemberId(id)) throw memberMissing();
      const account = await tx.account.findUnique({ where: { id: id.toLowerCase() }, select: memberSelect });
      if (!account) throw memberMissing();
      return memberProfile(account);
    });
  }
}
