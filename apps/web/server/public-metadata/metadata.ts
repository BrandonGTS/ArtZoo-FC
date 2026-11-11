import type { Metadata } from 'next';
import { isMemberId } from '@artzoo/domain';
import { publicMetadataOrigin, publicMetadataEnvironment, type PublicOriginEnvironment } from './origin';
export type PublicPhotoSummary = { id: string };
export type ReadPublicFeatured = (origin: URL) => Promise<ReadonlyArray<PublicPhotoSummary>>;
export function publicMetadataFallback(): Metadata {
  return { title: '公开精选', robots: { index: false, follow: false } };
}
export async function publicFeaturedMetadata(
  read: ReadPublicFeatured,
  environment: PublicOriginEnvironment = publicMetadataEnvironment()
): Promise<Metadata> {
  const base = publicMetadataFallback(),
    origin = publicMetadataOrigin(environment);
  if (!origin) return base;
  const photos = await read(origin),
    first = photos[0],
    image = first && isMemberId(first.id) ? first : undefined;
  const description = 'ArtZoo 公开可见的精选照片';
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
