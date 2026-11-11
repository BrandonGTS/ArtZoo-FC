import { LocalAvatarStorage, type AvatarStorage } from './storage';

/** Runtime composition only. Constructor-injected ports remain unchanged. */
export function avatarStorage(): AvatarStorage {
  return new LocalAvatarStorage();
}
