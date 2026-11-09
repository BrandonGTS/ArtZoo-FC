import type { Prisma, PrismaClient } from '@artzoo/db';
import type { PublicSiteSettings } from '@artzoo/domain';
export async function readPublicSiteSettings(
  db: Prisma.TransactionClient | PrismaClient
): Promise<PublicSiteSettings> {
  const row = await db.publicSiteSettings.findUnique({ where: { id: 'public' } });
  if (row) return { adminQq: row.adminQq, revision: row.revision, updatedAt: row.updatedAt.toISOString() };
  const value = process.env.ARTZOO_PUBLIC_ADMIN_QQ?.trim() ?? '';
  return { adminQq: /^[1-9]\d{4,11}$/.test(value) ? value : null, revision: 0, updatedAt: null };
}
