// Deliberately serial transactions; tests do NOT establish PostgreSQL concurrency correctness.
import assert from 'node:assert/strict';
const names = [
  'account',
  'accountSession',
  'invitation',
  'verificationCode',
  'accountRateEvent',
  'accountAudit'
];
const defaults = {
  account: { displayName: null, gameRegion: null, gameServer: null, passwordVersion: 0, adminRole: 'NONE' },
  accountSession: { revokedAt: null },
  invitation: {
    usageMode: 'SINGLE',
    usedAt: null,
    usedById: null,
    revokedAt: null,
    removedAt: null,
    tokenCiphertext: null
  },
  verificationCode: {
    invitationId: null,
    attempts: 0,
    consumedAt: null,
    invalidatedAt: null,
    deliveredAt: null
  },
  accountAudit: {
    targetAccountId: null,
    invitationId: null,
    beforeMembership: null,
    afterMembership: null,
    reason: null
  }
};
export class MemoryDb {
  constructor() {
    this.rows = Object.fromEntries(names.map((n) => [n, []]));
    this.tail = Promise.resolve();
    this.sequence = 0;
    this.locks = [];
    this.fail = null;
    for (const name of names) this[name] = this.model(name);
  }
  matches(row, where = {}) {
    return Object.entries(where).every(([key, val]) => {
      if (key === 'OR') return val.some((w) => this.matches(row, w));
      if (key === 'gameServer_displayName') return this.matches(row, val);
      const actual = row[key];
      if (val && typeof val === 'object' && !(val instanceof Date))
        return Object.entries(val).every(([op, value]) => {
          if (op === 'in') return value.includes(actual);
          if (op === 'gt') return actual > value;
          if (op === 'gte') return actual >= value;
          if (op === 'lt') return actual < value;
          if (op === 'lte') return actual <= value;
          if (op === 'contains')
            return (
              typeof actual === 'string' &&
              actual.toLowerCase().includes(value.replace(/\\([\\%_])/g, '$1').toLowerCase())
            );
          if (op === 'mode') return true;
          throw Error('Unsupported memory predicate: ' + op);
        });
      return actual instanceof Date && val instanceof Date ? +actual === +val : actual === val;
    });
  }
  output(name, row, args = {}) {
    if (!row) return null;
    const value = structuredClone(row);
    if (args.include?.account)
      value.account = structuredClone(this.rows.account.find((a) => a.id === row.accountId));
    if (args.include?.createdBy) {
      const a = this.rows.account.find((a) => a.id === row.createdById);
      value.createdBy = { id: a.id, displayName: a.displayName };
    }
    if (args.include?.actor)
      value.actor = structuredClone(this.rows.account.find((a) => a.id === row.actorId));
    return value;
  }
  model(name) {
    const search = (args = {}) => {
      let rows = this.rows[name].filter((row) => this.matches(row, args.where));
      const order = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
      rows.sort((a, b) => {
        for (const part of order)
          for (const [key, direction] of Object.entries(part)) {
            const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
            if (cmp) return direction === 'desc' ? -cmp : cmp;
          }
        return 0;
      });
      if (args.cursor)
        rows = rows.slice(
          Math.max(
            0,
            rows.findIndex((r) => r.id === args.cursor.id)
          )
        );
      if (args.skip) rows = rows.slice(args.skip);
      if (args.take) rows = rows.slice(0, args.take);
      return rows;
    };
    const update = (row, data) => {
      for (const [key, value] of Object.entries(data))
        row[key] =
          value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
    };
    const fault = (action) => {
      if (this.fail === name + '.' + action) throw Error('injected storage failure');
    };
    return {
      findMany: async (args) => search(args).map((r) => this.output(name, r, args)),
      findUnique: async (args) => this.output(name, search(args)[0], args),
      findFirst: async (args) => this.output(name, search(args)[0], args),
      findUniqueOrThrow: async (args) => {
        const row = search(args)[0];
        assert.ok(row);
        return this.output(name, row, args);
      },
      count: async (args) => search(args).length,
      create: async (args) => {
        fault('create');
        const data = Object.fromEntries(Object.entries(args.data).filter(([, v]) => v !== undefined));
        for (const key of name === 'account'
          ? ['phone']
          : ['accountSession', 'invitation'].includes(name)
            ? ['tokenHash']
            : [])
          if (this.rows[name].some((r) => r[key] === data[key]))
            throw Object.assign(Error('duplicate'), { code: 'P2002' });
        if (
          name === 'account' &&
          data.gameServer != null &&
          data.displayName != null &&
          this.rows.account.some(
            (r) => r.gameServer === data.gameServer && r.displayName === data.displayName
          )
        )
          throw Object.assign(Error('duplicate game name'), {
            code: 'P2002',
            meta: { target: ['gameServer', 'displayName'] }
          });
        const row = {
          ...structuredClone(defaults[name] || {}),
          id: String(++this.sequence).padStart(36, '0'),
          ...data
        };
        this.rows[name].push(row);
        return this.output(name, row, args);
      },
      update: async (args) => {
        fault('update');
        const row = search(args)[0];
        assert.ok(row);
        update(row, args.data);
        return this.output(name, row, args);
      },
      updateMany: async (args) => {
        fault('updateMany');
        const rows = search(args);
        rows.forEach((r) => update(r, args.data));
        return { count: rows.length };
      }
    };
  }
  async $queryRaw(strings, key) {
    this.locks.push(key);
    return [];
  }
  async $transaction(action) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((r) => {
      release = r;
    });
    await previous;
    const snapshot = structuredClone(this.rows);
    try {
      return await action(this);
    } catch (error) {
      this.rows = snapshot;
      throw error;
    } finally {
      release();
    }
  }
}
