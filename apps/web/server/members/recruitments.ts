import type { ActivityList } from '@artzoo/domain';
import type { Prisma } from '@artzoo/db';
import { AccountError, invalid, isMemberId } from '@artzoo/domain';
import { AccountService } from '../auth/service';
import { activitySelect, activitySummary } from '../activities/service';

export interface MemberRecruitmentPage extends ActivityList {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export class MemberRecruitmentService {
  constructor(readonly auth: AccountService) {}
  async list(id: string, url: URL, token?: string | null): Promise<MemberRecruitmentPage> {
    const rawPage = url.searchParams.get('page') ?? '1';
    const search = (url.searchParams.get('search') ?? '').trim();
    if (search.length > 100) invalid('search', '搜索内容过长');
    if (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage))) invalid('page', '页码无效');
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.auth.requireAccount(tx, token);
        if (!isMemberId(id)) throw new AccountError('NOT_FOUND', '成员不存在', 404);
        const memberId = id.toLowerCase();
        if (!(await tx.account.findUnique({ where: { id: memberId }, select: { id: true } })))
          throw new AccountError('NOT_FOUND', '成员不存在', 404);
        const now = this.auth.now(),
          pageSize = 15;
        // Match existing activity list/detail visibility: signed-in members can read
        // published activities, including past and cancelled records.
        const where: Prisma.ActivityWhereInput = {
          organizerId: memberId,
          AND: [
            { OR: [{ mode: 'SINGLE' }, { mode: 'SERIES', periodNumber: 1 }] },
            ...(search
              ? [
                  {
                    OR: [
                      { title: { contains: search, mode: 'insensitive' as const } },
                      { location: { contains: search, mode: 'insensitive' as const } },
                      {
                        dutySnapshot: {
                          path: ['name'],
                          string_contains: search,
                          mode: 'insensitive' as const
                        }
                      }
                    ]
                  }
                ]
              : [])
          ]
        };
        const total = await tx.activity.count({ where }),
          totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(Number(rawPage), totalPages);
        const rows = await tx.activity.findMany({
          where,
          select: activitySelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize
        });
        return {
          items: rows.map((row) => activitySummary(row, actor.accountId, now)),
          page,
          pageSize,
          total,
          totalPages,
          serverNow: now.toISOString(),
          timeZone: 'Asia/Shanghai'
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
}
