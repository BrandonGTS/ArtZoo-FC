import { stickerParts } from '../stickers/sticker-codec';

export const GUEST_TEXT_ONLY_ERROR = '游客留言仅支持文字，请移除图片表情后再提交';
/** Only current allowlisted image tokens are forbidden in new guest messages. */
export function guestTextContainsSticker(message: string): boolean {
  return stickerParts(message).some((part) => typeof part !== 'string');
}
