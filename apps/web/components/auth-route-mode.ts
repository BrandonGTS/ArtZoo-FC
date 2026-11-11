// Logical URLs only. Unknown/not-found paths must never wait indefinitely for a server seed.
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const fixed = new Set([
  '/activities',
  '/activities/new',
  '/albums',
  '/daily',
  '/knowledge',
  '/knowledge/new',
  '/lotteries',
  '/lotteries/new',
  '/members',
  '/teams',
  '/teams/new',
  '/wishes',
  '/wishes/new',
  '/me/activities',
  '/me/activity-penalties',
  '/me/messages',
  '/me/profile',
  '/me/teams',
  '/me/teams/history',
  '/admin',
  '/admin/account-lifecycle',
  '/admin/accounts',
  '/admin/announcements',
  '/admin/attendance-appeals',
  '/admin/bot-management',
  '/admin/contact-requests',
  '/admin/featured',
  '/admin/invitations',
  '/admin/knowledge-categories',
  '/admin/official-events',
  '/admin/penalty-appeals',
  '/admin/quick-links',
  '/admin/resources',
  '/admin/roles'
]);
const dynamic = new RegExp(
  '^/(?:activities/' +
    uuid +
    '(?:/edit)?|albums/' +
    uuid +
    '|daily/' +
    uuid +
    '|knowledge/' +
    uuid +
    '(?:/edit)?|lotteries/' +
    uuid +
    '|members/' +
    uuid +
    '(?:/photos)?|teams/' +
    uuid +
    '|wishes/' +
    uuid +
    '(?:/edit|/activity)?)$'
);
export function isProtectedSessionPath(pathname: string | null): boolean {
  return typeof pathname === 'string' && (fixed.has(pathname) || dynamic.test(pathname));
}
