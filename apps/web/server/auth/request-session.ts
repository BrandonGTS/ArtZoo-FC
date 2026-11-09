import { cache } from 'react';
import { anonymousSession } from '@artzoo/domain';
import { sessionToken } from './http';
import { getAccountService } from './runtime';
// React's request-local server cache only. Never put a session/token in a process cache.
export const requestPageSession = cache(async () => {
  const token = await sessionToken();
  return {
    hasToken: Boolean(token),
    session: token ? await getAccountService().session(token) : anonymousSession()
  };
});
