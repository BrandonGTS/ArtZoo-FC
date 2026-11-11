'use client';
import { Button } from 'antd';
import { PageHeading } from '../page-heading';
import FeaturedGallery from '../albums/featured-gallery';
import './public-sharing.css';
export default function PublicFeatured() {
  return (
    <main className="home-content sharing-featured-content" id="main-content">
      <div className="sharing-section-heading">
        <PageHeading level={1} decoration="burger">
          公开精选
        </PageHeading>
        <Button href="/">返回首页</Button>
      </div>
      <FeaturedGallery />
    </main>
  );
}
