export const state = {
  pools: [],
  clients: 0,
  configured: true,
  failed: false,
  probes: 0,
  disconnects: 0,
  disconnectFailure: false,
  connectFailure: false,
  disconnectWait: null,
  adapterInitialized: false
};
export class Pool {
  constructor(options) {
    this.options = options;
    this.totalCount = 0;
    this.ending = false;
    this.ended = false;
    this.endCalls = 0;
    state.pools.push(this);
  }
  on() {}
  async end() {
    this.endCalls++;
    this.ending = true;
    this.ended = true;
    this.totalCount = 0;
  }
  async connect() {
    if (state.connectFailure) throw new Error('synthetic connection failure');
    this.totalCount = 1;
    return {
      query: async (text) => ({ rows: text === 'SELECT 1::int AS ok' ? [{ ok: 1 }] : [] }),
      release() {}
    };
  }
}
export class PrismaPg {
  constructor(pool, options) {
    this.pool = pool;
    this.options = options;
  }
}
export class PrismaClient {
  constructor(options) {
    this.options = options;
    state.clients++;
  }
  async $disconnect() {
    state.disconnects++;
    await state.disconnectWait;
    if (state.disconnectFailure) throw new Error('synthetic disconnect failure');
    if (state.adapterInitialized && this.options.adapter.options.disposeExternalPool)
      await this.options.adapter.pool.end();
  }
}
export const Prisma = {};
export function databaseConfigured() {
  return state.configured;
}
export async function checkDatabase() {
  state.probes++;
  if (state.failed) throw new Error('sensitive.internal.details');
}
