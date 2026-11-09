import type { createMediaBudgetAdapter } from '@artzoo/db';
import { mediaBudgetPolicy } from '@artzoo/domain';
import { dirname, join, resolve } from 'node:path';
import type { AccountService } from '../auth/service';
import { processPhoto, withPhotoSlot } from '../media/photo-processor';
import { createPhotoStorage } from '@artzoo/media/cos-routed-storage';
import { LocalPhotoStorage } from '../media/photo-storage';
import { KnowledgeImageService } from './images';
export function getKnowledgeImageService(auth: AccountService): KnowledgeImageService {
  const cwd = resolve(/* turbopackIgnore: true */ process.cwd());
  const base = join(
    /* turbopackIgnore: true */ cwd.endsWith('/apps/web') ? dirname(dirname(cwd)) : cwd,
    '.local',
    'knowledge-media'
  );
  const legacy = new LocalPhotoStorage(
    process.env.ARTZOO_KNOWLEDGE_ORIGINAL_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/original/knowledge'
        : join(/* turbopackIgnore: true */ base, 'original')),
    process.env.ARTZOO_KNOWLEDGE_DERIVED_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/derived/knowledge'
        : join(/* turbopackIgnore: true */ base, 'derived'))
  );
  const store = createPhotoStorage({ scope: 'knowledge', legacy });
  const enabled = process.env.ARTZOO_MEDIA_BUDGET_ENABLED;
  const budget: ReturnType<typeof createMediaBudgetAdapter> | null =
    (enabled ?? '0') === '0'
      ? null
      : {
          async prepare(input) {
            try {
              // Keep this factory synchronous and defer policy/DB work until the original authorized upload preflight.
              const policy = mediaBudgetPolicy(process.env);
              const { createMediaBudgetAdapter } = await import('@artzoo/db');
              return await createMediaBudgetAdapter(auth.db, policy, () => auth.now()).prepare(input);
            } catch (error) {
              throw (await import('../media/budget-errors')).mediaBudgetError(error);
            }
          }
        };
  return new KnowledgeImageService(
    auth,
    {
      process: (input, name) => withPhotoSlot(() => processPhoto(input, name)),
      ...(store.writePhotoNamespaces ? { writePhotoNamespaces: store.writePhotoNamespaces.bind(store) } : {}),
      ...(store.boundPhotoNamespaces ? { boundPhotoNamespaces: store.boundPhotoNamespaces.bind(store) } : {}),
      put: store.put.bind(store),
      read: store.read.bind(store),
      discardUncommitted: store.discardUncommitted.bind(store)
    },
    undefined,
    budget
  );
}
