export default function DailyToolbarIcon({ kind }: { kind: 'photo' | 'mention' | 'emoji' | 'server' }) {
  return (
    <svg
      aria-hidden="true"
      width={kind === 'server' ? 16 : 22}
      height={kind === 'server' ? 16 : 22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'photo' ? (
        <>
          <path d="M13 20H3V4h18v9" />
          <circle cx="16" cy="8" r="2" />
          <path d="m3 16 5-5 5 5 3-3M19 16v6M16 19h6" />
        </>
      ) : null}
      {kind === 'mention' ? (
        <>
          <circle cx="11" cy="12" r="4" />
          <path d="M15 8v7a2 2 0 0 0 4 0v-3a8 8 0 1 0-3.3 6.5" />
        </>
      ) : null}
      {kind === 'emoji' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M8 14s1 3 4 3 4-3 4-3M8 9h.01M16 9h.01" />
        </>
      ) : null}
      {kind === 'server' ? (
        <>
          <path
            fill="currentColor"
            stroke="none"
            d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 10a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"
          />
        </>
      ) : null}
    </svg>
  );
}
