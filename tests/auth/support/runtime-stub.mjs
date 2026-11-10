// 测试替身：HTTP 层取得的账号服务由测试注入，任何真实数据库访问都会报错。
let injected;
export function setTestAccountService(service) {
  injected = service;
}
export function getAccountService() {
  if (!injected) throw new Error('Real database access is forbidden in isolated tests');
  return injected;
}
