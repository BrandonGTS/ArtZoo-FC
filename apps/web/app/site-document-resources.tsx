'use client';

import { AntdRegistry } from '@ant-design/nextjs-registry';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import Providers from '../components/providers';
import { previewPages } from './preview/preview-pages';

export default function SiteDocumentResources({
  children,
  fontStylesheets
}: Readonly<{ children: ReactNode; fontStylesheets: readonly string[] }>) {
  const pathname = usePathname();
  // The development preview does not run site effects or load site fonts.
  if (process.env.NODE_ENV === 'development' && previewPages.some(({ href }) => href === pathname)) {
    return children;
  }

  return (
    <>
      {fontStylesheets.map((href) => (
        <link key={href} rel="stylesheet" href={href} precedence="default" />
      ))}
      <AntdRegistry>
        <Providers>{children}</Providers>
      </AntdRegistry>
    </>
  );
}
