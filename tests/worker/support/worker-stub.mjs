const scenario = process.env.REV_WORKER_SCENARIO;
const originalSetTimeout = globalThis.setTimeout;
if (scenario === 'repeat')
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 30000 ? 5 : ms, ...args);
let probes = 0;
const note = (value) => console.log(JSON.stringify({ test: value }));
export const environmentIdentity = { notifications: 'simulation-only' };
export const databaseConfigured = () => scenario !== 'unconfigured';
export const createOfficialImagePorts = () => ({});
export function createMaintenanceState(stopping = () => false) {
  return { failed: 0, stopping };
}
export function logMaintenanceFailure(step, id, error) {
  console.error(JSON.stringify({ step, id, error: error.name }));
}
export const getDatabase = () => ({});
export async function disconnectDatabase() {
  note('disconnected');
}
export async function checkDatabase() {
  if (process.env.ARTZOO_PROCESS_ROLE !== 'worker') throw Error('Worker role missing');
  note('probe');
  if (scenario === 'repeat' && ++probes === 3) {
    process.kill(process.pid, 'SIGTERM');
    await new Promise((resolve) => originalSetTimeout(resolve, 20));
  }
  if (scenario === 'database') throw Error('private');
}
export async function processActivityMaintenance() {
  note('activity');
  if (scenario === 'activity') throw Error('private');
  if (scenario === 'signal') {
    process.kill(process.pid, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    note('committed');
  }
  if (scenario === 'item') return { reduced: 0, cancelled: 0, completed: 0, autoAbsent: 0, failed: 1 };
  return { reduced: 0, cancelled: 0, completed: 0, autoAbsent: 0, failed: 0 };
}
export async function processLotteryMaintenance() {
  note('lottery');
  if (scenario === 'lottery') throw Error('private');
  return { processed: 0, simulated: 0, failed: scenario === 'lotteryItem' ? 1 : 0, available: true };
}
export async function processOfficialEventSync() {
  note('officialEvents');
  if (scenario === 'officialEvents') throw Error('private');
  return { enabled: false, processed: false };
}
export async function processSecurityCleanup() {
  note('cleanup');
  if (scenario === 'cleanup') throw Error('private');
  return { rateEvents: 0, sessions: 0, verificationCodes: 0, failed: 0 };
}
