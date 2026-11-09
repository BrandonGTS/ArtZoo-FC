import { Suspense } from 'react';
import KnowledgeBrowser from '../../../../components/knowledge/browser';
import { requirePageAccount } from '../../../../server/auth/page-guards';
export default async function Page() {
  await requirePageAccount('/knowledge');
  return (
    <Suspense fallback={<p>正在读取…</p>}>
      <KnowledgeBrowser />
    </Suspense>
  );
}
