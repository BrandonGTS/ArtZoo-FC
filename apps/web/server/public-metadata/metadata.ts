import type { Metadata } from 'next';
import { AccountError, isMemberId } from '@artzoo/domain';
import { publicMetadataOrigin, publicMetadataEnvironment, type PublicOriginEnvironment } from './origin';
export type PublicShareSummary = {
  id: string;
  title: string;
  body: string;
  media: ReadonlyArray<{ id: string }>;
};
export type PublicPhotoSummary = { id: string };
export type ReadPublicShare = (id: string, origin: URL) => Promise<PublicShareSummary | null>;
export type ReadPublicFeatured = (origin: URL) => Promise<ReadonlyArray<PublicPhotoSummary>>;
export function publicMetadataFallback(kind: 'share' | 'featured'): Metadata {
  return { title: kind === 'share' ? '活动分享' : '公开精选', robots: { index: false, follow: false } };
}
function excerpt(value: string, limit: number): string {
  return Array.from(
    value
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  )
    .slice(0, limit)
    .join('');
}
function missing(error: unknown): boolean {
  return error instanceof AccountError && ['NOT_FOUND', 'VALIDATION_ERROR'].includes(error.code);
}
/** Receives only the existing anonymous public projection; never shares a row across requests. */
export async function publicShareMetadata(
  id: string,
  read: ReadPublicShare,
  environment: PublicOriginEnvironment = publicMetadataEnvironment()
): Promise<Metadata> {
  const base = publicMetadataFallback('share'),
    origin = publicMetadataOrigin(environment);
  if (!origin || !isMemberId(id)) return base;
  let row: PublicShareSummary | null;
  try {
    row = await read(id, origin);
  } catch (error) {
    if (missing(error)) return base;
    throw error;
  }
  if (!row || !isMemberId(row.id) || row.id.toLowerCase() !== id.toLowerCase()) return base;
  const title = excerpt(row.title, 120) || '活动分享';
  const description = excerpt(row.body, 160) || 'ArtZoo 公开活动分享';
  const first = row.media[0],
    image = first && isMemberId(first.id) ? first : undefined;
  return {
    ...base,
    title,
    description,
    openGraph: {
      type: 'article',
      siteName: 'ArtZoo',
      title: title + ' · ArtZoo',
      description,
      url: new URL('/activity-shares/' + row.id, origin).href,
      ...(image
        ? {
            images: [
              {
                url: new URL('/api/activity-share-media/' + image.id + '?variant=preview', origin).href,
                type: 'image/webp',
                alt: title
              }
            ]
          }
        : {})
    }
  };
}
export async function publicFeaturedMetadata(
  read: ReadPublicFeatured,
  environment: PublicOriginEnvironment = publicMetadataEnvironment()
): Promise<Metadata> {
  const base = publicMetadataFallback('featured'),
    origin = publicMetadataOrigin(environment);
  if (!origin) return base;
  const photos = await read(origin),
    first = photos[0],
    image = first && isMemberId(first.id) ? first : undefined;
  const description = 'ArtZoo 公开可见的精选照片与活动分享';
  return {
    ...base,
    description,
    openGraph: {
      type: 'website',
      siteName: 'ArtZoo',
      title: '公开精选 · ArtZoo',
      description,
      url: new URL('/featured', origin).href,
      ...(image
        ? {
            images: [
              {
                url: new URL('/api/album-photos/' + image.id + '/media?variant=preview', origin).href,
                type: 'image/webp',
                alt: 'ArtZoo 公开精选照片'
              }
            ]
          }
        : {})
    }
  };
}
