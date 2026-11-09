/** Public GET sources only. Calendar is authoritative; news may supplement matching text. */
import { BEIJING_OFFSET_MS, toBeijingParts } from '@artzoo/domain';
import {
  discoverOfficialTopic,
  officialNewsHasBacklink,
  officialTextFromHtml,
  validOfficialEventImageUrl,
  verifiedOfficialTopic,
  verifiedOfficialTopicFetchUrl,
  type OfficialSourceImage
} from './official-event-discovery.js';
export { validOfficialEventImageUrl, OFFICIAL_EVENT_IMAGE_HOSTS } from './official-event-discovery.js';
export const OFFICIAL_EVENT_SOURCE_KEY = 'FF14_CN_OFFICIAL';
export interface OfficialEventSourceInput {
  sourceKey: string;
  externalId: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceText: string;
  calendar?: { startsAt: string; endsAt: string; summary: string };
  image?: OfficialSourceImage;
  imageMissingReason?: string;
}
export interface OfficialEventCollectionResult {
  inputs: OfficialEventSourceInput[];
  errors: string[];
}
export interface OfficialEventCollectionOptions {
  fetch?: typeof fetch;
  now?: Date;
  months?: string[];
}
const CALENDAR =
  'https://apiff14risingstones.web.sdo.com/api/home/active/calendar/getActiveCalendarMonth?month=';
const NEWS_DETAIL = 'https://cqnews.web.sdo.com/api/news/newsDetail?gameCode=ff&id=';
const NEWS =
  'https://cqnews.web.sdo.com/api/news/newsList?gameCode=ff&CategoryCode=7141&pageIndex=0&pageSize=5';
const MAX_BYTES = 512 * 1024,
  MAX_TEXT = 80_000,
  TIMEOUT_MS = 8_000,
  COLLECTION_TIMEOUT_MS = 40_000;
