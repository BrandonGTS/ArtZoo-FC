'use client';

import { useEffect, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import './home-card-surface.css';

// Accepted homepage motion; the opt-in feed profile only bounds long-card rotation.
export const HOME_CARD_MOTION = {
  stiffness: 190,
  damping: 20,
  entryLift: 75,
  entryAngle: 0.8,
  entryDuration: 420,
  entryCycles: 2,
  followX: 4,
  followY: 3,
  followAngle: 1.25,
  lift: 2,
  maxX: 7,
  maxY: 9,
  maxAngle: 2.8
} as const;
const motionQuery = '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
const independent =
  'a,button,input,select,textarea,[role="button"],[contenteditable="true"],.ant-image,[data-home-card-independent]';
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

function activateCard(
  event: MouseEvent<HTMLDivElement>,
  frame: HTMLDivElement | null,
  down: { x: number; y: number } | null,
  paused = false
) {
  if (
    paused ||
    event.defaultPrevented ||
    ![0, 1].includes(event.button) ||
    !(event.target instanceof Element) ||
    event.target.closest(independent)
  )
    return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && frame?.contains(selection.anchorNode)) return;
  if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
  const link = frame?.querySelector<HTMLAnchorElement>('a[data-home-card-link]');
  if (!link) return;
  // Native anchors keep their own events. Background middle clicks use the
  // anchor activation default: synthetic auxclick has no browser navigation default.
  const middle = event.button === 1,
    mac = navigator.platform.includes('Mac');
  link.dispatchEvent(
    new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      ctrlKey: event.ctrlKey || (middle && !mac),
      metaKey: event.metaKey || (middle && mac),
      shiftKey: event.shiftKey,
      altKey: event.altKey
    })
  );
}

