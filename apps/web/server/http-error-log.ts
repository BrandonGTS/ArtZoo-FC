/** HTTP error logs contain classifications only, never caller-owned text. */
const routes = new Set([
  'next/request',
  'auth/http',
  'activities/http',
  'activities/attendance-http',
  'activities/penalty-appeals-http',
  'account-lifecycle/http',
  'bot-management/http',
  'resources/http',
  'checkin/http',
  'knowledge/http',
  'knowledge/image-http',
  'messages/http',
  'official-events/http',
  'announcements/http',
  'teams/http',
  'quick-links/upload-http',
  'quick-links/http',
  'qq-official/http',
  'admin-management/http',
  'members/http',
  'guest-contact/http',
  'site-help/http',
  'lottery/http',
  'lottery/media-http',
  'wishes/http',
  'daily/http',
  'albums/http',
  'api/avatars/[assetId]/route',
  'api/official-events/[id]/images/[imageId]/[variant]/route',
  'api/members/[id]/recruitments/route',
  'api/me/avatar/route'
]);
const names = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError',
  'PrismaClientValidationError',
  'PrismaClientRustPanicError'
]);
const codes = new Set([
  '40001',
  '40P01',
  '23505',
  '23503',
  '23502',
  '23514',
  '57014',
  '55P03',
  '53300',
  '57P01',
  '08000',
  '08003',
  '08006',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN'
]);
function field(error: unknown, key: 'name' | 'code'): unknown {
  // A rejected promise may carry a hostile getter/proxy instead of an Error.
  try {
    if (typeof error === 'object' && error !== null && key in error) return Reflect.get(error, key);
  } catch {
    /* A log must never replace the original error response. */
  }
  return undefined;
}
export function logUnexpectedHttpError(error: unknown, route: string): void {
  const name = field(error, 'name'),
    code = field(error, 'code');
  const safeCode = typeof code === 'string' && (codes.has(code) || /^P[0-9]{4}$/.test(code)) ? code : null;
  try {
    console.error(
      JSON.stringify({
        service: 'web',
        route: routes.has(route) ? route : 'unknown',
        error: typeof name === 'string' && names.has(name) ? name : 'Error',
        code: safeCode
      })
    );
  } catch {
    /* Logging failure must not change availability or leak a fallback object. */
  }
}
