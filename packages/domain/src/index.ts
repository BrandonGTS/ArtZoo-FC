export const environmentIdentity = {
  name: 'ArtZoo Next',
  notifications: 'simulation-only'
} as const;
export type HealthState = 'ok' | 'unconfigured' | 'unavailable';
export interface DatabaseHealth {
  status: HealthState;
}
export * from './account-contract.js';
export * from './member-contract.js';
export * from './activity-contract.js';
export * from './duty-contract.js';
export * from './duty-catalog-data.js';
export * from './activity-management-contract.js';
export * from './activity-attendance-contract.js';
export * from './activity-penalty-appeal-contract.js';

export * from './message-contract.js';

export * from './activity-series-contract.js';
export * from './activity-series-management-contract.js';
export * from './activity-series-view.js';
export * from './team-contract.js';
export * from './team-cycle.js';
export * from './activity-ordinary-management-contract.js';

export * from './activity-ordinary-edit-contract.js';

export * from './lottery-contract.js';

export * from './official-event-contract.js';

export * from './admin-management-contract.js';

export * from './account-lifecycle-contract.js';

export * from './bot-management-contract.js';

export * from './bot-team-values.js';

export * from './site-help-contract.js';

export * from './qq-signup-code.js';

export * from './qq-seat-labels.js';

export {
  BEIJING_OFFSET_MS,
  toBeijingParts,
  fromBeijingParts,
  toBeijingPicker,
  fromBeijingPicker,
  beijingDateKey,
  beijingMonthKey
} from './beijing-time.js';

export * from './media-budget.js';
