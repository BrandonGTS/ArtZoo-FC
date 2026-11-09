import { Suspense } from 'react';
import KnowledgeDetail from '../../../../../components/knowledge/detail';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageAccount('/knowledge/' + id);
  return (
    <Suspense fallback={<p>正在读取…</p>}>
      <KnowledgeDetail id={id} />
    </Suspense>
  );
}
