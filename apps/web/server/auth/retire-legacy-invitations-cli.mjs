// Explicit operational gate; no configuration file reads, output tokens, or credential creation.
if (
  process.argv.length !== 2 ||
  process.env.ARTZOO_DEPLOYMENT_ENV !== 'local' ||
  process.env.ARTZOO_PUBLIC_ORIGIN !== 'http://localhost:3100' ||
  process.env.ARTZOO_RETIRE_LEGACY_INVITATIONS !== 'approved-local-development'
) {
  console.error('NOT_RUN: explicit local development cleanup gate required.');
  process.exitCode = 2;
} else {
  let db;
  try {
    const { getDatabase } = await import('@artzoo/db');
    const { retireLegacyInvitations } = await import('./retire-legacy-invitations.ts');
    db = getDatabase();
    const result = await retireLegacyInvitations(db);
    console.log(JSON.stringify({ completed: true, ...result, accountsAndSessions: 'untouched' }));
  } catch {
    console.error('FAILED: cleanup did not complete; no sensitive diagnostics emitted.');
    process.exitCode = 1;
  } finally {
    if (db) await db.$disconnect();
  }
}
