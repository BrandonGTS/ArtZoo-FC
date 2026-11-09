import { Suspense } from 'react';
import KnowledgeEditor from '../../../../../../components/knowledge/editor';
import { requirePageAccount } from '../../../../../../server/auth/page-guards';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageAccount('/knowledge/' + id + '/edit');
  return (
    <Suspense fallback={<p>正在读取…</p>}>
      <KnowledgeEditor id={id} />
    </Suspense>
  );
}
