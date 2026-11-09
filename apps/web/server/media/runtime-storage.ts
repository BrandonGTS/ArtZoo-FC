import { createAvatarStorage } from '@artzoo/media/cos-routed-storage';
import { LocalAvatarStorage, type AvatarStorage } from './storage';

/** Runtime composition only. Constructor-injected ports remain unchanged. */
export function avatarStorage(): AvatarStorage {
  return createAvatarStorage({ legacy: new LocalAvatarStorage() });
}
