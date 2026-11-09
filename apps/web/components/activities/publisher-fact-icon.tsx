// Local reuse of accepted home fact icons; home source stays unchanged.
export function PublisherFactIcon({ kind }: { kind: 'period' | 'duty' | 'location' }) {
  return (
    <svg
      className="home-activity-fact-icon"
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.67"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'period' ? (
        <>
          <path d="M3 4h14v13H3zM6 2v4M14 2v4M3 8h14M7 11h6M7 14h4" />
        </>
      ) : null}
      {kind === 'duty' ? (
        <>
          <path d="M3 17h14M5 17V6l5-3 5 3v11M8 17v-5h4v5M8 7h.01M12 7h.01" />
        </>
      ) : null}
      {kind === 'location' ? (
        <>
          <path d="M16 8c0 4-6 9-6 9S4 12 4 8a6 6 0 1 1 12 0Z" />
          <circle cx="10" cy="8" r="2" />
        </>
      ) : null}
    </svg>
  );
}
