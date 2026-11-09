import { AccountError } from '@artzoo/domain';

interface MultipartLimits {
  maxBytes: number;
  timeoutMs: number;
  emptyMessage: string;
  oversizeMessage: string;
  timeoutMessage: string;
}
// Keep the runtime's multipart boundary/Content-Disposition semantics. The only
// body fed into formData is this bounded stream: no application-level chunks,
// concat buffer or Response(byteArray) copy of the full multipart envelope.
export async function readBoundedMultipart(request: Request, limits: MultipartLimits): Promise<FormData> {
  const invalid = (message: string) => new AccountError('VALIDATION_ERROR', message, 400);
  const reader = request.body?.getReader();
  if (!reader) throw invalid(limits.emptyMessage);
  let bytes = 0,
    bodyError: unknown;
  let bodyFailed = false,
    sourceDone = false,
    cancelled = false;
  const cancelSource = () => {
    if (cancelled || sourceDone) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false;
  const stop = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    bodyError = error;
    bodyFailed = true;
    controller.error(error);
    // Neither a stalled source cancellation nor a hostile producer holds a slot.
    cancelSource();
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull(value) {
      try {
        const part = await reader.read();
        if (stopped) return;
        if (part.done) {
          sourceDone = true;
          value.close();
          return;
        }
        bytes += part.value.byteLength;
        if (bytes > limits.maxBytes) {
          stop(invalid(limits.oversizeMessage));
          return;
        }
        value.enqueue(part.value);
      } catch (error) {
        stop(error);
      }
    },
    cancel() {
      cancelSource();
    }
  });
  const timer = setTimeout(() => stop(invalid(limits.timeoutMessage)), limits.timeoutMs);
  const abort = () => stop(invalid('上传已取消，请重新上传'));
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    if (request.signal.aborted) abort();
    return await new Response(body, {
      headers: { 'content-type': request.headers.get('content-type')! }
    }).formData();
  } catch (error) {
    if (bodyFailed) throw bodyError;
    if (error instanceof AccountError) throw error;
    throw invalid('上传格式无效');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    // A parser rejection (e.g. missing boundary) can happen before consuming body.
    cancelSource();
    reader.releaseLock();
  }
}
