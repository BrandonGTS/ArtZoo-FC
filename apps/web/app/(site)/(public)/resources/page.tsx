import type { Metadata } from 'next';

export const metadata: Metadata = { title: '资源导航', robots: { index: true, follow: true } };
import ResourceBrowser from '../../../../components/resources/resource-browser';
export default function ResourcesPage() {
  return <ResourceBrowser />;
}
