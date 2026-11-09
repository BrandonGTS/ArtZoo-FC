'use client';

import { useEffect, useRef, useState } from 'react';
import { Tag } from 'antd';
import Image from 'next/image';
import HomeCardSurface from '../home-card-surface';
import { beijingPickerTimestamp } from '../beijing-picker';
import type { OfficialCalendarEvent } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { ActivityPaper, beijingDate, beijingFull } from '../activities/activity-ui';
import './official-events.css';

type CalendarResponse = {
  items: OfficialCalendarEvent[];
  month: string;
  serverNow: string;
  timeZone: 'Asia/Shanghai';
};
export function useOfficialCalendar(month: string, enabled: boolean, owner: string | null) {
  const previous = useRef<{ key: string; retry: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: CalendarResponse | null;
    error: string | null;
  } | null>(null);
  const key = enabled && owner ? owner + ':' + month : null;
  // A disabled calendar or a different owner/month must never reuse the old projection.
  if (state && state.key !== key) setState(null);
  useEffect(() => {
    if (!key) return;
    let controller: AbortController | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let version = 0,
      disposed = false;
    function refresh(userInitiated = false) {
      controller?.abort();
      const request = new AbortController(),
        requestVersion = ++version;
      controller = request;
      accountRequest<CalendarResponse>('/api/official-events/calendar?month=' + month, {
        signal: request.signal,
        userInitiated
      }).then(
        (data) => {
          if (!disposed && !request.signal.aborted && requestVersion === version)
            setState({ key: key!, data, error: null });
        },
        (failure) => {
          if (!disposed && !request.signal.aborted && requestVersion === version)
            setState({ key: key!, data: null, error: errorDetail(failure).message });
        }
      );
    }
    function reactivate() {
      if (document.visibilityState !== 'visible') return;
      // Browsers commonly dispatch both events when returning to a tab.
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh();
      }, 50);
    }
    const changed =
      previous.current !== null && (previous.current.key !== key || previous.current.retry !== retry);
    previous.current = { key, retry };
    refresh(changed);
    window.addEventListener('focus', reactivate);
    document.addEventListener('visibilitychange', reactivate);
    return () => {
      disposed = true;
      controller?.abort();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      window.removeEventListener('focus', reactivate);
      document.removeEventListener('visibilitychange', reactivate);
    };
  }, [key, month, retry]);
  const current = state?.key === key ? state : null;
  return {
    items: current?.data?.items ?? [],
    serverNow: current?.data?.serverNow ?? null,
    loading: Boolean(key && !current),
    error: current?.error ?? null,
    retry: () => setRetry((value) => value + 1)
  };
}
export function officialOnDay(event: OfficialCalendarEvent, day: string) {
  // Calendar display includes the entire Beijing end date, including a midnight end.
  // This does not change the event's real instant or ordinary activity boundaries.
  return beijingDate(event.startsAt) <= day && day <= beijingDate(event.endsAt);
}
// Ongoing matches the original daily-paper outline; warm accents follow the site palette.
export const OFFICIAL_CALENDAR_STATES = [
  { key: 'ongoing', label: '当前进行', color: '#254B38' },
  { key: 'upcoming', label: '即将开始', color: '#D3972A' },
  { key: 'ending', label: '即将结束', color: '#D9553F' }
] as const;
export function OfficialCalendarLegend() {
  return (
    <div className="official-calendar-legend" aria-label="官方活动状态图例">
      <svg
        width="0"
        height="0"
        className="official-calendar-border-filters"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {OFFICIAL_CALENDAR_STATES.map((state) => (
            <filter
              key={state.key}
              id={`official-calendar-border-${state.key}`}
              colorInterpolationFilters="sRGB"
            >
              <feColorMatrix
                in="SourceGraphic"
                type="matrix"
                values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 -1 -1 2 0"
                result="ink"
              />
              <feFlood floodColor={state.color} result="color" />
              <feComposite in="color" in2="ink" operator="in" />
            </filter>
          ))}
        </defs>
      </svg>
      {OFFICIAL_CALENDAR_STATES.map((state) => (
        <span key={state.key}>
          <i
            className={`official-calendar-dot official-calendar-dot-${state.key}`}
            style={{ backgroundColor: state.color }}
            aria-hidden="true"
          />
          {state.label}
        </span>
      ))}
    </div>
  );
}
export function officialDayStates(items: OfficialCalendarEvent[], day: string) {
  const dayStart = beijingPickerTimestamp(day + 'T00:00:00');
  const states = new Set<string>();
  for (const item of items) {
    if (!officialOnDay(item, day)) continue;
    const startsToday = beijingDate(item.startsAt) === day;
    // Latest calendar rule: an end on the 25th marks the 23rd, 24th and 25th.
    // Calendar display includes a midnight end date, but never days before the start.
    const endDayStart = beijingPickerTimestamp(beijingDate(item.endsAt) + 'T00:00:00');
    const endingSoon = dayStart >= endDayStart - 2 * 86_400_000 && dayStart <= endDayStart;
    if (startsToday) states.add('upcoming');
    if (endingSoon) states.add('ending');
    // A short event can meet both explicit boundaries; keep both indications.
    if (!startsToday && !endingSoon) states.add('ongoing');
  }
  return OFFICIAL_CALENDAR_STATES.filter((state) => states.has(state.key));
}
export function OfficialDayMarker({ day, items }: { day: string; items: OfficialCalendarEvent[] }) {
  const states = officialDayStates(items, day);
  return (
    <div
      className="official-calendar-day-marker"
      aria-label={states.length ? states.map((state) => state.label).join('、') : undefined}
    >
      {states.map((state) => (
        <span
          key={state.key}
          className={`official-calendar-dot official-calendar-dot-${state.key}`}
          style={{ backgroundColor: state.color }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
export function officialEventType(event: OfficialCalendarEvent) {
  if (/联动|合作/.test(event.title)) return { label: '限时联动', kind: 'collaboration' };
  if (/月卡|商城/.test(event.title)) return { label: '月卡/商城', kind: 'store' };
  if (/守护天节|星芒节|降神祭|公主节|猎蛋节|红莲节|新生庆典|情人节/.test(event.title))
    return { label: '季节活动', kind: 'seasonal' };
  return { label: '特别活动', kind: 'special' };
}
export function officialCardState(event: OfficialCalendarEvent, day: string) {
  const states = officialDayStates([event], day);
  // New single-border policy: preserve both dots while emphasizing the ending state.
  return (
    states.find((state) => state.key === 'ending') ??
    states.find((state) => state.key === 'upcoming') ??
    states.find((state) => state.key === 'ongoing')
  );
}
export function OfficialDayCard({ event, day }: { event: OfficialCalendarEvent; day: string }) {
  const type = officialEventType(event);
  const state = officialCardState(event, day);
  return (
    <HomeCardSurface motionProfile="flat">
      <ActivityPaper
        className={`activity-card official-day-card${state ? ` official-day-card-${state.key}` : ''}`}
      >
        <a
          className="official-day-card-link"
          href={event.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-home-card-link
        >
          {event.image ? (
            <span className="official-calendar-image">
              <Image
                src={event.image.thumbnailUrl}
                width={200}
                height={112}
                unoptimized
                alt={event.title + '的活动配图'}
                className="official-image-content"
              />
            </span>
          ) : null}
          <div className="official-day-card-copy">
            <div className="official-day-card-title">
              <Tag className={`official-event-type official-event-type-${type.kind}`}>{type.label}</Tag>
              <h3>{event.title}</h3>
            </div>
            <p className="official-calendar-meta">
              <Image src="/artzoo/icons/calendar-days.svg" width="16" height="16" alt="" aria-hidden="true" />
              <span>
                {beijingFull(event.startsAt)} — {beijingFull(event.endsAt)}
              </span>
            </p>
            {event.summary ? <p className="official-calendar-summary">{event.summary}</p> : null}
          </div>
        </a>
      </ActivityPaper>
    </HomeCardSurface>
  );
}
export function officialLastDay(event: OfficialCalendarEvent) {
  return beijingDate(event.endsAt);
}
