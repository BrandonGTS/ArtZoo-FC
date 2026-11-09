'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from 'antd';
import { createPortal } from 'react-dom';
import {
  activityWithdrawalPenalty,
  activityCancellationPenalty,
  type ActivityDetail,
  type ActivityWriteResult
} from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';

type Action = 'withdraw' | 'cancel' | 'continue';
interface Confirmation {
  action: Action;
  key: string;
  revision: number;
  registrationId?: string;
  expectedPenaltyPoints: 0 | 1 | 2;
  warning: string;
}
const labels = { withdraw: '退出报名', cancel: '取消活动', continue: '继续举行' } as const;

export default function ActivityManagementControls({
  activity,
  now,
  onResult,
  onRefresh,
  onFeedback,
  organizerContainer
}: {
  activity: ActivityDetail;
  now: number;
  organizerContainer?: HTMLElement | null;
  onResult(result: ActivityWriteResult): void;
  onRefresh(): void;
  onFeedback(kind: 'success' | 'error', text: string): void;
}) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const beforeStart = now < Date.parse(activity.startsAt),
    open = !activity.cancelledAt && beforeStart;
  const shortage =
    now >= Date.parse(activity.registrationClosesAt) &&
    activity.registeredCount < activity.capacity &&
    !activity.continuedAt;
  function pointsFor(action: Action) {
    const startsAt = new Date(activity.startsAt),
      current = new Date(now);
    return action === 'withdraw'
      ? activityWithdrawalPenalty(startsAt, current, !!activity.myRegistration?.rescheduleExitAllowed)
      : action === 'cancel'
        ? activityCancellationPenalty(
            startsAt,
            current,
            activity.registeredCount,
            activity.capacity,
            !!activity.continuedAt
          )
        : 0;
  }
  const currentPoints = confirmation ? pointsFor(confirmation.action) : 0;
  const changedPenalty = !!confirmation && confirmation.expectedPenaltyPoints !== currentPoints;
  function confirm(action: Action) {
    if (!open || busy || pending.current) return;
    if (action === 'withdraw' && !activity.myRegistration) return;
    if (action !== 'withdraw' && !activity.isOrganizer) return;
    if (action === 'continue' && !shortage) return;
    let warning: string;
    if (action === 'withdraw')
      warning = activity.myRegistration?.rescheduleExitAllowed
        ? '活动已改期，你可以无责退出。退出后将释放席位，并保留报名记录。'
        : Date.parse(activity.startsAt) - now < 2 * 3600000
          ? '距开场不足2小时，退出将记1点。退出后释放席位；即使活动之后取消，此处罚仍保留。'
          : '退出后将释放席位并保留报名记录。本次退出无责。';
    else if (action === 'cancel')
      warning = shortage
        ? '报名截止后未满员且尚未确认继续举行，本次取消无责。取消后通知有效报名者并保留所有记录。'
        : Date.parse(activity.startsAt) - now < 4 * 3600000
          ? '距开场不足4小时，本次取消将记2点。报名者不受罚；通知有效报名者并保留所有记录。'
          : '本次取消无责。取消后通知有效报名者并保留所有记录。';
    else warning = '确认继续举行后，再取消将按普通取消规则处理。';
    setConfirmation({
      action,
      key: crypto.randomUUID(),
      revision: activity.revision,
      registrationId: activity.myRegistration?.id,
      expectedPenaltyPoints: pointsFor(action),
      warning
    });
  }
  async function submit() {
    if (!confirmation || !open || changedPenalty || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await accountRequest<ActivityWriteResult>(
        `/api/activities/${activity.id}/${confirmation.action}`,
        {
          method: 'POST',
          body: {
            idempotencyKey: confirmation.key,
            expectedRevision: confirmation.revision,
            ...(confirmation.action === 'withdraw'
              ? { expectedRegistrationId: confirmation.registrationId }
              : {}),
            ...(confirmation.action !== 'continue'
              ? { expectedPenaltyPoints: confirmation.expectedPenaltyPoints }
              : {})
          }
        }
      );
      if (!mounted.current) return;
      onFeedback(
        'success',
        confirmation.action === 'withdraw'
          ? '退出报名成功'
          : confirmation.action === 'cancel'
            ? '活动已取消'
            : '已确认继续举行'
      );
      setConfirmation(null);
      onResult(result);
    } catch (failure) {
      if (!mounted.current) return;
      const detail = errorDetail(failure);
      onFeedback('error', detail.message);
      if (['CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(detail.code)) {
        setConfirmation(null);
        onRefresh();
      }
      // Keep the exact command key for uncertain response retries. No silent new operation.
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const organizerActions =
    open && activity.isOrganizer ? (
      <section className="activity-copy-section" aria-label="活动管理">
        <Button href={`/activities/${activity.id}/edit`} disabled={busy}>
          修改活动
        </Button>
        {shortage ? (
          <>
            <p className="activity-note">报名截止后未满员，请选择继续举行或无责取消。</p>
            <Button htmlType="button" disabled={busy} onClick={() => confirm('continue')}>
              继续举行
            </Button>
          </>
        ) : null}
        {activity.continuedAt ? <p className="activity-note">已确认继续举行。</p> : null}
        <Button
          htmlType="button"
          danger
          styles={{ root: { boxShadow: 'none', borderColor: 'transparent' } }}
          disabled={busy}
          onClick={() => confirm('cancel')}
        >
          取消活动
        </Button>
      </section>
    ) : null;
  return (
    <>
      {open && (activity.myRegistration || (organizerContainer === undefined && activity.isOrganizer)) ? (
        <div className="activity-copy-section">
          {activity.myRegistration ? (
            <Button htmlType="button" danger disabled={busy} onClick={() => confirm('withdraw')}>
              退出报名
            </Button>
          ) : null}
          {organizerContainer === undefined ? organizerActions : null}
        </div>
      ) : null}
      {organizerContainer ? createPortal(organizerActions, organizerContainer) : null}
      <Modal
        open={!!confirmation}
        title={confirmation ? `确认${labels[confirmation.action]}` : ''}
        onCancel={() => {
          if (!pending.current) setConfirmation(null);
        }}
        onOk={() => void submit()}
        okText={confirmation ? `确认${labels[confirmation.action]}` : '确认'}
        cancelText="返回"
        confirmLoading={busy}
        okButtonProps={{ danger: confirmation?.action === 'cancel', disabled: !open || changedPenalty }}
        cancelButtonProps={{ disabled: busy }}
        mask={{ closable: !busy }}
        keyboard={!busy}
      >
        <p>{confirmation?.warning}</p>
        {changedPenalty && open ? (
          <>
            <p>
              时间或报名情况已变化，本次{currentPoints ? `将记${currentPoints}点` : '无责'}，需要重新确认。
            </p>
            <Button
              htmlType="button"
              onClick={() => {
                if (confirmation) confirm(confirmation.action);
              }}
            >
              重新确认本次操作
            </Button>
          </>
        ) : null}
        {!open && confirmation ? <p>活动已开始或已取消，请刷新详情。</p> : null}
      </Modal>
    </>
  );
}
