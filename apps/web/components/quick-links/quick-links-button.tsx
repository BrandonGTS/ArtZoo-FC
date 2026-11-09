'use client';
import { useEffect, useRef, type ReactNode, type ComponentRef } from 'react';
import { FloatButton, Popover, Button } from 'antd';
import type { QuickLinkList } from '../../server/quick-links/contract';
import { useSharingResource } from '../public-sharing/sharing-api';
import { CollectionSearch, ListPagination } from '../collection-controls';
import { useQuickLinkRevision } from './quick-link-data';
import { useQuickLinksState } from './quick-links-state';
import QuickLinkIcon from './quick-link-icon';
import './quick-links.css';
export default function QuickLinksButton({ icon }: { icon: ReactNode }) {
  const { open, setOpen, input, setInput, query, setQuery, page, setPage, size, activation, setActivation } =
    useQuickLinksState();
  const button = useRef<ComponentRef<typeof FloatButton>>(null),
    revision = useQuickLinkRevision();
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
    };
  }, [open, setOpen]);
  const resource = useSharingResource<QuickLinkList>(
    open
      ? `/api/quick-links?page=${page}&pageSize=${size}&query=${encodeURIComponent(query)}&fresh=${activation}-${revision}`
      : null
  );
  const data = resource.data;
  const change = (next: boolean) => {
    setOpen(next);
    if (next) setActivation((value) => value + 1);
  };
  const search = (value: string) => {
    setQuery(value.trim());
    setPage(1);
    setActivation((value) => value + 1);
  };
  const content = (
    <section className="quick-links-panel" role="dialog" aria-label="快捷入口面板">
      <CollectionSearch
        query={input}
        onQueryChange={setInput}
        onSearch={search}
        onClear={() => {
          setInput('');
          search('');
        }}
        searchLabel="搜索快捷入口"
        placeholder="搜索网站"
      />
      <div className="quick-links-items" aria-busy={resource.loading}>
        {resource.loading ? (
          <p role="status">正在读取…</p>
        ) : resource.error ? (
          <>
            <p role="alert">{resource.error}</p>
            <Button type="text" onClick={() => setActivation((value) => value + 1)}>
              重新读取
            </Button>
          </>
        ) : data?.items.length ? (
          data.items.map((item) => (
            <a
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="quick-link-item"
            >
              <QuickLinkIcon src={item.icon} />
              <span title={item.name}>{item.name}</span>
            </a>
          ))
        ) : (
          <p>暂无快捷入口</p>
        )}
      </div>
      {data && !resource.error ? (
        <ListPagination
          page={data.page}
          totalPages={data.totalPages}
          loading={resource.loading}
          onPageChange={setPage}
          label="快捷入口分页"
        />
      ) : null}
    </section>
  );
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={change}
      placement="leftBottom"
      arrow={false}
      content={content}
      zIndex={90}
      destroyOnHidden
      classNames={{ root: 'quick-links-popover' }}
      styles={{
        container: {
          padding: 16,
          boxShadow: 'none',
          background: 'var(--artzoo-surface)',
          border: '1px solid var(--artzoo-line)'
        }
      }}
    >
      <FloatButton
        ref={button}
        aria-label="快捷入口"
        aria-expanded={open}
        aria-haspopup="dialog"
        icon={icon}
      />
    </Popover>
  );
}
