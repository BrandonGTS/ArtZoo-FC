'use client';
import { AuthFallbackBootstrap } from '../components/auth-server-snapshot';
import SiteShell from '../components/site-shell';
import ForbiddenContent from '../components/system/forbidden-content';

export default function Forbidden({ title, subTitle }: { title?: string; subTitle?: string }) {
  return (
    <>
      <AuthFallbackBootstrap />
      <SiteShell>
        <ForbiddenContent title={title} subTitle={subTitle} />
      </SiteShell>
    </>
  );
}
