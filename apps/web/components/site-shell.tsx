import Image from 'next/image';
import SiteHeader from './site-header';
import SiteFloatButtons from './site-float-buttons';
import AnnouncementBar from './announcements/announcement-bar';
import './site-shell.css';

export function SiteShellFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="artzoo-site">
      <a className="site-skip-link" href="#site-main-content">
        跳至正文
      </a>
      <div className="site-backdrop" aria-hidden>
        <div className="backdrop-paper" />
        <div className="backdrop-animals" />
        <Image
          className="book-cart"
          src="/artzoo/book-cart-v2.png"
          alt=""
          width={2172}
          height={724}
          sizes="(max-width: 600px) 55vw, 432px"
          aria-hidden
        />
      </div>
      <AnnouncementBar />
      {children}
    </div>
  );
}

export function SiteShellContent({
  children,
  navigationPath
}: {
  children: React.ReactNode;
  navigationPath?: string;
}) {
  return (
    <>
      <SiteHeader navigationPath={navigationPath} />
      <div id="site-main-content" tabIndex={-1}>
        {children}
      </div>
      <SiteFloatButtons />
    </>
  );
}

export default function SiteShell({
  children,
  navigationPath
}: {
  children: React.ReactNode;
  navigationPath?: string;
}) {
  return (
    <SiteShellFrame>
      <SiteShellContent navigationPath={navigationPath}>{children}</SiteShellContent>
    </SiteShellFrame>
  );
}
