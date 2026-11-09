import { AccountError } from '@artzoo/domain';
import { resolveSecurityPolicy } from '../auth/security';
export type PublicOriginEnvironment = Readonly<{
  ARTZOO_PUBLIC_ORIGIN?: string;
  ARTZOO_DEPLOYMENT_ENV?: string;
}>;
export function publicMetadataEnvironment(): PublicOriginEnvironment {
  return {
    ARTZOO_PUBLIC_ORIGIN: process.env.ARTZOO_PUBLIC_ORIGIN,
    ARTZOO_DEPLOYMENT_ENV: process.env.ARTZOO_DEPLOYMENT_ENV
  };
}

/** Public metadata has no request-origin fallback. Explicit local uses the existing loopback policy. */
export function publicMetadataOrigin(
  environment: PublicOriginEnvironment = publicMetadataEnvironment()
): URL | null {
  try {
    const publicOrigin = environment.ARTZOO_PUBLIC_ORIGIN;
    if (!publicOrigin) return null;
    const policy = resolveSecurityPolicy({
      nodeEnv: 'production',
      deploymentEnv: environment.ARTZOO_DEPLOYMENT_ENV,
      publicOrigin
    });
    return policy.origin ? new URL(policy.origin) : null;
  } catch (error) {
    if (error instanceof AccountError && error.code === 'SERVICE_UNAVAILABLE') return null;
    throw error;
  }
}
