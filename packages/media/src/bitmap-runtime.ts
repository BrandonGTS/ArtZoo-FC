import { Worker } from 'node:worker_threads';
import { AccountError } from '@artzoo/domain';
import { PHOTO_RULES, bad } from './photo-contract.js';

const state = globalThis as unknown as { artzooBitmapWorkers?: number };
const messages: Record<string, string> = {
  ENCODING: '暂不支持此 BMP 编码，请使用未压缩24或32位BMP',
  DIMENSIONS: 'BMP尺寸或编码无效',
  INCOMPLETE: 'BMP文件不完整'
};
const decodeFailure = '图片解码失败或暂不支持此编码';

export async function bitmap(input: Buffer, timeoutSeconds: number): Promise<Buffer> {
  if ((state.artzooBitmapWorkers ?? 0) >= 2)
    throw new AccountError('SERVICE_UNAVAILABLE', '图片处理繁忙，请稍后再上传', 503);
  state.artzooBitmapWorkers = (state.artzooBitmapWorkers ?? 0) + 1;
  let worker: Worker | undefined;
  let releaseOnExit = false;
  try {
    // Keep the original bytes owned by the caller. Only this bounded private copy is transferred.
    const bytes = Uint8Array.from(input);
    worker = new Worker(new URL('./bitmap-worker.mjs', import.meta.url), {
      workerData: { input: bytes, maxPixels: PHOTO_RULES.maxPixels },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 }
    });
    const current = worker;
    return await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = async (output?: Buffer, code?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Do not release the process-wide worker slot or settle until termination completes.
        try {
          await current.terminate();
        } catch {
          // A failed termination must never make a still-live worker invisible to the cap.
          if (current.threadId !== -1) {
            releaseOnExit = true;
            current.once('exit', () => {
              current.off('message', onMessage);
              current.off('error', onError);
              current.off('exit', onExit);
              state.artzooBitmapWorkers!--;
            });
          }
          reject(new AccountError('VALIDATION_ERROR', decodeFailure, 400));
          return;
        } finally {
          if (!releaseOnExit) {
            current.off('message', onMessage);
            current.off('error', onError);
            current.off('exit', onExit);
          }
        }
        if (output) resolve(output);
        else {
          try {
            bad(code && Object.hasOwn(messages, code) ? messages[code]! : decodeFailure);
          } catch (error) {
            reject(error);
          }
        }
      };
      const onMessage = (message: unknown) => {
        const value = message as { ok?: unknown; output?: unknown; code?: unknown } | null;
        if (
          value?.ok === true &&
          value.output instanceof Uint8Array &&
          value.output.byteLength > 0 &&
          value.output.byteLength <= PHOTO_RULES.maxDecodedPixels * 4
        ) {
          void finish(Buffer.from(value.output.buffer, value.output.byteOffset, value.output.byteLength));
        } else void finish(undefined, typeof value?.code === 'string' ? value.code : undefined);
      };
      const onError = () => {
        void finish();
      };
      const onExit = () => {
        void finish();
      };
      current.on('message', onMessage);
      current.on('error', onError);
      current.on('exit', onExit);
      timer = setTimeout(() => {
        void finish();
      }, timeoutSeconds * 1000);
    });
  } catch (error) {
    if (error instanceof AccountError) throw error;
    return bad(decodeFailure);
  } finally {
    if (!releaseOnExit) state.artzooBitmapWorkers!--;
  }
}
