import { fromBeijingPicker, toBeijingPicker } from '@artzoo/domain';

/** Keep existing +08 payload spelling, including malformed picker text for the existing validators. */
export function beijingPickerOffset(wall: string): string {
  try {
    const precision = wall.includes('.') ? 'millisecond' : wall.length > 16 ? 'second' : 'minute';
    return toBeijingPicker(fromBeijingPicker(wall), precision).slice(0, wall.length) + '+08:00';
  } catch {
    return wall + '+08:00';
  }
}
/** Existing numeric picker checks use NaN on invalid values, rather than throwing during render/effects. */
export function beijingPickerTimestamp(wall: string): number {
  try {
    return fromBeijingPicker(wall).getTime();
  } catch {
    return Date.parse(beijingPickerOffset(wall));
  }
}
