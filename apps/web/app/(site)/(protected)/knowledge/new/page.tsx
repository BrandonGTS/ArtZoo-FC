import { Suspense } from 'react';
import KnowledgeEditor from '../../../../../components/knowledge/editor';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
export default async function Page() {
  await requirePageAccount('/knowledge/new');
  return (
    <Suspense fallback={<p>正在读取…</p>}>
      <KnowledgeEditor />
    </Suspense>
  );
}
