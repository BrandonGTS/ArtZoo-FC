'use client';
import { useState } from 'react';
import { Empty, Spin } from 'antd';
import { PageHeading } from '../home-content';
import { ErrorNotice } from '../account/account-ui';
import { useResourceCatalog } from './use-resource-catalog';
import { CollectionTabs } from '../collection-controls';
import './resources.css';
export default function ResourceBrowser() {
  const [category, setCategory] = useState(''),
    catalog = useResourceCatalog(category);
  return (
    <main id="main-content" className="home-content resource-content">
      <PageHeading level={1} decoration="burger">
        常用资源
      </PageHeading>
      <div className="resource-filters" aria-label="资源分类">
        <CollectionTabs
          tabs={[
            { key: '', label: '全部' },
            ...(catalog?.categories ?? []).map((c) => ({ key: c.id, label: c.name }))
          ]}
          activeKey={category}
          onTabChange={setCategory}
        />
      </div>
      {!catalog || catalog.loading ? (
        <Spin />
      ) : catalog.error ? (
        <ErrorNotice message={catalog.error} />
      ) : catalog.items.length ? (
        <div className="resource-list">
          {catalog.items.map((resource) => (
            <article key={resource.id} className="resource-row">
              <div className="resource-title-row">
                <a href={resource.url} target="_blank" rel="noopener noreferrer">
                  {resource.name}
                </a>
                <span className="resource-category">{resource.categoryName}</span>
              </div>
              <p>{resource.purpose}</p>
            </article>
          ))}
        </div>
      ) : (
        <Empty description="暂无资源" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </main>
  );
}
