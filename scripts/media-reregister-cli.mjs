import { parseBaselineArguments } from './media-baseline-cli.mjs';
import { deploymentMediaBaselineRoots } from '../packages/media/dist/media-baseline.js';
import { reregisterMediaIdentity } from '../packages/media/dist/media-reregistration.js';
import { databaseConfigured, getDatabase, disconnectDatabase } from '../packages/db/dist/index.js';

try {
  const database = parseBaselineArguments(process.argv.slice(2), process.env);
  const roots = deploymentMediaBaselineRoots(process.env);
  if (!databaseConfigured()) throw Error('MEDIA_REGISTER_CONFIG');
  console.log(JSON.stringify(await reregisterMediaIdentity(getDatabase(), { database, roots })));
} catch (error) {
  const code = /^MEDIA_(REGISTER|BOUND|BASELINE)_[A-Z_]+$/.test(error?.message ?? '')
    ? error.message
    : 'MEDIA_REGISTER_FAILED';
  console.error(
    code + ': registration refused or commit uncertain; keep writers stopped and run read-only diagnosis.'
  );
  process.exitCode = 1;
} finally {
  await disconnectDatabase().catch(() => {
    process.exitCode = 1;
  });
}
