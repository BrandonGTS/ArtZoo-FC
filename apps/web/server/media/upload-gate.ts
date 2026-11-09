import { AccountError } from '@artzoo/domain';

// Shared across route bundles/module reloads in this Node process, not a queue.
const state = globalThis as unknown as { artzooUploadRequests?: number };
function uploadLimit(): number {
  const configured = process.env.ARTZOO_UPLOAD_CONCURRENCY;
  return configured && /^[1-8]$/.test(configured) ? Number(configured) : 2;
}
export async function withUploadSlot<T>(
  action: () => Promise<T>,
  busyMessage = '图片处理繁忙，请稍后再上传'
): Promise<T> {
  if ((state.artzooUploadRequests ?? 0) >= uploadLimit()) {
    throw new AccountError('SERVICE_UNAVAILABLE', busyMessage, 503);
  }
  state.artzooUploadRequests = (state.artzooUploadRequests ?? 0) + 1;
  try {
    return await action();
  } finally {
    state.artzooUploadRequests!--;
  }
}
