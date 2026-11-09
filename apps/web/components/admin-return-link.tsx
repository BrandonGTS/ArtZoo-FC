'use client';

import Link from 'next/link';
import './admin-return-link.css';

export function AdminReturnLink({ disabled = false, className }: { disabled?: boolean; className?: string }) {
  return (
    <Link
      href="/admin"
      className={['admin-return-link', className].filter(Boolean).join(' ')}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (disabled) event.preventDefault();
      }}
    >
      返回管理入口
    </Link>
  );
}
