export { publicFeaturedPageMetadata as generateMetadata } from '../../../../server/public-metadata/runtime';
export const dynamic = 'force-dynamic';

import PublicFeatured from '../../../../components/public-sharing/public-featured';
export default function Featured() {
  return <PublicFeatured />;
}
