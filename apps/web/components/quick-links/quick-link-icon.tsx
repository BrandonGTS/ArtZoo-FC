'use client';
import { useState } from 'react';
import Image from 'next/image';
export function QuickLinkDefaultIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18" />
    </svg>
  );
}
export default function QuickLinkIcon({ src }: { src: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="quick-link-icon">
      {src && failed !== src ? (
        <Image src={src} alt="" width={24} height={24} unoptimized onError={() => setFailed(src)} />
      ) : (
        <QuickLinkDefaultIcon />
      )}
    </span>
  );
}
