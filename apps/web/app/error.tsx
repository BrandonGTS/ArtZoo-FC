'use client';
import PageStatus from '../components/system/page-status';
type Props = { error: unknown; reset: () => void; retry?: () => void };
export default function RouteError({ reset, retry }: Props) {
  return <PageStatus title="页面暂时无法显示" message="请稍后重试，或返回首页。" retry={retry ?? reset} />;
}
