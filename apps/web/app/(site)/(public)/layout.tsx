import { SiteShellContent } from '../../../components/site-shell';

export default function PublicLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SiteShellContent>{children}</SiteShellContent>;
}
