import type { Prisma } from '@artzoo/db';
import {
  AccountError,
  SITE_HELP_COMPATIBLE_LESSONS,
  siteHelpStepCommand,
  type SiteHelpProgress
} from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';

type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
export class SiteHelpProgressService {
  constructor(readonly auth: AccountService) {}
  private async fresh(tx: Tx, token?: string | null, expected?: Actor): Promise<Actor> {
    const actor = await this.auth.requireAccount(tx, token);
    if (actor.expiresAt <= this.auth.now())
      throw new AccountError('UNAUTHENTICATED', '登录已过期，请重新登录', 401);
    if (
      expected &&
      (actor.id !== expected.id ||
        actor.accountId !== expected.accountId ||
        actor.account.membership !== expected.account.membership ||
        actor.account.adminRole !== expected.account.adminRole)
    ) {
      throw new AccountError('UNAUTHENTICATED', '登录身份已变化，请重新登录', 401);
    }
    return actor;
  }
  private async summary(tx: Tx, accountId: string): Promise<SiteHelpProgress> {
    const rows = await tx.siteHelpStepProgress.findMany({
      where: {
        accountId,
        OR: SITE_HELP_COMPATIBLE_LESSONS.map((lesson) => ({
          lessonId: lesson.lessonId,
          version: lesson.version
        }))
      },
      select: { lessonId: true, version: true, stepId: true }
    });
    return {
      lessons: SITE_HELP_COMPATIBLE_LESSONS.map((lesson) => {
        const completed = new Set(
          rows
            .filter((row) => row.lessonId === lesson.lessonId && row.version === lesson.version)
            .map((row) => row.stepId)
        );
        return {
          lessonId: lesson.lessonId,
          version: lesson.version,
          completedStepIds: lesson.stepIds.filter((stepId) => completed.has(stepId))
        };
      })
    };
  }
  async read(token?: string | null): Promise<SiteHelpProgress> {
    const actor = await this.fresh(this.auth.db, token);
    return this.auth.transaction(async (tx) => {
      await this.fresh(tx, token, actor);
      const result = await this.summary(tx, actor.accountId);
      await this.fresh(tx, token, actor);
      return result;
    });
  }
  async complete(body: unknown, token?: string | null): Promise<SiteHelpProgress> {
    const input = siteHelpStepCommand(body);
    const actor = await this.fresh(this.auth.db, token);
    await this.auth.rate('site-help-progress:' + actor.accountId, 120, 900);
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'phone:' + actor.account.phone);
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${actor.accountId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id" = ${actor.id} FOR UPDATE`;
      await this.fresh(tx, token, actor);
      // The unique tuple makes repeated acknowledgements monotonic and idempotent.
      await tx.siteHelpStepProgress.createMany({
        data: [{ accountId: actor.accountId, ...input }],
        skipDuplicates: true
      });
      // INSERT can itself wait; a revoked/expired session rolls the insertion back.
      await this.fresh(tx, token, actor);
      const result = await this.summary(tx, actor.accountId);
      await this.fresh(tx, token, actor);
      return result;
    });
  }
}
