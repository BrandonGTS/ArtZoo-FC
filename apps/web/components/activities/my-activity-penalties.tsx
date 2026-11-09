'use client';
import { ListPagination } from '../collection-controls';

import { useEffect, useRef, useState } from 'react';
import OperationMenu from '../operation-menu';
import Link from 'next/link';
import { Input, Modal } from 'antd';
import type { MyActivityPenalties, MyActivityPenalty } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import { PageHeading } from '../home-content';
import adminStyles from '../invitation/admin.module.css';
import './appeals.css';
import { useActivityResource } from './use-activity-resource';
import { ActivityLoadState, ActivityPaper, beijingFull } from './activity-ui';
const labels = {
  LATE_WITHDRAWAL: '临近退出',
  LATE_CANCELLATION: '临近取消',
  SERIES_UNAGREED_ABSENCE: '未共识缺席',
  SERIES_UNCOMMUNICATED_EXIT: '未经沟通永久退出'
};
const statuses = { PENDING: '待处理', APPROVED: '已同意撤销', REJECTED: '已驳回' };
export default function MyActivityPenalties() {
  const [page, setPage] = useState(1),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    item: MyActivityPenalty;
    owner: string;
    reason: string;
    key: string;
    sent: boolean;
  } | null>(null);
  const { session } = useAuthSession(),
    owner = session?.user?.id;
  const pending = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { notify, contextHolder } = useFeedbackMessage();
  const resource = useActivityResource<MyActivityPenalties>(
    `/api/me/activity-penalties?page=${page}&refresh=${reload}`,
    { keepPreviousData: true }
  );
  const data = resource.data,
    current = confirmation?.owner === owner ? confirmation : null;
  async function submit() {
    if (!current || !current.reason.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setConfirmation({ ...current, sent: true });
    try {
      await accountRequest(`/api/me/activity-penalties/${current.item.id}/appeals`, {
        method: 'POST',
        body: {
          idempotencyKey: current.key,
          expectedLatestAppealId: current.item.latestAppeal?.id ?? null,
          reason: current.reason
        }
      });
      if (!mounted.current) return;
      notify('success', '申诉已提交');
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
        setConfirmation({ ...current, sent: false });
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
          活动处罚与申诉
        </PageHeading>
      </div>
      <ActivityLoadState
        loading={resource.loading && !data}
        error={resource.error}
        retry={() => setReload((value) => value + 1)}
      />
      {data ? (
        <div className="home-section" aria-busy={resource.loading}>
          <p>
            当前点数：{data.points}
            {data.restricted ? ' · 已限制新报名和发起活动' : ''}
          </p>
          {!data.items.length ? <p>暂无活动处罚记录。</p> : null}
          {data.items.map((item) => (
            <ActivityPaper key={item.id} className="appeal-record-card">
              <div className="activity-copy-section">
                <h2>
                  <Link className="activity-text-link" href={`/activities/${item.activityId}`}>
                    {item.activityTitle}
                  </Link>
                </h2>
                <p>
                  {labels[item.reason]} · {item.points}点{item.reversedAt ? ' · 已撤销' : ''}
                </p>
                <p className="activity-note">
                  产生于{beijingFull(item.createdAt)} · 申诉截止{beijingFull(item.expiresAt)}
                </p>
                {item.latestAppeal ? (
                  <>
                    <p>{statuses[item.latestAppeal.status]}</p>
                    <p className="activity-description">{item.latestAppeal.reason}</p>
                    {item.latestAppeal.decisionReason ? (
                      <p className="activity-description">处理说明：{item.latestAppeal.decisionReason}</p>
                    ) : null}
                  </>
                ) : null}
                {item.canAppeal && owner ? (
                  <OperationMenu
                    label="处罚申诉操作"
                    disabled={busy || resource.loading}
                    items={[
                      {
                        key: 'appeal',
                        label: item.latestAppeal?.status === 'REJECTED' ? '补充理由再申诉' : '提交申诉'
                      }
                    ]}
                    onAction={() =>
                      setConfirmation({ item, owner, reason: '', key: crypto.randomUUID(), sent: false })
                    }
                  />
                ) : null}
              </div>
            </ActivityPaper>
          ))}
          <ListPagination
            page={data.page}
            totalPages={data.totalPages}
            loading={busy || resource.loading}
            onPageChange={setPage}
            label="处罚记录分页"
          />
        </div>
      ) : null}
      <Modal
        open={!!current}
        title={current?.item.latestAppeal ? '补充理由再申诉' : '提交处罚申诉'}
        onOk={() => void submit()}
        onCancel={() => {
          if (!pending.current) setConfirmation(null);
        }}
        confirmLoading={busy}
        okText={current?.sent ? '重试同一次提交' : '确认提交'}
        cancelText="返回"
        okButtonProps={{ disabled: !current?.reason.trim() }}
        cancelButtonProps={{ disabled: busy }}
        mask={{ closable: !busy }}
        keyboard={!busy}
      >
        <p>申诉截止：{current ? beijingFull(current.item.expiresAt) : ''}。审核期间原处罚与限制继续生效。</p>
        <Input.TextArea
          autoComplete="off"
          aria-label="处罚申诉原因"
          maxLength={1000}
          value={current?.reason ?? ''}
          disabled={busy || current?.sent}
          onChange={(event) => {
            if (current) setConfirmation({ ...current, reason: event.target.value });
          }}
        />
      </Modal>
    </main>
  );
}
