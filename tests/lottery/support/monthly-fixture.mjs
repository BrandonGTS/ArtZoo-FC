// Test-only natural-day checkins in the explicitly disposable caller database.
export async function seedMonth(db, accountIds, month, days) {
  for (const accountId of accountIds)
    for (let n = 1; n <= days; n++) {
      const day = month + '-' + String(n).padStart(2, '0');
      if (!(await db.dailyCheckin.findUnique({ where: { accountId_day: { accountId, day } } })))
        await db.dailyCheckin.create({ data: { accountId, day, createdAt: new Date(day + 'T00:00:00Z') } });
    }
}
export const monthCounter = (db, month) => async (tx, id) =>
  (tx ?? db).dailyCheckin.count({ where: { accountId: id, day: { gte: month + '-01', lt: month + '-32' } } });
