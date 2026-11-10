export * from '../../../packages/db/src/activity-standing.ts';
export { Prisma } from '../../../packages/db/src/generated/prisma/client.ts';
export function getDatabase() {
  throw new Error('活动单元测试禁止使用真实数据库');
}
export * from '../../../packages/db/src/activity-completion.ts';
export * from '../../../packages/db/src/activity-series.ts';

export * from '../../../packages/db/src/activity-attendance-policy.ts';
