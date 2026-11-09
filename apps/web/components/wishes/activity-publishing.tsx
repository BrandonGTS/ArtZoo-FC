'use client';
import { createContext, useContext } from 'react';
import type { ActivityWriteResult, CreateActivityInput } from '@artzoo/domain';
import { accountRequest } from '../account/api';
interface WishPublishing {
  id: string;
  title: string;
  body: string;
}
const Context = createContext<WishPublishing | null>(null);
export function WishPublishingProvider({
  wish,
  children
}: {
  wish: WishPublishing;
  children: React.ReactNode;
}) {
  return <Context.Provider value={wish}>{children}</Context.Provider>;
}
export function useWishPublishing() {
  return useContext(Context);
}
export function publishWishActivity(wishId: string, input: CreateActivityInput) {
  return accountRequest<ActivityWriteResult>('/api/wishes/' + encodeURIComponent(wishId) + '/convert', {
    method: 'POST',
    body: { activity: input }
  });
}
