'use client';
import type { ReactNode } from 'react';
import { homeDailyDemoResponse, HOME_DAILY_MEMBER } from './modules/home-daily-fixtures';
import { albumDemoResponse } from './modules/albums-fixtures';
import { activityDemoResponse } from './modules/activities-fixtures';
import { wishDemoResponse } from './modules/wishes-fixtures';
import { lotteryDemoResponse } from './modules/lotteries-fixtures';
import { knowledgeDemoResponse } from './modules/knowledge-fixtures';

type DemoWindow = Window & { __artzooGuideNetworkInstalled?: boolean };
const actor = {
  ...HOME_DAILY_MEMBER,
  id: '00000000-0000-4000-8000-000000000099',
  adminRole: 'NONE',
  phoneMasked: '示例账号'
};
function installDemoNetwork() {
  if (typeof window === 'undefined' || window.parent === window || window.location.pathname !== '/help-demo')
    return;
  const scope = window as DemoWindow;
  if (scope.__artzooGuideNetworkInstalled) return;
  scope.__artzooGuideNetworkInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  const lesson = new URLSearchParams(window.location.search).get('lesson') ?? 'home';
  const adapter =
    lesson === 'albums'
      ? albumDemoResponse
      : lesson === 'activities'
        ? activityDemoResponse
        : lesson === 'wishes'
          ? wishDemoResponse
          : lesson === 'lotteries'
            ? lotteryDemoResponse
            : lesson === 'knowledge'
              ? knowledgeDemoResponse
              : homeDailyDemoResponse;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), window.location.href);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const signal = init?.signal ?? request?.signal;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (
      url.origin === window.location.origin &&
      method === 'GET' &&
      url.pathname.startsWith('/_next/static/')
    )
      return nativeFetch(input, init);
    const response = (data: unknown) =>
      Response.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
    const blocked = () =>
      Response.json(
        { ok: false, error: { code: 'GUIDE_ONLY', message: '请在引导结束后进行此操作。' } },
        { status: 403 }
      );
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return blocked();
    if (method === 'GET' && url.pathname === '/api/auth/session')
      return response({
        user: actor,
        expiresAt: '2099-01-01T00:00:00.000Z',
        capabilities: { manageInvitations: false, manageMembership: false }
      });
    if (method === 'GET' && url.pathname === '/api/me/profile') return response(actor);
    if (method === 'GET' && url.pathname === '/api/me/help-progress') return response({ lessons: [] });
    if (method === 'GET' && url.pathname === '/api/me/messages/unread')
      return response({ unreadCount: 0, systemUnreadCount: 0, categoryUnread: {} });
    if (method === 'GET' && url.pathname === '/api/me/messages/preview')
      return response({ items: [], unreadCount: 0, systemUnreadCount: 0, categoryUnread: {} });
    if (method === 'GET' && url.pathname === '/api/announcements/active') return response({ items: [] });
    if (method === 'GET' && url.pathname === '/api/me/check-in')
      return response({
        month: '2026-10',
        today: '2026-10-31',
        count: 3,
        checkedInToday: false,
        serverNow: '2026-10-31T04:00:00.000Z',
        days: []
      });
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    const data = adapter(url.pathname + url.search, method, body);
    return data === undefined ? blocked() : response(data);
  };
  // Upload libraries may use XHR rather than fetch. No guide XHR can leave this frame.
  window.XMLHttpRequest.prototype.send = function () {
    throw new DOMException('Guide upload blocked', 'NotAllowedError');
  };
  window.navigator.sendBeacon = () => false;
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (target) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );
  document.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
  // A focused native demo modal belongs to the iframe document, so its keyboard
  // events cannot bubble into the outer Tour's escape/focus trap.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.parent.postMessage(
        { type: event.key === 'Escape' ? 'help-exit' : 'help-focus', lesson },
        window.location.origin
      );
    },
    true
  );
}
/** Install during child render, before auth/message ancestor effects can issue requests.
 * Only the separate embedded guide window is touched; the real page keeps native networking.
 */
export default function DemoBootstrap({ children }: { children: ReactNode }) {
  installDemoNetwork();
  return children;
}
