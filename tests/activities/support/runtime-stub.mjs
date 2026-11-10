let service, token;
export function setRuntime(value, session) {
  service = value;
  token = session;
}
export function getAccountService() {
  if (!service) throw Error('活动单元测试禁止使用真实数据库');
  return service;
}
export async function cookies() {
  return { get: () => (token ? { value: token } : undefined) };
}
