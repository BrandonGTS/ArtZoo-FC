'use client';
import { useState } from 'react';
import { CollectionFilters } from '../collection-controls';
import { useAuthSession } from '../auth-session';
import { AdminReturnLink } from '../admin-return-link';
import { PageHeading } from '../page-heading';
import { useFeedbackMessage } from '../use-feedback-message';
import type { FeaturedPool } from '../../content/album-publicity';
import FeaturedPhotoAdmin from './featured-photo-admin';
import './public-sharing.css';
import './photos-manager.css';
export default function FeaturedManager() {
  const { session, loading } = useAuthSession(),
    actor = session?.user;
  return !loading && actor && ['ADMIN', 'SUPER_ADMIN'].includes(actor.adminRole) ? (
    <OwnedManager key={[actor.id, actor.membership, actor.adminRole].join(':')} />
  ) : null;
}
function OwnedManager() {
  const [pool, setPool] = useState<FeaturedPool>('CANDIDATE'),
    [draft, setDraft] = useState(''),
    [query, setQuery] = useState(''),
    [locked, setLocked] = useState(false);
  const { notify, contextHolder } = useFeedbackMessage();
  return (
    <main className="home-content sharing-featured-manager photos-manager" id="main-content">
      {contextHolder}
      <header className="photos-manager-heading">
        <PageHeading level={1} decoration="burger">
          相册精选
        </PageHeading>
        <AdminReturnLink disabled={locked} />
      </header>
      <CollectionFilters
        tabs={[
          { key: 'CANDIDATE', label: '备选池' },
          { key: 'SELECTED', label: '入选池' }
        ]}
        activeKey={pool}
        onTabChange={(key) => setPool(key as FeaturedPool)}
        query={draft}
        onQueryChange={setDraft}
        onSearch={(value) => setQuery(value.trim())}
        onClear={() => {
          setDraft('');
          setQuery('');
        }}
        disabled={locked}
        searchLabel="按照片说明、文件名或上传者搜索"
        placeholder="按照片说明、文件名或上传者搜索"
      />
      <FeaturedPhotoAdmin
        key={pool + ':' + query}
        pool={pool}
        query={query}
        notify={notify}
        onLock={setLocked}
      />
    </main>
  );
}
