export { publicFeaturedPageMetadata as generateMetadata } from '../../../../server/public-metadata/runtime';
export const dynamic = 'force-dynamic';

import PublicFeatured from '../../../../components/public-sharing/public-featured';
export default async function Featured({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams;
  return <PublicFeatured initialType={type === 'shares' ? 'shares' : 'photos'} />;
}