const monthPattern = /^20\d{2}-(0[1-9]|1[0-2])$/;
export function validOfficialEventSourceUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  // Navigation validation only; topic requests additionally require an exact verified six-topic rule. Assets are discovered here and downloaded by the separate media adapter.
  return (
    /^https:\/\/actff1\.web\.sdo\.com\/(?:[Pp]roject\/)?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,5}\/index\.html(?:#\/index)?$/.test(
      value
    ) || /^https:\/\/ff\.web\.sdo\.com\/web8\/index\.html#\/newstab\/newscont\/[1-9]\d{0,11}$/.test(value)
  );
}
export function validateOfficialEventSourceInput(input: OfficialEventSourceInput): void {
  if (
    !input ||
    input.sourceKey !== OFFICIAL_EVENT_SOURCE_KEY ||
    !/^(news|activity|calendar):[1-9]\d{0,11}$/.test(input.externalId) ||
    !validOfficialEventSourceUrl(input.sourceUrl) ||
    typeof input.sourceTitle !== 'string' ||
    !input.sourceTitle.trim() ||
    input.sourceTitle.length > 300 ||
    typeof input.sourceText !== 'string' ||
    input.sourceText.length > MAX_TEXT ||
    /\u0000/.test(input.sourceTitle + input.sourceText)
  )
    throw new Error('Invalid official source snapshot');
  if (
    input.externalId.startsWith('news:') &&
    input.sourceUrl !==
      `https://ff.web.sdo.com/web8/index.html#/newstab/newscont/${input.externalId.slice(5)}`
  )
    throw new Error('Official news identity mismatch');
  if (input.externalId.startsWith('calendar:') !== Boolean(input.calendar))
    throw new Error('Official calendar identity mismatch');
  if (
    input.image &&
    (!validOfficialEventImageUrl(input.image.url) ||
      !validOfficialEventSourceUrl(input.image.pageUrl) ||
      !['API', 'NEWS', 'TOPIC_METADATA', 'TOPIC_SECTION'].includes(input.image.kind))
  )
    throw new Error('Invalid official image provenance');
  if (input.image) {
    if (
      input.image.kind === 'NEWS' &&
      !/^https:\/\/ff\.web\.sdo\.com\/web8\/index\.html#\/newstab\/newscont\/[1-9]\d{0,11}$/.test(
        input.image.pageUrl
      )
    )
      throw new Error('Invalid official news image page');
    if (input.image.kind !== 'NEWS' && input.image.pageUrl !== input.sourceUrl)
      throw new Error('Official image page mismatch');
    if (
      input.image.kind.startsWith('TOPIC_') &&
      !verifiedOfficialTopic(input.externalId, input.image.pageUrl)
    )
      throw new Error('Unverified official topic image page');
  }
  if (
    input.imageMissingReason !== undefined &&
    (typeof input.imageMissingReason !== 'string' ||
      input.imageMissingReason.length > 500 ||
      /\u0000/.test(input.imageMissingReason))
  )
    throw new Error('Invalid official image reason');
  if (input.calendar) {
    const { startsAt, endsAt, summary } = input.calendar;
    if (
      typeof startsAt !== 'string' ||
      typeof endsAt !== 'string' ||
      !Number.isFinite(Date.parse(startsAt)) ||
      !Number.isFinite(Date.parse(endsAt)) ||
      new Date(startsAt).toISOString() !== startsAt ||
      new Date(endsAt).toISOString() !== endsAt ||
      Date.parse(endsAt) <= Date.parse(startsAt) ||
      typeof summary !== 'string' ||
      summary.length > 2000 ||
      /\u0000/.test(summary)
    )
      throw new Error('Invalid official calendar fields');
  }
}
function validFetchUrl(url: string) {
  return (
    url === NEWS ||
    (url.startsWith(CALENDAR) && monthPattern.test(url.slice(CALENDAR.length))) ||
    (url.startsWith(NEWS_DETAIL) && /^[1-9]\d{0,11}$/.test(url.slice(NEWS_DETAIL.length))) ||
    verifiedOfficialTopicFetchUrl(url)
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unexpected official payload');
  return value as Record<string, unknown>;
}
function plainText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => {
      const code = n[0]?.toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : ' ';
    })
    .replace(
      /&(nbsp|amp|lt|gt|quot|apos);/gi,
      (_, n: string) =>
        ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n.toLowerCase()] ?? ' '
    )
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
async function readPublicText(
  url: string,
  fetcher: typeof fetch,
  html = false,
  deadline = Infinity
): Promise<string> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Official collection time budget exhausted');
  const timeout = Math.min(TIMEOUT_MS, remaining);
  if (!validFetchUrl(url)) throw new Error('Unverified official endpoint');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: {
        accept: html ? 'text/html' : 'application/json',
        'user-agent': 'ArtZoo-OfficialEventCollector/2.0'
      }
    });
    if (Date.now() >= deadline) {
      await response.body?.cancel();
      throw new Error('Official collection time budget exhausted');
    }
    if (response.url && response.url !== url) {
      await response.body?.cancel();
      throw new Error('Unexpected official redirect');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Official source unavailable');
    }
    if (
      !(html ? /^text\/html(?:;|$)/i : /^application\/json(?:;|$)/i).test(
        response.headers.get('content-type') ?? ''
      )
    ) {
      await response.body?.cancel();
      throw new Error('Unexpected official content type');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
      await response.body?.cancel();
      throw new Error('Official source exceeded byte limit');
    }
    if (!response.body) throw new Error('Empty official source');
    const reader = response.body.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '',
      size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new Error('Official source exceeded byte limit');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    return text;
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Official source timed out'));
        }, timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
