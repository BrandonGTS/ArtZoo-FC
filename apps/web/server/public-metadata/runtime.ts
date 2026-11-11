import type { Metadata } from 'next';
import { getAccountService } from '../auth/runtime';
import { AlbumService } from '../albums/service';
import { publicFeaturedMetadata } from './metadata';

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
