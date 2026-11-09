import { SiteShellFrame } from '../../components/site-shell';

export default function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SiteShellFrame>{children}</SiteShellFrame>;
}
