'use client';
import { useState } from 'react';
import { ConfigProvider, Table } from 'antd';
import type { AdminRole, ManagementAudit, NumberedPageResult } from '@artzoo/domain';
import { ErrorNotice } from '../account/account-ui';
import { beijingFull } from '../activities/activity-ui';
import { ListPagination } from '../collection-controls';
import { useManagementResource } from './management-api';
export const roleLabels: Record<AdminRole, string> = {
  NONE: '非管理员',
  ADMIN: '普通管理员',
  SUPER_ADMIN: '超级管理员'
};
export function ManagementAudits({
  scope,
  refresh,
  disabled
}: {
  scope: 'roles';
  refresh: number;
  disabled: boolean;
}) {
  const [page, setPage] = useState(1);
  const resource = useManagementResource<NumberedPageResult<ManagementAudit>>(
    '/api/admin/management/audits?scope=' + scope + '&page=' + page + '&pageSize=10&refresh=' + refresh,
    { keepPrevious: true, revalidate: !disabled }
  );
  if (!resource.loading && resource.data && page > Math.max(1, Math.ceil(resource.data.total / 10)))
    setPage(Math.max(1, Math.ceil(resource.data.total / 10)));
  if (resource.blocked) return null;
  return (
    <section className="management-audits">
      <h2>操作记录</h2>
      <ErrorNotice message={resource.error} />
      <ManagementTable>
        <Table<ManagementAudit>
          rowKey="id"
          loading={resource.loading}
          dataSource={resource.data?.items ?? []}
          pagination={false}
          scroll={{ x: 680 }}
          locale={{ emptyText: '暂无操作记录' }}
          columns={[
            {
              title: '时间 / 操作人',
              key: 'actor',
              render: (_, row) => (
                <span>
                  {beijingFull(row.createdAt)} · {row.actor.displayName || '超级管理员'}
                </span>
              )
            },
            ...(scope === 'roles'
              ? [
                  {
                    title: '目标',
                    key: 'target',
                    render: (_: unknown, row: ManagementAudit) => row.target?.displayName || '成员'
                  }
                ]
              : []),
            {
              title: '变更',
              key: 'change',
              render: (_, row) => (
                <span>
                  {row.beforeRole ? roleLabels[row.beforeRole] : '—'} →{' '}
                  {row.afterRole ? roleLabels[row.afterRole] : '—'}
                </span>
              )
            },
            { title: '原因', dataIndex: 'reason' }
          ]}
        />
      </ManagementTable>
      {resource.data && resource.data.total > 0 ? (
        <ListPagination
          page={page}
          totalPages={Math.ceil(resource.data.total / 10)}
          loading={resource.loading || disabled}
          onPageChange={setPage}
          label="管理操作记录分页"
        />
      ) : null}
    </section>
  );
}
export function ManagementTable({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      theme={{
        components: {
          Table: {
            headerBg: 'var(--artzoo-fill)',
            rowHoverBg: 'var(--artzoo-fill)',
            colorBgContainer: 'transparent',
            headerSplitColor: 'transparent'
          }
        }
      }}
    >
      {children}
    </ConfigProvider>
  );
}
