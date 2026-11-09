import type { Metadata } from 'next';
import { getAccountService } from '../auth/runtime';
import { ActivityShareService } from '../activity-shares/service';
import { AlbumService } from '../albums/service';
import { publicShareMetadata, publicFeaturedMetadata } from './metadata';

export async function publicSharePageMetadata({
  params
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return publicShareMetadata(id, async (key, origin) => {
    // Fixed guest-only URL: never inherit cookies, manage/history flags, query or request Host.
    const value = await new ActivityShareService(getAccountService()).get(
      key,
      new URL('/api/activity-shares/' + key, origin),
      null
    );
    return {
      id: value.id,
      title: value.title,
      body: value.body,
      media: value.media.map((item) => ({ id: item.id }))
    };
  });
}
export async function publicFeaturedPageMetadata(): Promise<Metadata> {
  return publicFeaturedMetadata(async (origin) => {
    const value = await new AlbumService(getAccountService()).featured(
      new URL('/api/albums/featured?page=1', origin),
      null,
      false
    );
    return value.items.map((item) => ({ id: item.id }));
  });
}
