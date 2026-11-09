'use client';

import HomeActivities from './home-activities';
import DailySection from './daily/daily-section';
import { useAuthSession } from './auth-session';
import HomeWishes from './wishes/home-wishes';

import GuestHome from './public-sharing/guest-home';
import { PageHeading } from './page-heading';
export { PageHeading } from './page-heading';

export default function HomeContent() {
  const { session, loading } = useAuthSession();
  if (loading)
    return (
      <main className="home-content" id="main-content" aria-busy="true">
        <p role="status">正在读取首页…</p>
      </main>
    );
  if (!session?.user) return <GuestHome />;
  return (
    <main className="home-content home-main-content" id="main-content">
      <div className="home-public-entry">
        <PageHeading level={1} decoration="burger">
          首页
        </PageHeading>
      </div>
      <section className="home-section" aria-labelledby="activities-heading">
        <div id="activities-heading">
          <PageHeading decoration="tomato">近期可参与活动</PageHeading>
        </div>
        <div className="activity-grid">
          <HomeActivities />
        </div>
      </section>
      <div className="home-secondary">
        <DailySection title="日常动态" decoration="cheese" interactivePreview />
        <section className="home-section" aria-labelledby="wishes-heading">
          <HomeWishes />
        </section>
      </div>
    </main>
  );
}
