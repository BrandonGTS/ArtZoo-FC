// Explicit tools-image maintenance entry point; never imported by web or worker.
import { pathToFileURL } from 'node:url';

export function parseBaselineArguments(args, env) {
  if (
    args.length !== 3 ||
    args[0] !== '--offline' ||
    args[1] !== '--expect-database' ||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(args[2]) ||
    args[2] !== env.PGDATABASE
  )
    throw Error('MEDIA_BASELINE_ARGUMENTS');
  return args[2];
}

export async function runBaselineCommand(args, env = process.env) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node /app/scripts/media-baseline-cli.mjs --offline --expect-database NAME');
    console.log(
      'Stop web, worker and all media writers first. Requires migrated DB and the Compose media mounts.'
    );
    console.log(
      'Initializes only an empty target to zero bytes; never resets usage. No quota switch is changed.'
    );
    return 0;
  }
  let disconnect;
  try {
    const database = parseBaselineArguments(args, env);
    const { deploymentMediaBaselineRoots, initializeEmptyMediaBaseline } =
      await import('../packages/media/dist/media-baseline.js');
    const roots = deploymentMediaBaselineRoots(env);
    const { databaseConfigured, getDatabase, disconnectDatabase } =
      await import('../packages/db/dist/index.js');
    disconnect = disconnectDatabase;
    if (!databaseConfigured()) throw Error('MEDIA_BASELINE_DATABASE_CONFIG');
    const result = await initializeEmptyMediaBaseline(getDatabase(), { database, roots });
    console.log('Media baseline: ' + result + '. Usage unchanged; quota configuration unchanged.');
    return 0;
  } catch {
    // Do not print driver errors, URLs, environment values, paths or connection secrets.
    console.error(
      'Media baseline refused. Check arguments, offline state, target, migrations, empty media/ledger and trusted directory permissions. No reset was performed.'
    );
    return 1;
  } finally {
    await disconnect?.().catch(() => undefined);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runBaselineCommand(process.argv.slice(2));
