'use client';
import { useEffect, useRef } from 'react';
import { useAuthSession } from '../auth-session';
import { safeReturnTo } from './api';

export default function LoginEntry({ returnTo }: { returnTo: string }) {
  const { openLogin } = useAuthSession();
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      openLogin(safeReturnTo(returnTo));
    }
  }, [openLogin, returnTo]);
  return null;
}
