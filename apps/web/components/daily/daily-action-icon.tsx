export default function DailyActionIcon({ kind, active }: { kind: 'reply' | 'like'; active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="27"
      height="27"
      viewBox="0 0 24 24"
      fill={active ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'reply' ? (
        <>
          <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
          <path
            className={active ? 'daily-action-icon-detail' : undefined}
            d="M8 11h.01M12 11h.01M16 11h.01"
          />
        </>
      ) : (
        <>
          <path d="M7 10v11H3V10h4ZM7 10l5-8a3 3 0 0 1 2 3l-1 5h6a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7" />
        </>
      )}
    </svg>
  );
}
