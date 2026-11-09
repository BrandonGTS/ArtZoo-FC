export { publicSharePageMetadata as generateMetadata } from '../../../../../server/public-metadata/runtime';
export const dynamic = 'force-dynamic';

import SharePublicDetail from '../../../../../components/public-sharing/share-public-detail';
export default async function ActivitySharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SharePublicDetail id={id} />;
}
