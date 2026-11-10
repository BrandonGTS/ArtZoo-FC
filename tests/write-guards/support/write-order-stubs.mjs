export const state = { quota: 0, accounts: 0, rate: 0 };
export const actor = {
  id: 'synthetic-session',
  accountId: '10000000-0000-4000-8000-000000000001',
  account: { adminRole: 'SUPER_ADMIN', membership: 'MEMBER' }
};
export const auth = {
  db: {},
  requireAccount: async () => {
    state.accounts++;
    return actor;
  },
  limitWriteSource: async () => {
    state.quota++;
  },
  checkWriteSource: async () => {},
  limitWriteParsing: async () => {},
  rate: async () => {
    state.rate++;
  }
};
export const getAccountService = () => auth;
class Service {
  constructor(a) {
    this.auth = a;
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
  ActivityPenaltyAppealService = Service;
export const getKnowledgeImageService = () => new Service(auth);
export const withPhotoSlot = (fn) => fn();
export const processPhoto = () => {
  throw Error('unexpected decoder access');
};
export const lotteryStorage = () => {
  throw Error('unexpected storage access');
};
export const cookies = async () => ({ get: () => ({ value: 'a'.repeat(43) }) });
