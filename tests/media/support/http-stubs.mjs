import { AccountError } from '../../../packages/domain/src/index.ts';
export { withPhotoSlot } from '../../../packages/media/src/photo-processor.ts';
export const state = {};
export function reset() {
  Object.assign(state, {
    events: [],
    quota: 0,
    checks: 0,
    parsing: 0,
    rate: 0,
    business: 0,
    decoded: 0,
    stored: 0,
    denied: false,
    exhausted: false,
    parseExhausted: false,
    denyConsume: false,
    actorId: '10000000-0000-4000-8000-000000000001'
  });
}
reset();
export const actor = () => ({
  id: 'synthetic-session',
  accountId: state.actorId,
  account: { adminRole: 'SUPER_ADMIN', membership: 'MEMBER' }
});
const limited = () => new AccountError('RATE_LIMITED', '操作过于频繁，请稍后再试', 429, undefined, 900);
export const auth = {
  db: {},
  requireAccount: async (_db, _token, admin) => {
    state.events.push(admin ? 'admin' : 'auth');
    if (state.denied) throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    return actor();
  },
  checkWriteSource: async (source) => {
    if (source !== 'untrusted-source') throw Error('unexpected bucket');
    state.events.push('check');
    state.checks++;
    if (state.exhausted) throw limited();
  },
  limitWriteParsing: async (source, id) => {
    if (source !== 'untrusted-source' || id !== state.actorId) throw Error('unexpected parser identity');
    state.events.push('parseBudget');
    state.parsing++;
    if (state.parseExhausted) throw limited();
  },
  limitWriteSource: async (source) => {
    if (source !== 'untrusted-source') throw Error('unexpected bucket');
    state.events.push('consume');
    state.quota++;
    if (state.denyConsume) throw limited();
  },
  rate: async () => {
    state.events.push('businessRate');
    state.rate++;
  }
};
export const getAccountService = () => auth;
const result = async () => {
  state.events.push('business');
  state.business++;
  return { synthetic: true };
};
class Service {
  constructor(a) {
    this.auth = a;
  }
  upload(...args) {
    return result(...args);
  }
  uploadCommentMedia(...args) {
    return result(...args);
  }
  create(...args) {
    return result(...args);
  }
  record(...args) {
    return result(...args);
  }
  appeal(...args) {
    return result(...args);
  }
  decide(...args) {
    return result(...args);
  }
  mutatePhotos(...args) {
    return result(...args);
  }
  async authorizeIconUpload() {
    await auth.requireAccount(auth.db, undefined, true);
  }
  mutateWithIcon(...args) {
    return result(...args);
  }
}
export const DailyService = Service,
  WishService = Service,
  AlbumService = Service,
  ActivityShareService = Service,
  ActivityService = Service,
  ActivitySeriesService = Service,
  ActivityManagementService = Service,
  OrdinaryActivityManagementService = Service,
  KnowledgeService = Service,
  ActivityAttendanceService = Service,
  ActivityPenaltyAppealService = Service,
  QuickLinkService = Service;
export const getKnowledgeImageService = () => new Service(auth);
export const processPhoto = async () => {
  state.events.push('decode');
  state.decoded++;
  return {};
};
export const lotteryStorage = () => ({
  put: async () => {
    state.events.push('store');
    state.stored++;
  },
  discardUncommitted: async () => {}
});
export const cookies = async () => ({ get: () => ({ value: 'synthetic-cookie' }) });
