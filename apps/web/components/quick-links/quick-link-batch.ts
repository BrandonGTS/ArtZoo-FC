import { useEffect, useRef, useState } from 'react';
import { accountRequest, errorDetail } from '../account/api';
import type { QuickLinkList, QuickLinkResult } from '../../server/quick-links/contract';
type Status = 'pending' | 'reading' | 'adding' | 'added' | 'failed' | 'unknown';
type Row = {
  line: number;
  url: string;
  key: string;
  status: Status;
  message: string;
  body?: Record<string, unknown>;
};
type Batch = { rows: Row[]; index: number; changed: boolean; unknown: boolean };
export function useQuickLinkBatch({
  notify,
  changed,
  denied
}: {
  notify(type: 'success' | 'error', message: string): void;
  changed(): void;
  denied(): void;
}) {
  const [text, setText] = useState(''),
    [rows, setRows] = useState<Row[]>([]),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false);
  const retained = useRef<Batch | null>(null),
    pending = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const publish = (batch: Batch) => setRows(batch.rows.map((row) => ({ ...row })));
  async function run(batch: Batch) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setUnknown(false);
    batch.unknown = false;
    const abort = new AbortController();
    controller.current = abort;
    try {
      for (; batch.index < batch.rows.length; batch.index++) {
        if (abort.signal.aborted) return;
        const row = batch.rows[batch.index]!;
        if (row.status === 'added' || row.status === 'failed') continue;
        if (!row.body) {
          row.status = 'reading';
          row.message = '读取中';
          publish(batch);
          try {
            const latest = await accountRequest<QuickLinkList>('/api/admin/quick-links?page=1&pageSize=1', {
              signal: abort.signal
            });
            if (abort.signal.aborted) return;
            if (!Number.isSafeInteger(latest.revision)) throw Error('Invalid catalog version');
            row.body = {
              action: 'create',
              url: row.url,
              expectedRevision: latest.revision,
              idempotencyKey: row.key
            };
          } catch (error) {
            if (abort.signal.aborted) return;
            const detail = errorDetail(error);
            row.status = 'failed';
            row.message = detail.message;
            publish(batch);
            if (['UNAUTHENTICATED', 'FORBIDDEN'].includes(detail.code)) {
              denied();
              break;
            }
            continue;
          }
        }
        row.status = 'adding';
        row.message = '添加中';
        publish(batch);
        try {
          const result = await accountRequest<QuickLinkResult>('/api/admin/quick-links', {
            method: 'POST',
            body: row.body,
            signal: abort.signal
          });
          if (abort.signal.aborted) return;
          if (!result.id || !Number.isSafeInteger(result.revision)) throw Error('Invalid result');
          row.status = 'added';
          row.message = result.name ? '已添加：' + result.name : '已添加';
          batch.changed = true;
          publish(batch);
        } catch (error) {
          if (abort.signal.aborted) return;
          const detail = errorDetail(error);
          if (['NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR'].includes(detail.code)) {
            row.status = 'unknown';
            row.message = '结果待确认';
            batch.unknown = true;
            setUnknown(true);
            publish(batch);
            break;
          }
          row.status = 'failed';
          row.message = detail.message;
          publish(batch);
          if (['UNAUTHENTICATED', 'FORBIDDEN'].includes(detail.code)) {
            denied();
            break;
          }
          if (detail.retryAfterSeconds || ['RATE_LIMITED', 'TOO_MANY_REQUESTS'].includes(detail.code)) break;
        }
      }
      if (abort.signal.aborted) return;
      setText(
        batch.rows
          .filter((row) => row.status !== 'added')
          .map((row) => row.url)
          .join('\n')
      );
      if (batch.changed) {
        changed();
        batch.changed = false;
      }
      if (batch.unknown) notify('error', '结果暂未确认，请重试确认后继续。');
      else {
        const added = batch.rows.filter((row) => row.status === 'added').length,
          remaining = batch.rows.length - added;
        notify(
          added ? 'success' : 'error',
          '已添加' + added + '条' + (remaining ? '，' + remaining + '条未添加' : '')
        );
        retained.current = null;
      }
    } finally {
      pending.current = false;
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  function start() {
    if (pending.current || retained.current?.unknown) return;
    const lines = text
      .split(/\r?\n/)
      .map((url, index) => ({ url: url.trim(), line: index + 1 }))
      .filter((row) => row.url);
    if (text.length > 40980) {
      notify('error', '网址内容过长，每次最多20行、每行最多2048个字符');
      return;
    }
    if (!lines.length || lines.length > 20) {
      notify('error', '每次请输入1至20个网址');
      return;
    }
    const seen = new Map<string, number>();
    const next: Row[] = lines.map((row) => {
      let normalized = row.url;
      try {
        normalized = new URL(row.url).href;
      } catch {
        /* final URL validation is server-side */
      }
      const previous = seen.get(normalized);
      if (previous === undefined) seen.set(normalized, row.line);
      return {
        ...row,
        key: crypto.randomUUID(),
        status: previous === undefined ? 'pending' : 'failed',
        message: previous === undefined ? '等待添加' : '与第' + previous + '行网址重复'
      };
    });
    const batch: Batch = { rows: next, index: 0, changed: false, unknown: false };
    retained.current = batch;
    publish(batch);
    void run(batch);
  }
  function retry() {
    const batch = retained.current;
    if (batch?.unknown && !pending.current) void run(batch);
  }
  return { text, setText, rows, busy, unknown, locked: busy || unknown, start, retry };
}
