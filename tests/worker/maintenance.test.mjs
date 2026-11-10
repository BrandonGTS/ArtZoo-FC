import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaintenanceState, runMaintenanceItem } from '../../packages/db/src/maintenance-run.ts';
import { LocalQcDataBlocked } from '../../packages/db/src/local-qc-safety.ts';
import { processSecurityCleanup } from '../../packages/db/src/security-cleanup.ts';
import { processActivityMaintenance } from '../../packages/db/src/activity-maintenance.ts';
const now = new Date('2030-06-10T00:00:00Z'),
  day = 86400000;
test('failure logs allowlisted metadata only; safety failure propagates', async () => {
  const state = createMaintenanceState(),
    lines = [];
  const original = console.error;
  console.error = (v) => lines.push(JSON.parse(v));
  try {
    const error = Object.assign(Error('private token=secret'), { code: 'P2028', stack: 'secret' });
    assert.equal(
      await runMaintenanceItem(state, 'activity', 'id', async () => {
        throw error;
      }),
      undefined
    );
    assert.equal(state.failed, 1);
    assert.deepEqual(lines, [{ step: 'activity', id: 'id', error: 'Error', code: 'P2028' }]);
    await assert.rejects(
      () =>
        runMaintenanceItem(state, 'activity', 'id', async () => {
          throw new LocalQcDataBlocked();
        }),
      LocalQcDataBlocked
    );
    assert.equal(state.failed, 1);
  } finally {
    console.error = original;
  }
});
test('stop prevents new transactions', async () => {
  let calls = 0;
  await runMaintenanceItem(
    createMaintenanceState(() => true),
    'step',
    'id',
    async () => calls++
  );
  assert.equal(calls, 0);
});
function matches(row, where) {
  if (where.OR && !where.OR.some((w) => matches(row, w))) return false;
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') continue;
    if (condition.lt && !(row[key] && row[key] < condition.lt)) return false;
    if (condition.in && !condition.in.includes(row[key])) return false;
  }
  return true;
}
function fixture(seed, fail) {
  const data = structuredClone(seed),
    batches = [],
    queries = [];
  const db = {
    $transaction: async (action) => action(db),
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?');
      queries.push(sql);
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      const model = sql.includes('"AccountRateEvent"')
        ? 'accountRateEvent'
        : sql.includes('"AccountSession"')
          ? 'accountSession'
          : 'verificationCode';
      const cutoff = values[0],
        take = values.at(-1);
      const where =
        model === 'accountRateEvent'
          ? { createdAt: { lt: cutoff } }
          : model === 'accountSession'
            ? { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] }
            : { expiresAt: { lt: cutoff } };
      return db[model].findMany({ where, take });
    }
  };
  for (const model of ['accountRateEvent', 'accountSession', 'verificationCode'])
    db[model] = {
      findMany: async ({ where, take }) => {
        if (fail === model) throw Error('private');
        assert.ok(take <= 1000);
        batches.push([model, take]);
        return data[model]
          .filter((r) => matches(r, where))
          .slice(0, take)
          .map((r) => ({ id: r.id }));
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        data[model] = data[model].filter((r) => {
          if (matches(r, where)) {
            count++;
            return false;
          }
          return true;
        });
        return { count };
      }
    };
  return { db, data, batches, queries };
}
test('cleanup exact cutoffs, revoked-session alternative, valid rows and idempotence', async () => {
  const h = fixture({
    accountRateEvent: [
      { id: 'old', createdAt: new Date(+now - day - 1) },
      { id: 'edge', createdAt: new Date(+now - day) }
    ],
    accountSession: [
      { id: 'old', expiresAt: new Date(+now - 7 * day - 1), revokedAt: null },
      { id: 'revoked', expiresAt: new Date(+now + day), revokedAt: new Date(+now - 7 * day - 1) },
      { id: 'valid', expiresAt: new Date(+now + day), revokedAt: null },
      { id: 'edge', expiresAt: new Date(+now - 7 * day), revokedAt: null }
    ],
    verificationCode: [
      { id: 'old', expiresAt: new Date(+now - 7 * day - 1) },
      { id: 'edge', expiresAt: new Date(+now - 7 * day) },
      { id: 'new', expiresAt: new Date(+now + day) }
    ]
  });
  assert.deepEqual(await processSecurityCleanup(h.db, now), {
    rateEvents: 1,
    sessions: 2,
    verificationCodes: 1,
    failed: 0
  });
  assert.deepEqual(
    h.data.accountSession.map((r) => r.id),
    ['valid', 'edge']
  );
  assert.deepEqual(await processSecurityCleanup(h.db, now), {
    rateEvents: 0,
    sessions: 0,
    verificationCodes: 0,
    failed: 0
  });
});
test('cleanup has per-run total cap and table fairness', async () => {
  const rows = Array.from({ length: 12000 }, (_, i) => ({
    id: String(i),
    createdAt: new Date(+now - 2 * day)
  }));
  const h = fixture({
    accountRateEvent: rows,
    accountSession: [{ id: 'old', expiresAt: new Date(+now - 8 * day) }],
    verificationCode: [{ id: 'old', expiresAt: new Date(+now - 8 * day) }]
  });
  const out = await processSecurityCleanup(h.db, now);
  assert.equal(out.rateEvents + out.sessions + out.verificationCodes, 10000);
  assert.equal(out.sessions, 1);
  assert.equal(out.verificationCodes, 1);
  assert.equal(h.data.accountRateEvent.length, 2002);
});
test('cleanup table failure does not prevent remaining tables', async () => {
  const h = fixture(
    {
      accountRateEvent: [],
      accountSession: [{ id: 'old', expiresAt: new Date(+now - 8 * day) }],
      verificationCode: [{ id: 'old', expiresAt: new Date(+now - 8 * day) }]
    },
    'accountRateEvent'
  );
  const out = await processSecurityCleanup(h.db, now);
  assert.equal(out.failed, 1);
  assert.equal(out.sessions, 1);
  assert.equal(out.verificationCodes, 1);
});
test('a failed activity transaction does not block the next account or substep; commit failure is not success', async () => {
  let transaction = 0,
    updates = 0;
  const scans = [];
  const tx = {
    $queryRaw: async () => [{ activityPoints: 3, activityDecayAt: new Date(+now - day) }],
    account: {
      update: async () => {
        updates++;
      }
    },
    activityScoreChange: { create: async () => {} }
  };
  const db = {
    $transaction: async (action) => {
      transaction++;
      if (transaction === 1) throw Error('private');
      return action(tx);
    },
    account: { findMany: async () => [{ id: 'bad' }, { id: 'good' }] },
    activity: {
      fields: { managementEnabledAt: {} },
      findMany: async () => {
        scans.push('activity');
        return [];
      }
    },
    activitySeries: {
      findMany: async () => {
        scans.push('series');
        return [];
      }
    },
    activityRegistration: {
      findMany: async () => {
        scans.push('registration');
        return [];
      }
    }
  };
  const out = await processActivityMaintenance(db, now);
  assert.equal(out.failed, 1);
  assert.equal(out.reduced, 1);
  assert.equal(transaction, 2);
  assert.equal(updates, 1);
  assert.deepEqual(scans, ['activity', 'series', 'registration', 'registration']);
  db.$transaction = async (action) => {
    await action(tx);
    throw Error('commit failure');
  };
  const failed = await processActivityMaintenance(db, now);
  assert.equal(failed.reduced, 0);
  assert.equal(failed.failed, 2);
});

