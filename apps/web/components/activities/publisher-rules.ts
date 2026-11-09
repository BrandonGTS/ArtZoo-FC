import { ACTIVITY_JOBS, type ActivityRole, type DutySeatTemplate } from '@artzoo/domain';

export function repeatedWeekdays(manual: readonly number[], automatic: number | null): number[] {
  return [...new Set([...manual, ...(automatic === null ? [] : [automatic])])].sort((a, b) => a - b);
}
export function manualWeekdaysAfterSelection(
  selected: readonly number[],
  manual: readonly number[],
  automatic: number | null
): number[] {
  return repeatedWeekdays(
    selected.filter((day) => day !== automatic),
    automatic !== null && manual.includes(automatic) ? automatic : null
  );
}
export function templateSeatRole(
  template: readonly DutySeatTemplate[],
  index: number
): ActivityRole | undefined {
  const requirement = template[index]?.requirement;
  return requirement?.kind === 'ROLE' ? requirement.role : undefined;
}

export function allowedSeatJobs(role?: ActivityRole): string[] {
  return ACTIVITY_JOBS.filter((job) => !role || job.role === role).map((job) => job.name);
}
