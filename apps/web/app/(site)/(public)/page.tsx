import type { Metadata } from 'next';
export const metadata: Metadata = { robots: { index: true, follow: true } };
import HomeContent from '../../../components/home-content';

export default function Home() {
  return <HomeContent />;
}
