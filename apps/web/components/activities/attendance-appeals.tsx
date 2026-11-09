'use client';
import { CollectionTabs, ListPagination } from '../collection-controls';

import { useEffect, useRef, useState } from 'react';
import OperationMenu from '../operation-menu';
import Link from 'next/link';
import { AdminReturnLink } from '../admin-return-link';
import { Input, Modal } from 'antd';
import type { AttendanceAppealPage } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import { AdminSectionTabs } from '../admin-management/admin-section-tabs';
import { PageHeading } from '../home-content';
import adminStyles from '../invitation/admin.module.css';
import './appeals.css';
import { useActivityResource } from './use-activity-resource';
import { ActivityLoadState, ActivityPaper, beijingFull } from './activity-ui';
const labels = { PRESENT: '到场', ABSENT: '未到场' };
type Item = AttendanceAppealPage['items'][number];
export default function AttendanceAppeals() {
  const [scope, setScope] = useState<'pending' | 'handled'>('pending'),
    [page, setPage] = useState(1),
    [reload, setReload] = useState(0);
  const [confirmation, setConfirmation] = useState<{
    item: Item;
    decision: 'APPROVE' | 'REJECT';
    reason: string;
    key: string;
    sent: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    pending = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { notify, contextHolder } = useFeedbackMessage();
  const resource = useActivityResource<AttendanceAppealPage>(
    `/api/admin/activity-attendance-appeals?scope=${scope}&page=${page}&refresh=${reload}`,
    { keepPreviousData: true }
  );
  const data = resource.data;
  async function submit() {
    if (!confirmation || !confirmation.reason.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setConfirmation({ ...confirmation, sent: true });
    try {
      await accountRequest(`/api/admin/activity-attendance-appeals/${confirmation.item.id}`, {
        method: 'POST',
        body: {
          idempotencyKey: confirmation.key,
          expectedAttendanceRevision: confirmation.item.attendanceRevision,
          expectedAppealRevision: confirmation.item.revision,
          decision: confirmation.decision,
          reason: confirmation.reason
        }
      });
      if (!mounted.current) return;
      notify('success', '申诉处理结果已保存');
      setConfirmation(null);
      setReload((value) => value + 1);
    } catch (failure) {
      if (!mounted.current) return;
      const detail = errorDetail(failure);
      notify('error', detail.message);
      if (['CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(detail.code)) {
        setConfirmation(null);
        setReload((value) => value + 1);
      } else if (['VALIDATION_ERROR', 'RATE_LIMITED'].includes(detail.code))
        setConfirmation({ ...confirmation, sent: false });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <main className={['home-content', 'appeals-page', adminStyles.main].join(' ')} id="main-content">
      {contextHolder}
      <div className={adminStyles.heading}>
        <PageHeading level={1} decoration="burger">
          到场申诉处理
        </PageHeading>
        <AdminReturnLink />
      </div>
      <AdminSectionTabs
        group="appeals"
        active="/admin/attendance-appeals"
        disabled={busy || Boolean(confirmation)}
      />
      <CollectionTabs
        variant="secondary"
        tabs={[
          { key: 'pending', label: '待处理' },
          { key: 'handled', label: '已处理' }
        ]}
        activeKey={scope}
        disabled={busy}
        onTabChange={(value) => {
          if (value !== scope) {
            setScope(value as 'pending' | 'handled');
            setPage(1);
          }
        }}
      />
      <ActivityLoadState
        loading={resource.loading && !data}
        error={resource.error}
        retry={() => setReload((value) => value + 1)}
      />
      {data ? (
        <div className="home-section" id="attendance-appeal-results" aria-busy={resource.loading}>
          {!data.items.length ? <p>暂无{scope === 'pending' ? '待处理' : '已处理'}的到场申诉。</p> : null}
          {data.items.map((item) => (
            <ActivityPaper key={item.id} className="appeal-record-card">
              <div className="activity-copy-section">
                <h2>
                  {item.participantName} ·{' '}
                  <Link className="activity-text-link" href={`/activities/${item.activityId}`}>
                    {item.activityTitle}
                  </Link>
                </h2>
                <p>
                  现有结果：{item.currentStatus ? labels[item.currentStatus] : '待确认'} · 申请更正为
                  {labels[item.requestedStatus]}
                </p>
                <p className="activity-note">提交于{beijingFull(item.createdAt)}</p>
                <p className="activity-description">{item.reason}</p>
                {item.status === 'PENDING' ? (
                  <OperationMenu
                    label="申诉处理操作"
                    disabled={busy || resource.loading}
                    items={[
                      { key: 'APPROVE', label: '同意更正' },
                      { key: 'REJECT', label: '驳回申诉' }
                    ]}
                    onAction={(decision) =>
                      setConfirmation({
                        item,
                        decision: decision as 'APPROVE' | 'REJECT',
                        reason: '',
                        key: crypto.randomUUID(),
                        sent: false
                      })
                    }
                  />
                ) : (
                  <>
                    <p>{item.status === 'APPROVED' ? '已同意更正' : '已驳回'}</p>
                    <p className="activity-description">{item.decisionReason}</p>
                  </>
                )}
              </div>
            </ActivityPaper>
          ))}
          <ListPagination
            page={data.page}
            totalPages={data.totalPages}
            loading={busy || resource.loading}
            onPageChange={setPage}
            label="到场申诉分页"
          />
        </div>
      ) : null}
      <Modal
        open={!!confirmation}
        title={confirmation?.decision === 'APPROVE' ? '确认同意更正' : '确认驳回申诉'}
        onOk={() => void submit()}
        onCancel={() => {
          if (!pending.current) setConfirmation(null);
        }}
        confirmLoading={busy}
        okText={confirmation?.sent ? '重试同一次处理' : '确认处理'}
        cancelText="返回"
        okButtonProps={{ disabled: !confirmation?.reason.trim() }}
        cancelButtonProps={{ disabled: busy }}
        mask={{ closable: !busy }}
        keyboard={!busy}
      >
        <p>
          {confirmation?.decision === 'APPROVE'
            ? confirmation.item.requestedStatus === 'ABSENT'
              ? '同意更正为未到场，将记2点并同步纠正完成减分，保留全部历史。'
              : '仅纠正这份已有到场记录，撤销对应未到场处罚、同步纠正完成结算并重新核算，保留全部历史。'
            : '保留原到场结果及相应处罚。'}
        </p>
        <Input.TextArea
          autoComplete="off"
          aria-label="申诉处理说明"
          maxLength={1000}
          value={confirmation?.reason ?? ''}
          disabled={busy || confirmation?.sent}
          onChange={(event) => {
            if (confirmation) setConfirmation({ ...confirmation, reason: event.target.value });
          }}
        />
      </Modal>
    </main>
  );
}
