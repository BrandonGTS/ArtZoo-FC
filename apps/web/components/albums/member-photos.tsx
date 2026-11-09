'use client';
import { CursorPagination } from '../collection-controls';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { useAuthSession } from '../auth-session';
import type { PhotoView } from '../../server/albums/contract';
import { PageHeading } from '../home-content';
import { MemberPaper } from '../members/member-ui';
import { ErrorNotice } from '../account/account-ui';
import { useAlbumResource } from './use-album-resource';
import './album-integration.css';
export default function MemberPhotos({ id }: { id: string }) {
  const { session } = useAuthSession();
  return session?.user ? <MemberPhotoContent key={session.user.id + ':' + id} id={id} /> : null;
}
function MemberPhotoContent({ id }: { id: string }) {
  const [page, setPage] = useState(1),
    resource = useAlbumResource<{ items: PhotoView[]; hasMore: boolean }>(
      `/api/members/${id}/photos?page=${page}`
    );
  return (
    <section className="home-section" aria-label="上传的照片">
      <PageHeading decoration="cheese">上传的照片</PageHeading>
      <MemberPaper>
        <ErrorNotice message={resource.error} />
        {resource.loading ? (
          <p role="status">正在读取照片…</p>
        ) : resource.data?.items.length ? (
          <>
            <div className="member-photo-grid">
              {resource.data.items.map((photo) => (
                <Link key={photo.id} href={`/albums/${photo.albumId}?photoId=${photo.id}`}>
                  <Image
                    unoptimized
                    src={photo.thumbnailUrl}
                    alt={photo.description || photo.originalName}
                    width={photo.width}
                    height={photo.height}
                  />
                </Link>
              ))}
            </div>
          </>
        ) : !resource.error ? (
          <p>暂无照片</p>
        ) : null}
        <CursorPagination
          page={page}
          hasMore={resource.data?.hasMore ?? false}
          loading={resource.loading}
          onPageChange={setPage}
          label="成员照片分页"
        />
      </MemberPaper>
    </section>
  );
}
