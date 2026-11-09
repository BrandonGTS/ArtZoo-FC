// Normal startup refuses accidental QC database export. No bypass flag or test login route.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertLocalQcDatabaseAllowed, databaseConfigured, getDatabase } from '../packages/db/dist/index.js';
const args = process.argv.slice(2);
if (args.length !== 1 || !['dev', 'start', 'container'].includes(args[0]))
  throw Error('Expected fixed web startup mode');
let database;
try {
  if (databaseConfigured()) {
    database = getDatabase();
    await assertLocalQcDatabaseAllowed(database);
    await database.$disconnect();
  }
} catch {
  process.stderr.write(
    'Web startup refused: verify the deployment database and absence of local QC data. No data was changed.\n'
  );
  process.exitCode = 1;
}
if (!process.exitCode) {
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      require.resolve('next/dist/bin/next'),
      args[0] === 'dev' ? 'dev' : 'start',
      '--hostname',
      args[0] === 'container' ? '0.0.0.0' : '127.0.0.1',
      '--port',
      '3100'
    ],
    { stdio: 'inherit', cwd: fileURLToPath(new URL('../apps/web/', import.meta.url)) }
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('error', () => {
    process.stderr.write('Web startup failed.\n');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
