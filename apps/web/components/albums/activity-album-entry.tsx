'use client';
import { useState } from 'react';
import { Button } from 'antd';
import type { AlbumView, Category, Primary } from '../../server/albums/contract';
import { ErrorNotice } from '../account/account-ui';
import AlbumEditor from './album-editor';
import { useAlbumResource } from './use-album-resource';
// The activity owner chooses whether/where to mount this integration entry.
export default function ActivityAlbumEntry({
  activityId,
  primary,
  canCreate
}: {
  activityId: string;
  primary: Primary;
  canCreate: boolean;
}) {
  const [open, setOpen] = useState(false),
    [reload, setReload] = useState(0);
  const resource = useAlbumResource<{ album: AlbumView | null }>(
      `/api/albums/activity/${activityId}?refresh=${reload}`
    ),
    categories = useAlbumResource<{ items: Category[] }>(open ? '/api/albums/categories' : null);
  return (
    <>
      <ErrorNotice message={resource.error ?? categories.error} />
      {resource.data?.album ? (
        <Button href={`/albums/${resource.data.album.id}?periodActivityId=${activityId}`}>进入相册</Button>
      ) : resource.data && canCreate ? (
        <Button onClick={() => setOpen(true)}>创建关联相册</Button>
      ) : null}
      {open ? (
        <AlbumEditor
          categories={categories.data?.items ?? []}
          activity={{ id: activityId, primary }}
          close={() => setOpen(false)}
          saved={() => {
            setOpen(false);
            setReload((v) => v + 1);
          }}
        />
      ) : null}
    </>
  );
}
