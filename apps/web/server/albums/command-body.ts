import { bad } from './contract';
// Cross-page selections can exceed the small account form body size; keep a bounded parser local.
export async function readPhotoCommandBody(request: Request): Promise<Record<string, unknown>> {
  const max = 1024 * 1024;
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) bad('请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) bad('请求内容不能为空');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        bad('请求内容过大');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    bad('请求JSON格式无效');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('请求格式无效');
  return value as Record<string, unknown>;
}
