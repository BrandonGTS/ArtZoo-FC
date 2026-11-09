/** Compatible application policy. No proxy, TLS, HSTS or account settings. */
export function siteSecurityHeaders(development: boolean) {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "frame-src 'self'",
    "form-action 'self'",
    // Next's streamed bootstrap and AntD's SSR/client styles are inline.
    // A strict per-response nonce would require a separately measured dynamic-rendering change.
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ''}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${development ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'"
  ];
  return [
    { key: 'Content-Security-Policy', value: directives.join('; ') },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'Referrer-Policy', value: 'no-referrer' }
  ];
}
