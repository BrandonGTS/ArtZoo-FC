'use client';
import dynamic from 'next/dynamic';
function EditorLoading() {
  return (
    <p className="daily-meta" role="status">
      正在打开编辑器…
    </p>
  );
}
// Creating these boundaries does not load an editor. Keep each caller's original mount/key lifetime.
export const DailyComposer = dynamic(() => import('./daily-composer'), {
  ssr: false,
  loading: EditorLoading
});
export const DailyReplyComposer = dynamic(() => import('./daily-reply-composer'), {
  ssr: false,
  loading: EditorLoading
});
