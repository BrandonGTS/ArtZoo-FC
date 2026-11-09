'use client';
import { createContext } from 'react';
import type { AuthSnapshot, AuthStore } from './auth-session-store';
export type AuthActions = {
  refresh(): Promise<void>;
  passwordResetCompleted(): Promise<void>;
  openLogin(returnTo?: string): void;
  logout(): Promise<boolean>;
};
export const AuthStoreContext = createContext<({ store: AuthStore } & AuthActions) | null>(null);
// Request-only hydration input, never another store or an independent identity owner.
export const AuthServerSnapshotContext = createContext<AuthSnapshot | null>(null);
