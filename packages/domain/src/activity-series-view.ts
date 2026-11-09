import type { ActivitySummary } from './activity-contract.js';

// Future periods have no recruitable places until the first period forms its roster.
export function isAwaitingSeriesRoster(activity: Pick<ActivitySummary, 'series' | 'cancelledAt'>): boolean {
  return !activity.cancelledAt && activity.series?.state === 'RECRUITING' && activity.series.periodNumber > 1;
}
