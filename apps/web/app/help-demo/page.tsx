import type { Metadata } from 'next';

export const metadata: Metadata = { title: '使用帮助演示', robots: { index: false, follow: false } };
import DemoPage from '../../components/site-help/demo-page';
export default function HelpDemoPage() {
  return <DemoPage />;
}
