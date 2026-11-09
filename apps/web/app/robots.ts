import type { MetadataRoute } from 'next';
// Only these two HTML URLs have explicit indexing approval. Keep the end anchors.
const html = ['/$', '/resources$'];
// Rendering dependencies only; these namespaces contain shipped UI assets, never uploaded media.
const assets = [
  '/_next/static/*.js$',
  '/_next/static/*.js?*',
  '/_next/static/*.css$',
  '/_next/static/*.css?*',
  '/_next/static/media/*.woff2$',
  '/_next/static/media/*.svg$',
  '/_next/static/media/*.png$',
  '/_next/static/media/*.webp$',
  '/artzoo/fonts/*.woff2$',
  '/artzoo/fonts/*.woff2?*',
  '/artzoo/fonts/*.css$',
  '/artzoo/fonts/*.css?*',
  '/artzoo/icons/*.svg$',
  '/artzoo/jobs/*.png$',
  '/artzoo/optimized/*.webp$',
  '/artzoo/logo-mask.png$'
];
// Match the existing optimizer's six static UI inputs, not an arbitrary image URL or API route.
const optimizedUi = [
  'animal-v5.png',
  'book-cart-v2.png',
  'daily-paper.png',
  'food-title.png',
  'patty-title.png',
  'wish-paper.png'
].map((name) => '/_next/image?url=' + encodeURIComponent('/artzoo/' + name) + '&');
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/', allow: [...html, ...assets, ...optimizedUi] } };
}
