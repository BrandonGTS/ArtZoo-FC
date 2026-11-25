import type { SiteHelpLessonId } from '@artzoo/domain';

export default function LessonIcon({ lessonId }: { lessonId: SiteHelpLessonId }) {
  const paths = {
    home: 'm3 10 9-7 9 7v10H3V10M9 20v-7h6v7',
    albums: 'M3 4h18v16H3V4m0 12 6-6 5 5 3-3 4 4M16 8h.01',
    daily: 'M4 4h16v12H9l-5 4V4m4 4h8m-8 4h5',
    activities: 'M4 6h16v15H4V6m0 5h16M8 3v6m8-6v6',
    wishes: 'M12 21 3 12a5 5 0 0 1 9-6 5 5 0 0 1 9 6L12 21',
    lotteries: 'M3 8h18v13H3V8M2 4h20v4H2V4M12 4v17',
    knowledge: 'M12 6C8 3 4 4 3 5v15c3-2 6-1 9 1m0-15c4-3 8-2 9-1v15c-3-2-6-1-9 1V6'
  };
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[lessonId]} />
    </svg>
  );
}
