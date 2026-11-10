import { AccountError } from '@artzoo/domain';
export const state = {};
export function reset() {
  Object.assign(state, {
    token: 'synthetic-session-token',
    accountId: 'synthetic-account',
    events: [],
    consumed: [],
    checked: [],
    parsing: [],
    uploaded: [],
    submitted: [],
    processed: [],
    listed: [],
    failCheck: false,
    failParsing: false,
    failConsume: false,
    denyAccount: false
  });
}
reset();
const limited = () => new AccountError('RATE_LIMITED', '操作过于频繁，请稍后再试', 429, undefined, 37);
export const cookies = async () => ({ get: () => (state.token ? { value: state.token } : undefined) });
export const auth = {
  db: {},
  async requireAccount(_db, token) {
    state.events.push('authorize');
    if (!token || state.denyAccount) throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    return { accountId: state.accountId };
  },
  async rate(key, limit, seconds) {
    state.events.push('avatar-own-budget');
    state.privateRate = { key, limit, seconds };
  },
  async checkWriteSource(source, token) {
    state.events.push('check');
    state.checked.push({ source, token });
    if (state.failCheck) throw limited();
  },
  async limitWriteParsing(source, accountId) {
    state.events.push('parse-budget');
    state.parsing.push({ source, accountId });
    if (state.failParsing) throw limited();
  },
  async limitWriteSource(source, token) {
    state.events.push('consume');
    state.consumed.push({ source, token });
    if (state.failConsume) throw limited();
  }
};
export const getAccountService = () => auth;
export class AvatarService {
  constructor(value) {
    this.auth = value;
  }
  async authorizeUpload(token) {
    const session = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`avatar:${session.accountId}`, 10, 900);
    return session.accountId;
  }
  async upload(...args) {
    state.events.push('upload');
    state.uploaded.push(args);
    return { uploaded: true };
  }
}
export class GuestContactService {
  async submit(body) {
    state.events.push('submit');
    state.submitted.push(body);
    return { submitted: true };
  }
  async process(id, body, token) {
    state.events.push('process');
    state.processed.push({ id, body, token });
    return { processed: true };
  }
  async list(url, token) {
    state.events.push('list');
    state.listed.push({ url: url.href, token });
    return { items: [] };
  }
}
