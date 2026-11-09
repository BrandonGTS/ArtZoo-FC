import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import staticAssets from './static-assets.json';
import { siteSecurityHeaders } from './security-headers';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  outputFileTracingIncludes: { '/*': ['../../packages/media/dist/bitmap-worker.mjs'] },
  // Runtime data and private test/server configuration must never enter a build artifact.
  outputFileTracingExcludes: {
    '/*': ['../../.local/**/*', '**/.local/**/*', '**/.env', '**/.env.*', '**/secrets/**/*']
  },
  transpilePackages: ['@artzoo/domain', '@artzoo/db', '@artzoo/media'],
  serverExternalPackages: ['@prisma/adapter-pg', '@prisma/client', 'pg'],
  images: {
    qualities: [75, 90],
    // Only these public raster assets use the built-in optimizer. Authenticated
    // media and SVG icons stay on their existing unoptimized/direct paths.
    localPatterns: [
      { pathname: '/artzoo/animal-v5.png', search: '' },
      { pathname: '/artzoo/book-cart-v2.png', search: '' },
      { pathname: '/artzoo/daily-paper.png', search: '' },
      { pathname: '/artzoo/food-title.png', search: '' },
      { pathname: '/artzoo/patty-title.png', search: '' },
      { pathname: '/artzoo/wish-paper.png', search: '' }
    ]
  },
  async headers() {
    return [
      { source: '/:path*', headers: siteSecurityHeaders(process.env.NODE_ENV === 'development') },
      // Only content-addressed public backgrounds and the current font version are immutable.
      {
        source: '/artzoo/optimized/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }]
      },
      {
        source: '/artzoo/fonts/:path*',
        has: [{ type: 'query', key: 'v', value: staticAssets.fontVersion }],
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }]
      }
    ];
  },
  poweredByHeader: false,
  experimental: { authInterrupts: true }
};
export default config;
