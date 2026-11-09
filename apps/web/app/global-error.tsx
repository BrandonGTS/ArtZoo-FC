'use client';
import PageStatus from '../components/system/page-status';
export default function GlobalError() {
  return (
    <html lang="zh-CN">
      <head>
        <title>页面暂时无法显示 · ArtZoo</title>
      </head>
      <body
        style={{ margin: 0, background: '#f9f3df', color: '#24372b', fontFamily: 'system-ui, sans-serif' }}
      >
        <PageStatus
          title="页面暂时无法显示"
          message="请稍后重试，或返回首页。"
          retry={() => window.location.reload()}
          standalone
        />
      </body>
    </html>
  );
}
