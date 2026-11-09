import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '内容分享',
  robots: { index: false, follow: false }
};

export default function SectionLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
