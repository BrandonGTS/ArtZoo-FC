'use client';

import type { ReactNode } from 'react';
import { Button, Input, Tabs } from 'antd';
import type { ButtonProps } from 'antd';
import './collection-controls.css';
import { paginationViewportProps } from './pagination-viewport';

export interface CollectionTabsProps {
  tabs: { key: string; label: ReactNode; disabled?: boolean }[];
  activeKey: string;
  onTabChange(key: string): void;
  disabled?: boolean;
  className?: string;
  variant?: 'primary' | 'secondary';
}
export interface CollectionSearchProps {
  query: string;
  onQueryChange(value: string): void;
  onSearch(value: string): void;
  onClear(): void;
  searchLabel: string;
  placeholder: string;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
  id?: string;
}
export interface CollectionFiltersProps extends CollectionTabsProps, CollectionSearchProps {}

function TabsControl({ tabs, activeKey, onTabChange, disabled = false }: CollectionTabsProps) {
  return (
    <Tabs
      className="collection-tabs"
      activeKey={activeKey}
      type="line"
      animated={{ inkBar: true, tabPane: false }}
      indicator={{ align: 'center' }}
      classNames={{
        header: 'collection-tabs-header',
        indicator: 'collection-tabs-indicator',
        body: 'collection-tabs-body'
      }}
      items={disabled ? tabs.map((tab) => ({ ...tab, disabled: true })) : tabs}
      onChange={(key) => {
        if (!disabled) onTabChange(key);
      }}
    />
  );
}
export function CollectionTabs({ className, variant = 'primary', ...props }: CollectionTabsProps) {
  return (
    <div
      className={[
        'collection-filterbar',
        variant === 'secondary' && 'collection-filterbar-secondary',
        className
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <TabsControl {...props} />
    </div>
  );
}
export function CollectionSearch({
  query,
  onQueryChange,
  onSearch,
  onClear,
  searchLabel,
  placeholder,
  disabled = false,
  maxLength = 100,
  className,
  id
}: CollectionSearchProps) {
  return (
    <div className={['collection-search', className].filter(Boolean).join(' ')}>
      <Input.Search
        autoComplete="off"
        id={id}
        aria-label={searchLabel}
        placeholder={placeholder}
        value={query}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => onQueryChange(event.target.value)}
        onSearch={onSearch}
        allowClear={{
          clearIcon: (
            <span className="collection-search-clear" aria-label="清空搜索">
              ×
            </span>
          )
        }}
        onClear={onClear}
      />
    </div>
  );
}
export function CollectionFilters({
  tabs,
  activeKey,
  onTabChange,
  disabled = false,
  className,
  ...search
}: CollectionFiltersProps) {
  return (
    <div className={['collection-filterbar', className].filter(Boolean).join(' ')}>
      <TabsControl tabs={tabs} activeKey={activeKey} onTabChange={onTabChange} disabled={disabled} />
      <CollectionSearch {...search} disabled={disabled} />
    </div>
  );
}

/** Pure shared pagination arrow; callers own positioning and navigation behavior. */
export function PageArrowButton({
  direction,
  label = direction === 'previous' ? '上一页' : '下一页',
  ...props
}: Pick<ButtonProps, 'disabled' | 'onClick'> & { direction: 'previous' | 'next'; label?: string }) {
  return (
    <Button
      type="text"
      aria-label={label}
      {...props}
      icon={
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d={direction === 'previous' ? 'm14 5-7 7 7 7' : 'm10 5 7 7-7 7'}
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      }
    />
  );
}

type PageNavigationProps = {
  page: number;
  loading?: boolean;
  onPageChange(page: number): void;
  label?: string;
};
function PageNavigation({
  page,
  totalPages,
  hasMore,
  loading = false,
  onPageChange,
  label = '列表分页'
}: PageNavigationProps & { totalPages?: number; hasMore: boolean }) {
  return (
    <nav
      className="collection-page-navigation"
      aria-label={label}
      {...paginationViewportProps(page, loading, label)}
    >
      <PageArrowButton
        direction="previous"
        disabled={loading || page <= 1}
        onClick={() => onPageChange(page - 1)}
      />
      <span aria-live="polite" aria-atomic="true">
        {totalPages === undefined ? page : `${page} / ${totalPages}`}
      </span>
      <PageArrowButton
        direction="next"
        disabled={loading || !hasMore}
        onClick={() => onPageChange(page + 1)}
      />
    </nav>
  );
}
export function ListPagination({ page, totalPages, ...props }: PageNavigationProps & { totalPages: number }) {
  const pages = Math.max(1, totalPages);
  return pages <= 1 ? null : (
    <PageNavigation {...props} page={page} totalPages={pages} hasMore={page < pages} />
  );
}
/** Unknown-total resources retain their existing hasMore contract; do not invent a total. */
export function CursorPagination({ page, hasMore, ...props }: PageNavigationProps & { hasMore: boolean }) {
  return page <= 1 && !hasMore ? null : <PageNavigation {...props} page={page} hasMore={hasMore} />;
}
