'use client';
import Image from 'next/image';
import { Button, Card } from 'antd';
import type { PublicActivityShare } from '@artzoo/domain';
import { PageHeading } from '../page-heading';
import { ErrorNotice } from '../account/account-ui';
import { useSharingResource } from './sharing-api';
import './public-sharing.css';
export default function SharePublicDetail({ id }: { id: string }) {
  const resource = useSharingResource<PublicActivityShare>('/api/activity-shares/' + id);
  return (
    <main className="home-content" id="main-content">
      <div className="sharing-section-heading">
        <PageHeading level={1} decoration="burger">
          活动分享
        </PageHeading>
        <Button href="/featured?type=shares">返回活动分享</Button>
      </div>
      <ErrorNotice message={resource.error} />
      {resource.loading ? <p role="status">正在读取活动分享…</p> : null}
      {resource.data ? (
        <Card
          variant="borderless"
          classNames={{ root: 'paper-panel paper-activity public-share-detail', body: 'sharing-detail-body' }}
        >
          <h2>{resource.data.title}</h2>
          <p className="sharing-body">{resource.data.body}</p>
          <div className="sharing-public-media">
            {resource.data.media.map((media) => (
              <Image
                unoptimized
                key={media.id}
                src={media.previewUrl}
                width={media.width}
                height={media.height}
                alt={resource.data!.title}
              />
            ))}
          </div>
        </Card>
      ) : null}
    </main>
  );
}