// Detail pages retain card navigation without mounting any motion behavior.
export function HomeCardNavigationSurface({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const activate = (event: MouseEvent<HTMLDivElement>) => activateCard(event, frame.current, down.current);
  return (
    <div
      ref={frame}
      className="home-card-surface"
      onPointerDown={(event) => {
        down.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerLeave={() => {
        down.current = null;
      }}
      onPointerCancel={() => {
        down.current = null;
      }}
      onClick={activate}
      onAuxClick={activate}
    >
      {children}
    </div>
  );
}

export default function HomeCardSurface({
  children,
  interactionPaused = false,
  motionProfile = 'regular',
  navigation = 'card'
}: {
  children: ReactNode;
  interactionPaused?: boolean;
  motionProfile?: 'regular' | 'flat' | 'feed';
  navigation?: 'card' | 'links';
}) {
  // Wide daily/official cards need a smaller entry rotation, while preserving
  // the accepted timing, repetition and inverse pointer-follow behavior.
  const frame = useRef<HTMLDivElement>(null),
    visual = useRef<HTMLDivElement>(null);
  const raf = useRef<number | null>(null),
    last = useRef(0),
    down = useRef<{ x: number; y: number } | null>(null);
  const entry = useRef({
    active: false,
    startedAt: 0,
    direction: 1,
    amplitude: HOME_CARD_MOTION.entryAngle as number
  });
  const state = useRef({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, va: 0, tx: 0, ty: 0, ta: 0 });
  const reset = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    last.current = 0;
    entry.current.active = false;
    state.current = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, va: 0, tx: 0, ty: 0, ta: 0 };
    if (visual.current) {
      visual.current.style.transform = '';
      visual.current.style.willChange = '';
    }
  };
  useEffect(() => {
    const media = window.matchMedia(motionQuery);
    const change = () => {
      if (!media.matches) reset();
    };
    media.addEventListener('change', change);
    return () => {
      media.removeEventListener('change', change);
      reset();
    };
  }, []);

  useEffect(() => {
    if (interactionPaused) reset();
  }, [interactionPaused]);

  function tick(now: number) {
    const s = state.current,
      c = HOME_CARD_MOTION;
    const dt = Math.min(last.current ? (now - last.current) / 1000 : 1 / 60, 0.032);
    last.current = now;
    s.vx += ((s.tx - s.x) * c.stiffness - s.vx * c.damping) * dt;
    s.vy += ((s.ty - s.y) * c.stiffness - s.vy * c.damping) * dt;
    s.va += ((s.ta - s.angle) * c.stiffness - s.va * c.damping) * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.angle += s.va * dt;
    const resting =
      Math.max(
        Math.abs(s.tx - s.x),
        Math.abs(s.ty - s.y),
        Math.abs(s.ta - s.angle),
        Math.abs(s.vx),
        Math.abs(s.vy),
        Math.abs(s.va)
      ) < 0.025;
    if (resting) {
      s.x = s.tx;
      s.y = s.ty;
      s.angle = s.ta;
      s.vx = s.vy = s.va = 0;
    }
    // Two small, finite rotation cycles overlay the unchanged follow spring.
    // Re-entry restarts this envelope instead of accumulating angular impulses.
    let entryAngle = 0;
    if (entry.current.active) {
      const progress = Math.max(0, (now - entry.current.startedAt) / c.entryDuration);
      if (progress >= 1) entry.current.active = false;
      else
        entryAngle =
          entry.current.direction *
          entry.current.amplitude *
          (1 - progress) *
          Math.sin(2 * Math.PI * c.entryCycles * progress);
    }
    const settled = resting && !entry.current.active;
    if (visual.current) {
      visual.current.style.transform =
        settled && s.tx === 0 && s.ty === 0 && s.ta === 0
          ? ''
          : `translate3d(${clamp(s.x, c.maxX).toFixed(3)}px,${clamp(s.y, c.maxY).toFixed(3)}px,0) rotate(${clamp(s.angle + entryAngle, c.maxAngle).toFixed(3)}deg)`;
      visual.current.style.willChange = settled ? '' : 'transform';
    }
    if (settled) {
      raf.current = null;
      last.current = 0;
    } else raf.current = requestAnimationFrame(tick);
  }
  function start() {
    if (raf.current === null) {
      last.current = 0;
      raf.current = requestAnimationFrame(tick);
    }
  }
  function follow(event: PointerEvent<HTMLDivElement>, entering = false) {
    if (
      interactionPaused ||
      event.pointerType !== 'mouse' ||
      !window.matchMedia(motionQuery).matches ||
      !frame.current
    )
      return;
    // Measure the stationary frame, never the moving paper: no feedback jitter.
    const box = frame.current.getBoundingClientRect(),
      c = HOME_CARD_MOTION,
      s = state.current;
    const x = clamp(((event.clientX - box.left) / box.width) * 2 - 1, 1),
      y = clamp(((event.clientY - box.top) / box.height) * 2 - 1, 1);
    const angleScale = motionProfile === 'feed' ? Math.min(1, 320 / Math.max(box.width, box.height)) : 1;
    s.tx = -x * c.followX;
    s.ty = -y * c.followY - c.lift;
    s.ta = -x * c.followAngle * angleScale;
    if (entering) {
      entry.current = {
        active: true,
        startedAt: performance.now(),
        direction: x < 0 ? -1 : 1,
        amplitude: (motionProfile === 'regular' ? c.entryAngle : 0.35) * angleScale
      };
      s.vy -= c.entryLift;
    }
    start();
  }
  function leave() {
    if (interactionPaused) {
      reset();
      down.current = null;
      return;
    }
    const s = state.current;
    s.tx = s.ty = s.ta = 0;
    down.current = null;
    start();
  }
  const activate = (event: MouseEvent<HTMLDivElement>) =>
    activateCard(event, frame.current, down.current, navigation === 'links' || interactionPaused);
  return (
    <div
      ref={frame}
      className="home-card-surface"
      onPointerEnter={(event) => follow(event, true)}
      onPointerMove={(event) => follow(event)}
      onPointerLeave={leave}
      onPointerCancel={leave}
      onPointerDown={(event) => {
        down.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={activate}
      onAuxClick={activate}
    >
      <div ref={visual} className="home-card-motion">
        {children}
      </div>
    </div>
  );
}
