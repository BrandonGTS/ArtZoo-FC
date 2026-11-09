import { checkDatabase, databaseConfigured } from '@artzoo/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let ok = false;
  try {
    if (databaseConfigured()) {
      await checkDatabase();
      ok = true;
    }
  } catch {
    /* The public probe intentionally exposes no internal details. */
  }
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
