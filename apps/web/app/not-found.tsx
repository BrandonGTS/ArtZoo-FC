import type { Metadata } from 'next';
export const metadata: Metadata = { title: '页面未找到', robots: { index: false, follow: false } };
import PageStatus from '../components/system/page-status';
export default function NotFound() {
  return <PageStatus title="页面未找到" message="页面可能已移动或不存在，请返回首页继续浏览。" />;
}
