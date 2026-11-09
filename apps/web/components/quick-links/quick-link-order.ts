import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, MouseEvent } from 'react';
import type { QuickLinkView } from '../../server/quick-links/contract';

export function moveQuickLink<T extends { id: string }>(items: readonly T[], id: string, index: number): T[] {
  const from = items.findIndex((item) => item.id === id),
    result = [...items];
  if (from < 0 || index < 0 || index >= items.length) return result;
  result.splice(index, 0, result.splice(from, 1)[0]!);
  return result;
}
type Session = {
  version: string;
  item: QuickLinkView;
  base: QuickLinkView[];
  index: number;
  pointer: number | null;
  centers: number[];
};
export function useQuickLinkOrder(
  items: QuickLinkView[],
  disabled: boolean,
  version: string,
  commit: (item: QuickLinkView, targetId: string) => void,
  adjacent: (item: QuickLinkView, direction: 'up' | 'down') => void,
  total: number
) {
  const current = useRef<Session | null>(null),
    [session, setSession] = useState<Session | null>(null),
    [announcement, setAnnouncement] = useState('');
  const change = (next: Session | null) => {
    current.current = next;
    setSession(next);
  };
  const active = () => (!disabled && current.current?.version === version ? current.current : null);
  const visible = !disabled && session?.version === version ? session : null;
  const cancel = () => {
    if (current.current) {
      setAnnouncement('已取消排序');
      change(null);
    }
  };
  const finish = () => {
    const s = active();
    if (!s) return;
    change(null);
    const target = s.base[s.index];
    if (!disabled && target && target.id !== s.item.id) {
      setAnnouncement('正在保存排序');
      commit(s.item, target.id);
    } else setAnnouncement('顺序未更改');
  };
  const step = (s: Session, index: number) => {
    const next = Math.max(0, Math.min(s.base.length - 1, index));
    if (next === s.index) return;
    change({ ...s, index: next });
    setAnnouncement(s.item.name + '，本页第' + (next + 1) + '项');
  };
  const bindings = (item: QuickLinkView) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (disabled || active() || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rows = event.currentTarget
        .closest('.quick-links-admin-list')
        ?.querySelectorAll<HTMLElement>('[data-quick-link-id]');
      if (!rows || rows.length !== items.length) return;
      const centers = Array.from(rows, (row) => {
        const rect = row.getBoundingClientRect();
        return rect.top + rect.height / 2 + (window.scrollY ?? 0);
      });
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      change({
        version,
        item,
        base: [...items],
        index: items.findIndex((row) => row.id === item.id),
        pointer: event.pointerId,
        centers
      });
      setAnnouncement('已选中' + item.name);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const s = active();
      if (!s || s.pointer !== event.pointerId || disabled) return;
      event.preventDefault();
      event.stopPropagation();
      let index = 0;
      while (
        index < s.centers.length - 1 &&
        event.clientY + (window.scrollY ?? 0) > (s.centers[index]! + s.centers[index + 1]!) / 2
      )
        index++;
      step(s, index);
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      if (active()?.pointer !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    },
    onPointerCancel: () => cancel(),
    onLostPointerCapture: () => {
      if (current.current?.pointer !== null) cancel();
    },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    onBlur: () => cancel(),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      const s = active();
      if (!s && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const up = event.key === 'ArrowUp';
        if (up ? item.ordinal > 0 : item.ordinal < total - 1) adjacent(item, up ? 'up' : 'down');
        return;
      }
      if (!s && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        event.stopPropagation();
        change({
          version,
          item,
          base: [...items],
          index: items.findIndex((row) => row.id === item.id),
          pointer: null,
          centers: []
        });
        setAnnouncement('已选中' + item.name);
        return;
      }
      if (!s || s.item.id !== item.id) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (s.pointer !== null) return;
      if (['ArrowUp', 'ArrowDown', 'Home', 'End', ' ', 'Enter', 'Escape'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') cancel();
        else if (event.key === ' ' || event.key === 'Enter') finish();
        else
          step(
            s,
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? s.base.length - 1
                : s.index + (event.key === 'ArrowUp' ? -1 : 1)
          );
      }
    }
  });
  return {
    items: visible ? moveQuickLink(visible.base, visible.item.id, visible.index) : items,
    activeId: visible?.item.id ?? null,
    announcement: session && !visible ? '已取消排序' : announcement,
    bindings
  };
}
