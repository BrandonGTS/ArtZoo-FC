import { isIP } from 'node:net';

/** Only enable behind the reviewed Caddy-only network entry; headers alone are not authentication. */
export function resolveRequestSource(
  request: Pick<Request, 'headers'>,
  trustedProxy = process.env.ARTZOO_TRUSTED_PROXY
): string {
  if (trustedProxy !== 'caddy') return 'untrusted-source';
  const raw = request.headers.get('x-forwarded-for');
  if (!raw || raw.length > 4096) return 'untrusted-source';
  const value = raw.split(',').at(-1)!.trim();
  const family = isIP(value);
  if (family === 4) return `ip:${value}`;
  if (family !== 6 || value.includes('%')) return 'untrusted-source';
  // URL uses the platform IPv6 parser/serializer, including embedded IPv4, then pad the /64 prefix.
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const [left = '', right = ''] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const parts = canonical.includes('::')
    ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
    : head;
  return `ip:${parts
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join(':')}::/64`;
}
