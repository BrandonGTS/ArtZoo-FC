'use client';
import { CursorPagination } from '../collection-controls';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { Button, Card } from 'antd';
import type { PhotoView } from '../../server/albums/contract';
import { ErrorNotice } from '../account/account-ui';
import Modal from './album-modal';
import { useSharingResource } from '../public-sharing/sharing-api';
import HomeCardSurface from '../home-card-surface';
import './albums.css';
import './album-integration.css';
import '../public-sharing/public-sharing.css';
type Featured = Pick<
  PhotoView,
  'id' | 'albumId' | 'description' | 'width' | 'height' | 'previewUrl' | 'thumbnailUrl'
>;
export default function FeaturedGallery({ limit }: { limit?: number }) {
  const [page, setPage] = useState(1),
    resource = useSharingResource<{ items: Featured[]; hasMore: boolean }>(
      '/api/albums/featured?page=' + page
    ),
    [photo, setPhoto] = useState<Featured | null>(null);
  const items = limit ? (resource.data?.items ?? []).slice(0, limit) : (resource.data?.items ?? []);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const activePhoto = photo ? (resource.data?.items.find((item) => item.id === photo.id) ?? null) : null;
  if (photo && !resource.loading && !activePhoto) setPhoto(null);
  useEffect(() => {
    if (activePhoto || !previewTrigger.current) return;
    const trigger = previewTrigger.current;
    previewTrigger.current = null;
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  }, [activePhoto]);
  return (
    <>
      <ErrorNotice message={resource.error} />
      {resource.loading ? (
        <p role="status">正在读取精选照片…</p>
      ) : items.length ? (
        <div className="featured-gallery sharing-featured-gallery">
          {items.map((item) => (
            <HomeCardSurface
              key={item.id}
              motionProfile="feed"
              navigation="links"
              interactionPaused={Boolean(activePhoto)}
            >
              <Card
                variant="borderless"
                classNames={{
                  root: 'paper-panel paper-activity sharing-photo-card',
                  body: 'sharing-photo-card-body'
                }}
              >
                <Button
                  type="text"
                  className="featured-photo-button"
                  aria-label={item.description || '查看精选照片'}
                  onClick={(event) => {
                    if (event.currentTarget instanceof HTMLButtonElement)
                      previewTrigger.current = event.currentTarget;
                    setPhoto(item);
                  }}
                >
                  <Image
                    unoptimized
                    src={item.thumbnailUrl}
                    alt={item.description || '精选照片'}
                    width={item.width}
                    height={item.height}
                  />
                </Button>
                <h3>{item.description || '精选照片'}</h3>
              </Card>
            </HomeCardSurface>
          ))}
        </div>
      ) : !resource.error ? (
        <p>暂无精选照片</p>
      ) : null}
      {!limit ? (
        <CursorPagination
          page={page}
          hasMore={resource.data?.hasMore ?? false}
          loading={resource.loading}
          onPageChange={setPage}
          label="精选照片分页"
        />
      ) : null}
      {activePhoto ? (
        <Modal
          open
          title={activePhoto.description || '精选照片'}
          footer={null}
          onCancel={() => setPhoto(null)}
          width={1120}
          className="album-modal sharing-featured-preview-modal"
        >
          <Image
            className="featured-preview-image"
            unoptimized
            src={activePhoto.previewUrl}
            alt={activePhoto.description || '精选照片'}
            width={activePhoto.width}
            height={activePhoto.height}
          />
        </Modal>
      ) : null}
    </>
  );
}
