'use client';
import { useState } from 'react';
import { Button } from 'antd';
import { PageHeading } from '../page-heading';
import { CollectionTabs } from '../collection-controls';
import FeaturedGallery from '../albums/featured-gallery';
import PublicShareList from './public-share-list';
import './public-sharing.css';
export default function PublicFeatured({ initialType }: { initialType: 'photos' | 'shares' }) {
  const [type, setType] = useState(initialType);
  return (
    <main className="home-content sharing-featured-content" id="main-content">
      <div className="sharing-section-heading">
        <PageHeading level={1} decoration="burger">
          公开精选
        </PageHeading>
        <Button href="/">返回首页</Button>
      </div>
      <CollectionTabs
        tabs={[
          { key: 'photos', label: '照片' },
          { key: 'shares', label: '活动分享' }
        ]}
        activeKey={type}
        onTabChange={(key) => setType(key as 'photos' | 'shares')}
      />
      {type === 'photos' ? <FeaturedGallery /> : <PublicShareList />}
    </main>
  );
}