test('hostile thrown objects and failed log sinks never abort item isolation', async () => {
  const state = createMaintenanceState(),
    original = console.error;
  try {
    console.error = () => {
      throw Error('log sink failed');
    };
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw Error('prototype failed');
        },
        has() {
          throw Error('has failed');
        },
        get() {
          throw Error('getter failed');
        }
      }
    );
    for (const error of [
      hostile,
      Object.defineProperty(Error('private'), 'code', {
        get() {
          throw Error('code failed');
        }
      }),
      Object.defineProperty(Error('private'), 'name', {
        get() {
          throw Error('name failed');
        }
      })
    ])
      assert.equal(
        await runMaintenanceItem(state, 'activity', 'id', async () => {
          throw error;
        }),
        undefined
      );
    assert.equal(state.failed, 3);
    assert.equal(await runMaintenanceItem(state, 'activity', 'good', async () => 42), 42);
  } finally {
    console.error = original;
  }
});

test('error name is read only once before allowlist validation', async () => {
  let reads = 0;
  const error = Object.defineProperty(Error('private'), 'name', {
    get() {
      return reads++ === 0 ? 'TypeError' : 'private secret';
    }
  });
  const original = console.error,
    lines = [];
  console.error = (value) => lines.push(JSON.parse(value));
  try {
    await runMaintenanceItem(createMaintenanceState(), 'activity', 'id', async () => {
      throw error;
    });
    assert.equal(reads, 1);
    assert.equal(lines[0].error, 'TypeError');
  } finally {
    console.error = original;
  }
});
