let injected;
export function setTestAccountService(value) {
  injected = value;
}
export function getAccountService() {
  if (!injected) throw Error('Real database forbidden in isolated Phase 3 tests');
  return injected;
}
