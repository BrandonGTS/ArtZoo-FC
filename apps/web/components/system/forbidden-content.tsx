'use client';
import { Button, Result } from 'antd';
import type { ResultRef } from 'antd';
import '../../app/forbidden.css';

// AntD 6.6.5's built-in 403 SVG has a 251x294 viewport but no viewBox.
// Add its native coordinate system before paint so the local width limit scales it.
function sizeIllustration(result: ResultRef | null) {
  result?.nativeElement.querySelector('svg')?.setAttribute('viewBox', '0 0 251 294');
}

export default function ForbiddenContent({
  title = '没有管理权限',
  subTitle = '当前账号没有此页面的管理权限。'
}: {
  title?: string;
  subTitle?: string;
}) {
  return (
    <main className="home-content">
      <Result
        ref={sizeIllustration}
        className="site-forbidden-result"
        classNames={{ icon: 'site-forbidden-illustration' }}
        status="403"
        title={title}
        subTitle={subTitle}
        extra={
          <Button href="/" type="primary">
            返回首页
          </Button>
        }
      />
    </main>
  );
}
