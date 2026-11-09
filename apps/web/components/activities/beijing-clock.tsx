'use client';

import { useEffect, useState } from 'react';
import './beijing-clock.css';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function formatBeijingClock(now: Date, compact: boolean) {
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  return compact ? time : `${parts.year}/${parts.month}/${parts.day} ${time}`;
}

export function BeijingClock({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  // A stable server/client placeholder avoids time-dependent hydration output.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);
  return (
    <span
      className={`beijing-clock ${compact ? 'beijing-clock-compact' : ''} ${className}`}
      role="timer"
      aria-label="当前北京时间"
      aria-live="off"
    >
      <span className="beijing-clock-label">北京时间</span>
      <time className="beijing-clock-value" dateTime={now?.toISOString()}>
        {now ? formatBeijingClock(now, compact) : compact ? '--:--:--' : '----/--/-- --:--:--'}
      </time>
    </span>
  );
}
