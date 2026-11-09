'use client';
import { useState } from 'react';
import { Button, Card } from 'antd';
import { PageHeading } from '../page-heading';
import GuestFeaturedCarousel from './guest-featured-carousel';
import GuestContactForm from '../guest-contact/contact-form';
import Modal from '../albums/album-modal';
import '../albums/albums.css';
import './public-sharing.css';
export default function GuestHome() {
  const [contactOpen, setContactOpen] = useState(false),
    [contactMounted, setContactMounted] = useState(false);
  return (
    <main className="home-content sharing-guest-home" id="main-content">
      <PageHeading level={1} decoration="burger">
        欢迎来到 ArtZoo
      </PageHeading>
      <Card
        variant="borderless"
        classNames={{
          root: 'paper-panel paper-activity public-introduction',
          body: 'public-introduction-body'
        }}
      >
        <div>
          <PageHeading decoration="tomato">一起玩，也一起留下回忆</PageHeading>
          <p>这里是我们的小小部队社区。</p>
          <p>分享游戏里的相遇、合照与故事，也欢迎相同爱好的新伙伴。</p>
        </div>
        <div className="public-contact">
          <h3>认识我们</h3>
          <p>想聊聊加入部队？留下联系方式和留言。</p>
          <Button
            type="primary"
            onClick={() => {
              setContactMounted(true);
              setContactOpen(true);
            }}
          >
            联系我们
          </Button>
        </div>
      </Card>
      <section className="home-section">
        <div className="sharing-section-heading">
          <PageHeading decoration="cheese">精选照片</PageHeading>
        </div>
        <GuestFeaturedCarousel />
      </section>
      {/* Mount the portal on first use, then retain the existing draft across close/reopen. */}
      {contactMounted ? (
        <Modal
          open={contactOpen}
          title="联系我们"
          footer={null}
          width={480}
          onCancel={() => setContactOpen(false)}
          forceRender
          destroyOnHidden={false}
          className="album-modal guest-contact-modal"
        >
          <GuestContactForm onSubmitted={() => setContactOpen(false)} />
        </Modal>
      ) : null}
    </main>
  );
}