async function readPublic(url: string, fetcher: typeof fetch, deadline: number): Promise<unknown> {
  return JSON.parse(await readPublicText(url, fetcher, false, deadline)) as unknown;
}
function defaultMonths(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid collection date');
  const instant = now.getTime(),
    beijing = new Date(instant + BEIJING_OFFSET_MS),
    beijingYear = beijing.getUTCFullYear(),
    parts =
      Number.isSafeInteger(instant) && beijingYear >= 0 && beijingYear <= 9999
        ? toBeijingParts(instant)
        : null,
    year = parts?.year ?? beijingYear,
    month = parts ? parts.month - 1 : beijing.getUTCMonth();
  return [0, 1].map((offset) => new Date(Date.UTC(year, month + offset, 1)).toISOString().slice(0, 7));
}
/** Calendar end_time includes its final second; the calendar projection uses an exclusive end. */
function calendarInput(value: unknown): OfficialEventSourceInput {
  const row = object(value),
    id = row.id;
  if (
    !Number.isSafeInteger(id) ||
    Number(id) < 1 ||
    Number(id) > 999999999999 ||
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    row.name.length > 300 ||
    typeof row.url !== 'string' ||
    !validOfficialEventSourceUrl(row.url) ||
    !Number.isSafeInteger(row.begin_time) ||
    !Number.isSafeInteger(row.end_time) ||
    Number(row.begin_time) < 946684800 ||
    Number(row.end_time) < Number(row.begin_time) ||
    Number(row.end_time) > 4133980799
  )
    throw new Error('Invalid official calendar event');
  const sourceTitle = plainText(row.name),
    startsAt = new Date(Number(row.begin_time) * 1000).toISOString(),
    endsAt = new Date((Number(row.end_time) + 1) * 1000).toISOString();
  const input: OfficialEventSourceInput = {
    sourceKey: OFFICIAL_EVENT_SOURCE_KEY,
    externalId: `calendar:${id}`,
    sourceUrl: row.url,
    sourceTitle,
    sourceText: '',
    calendar: { startsAt, endsAt, summary: '' }
  };
  if (validOfficialEventImageUrl(row.banner_url))
    input.image = { url: row.banner_url, pageUrl: input.sourceUrl, kind: 'API' };
  validateOfficialEventSourceInput(input);
  return input;
}
export async function collectOfficialEventInputs(
  options: OfficialEventCollectionOptions = {}
): Promise<OfficialEventCollectionResult> {
  const deadline = Date.now() + COLLECTION_TIMEOUT_MS;
  const months = options.months ?? defaultMonths(options.now ?? new Date());
  if (!months.length || months.length > 3 || months.some((month) => !monthPattern.test(month)))
    throw new Error('Invalid official collection months');
  const fetcher = options.fetch ?? globalThis.fetch,
    events = new Map<string, OfficialEventSourceInput>(),
    errors: string[] = [];
  const ambiguous = new Set<string>();
  for (const month of new Set(months)) {
    if (Date.now() >= deadline) {
      errors.push('官方来源获取达到本次时间上限，已保留可用数据');
      break;
    }
    try {
      const payload = object(await readPublic(CALENDAR + month, fetcher, deadline));
      if (payload.code !== 10000 || !Array.isArray(payload.data) || payload.data.length > 200)
        throw new Error('Invalid official calendar response');
      for (const entry of payload.data) {
        try {
          const input = calendarInput(entry),
            previous = events.get(input.externalId);
          if (previous && JSON.stringify(previous) !== JSON.stringify(input)) {
            ambiguous.add(input.externalId);
            events.delete(input.externalId);
            errors.push('官方月历条目不一致，已保留原数据');
          } else if (!ambiguous.has(input.externalId)) events.set(input.externalId, input);
        } catch {
          errors.push('官方月历条目无效，已保留原数据');
        }
      }
    } catch {
      errors.push(`官方月历 ${month} 获取失败，已保留原数据`);
    }
  }
  if (events.size) {
    try {
      const payload = object(await readPublic(NEWS, fetcher, deadline));
      if (String(payload.Code) !== '0' || !Array.isArray(payload.Data) || payload.Data.length > 5)
        throw new Error('Invalid official news response');
      const news = payload.Data.map(object).filter((row) => String(row.CategoryCode) === '7141');
      for (const input of events.values()) {
        const matches = news.filter((row) => row.OutLink === input.sourceUrl);
        if (matches.length !== 1) continue;
        const match = matches[0]!;
        if (!input.image && validOfficialEventImageUrl(match.HomeImagePath)) {
          const id = String(match.Id);
          if (/^[1-9]\d{0,11}$/.test(id))
            input.image = {
              url: match.HomeImagePath,
              pageUrl: `https://ff.web.sdo.com/web8/index.html#/newstab/newscont/${id}`,
              kind: 'NEWS'
            };
        }
        if (typeof match.Summary === 'string') {
          const summary = plainText(match.Summary);
          if (summary.length <= 2000 && !/\u0000/.test(summary)) {
            input.sourceText = summary;
            input.calendar!.summary = summary;
          }
        }
      }
      // Follow only numeric news pages explicitly linked by the fixed official list.
      // No title matching: a detail must link back to the exact authoritative calendar URL.
      const detailIds = [
        ...new Set(
          news.flatMap((row) =>
            typeof row.OutLink === 'string'
              ? [
                  row.OutLink.match(
                    /^https:\/\/ff\.web\.sdo\.com\/web8\/index\.html#\/newstab\/newscont\/([1-9]\d{0,11})$/
                  )?.[1]
                ].filter((id): id is string => Boolean(id))
              : []
          )
        )
      ].slice(0, 5);
      if ([...events.values()].some((input) => !input.image || !input.sourceText))
        for (const id of detailIds) {
          if (Date.now() >= deadline) {
            errors.push('官方来源补充达到本次时间上限，已保留可用数据');
            break;
          }
          try {
            const payload = object(await readPublic(NEWS_DETAIL + id, fetcher, deadline));
            if (String(payload.Code) !== '0') throw new Error('Invalid official detail');
            const detail = object(payload.Data);
            if (
              String(detail.Id) !== id ||
              typeof detail.Content !== 'string' ||
              detail.Content.length > MAX_BYTES
            )
              throw new Error('Invalid official detail identity');
            const matches = [...events.values()].filter((input) =>
              officialNewsHasBacklink(detail.Content as string, input.sourceUrl)
            );
            if (matches.length > 1) {
              errors.push('官方新闻详情同时关联多个活动，未采用图文补充');
              for (const input of matches)
                if (!input.image) input.imageMissingReason = '官方新闻详情关联多个活动，无法可靠归属图片';
              continue;
            }
            for (const input of matches) {
              if (!input.image && validOfficialEventImageUrl(detail.HomeImagePath))
                input.image = {
                  url: detail.HomeImagePath,
                  pageUrl: `https://ff.web.sdo.com/web8/index.html#/newstab/newscont/${id}`,
                  kind: 'NEWS'
                };
              const sourceText = officialTextFromHtml(detail.Content),
                summary = typeof detail.Summary === 'string' ? plainText(detail.Summary) : '';
              if (sourceText && !/\u0000/.test(sourceText)) input.sourceText = sourceText;
              if (summary && summary.length <= 2000 && !/\u0000/.test(summary))
                input.calendar!.summary = summary;
              else if (sourceText && !/\u0000/.test(sourceText))
                input.calendar!.summary = sourceText.slice(0, 2000).trim();
            }
          } catch {
            errors.push('官方新闻详情补充暂不可用，已保留可用月历内容');
          }
        }
    } catch {
      errors.push('官方新闻补充暂不可用，活动时间已按官方月历同步');
    }
    for (const input of events.values()) {
      if (Date.now() >= deadline) {
        errors.push('官方来源补充达到本次时间上限，已保留可用数据');
        break;
      }
      if (verifiedOfficialTopic(input.externalId, input.sourceUrl) && input.externalId !== 'calendar:99') {
        try {
          const topic = discoverOfficialTopic(
            input.externalId,
            input.sourceUrl,
            await readPublicText(input.sourceUrl.split('#')[0]!, fetcher, true, deadline)
          );
          if (topic.sourceText) {
            input.sourceText = topic.sourceText;
            input.calendar!.summary = topic.summary;
          }
          if (!input.image && topic.image) input.image = topic.image;
        } catch {
          errors.push('官方专题补充暂不可用，已保留可用月历内容');
        }
      }
    }
    for (const input of events.values()) {
      if (!input.image) input.imageMissingReason ??= '官方来源未提供可可靠归属且通过校验的图片';
      validateOfficialEventSourceInput(input);
    }
  }
  return { inputs: [...events.values()], errors: errors.slice(0, 30) };
}
