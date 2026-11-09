import { qqPresetSeatLabels } from './qq-seat-labels.js';
import { dutyPresetSeats, type PartyComposition } from './duty-contract.js';
export interface BotSeatValue {
  position: number;
  groupKey: string | null;
  kind: 'ANY' | 'ROLE' | 'JOB';
  role?: string | null;
  job?: string | null;
  registration: { status: string } | null;
}
export function botTeamValues(input: {
  scene: string;
  composition?: unknown;
  seats: readonly BotSeatValue[];
}) {
  if (input.scene === 'OFFLINE') return { team: '', vacancies: '' };
  const seats = [...input.seats].sort((a, b) => a.position - b.position),
    preset = dutyPresetSeats(input.composition as PartyComposition);
  const names = new Map(
    qqPresetSeatLabels(input.composition as PartyComposition).map((label, position) => [position, label])
  );
  const requirement = (s: BotSeatValue) =>
    s.kind === 'ANY'
      ? '不限'
      : s.kind === 'JOB'
        ? (s.job ?? '')
        : ({ TANK: '防护', HEALER: '治疗', DAMAGE: '输出' }[s.role ?? ''] ?? '');
  const formatted = (selected: readonly BotSeatValue[]) => {
    if (!preset.length && selected.length > 24) {
      const groups = new Map<string, number[]>();
      for (const s of selected) {
        const key = requirement(s);
        groups.set(key, [...(groups.get(key) ?? []), s.position + 1]);
      }
      return [...groups]
        .map(([req, positions]) => {
          const runs: string[] = [];
          for (let i = 0; i < positions.length; i++) {
            const start = positions[i]!;
            let end = start;
            while (positions[i + 1] === end + 1) end = positions[++i]!;
            runs.push(start === end ? String(start) : start + '–' + end);
          }
          return '席位' + runs.join('、') + '（' + req + '）';
        })
        .join('、');
    }
    return selected
      .map(
        (s) =>
          (s.groupKey ? s.groupKey + '队 ' : '') +
          (names.get(s.position) ?? '席位' + (s.position + 1)) +
          '（' +
          requirement(s) +
          '）'
      )
      .join('、');
  };
  const empty = seats.filter((s) => s.registration?.status !== 'ACTIVE');
  const vacancies =
    input.composition === 'ALLIANCE' && empty.length
      ? ['A', 'B', 'C']
          .map(
            (group) =>
              group +
              '队：' +
              (empty
                .filter((s) => s.groupKey === group)
                .map(
                  (s) => (names.get(s.position) ?? '席位' + (s.position + 1)) + '（' + requirement(s) + '）'
                )
                .join('、') || '无空缺')
          )
          .join('\n')
      : formatted(empty);
  return { team: formatted(seats), vacancies };
}
