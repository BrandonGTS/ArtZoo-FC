import { toBeijingPicker } from '@artzoo/domain';
import { beijingPickerOffset } from '../beijing-picker';
/** Preserve the original instant when the minute-only picker was not changed. */
export function serializeOrdinaryEditTime(minute: string, original: string): string {
  const beijing = beijingPickerOffset(toBeijingPicker(new Date(original), 'millisecond'));
  return minute === beijing.slice(0, 16) ? beijing : minute;
}
