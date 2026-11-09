import { dutyPresetSeats, type PartyComposition } from './duty-contract.js';

/** Website preset position labels; actual requirements may be customized separately. */
export function qqPresetSeatLabels(composition: PartyComposition): string[] {
  const counts = new Map<string, number>();
  return dutyPresetSeats(composition).map((seat) => {
    if (seat.requirement.kind !== 'ROLE') return '';
    const role = seat.requirement.role,
      key = `${seat.groupKey ?? ''}:${role}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    return role === 'TANK'
      ? composition === 'FULL'
        ? ordinal === 1
          ? 'MT'
          : 'ST'
        : 'T'
      : role === 'HEALER'
        ? composition === 'LIGHT'
          ? 'H'
          : `H${ordinal}`
        : `D${ordinal}`;
  });
}
