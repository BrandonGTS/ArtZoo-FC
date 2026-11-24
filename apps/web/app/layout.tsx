import type { Metadata } from 'next';
import 'antd/dist/reset.css';
import './globals.css';
import SiteDocumentResources from './site-document-resources';
import staticAssets from '../static-assets.json';

export const metadata: Metadata = {
  title: { default: 'ArtZoo', template: '%s · ArtZoo' },
  description: 'ArtZoo · 一起记录日常与相聚',
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <SiteDocumentResources fontStylesheets={staticAssets.stylesheets}>{children}</SiteDocumentResources>
      </body>
    </html>
  );
}
