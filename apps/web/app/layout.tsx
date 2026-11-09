import type { Metadata } from 'next';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import Providers from '../components/providers';
import 'antd/dist/reset.css';
import './globals.css';
import staticAssets from '../static-assets.json';

export const metadata: Metadata = {
  title: { default: 'ArtZoo', template: '%s · ArtZoo' },
  description: 'ArtZoo · 一起记录日常与相聚',
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        {/* Versioned, self-hosted unicode-range sheets load only needed glyph slices. */}
        {staticAssets.stylesheets.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
      </head>
      <body>
        <AntdRegistry>
          <Providers>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
