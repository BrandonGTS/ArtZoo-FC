import { isMemberId } from '@artzoo/domain';

const folders: Record<string, string> = {
  daily: 'daily',
  wish: 'wishes',
  'lottery-image': 'lotteries',
  knowledge: 'knowledge',
  'album-comment': 'albums',
  'album-photo': 'albums',
  'official-image': 'official-events'
};
/** Reviewed Compose namespace mapping. Never accept paths from stored rows. */
export function locateComponent(row: { namespace: string; objectKey?: string; part?: string }) {
  const kind = row.namespace === 'official-image' ? 'official' : row.namespace;
  const keys = row.objectKey?.split(':') ?? [];
  if (kind === 'lottery-image') {
    if (keys.length !== 3 || keys[0] !== 'lottery' || !isMemberId(keys[1] ?? '')) return null;
  } else if (keys.length !== 2 || keys[0] !== kind) return null;
  const id = keys.at(-1);
  if (!id || !isMemberId(id)) return null;
  let directory: string | undefined;
  if (kind === 'avatar' && ['avatar-full', 'avatar-small'].includes(row.part ?? '')) directory = 'avatars';
  else if (kind === 'knowledge' && row.part === 'knowledge-journal') directory = 'original/knowledge';
  else if (Object.hasOwn(folders, row.namespace)) {
    const prefix = kind === 'official' ? 'official-' : 'photo-';
    const variant = row.part?.startsWith(prefix) ? row.part.slice(prefix.length) : '';
    if (!['original', 'preview', 'thumbnail'].includes(variant)) return null;
    directory = `${variant === 'original' ? 'original' : 'derived'}/${folders[row.namespace]}`;
  }
  return directory ? { kind, id, directory } : null;
}
