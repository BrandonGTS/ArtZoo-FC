'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Modal } from 'antd';
import type { ActivityDetail, ActivityWriteResult } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { beijingFull } from './activity-ui';

type Props = {
  activity: ActivityDetail;
  now: number;
  onResult(result: ActivityWriteResult): void;
  onRefresh(): void;
  onFeedback(kind: 'success' | 'error', text: string): void;
};
export default function ActivitySeriesCancellation({
  activity,
  now,
  onResult,
  onRefresh,
  onFeedback
}: Props) {
  const [confirmation, setConfirmation] = useState<{
    activityId: string;
    key: string;
    revision: number;
    agreed: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const eligible =
    activity.scene === 'GAME' &&
    activity.mode === 'SERIES' &&
    activity.series?.state === 'FORMED' &&
    activity.isOrganizer &&
    !activity.cancelledAt &&
    now < Date.parse(activity.startsAt);
  const changed =
    !!confirmation &&
    (confirmation.activityId !== activity.id || confirmation.revision !== activity.revision);
  async function submit() {
    if (!eligible || !confirmation?.agreed || changed || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await accountRequest<ActivityWriteResult>(
        `/api/activities/${confirmation.activityId}/series/cancel-period`,
        {
          method: 'POST',
          body: {
            idempotencyKey: confirmation.key,
            expectedRevision: confirmation.revision,
            allMembersAgreed: true
          }
        }
      );
      if (!mounted.current) return;
      setConfirmation(null);
      onFeedback('success', '本期已协商取消');
      onResult(result);
    } catch (failure) {
      if (!mounted.current) return;
      const detail = errorDetail(failure);
      onFeedback('error', detail.message);
      if (['CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(detail.code)) {
        setConfirmation(null);
        onRefresh();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      {eligible ? (
        <section className="activity-copy-section" aria-label="活动管理">
          <hr className="activity-detail-divider" />
          <Button
            htmlType="button"
            danger
            block
            styles={{ root: { boxShadow: 'none', borderColor: 'transparent' } }}
            disabled={busy}
            onClick={() => {
              if (!pending.current)
                setConfirmation({
                  activityId: activity.id,
                  key: crypto.randomUUID(),
                  revision: activity.revision,
                  agreed: false
                });
            }}
          >
            协商取消本期
          </Button>
        </section>
      ) : null}
      <Modal
        open={!!confirmation}
        title="协商取消本期"
        okText="确认取消本期"
        cancelText="返回"
        confirmLoading={busy}
        onCancel={() => {
          if (!pending.current) setConfirmation(null);
        }}
        onOk={() => void submit()}
        okButtonProps={{ danger: true, disabled: !eligible || changed || !confirmation?.agreed }}
        cancelButtonProps={{ disabled: busy }}
        mask={{ closable: !busy }}
        keyboard={!busy}
      >
        <p>
          第{activity.series?.periodNumber}期 · {beijingFull(activity.startsAt)}
        </p>
        <p>
          全员同意后，本期可无责取消，不记处罚；将通知本期成员。后续期次按原计划举行，不补办、不顺延，总期数和结束条件不变。
        </p>
        <Checkbox
          checked={confirmation?.agreed ?? false}
          disabled={busy || changed || !eligible}
          onChange={(event) =>
            setConfirmation((value) => (value ? { ...value, agreed: event.target.checked } : null))
          }
        >
          我已与全体成员沟通，并征得全员同意取消本期
        </Checkbox>
        {changed ? (
          <p>活动已变化，请返回后重新确认。</p>
        ) : !eligible && confirmation ? (
          <p>当前不能协商取消本期，请返回并刷新详情。</p>
        ) : null}
      </Modal>
    </>
  );
}
