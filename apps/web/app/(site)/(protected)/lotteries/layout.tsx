import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '抽奖',
  robots: { index: false, follow: false }
};

export default function SectionLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
