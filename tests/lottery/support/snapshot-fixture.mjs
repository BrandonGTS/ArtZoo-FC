// Test-only adapter for fixtures whose mutable facts are explicitly treated as the as-of-T facts.
// Never use this current-row shortcut in production or as evidence for delayed temporal correctness.
export function withFixtureSnapshot(ports = {}) {
  return {
    ...ports,
    drawEligibilityAt: async (tx, { lottery, accountIds }) => {
      const rows = await tx.account.findMany({
        where: accountIds ? { id: { in: accountIds } } : undefined,
        select: { id: true, displayName: true, membership: true, createdAt: true }
      });
      const accounts = [];
      for (const a of rows)
        accounts.push({
          identity: {
            id: a.id,
            displayName: a.displayName,
            membership: a.membership,
            active: ports.accountActive ? await ports.accountActive(tx, a.id) : true
          },
          registeredAt: a.createdAt,
          monthCount:
            lottery.kind === 'MONTHLY'
              ? ports.countMonth
                ? await ports.countMonth(tx, a.id, lottery.month)
                : 0
              : null
        });
      return { at: lottery.drawAt, complete: true, accounts };
    }
  };
}
