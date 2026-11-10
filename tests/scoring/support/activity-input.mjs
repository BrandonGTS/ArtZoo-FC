import { composeActivityDescription } from '../../../apps/web/lib/activity-description.ts';
export const id = (n) => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
export const input = (extra = {}) => ({
  idempotencyKey: id(1),
  title: 'Isolated activity',
  description: composeActivityDescription('Synthetic fixture', 'Synthetic participation'),
  category: 'DUNGEON',
  startsAt: '2030-06-01T20:00:00+08:00',
  endsAt: '2030-06-01T22:00:00+08:00',
  seats: [{ kind: 'ANY' }, { kind: 'ROLE', role: 'TANK' }, { kind: 'JOB', job: '白魔法师' }],
  dutySelection:
    extra.category === 'SOCIAL' ? null : { type: 'OTHER', name: '隔离测试副本', partyComposition: 'CUSTOM' },
  ...extra
});
