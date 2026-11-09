import type { Metadata } from 'next';

export const metadata: Metadata = { title: '登录', robots: { index: false, follow: false } };
import HomeContent from '../../../../components/home-content';
import LoginEntry from '../../../../components/account/login-entry';
export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ returnTo?: string; completed?: string }>;
}) {
  const params = await searchParams;
  return (
    <>
      {params.completed === 'registered' ? <p role="status">注册成功，请登录。</p> : null}
      <HomeContent />
      <LoginEntry returnTo={params.returnTo ?? '/'} />
    </>
  );
}
