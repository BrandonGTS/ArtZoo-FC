import { AccountError } from '@artzoo/domain';
export interface SecurityEnvironment {
  nodeEnv?: string;
  deploymentEnv?: string;
  publicOrigin?: string;
}
export interface SecurityPolicy {
  origin: string | null;
  secure: boolean;
  cookieName: string;
}
function configurationError(): never {
  throw new AccountError('SERVICE_UNAVAILABLE', '网站来源配置无效或尚未配置', 503);
}
function canonicalOrigin(value?: string): URL {
  if (!value) configurationError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    configurationError();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) configurationError();
  return url;
}
export function resolveSecurityPolicy(environment: SecurityEnvironment, requestUrl?: string): SecurityPolicy {
  const { nodeEnv, deploymentEnv, publicOrigin } = environment;
  if (deploymentEnv && !['local', 'production'].includes(deploymentEnv)) configurationError();
  if (deploymentEnv === 'local') {
    const url = canonicalOrigin(publicOrigin);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) configurationError();
    const secure = url.protocol === 'https:';
    return { origin: url.origin, secure, cookieName: secure ? '__Host-artzoo-session' : 'artzoo-session' };
  }
  if (deploymentEnv === 'production' || nodeEnv === 'production') {
    const url = canonicalOrigin(publicOrigin);
    if (url.protocol !== 'https:') configurationError();
    return { origin: url.origin, secure: true, cookieName: '__Host-artzoo-session' };
  }
  const url = publicOrigin ? canonicalOrigin(publicOrigin) : requestUrl ? new URL(requestUrl) : null;
  return { origin: url?.origin ?? null, secure: url?.protocol === 'https:', cookieName: 'artzoo-session' };
}
export function securityPolicy(requestUrl?: string): SecurityPolicy {
  return resolveSecurityPolicy(
    {
      nodeEnv: process.env.NODE_ENV,
      deploymentEnv: process.env.ARTZOO_DEPLOYMENT_ENV,
      publicOrigin: process.env.ARTZOO_PUBLIC_ORIGIN
    },
    requestUrl
  );
}
