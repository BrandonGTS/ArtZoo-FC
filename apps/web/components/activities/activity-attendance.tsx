'use client';

import { useEffect, useRef, useState } from 'react';
import { Avatar, Button, Input, Modal } from 'antd';
import Image from 'next/image';
import Link from 'next/link';
import type { ActivityAttendance as AttendanceData, AttendanceStatus } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../home-content';
import { useActivityResource } from './use-activity-resource';
import { ActivityLoadState, ActivityPaper, beijingFull } from './activity-ui';
const labels = { PRESENT: '已签到', ABSENT: '未到场' };
const completionLabels = { PENDING: '待结算', CREDITED: '已结算', NOT_CREDITED: '不计入' };
const appealLabels = { PENDING: '待处理', APPROVED: '已同意更正', REJECTED: '已驳回' };
type Item = AttendanceData['items'][number];
type Confirmation = {
  mode: 'record' | 'appeal';
  row: Item;
  status: AttendanceStatus;
  key: string;
  reason: string;
  sent: boolean;
};
function AttendanceRow({
  row,
  canEdit,
  canAppeal,
  busy,
  onRecord,
  onAppeal
}: {
  row: Item;
  canEdit: boolean;
  canAppeal: boolean;
  busy: boolean;
  onRecord(): void;
  onAppeal(): void;
}) {
  return (
    <li className="activity-attendance-row">
      <div className="activity-attendance-main">
        <Link className="activity-attendance-person" href={`/members/${row.participant.id}`}>
          <Avatar
            size={40}
            src={row.participant.avatarUrl}
            alt=""
            icon={<Image src="/artzoo/icons/user-round.svg" alt="" width={20} height={20} unoptimized />}
          />
          <span>{row.participant.displayName || '成员'}</span>
        </Link>
        {row.status === 'PRESENT' ? (
          <span className="activity-attendance-present">已签到</span>
        ) : canEdit ? (
          <Button type="primary" htmlType="button" disabled={busy} onClick={onRecord}>
            签到
          </Button>
        ) : (
          <span className="activity-note">{row.status ? labels[row.status] : '未签到'}</span>
        )}
      </div>
      {row.completion ? (
        <p className="activity-note">正常完成：{completionLabels[row.completion.status]}</p>
      ) : null}
      {row.updatedAt ? <p className="activity-note">最近更新：{beijingFull(row.updatedAt)}</p> : null}
      {row.appeal ? (
        <div className="activity-copy-section">
          <p>
            你的到场申诉 · {appealLabels[row.appeal.status]} · 申请更正为{labels[row.appeal.requestedStatus]}
          </p>
          <p className="activity-description">{row.appeal.reason}</p>
          {row.appeal.decisionReason ? (
            <p className="activity-description">处理说明：{row.appeal.decisionReason}</p>
          ) : null}
        </div>
      ) : null}
      {canAppeal ? (
        <Button htmlType="button" disabled={busy} onClick={onAppeal}>
          申请更正到场结果
        </Button>
      ) : null}
    </li>
  );
}
export default function ActivityAttendance({
  id,
  now,
  onChanged,
  onFeedback
}: {
  id: string;
  now: number;
  onChanged(): void;
  onFeedback(kind: 'success' | 'error', text: string): void;
}) {
  const { session } = useAuthSession();
  const [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pending = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const resource = useActivityResource<AttendanceData>(
    `/api/activities/${encodeURIComponent(id)}/attendance?refresh=${reload}`
  );
  const data = resource.data;
  const open =
    !!data &&
    data.eligible &&
    !data.cancelled &&
    now >= Date.parse(data.startsAt) &&
    now < Date.parse(data.endsAt);
  const canSubmit =
    !!confirmation &&
    !!data &&
    (confirmation.mode === 'record'
      ? open && data.isOrganizer && confirmation.row.status !== 'PRESENT'
      : now >= Date.parse(data.endsAt) && confirmation.reason.trim().length > 0);
  const refresh = () => {
    setReload((value) => value + 1);
    onChanged();
  };
  async function submit() {
    if (!confirmation || !canSubmit || pending.current) return;
    pending.current = true;
    setBusy(true);
    setConfirmation({ ...confirmation, sent: true });
    try {
      await accountRequest(
        `/api/activities/${id}/attendance${confirmation.mode === 'appeal' ? '/appeals' : ''}`,
        {
          method: 'POST',
          body: {
            idempotencyKey: confirmation.key,
            registrationId: confirmation.row.registrationId,
            expectedAttendanceRevision: confirmation.row.revision,
            ...(confirmation.mode === 'record'
              ? { status: confirmation.status }
              : { requestedStatus: confirmation.status, reason: confirmation.reason })
          }
        }
      );
      if (!mounted.current) return;
      onFeedback(
        'success',
        confirmation.mode === 'record' ? '签到已保存' : '到场申诉已提交，处理期间原限制继续生效'
      );
      setConfirmation(null);
      refresh();
    } catch (failure) {
      if (!mounted.current) return;
      const detail = errorDetail(failure);
      onFeedback('error', detail.message);
      if (['CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(detail.code)) {
        setConfirmation(null);
        refresh();
      } else if (['VALIDATION_ERROR', 'RATE_LIMITED'].includes(detail.code))
        setConfirmation({ ...confirmation, sent: false });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <ActivityPaper>
      <section className="activity-copy-section" aria-label="到场登记">
        <PageHeading decoration="tomato">到场记录</PageHeading>
        <ActivityLoadState
          loading={resource.loading}
          error={resource.error}
          retry={() => setReload((value) => value + 1)}
        />
        {data ? (
          <>
            {!data.eligible ? (
              <p className="activity-note">此历史活动不追补到场记录或处罚。</p>
            ) : data.cancelled ? (
              <p className="activity-note">活动已取消，无需登记。</p>
            ) : now < Date.parse(data.startsAt) ? null : !open ? (
              <p className="activity-note">
                登记已截止。已有结果如需纠正，请本人提交申诉；未填记录不能补录。
              </p>
            ) : null}
            {data.autoAbsence && data.eligible && !data.cancelled ? (
              <p className="activity-note">
                截止：{beijingFull(data.endsAt)}。结束后未签到将自动记为未到场并记2点，可由本人申诉。
              </p>
            ) : null}
            {!data.items.length ? <p className="activity-note">暂无有效报名。</p> : null}
            <ul className="activity-attendance-list">
              {data.items.map((row) => (
                <AttendanceRow
                  key={`${row.registrationId}:${row.revision}`}
                  row={row}
                  busy={busy}
                  canEdit={open && data.isOrganizer}
                  canAppeal={
                    data.eligible &&
                    !data.cancelled &&
                    now >= Date.parse(data.endsAt) &&
                    row.participant.id === session?.user?.id &&
                    !!row.status &&
                    !!row.recordedAt &&
                    Date.parse(row.recordedAt) >= Date.parse(data.startsAt) &&
                    (Date.parse(row.recordedAt) < Date.parse(data.endsAt) ||
                      (row.source === 'AUTO_DEADLINE' &&
                        data.autoAbsence &&
                        Date.parse(row.recordedAt) >= Date.parse(data.endsAt))) &&
                    row.appeal?.status !== 'PENDING'
                  }
                  onRecord={() =>
                    setConfirmation({
                      mode: 'record',
                      row,
                      status: 'PRESENT',
                      key: crypto.randomUUID(),
                      reason: '',
                      sent: false
                    })
                  }
                  onAppeal={() =>
                    setConfirmation({
                      mode: 'appeal',
                      row,
                      status: row.status === 'ABSENT' ? 'PRESENT' : 'ABSENT',
                      key: crypto.randomUUID(),
                      reason: '',
                      sent: false
                    })
                  }
                />
              ))}
            </ul>
          </>
        ) : null}
        <Modal
          open={!!confirmation}
          title={confirmation?.mode === 'appeal' ? '申请更正到场结果' : '确认签到'}
          onOk={() => void submit()}
          onCancel={() => {
            if (!pending.current) setConfirmation(null);
          }}
          okText={confirmation?.sent ? '重试同一次提交' : '确认提交'}
          cancelText="返回"
          confirmLoading={busy}
          okButtonProps={{ disabled: !canSubmit }}
          cancelButtonProps={{ disabled: busy }}
          mask={{ closable: !busy }}
          keyboard={!busy}
        >
          <p>
            {confirmation?.row.participant.displayName || '成员'} ·{' '}
            {confirmation
              ? confirmation.mode === 'record'
                ? '确认后签到'
                : labels[confirmation.status]
              : ''}
          </p>
          <p>
            {confirmation?.status === 'ABSENT'
              ? '登记未到场将记2点。'
              : confirmation?.row.status === 'ABSENT'
                ? '更正为到场会撤销本次未到场处罚，重新核算点数与限制，保留历史；同步更正完成结算，不撤销其他处罚。'
                : '确认签到后记录为到场；本次不进行正常完成减分。'}
          </p>
          {confirmation?.mode === 'appeal' ? (
            <>
              <p>申请仅纠正已有记录；处理期间原处罚和限制继续生效。</p>
              <Input.TextArea
                autoComplete="off"
                aria-label="到场申诉原因"
                maxLength={1000}
                value={confirmation.reason}
                disabled={busy || confirmation.sent}
                onChange={(event) => setConfirmation({ ...confirmation, reason: event.target.value })}
              />
            </>
          ) : null}
          {confirmation?.mode === 'record' && !open ? <p>登记窗口已关闭，不能再提交或更正。</p> : null}
        </Modal>
      </section>
    </ActivityPaper>
  );
}
