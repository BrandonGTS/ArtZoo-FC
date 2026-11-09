'use client';

import { useEffect, useRef, useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import { Button, Checkbox, DatePicker, Form, Modal, Space } from 'antd';
import { createPortal } from 'react-dom';
import { toBeijingPicker } from '@artzoo/domain';
import { beijingPickerTimestamp } from '../beijing-picker';
import type { ActivityDetail, ActivityWriteResult } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { beijingFull } from './activity-ui';
import ActivityOrdinaryEditControls from './activity-ordinary-edit-controls';

type Action = 'withdraw' | 'cancel' | 'reschedule';
type Payload = {
  idempotencyKey: string;
  expectedRevision: number;
  expectedRegistrationId?: string;
  confirmed?: true;
  startsAt?: string;
  endsAt?: string;
  allMembersAgreed?: true;
};
type Confirmation = {
  activityId: string;
  action: Action;
  key: string;
  revision: number;
  registrationId?: string;
  startsAt: string;
  endsAt: string;
  periodNumber?: number;
  request?: Payload;
  uncertain: boolean;
};
type RescheduleValues = { startsAt?: Dayjs; endsAt?: Dayjs; allMembersAgreed?: boolean };
type Props = {
  activity: ActivityDetail;
  now: number;
  organizerContainer?: HTMLElement | null;
  onRecoveryChange?(needed: boolean): void;
  onResult(result: ActivityWriteResult): void;
  onRefresh(): void;
  onFeedback(kind: 'success' | 'error', text: string): void;
};
const labels = { withdraw: '退出报名', cancel: '取消活动', reschedule: '协商改期本期' } as const;
const success = { withdraw: '退出报名成功', cancel: '活动已取消', reschedule: '本期已协商改期' } as const;
function beijingTimestamp(value: Dayjs) {
  return beijingPickerTimestamp(value.format('YYYY-MM-DDTHH:mm') + ':00');
}
function picker(value: string) {
  return dayjs(toBeijingPicker(new Date(value)));
}

export default function ActivityOrdinaryManagementControls({
  activity,
  now,
  onResult,
  onRefresh,
  onFeedback,
  organizerContainer,
  onRecoveryChange
}: Props) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false);
  const [editRecoveryNeeded, setEditRecoveryNeeded] = useState(false);
  const pending = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const offline = activity.scene === 'OFFLINE' && activity.mode !== 'SERIES';
  const series = activity.scene === 'GAME' && activity.mode === 'SERIES';
  const recruiting = series && activity.series?.periodNumber === 1 && activity.series.state === 'RECRUITING';
  const beforeStart = now < Date.parse(activity.startsAt),
    beforeCutoff = now < Date.parse(activity.registrationClosesAt);
  const eligible = {
    withdraw: !activity.cancelledAt && !!activity.myRegistration && beforeCutoff && (offline || recruiting),
    cancel: offline && !activity.cancelledAt && activity.isOrganizer && beforeStart,
    reschedule:
      series &&
      activity.series?.state === 'FORMED' &&
      !activity.cancelledAt &&
      activity.isOrganizer &&
      beforeStart
  };
  const changed =
    !!confirmation &&
    (confirmation.activityId !== activity.id ||
      confirmation.revision !== activity.revision ||
      (confirmation.action === 'withdraw' && confirmation.registrationId !== activity.myRegistration?.id));
  const uncertain = !!confirmation?.uncertain;
  const organizerRecoveryNeeded = editRecoveryNeeded || (uncertain && confirmation?.action !== 'withdraw');
  useEffect(() => {
    onRecoveryChange?.(organizerRecoveryNeeded);
    return () => onRecoveryChange?.(false);
  }, [organizerRecoveryNeeded, onRecoveryChange]);
  const formDisabled = busy || changed || uncertain || (!!confirmation && !eligible[confirmation.action]);
  function open(action: Action) {
    if (pending.current) return;
    if (confirmation?.uncertain) {
      setVisible(true);
      return;
    }
    if (!eligible[action]) return;
    setConfirmation({
      activityId: activity.id,
      action,
      key: crypto.randomUUID(),
      revision: activity.revision,
      registrationId: activity.myRegistration?.id,
      startsAt: activity.startsAt,
      endsAt: activity.endsAt,
      periodNumber: activity.series?.periodNumber,
      uncertain: false
    });
    setVisible(true);
  }
  function close() {
    if (pending.current) return;
    setVisible(false);
    if (!confirmation?.uncertain) setConfirmation(null);
  }
  async function submit(values: RescheduleValues = {}) {
    if (!mounted.current || pending.current || !confirmation || confirmation.activityId !== activity.id)
      return;
    if (!confirmation.uncertain && (changed || !eligible[confirmation.action])) return;
    let body = confirmation.uncertain ? confirmation.request : undefined;
    if (!body) {
      body = { idempotencyKey: confirmation.key, expectedRevision: confirmation.revision };
      if (confirmation.action === 'withdraw') body.expectedRegistrationId = confirmation.registrationId;
      else if (confirmation.action === 'cancel') body.confirmed = true;
      else {
        if (!values.startsAt || !values.endsAt || values.allMembersAgreed !== true) return;
        body.startsAt = values.startsAt.format('YYYY-MM-DDTHH:mm');
        body.endsAt = values.endsAt.format('YYYY-MM-DDTHH:mm');
        body.allMembersAgreed = true;
      }
    }
    // The uncertain retry always reuses this frozen body, including the original key and revision.
    const command = confirmation,
      request = body;
    pending.current = true;
    setBusy(true);
    let result: ActivityWriteResult;
    try {
      result = await accountRequest<ActivityWriteResult>(
        `/api/activities/${command.activityId}/ordinary-management/${command.action}`,
        { method: 'POST', body: request }
      );
    } catch (failure) {
      if (!mounted.current) return;
      const detail = errorDetail(failure);
      const unknown = ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(detail.code);
      setConfirmation((value) =>
        value?.key === command.key
          ? { ...value, request: unknown ? request : undefined, uncertain: unknown }
          : value
      );
      onFeedback('error', detail.message);
      if (['CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHENTICATED'].includes(detail.code)) {
        setVisible(false);
        setConfirmation(null);
        onRefresh();
      }
      return;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
    if (!mounted.current) return;
    setVisible(false);
    setConfirmation(null);
    onFeedback('success', success[command.action]);
    onResult(result);
  }
  const anyEligible = eligible.withdraw || eligible.cancel || eligible.reschedule;
  const editControls = (
    <ActivityOrdinaryEditControls
      onRecoveryChange={setEditRecoveryNeeded}
      activity={activity}
      now={now}
      onResult={onResult}
      onRefresh={onRefresh}
      onFeedback={onFeedback}
    />
  );
  const withdrawButton = eligible.withdraw ? (
    <Button htmlType="button" danger block disabled={busy || uncertain} onClick={() => open('withdraw')}>
      退出报名
    </Button>
  ) : null;
  const cancelButton = eligible.cancel ? (
    <Button
      htmlType="button"
      danger
      block
      styles={{ root: { boxShadow: 'none', borderColor: 'transparent' } }}
      disabled={busy || uncertain}
      onClick={() => open('cancel')}
    >
      取消活动
    </Button>
  ) : null;
  const rescheduleButton = eligible.reschedule ? (
    <Button htmlType="button" block disabled={busy || uncertain} onClick={() => open('reschedule')}>
      协商改期本期
    </Button>
  ) : null;
  const retryButton =
    uncertain && !visible ? (
      <Button htmlType="button" block disabled={busy} onClick={() => setVisible(true)}>
        重试原提交
      </Button>
    ) : null;
  const organizerActions = (
    <>
      {editControls}
      {eligible.cancel || eligible.reschedule || (uncertain && confirmation?.action !== 'withdraw') ? (
        <section className="activity-copy-section" aria-label="活动管理">
          {cancelButton}
          {rescheduleButton}
          {confirmation?.action !== 'withdraw' ? retryButton : null}
        </section>
      ) : null}
    </>
  );
  return (
    <>
      {organizerContainer === undefined ? (
        <>
          {editControls}
          {anyEligible || uncertain ? (
            <section className="activity-copy-section" aria-label="活动管理">
              {withdrawButton}
              {cancelButton}
              {rescheduleButton}
              {retryButton}
            </section>
          ) : null}
        </>
      ) : (
        <>
          {organizerContainer ? createPortal(organizerActions, organizerContainer) : null}
          {eligible.withdraw || (uncertain && confirmation?.action === 'withdraw') ? (
            <section className="activity-copy-section" aria-label="报名管理">
              {withdrawButton}
              {confirmation?.action === 'withdraw' ? retryButton : null}
            </section>
          ) : null}
        </>
      )}
      <Modal
        open={visible && !!confirmation}
        title={confirmation ? labels[confirmation.action] : ''}
        footer={null}
        destroyOnHidden
        onCancel={close}
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
      >
        {confirmation ? (
          <Form<RescheduleValues>
            autoComplete="off"
            key={confirmation.key}
            layout="vertical"
            disabled={formDisabled}
            preserve={false}
            initialValues={{
              startsAt: confirmation.request?.startsAt
                ? dayjs(confirmation.request.startsAt)
                : picker(confirmation.startsAt),
              endsAt: confirmation.request?.endsAt
                ? dayjs(confirmation.request.endsAt)
                : picker(confirmation.endsAt),
              allMembersAgreed: confirmation.request?.allMembersAgreed ?? false
            }}
            onFinish={(values) => void submit(values)}
          >
            <p>
              {confirmation.periodNumber ? `第${confirmation.periodNumber}期 · ` : ''}
              {beijingFull(confirmation.startsAt)}
            </p>
            {confirmation.action === 'withdraw' ? (
              <p>确认退出报名？本次退出不记处罚，将释放席位并通知组织者，报名记录保留。</p>
            ) : confirmation.action === 'cancel' ? (
              <p>确认取消活动？本次取消不记处罚，将通知有效报名成员，报名与操作记录保留。</p>
            ) : (
              <>
                <p>全员同意后调整本期时间，成员名单及其他期次保持不变。</p>
                <Form.Item
                  name="startsAt"
                  label="开始日期和时间（北京时间）"
                  rules={[
                    { required: true, message: '请选择开始日期和时间' },
                    {
                      validator: (_, value: Dayjs | null) =>
                        !value || beijingTimestamp(value) > now
                          ? Promise.resolve()
                          : Promise.reject(new Error('请选择未来开始时间'))
                    }
                  ]}
                >
                  <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" />
                </Form.Item>
                <Form.Item
                  name="endsAt"
                  label="结束日期和时间（北京时间）"
                  dependencies={['startsAt']}
                  rules={[
                    { required: true, message: '请选择结束日期和时间' },
                    ({ getFieldValue }) => ({
                      validator: (_, value: Dayjs | null) =>
                        !value ||
                        !getFieldValue('startsAt') ||
                        beijingTimestamp(value) > beijingTimestamp(getFieldValue('startsAt'))
                          ? Promise.resolve()
                          : Promise.reject(new Error('结束时间须晚于开始时间'))
                    })
                  ]}
                >
                  <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" />
                </Form.Item>
                <Form.Item
                  name="allMembersAgreed"
                  valuePropName="checked"
                  rules={[
                    {
                      validator: (_, value: boolean) =>
                        value === true
                          ? Promise.resolve()
                          : Promise.reject(new Error('请先确认已征得全员同意'))
                    }
                  ]}
                >
                  <Checkbox>我已与全体成员沟通，并征得全员同意调整本期时间</Checkbox>
                </Form.Item>
              </>
            )}
            {uncertain ? (
              <p role="status">暂未确认提交结果，请重试原提交。</p>
            ) : changed ? (
              <p role="alert">活动或报名已变化，请返回并刷新详情。</p>
            ) : !eligible[confirmation.action] ? (
              <p role="alert">当前已不能执行本次操作，请返回并刷新详情。</p>
            ) : null}
            <Space wrap>
              <Button htmlType="button" disabled={busy} onClick={close}>
                返回
              </Button>
              {uncertain ? (
                <Button
                  htmlType="button"
                  type="primary"
                  danger={confirmation.action === 'cancel'}
                  loading={busy}
                  disabled={busy}
                  onClick={() => void submit()}
                >
                  重试原提交
                </Button>
              ) : (
                <Button
                  htmlType="submit"
                  type="primary"
                  danger={confirmation.action === 'cancel'}
                  loading={busy}
                  disabled={formDisabled}
                >
                  {confirmation.action === 'reschedule'
                    ? '确认改期本期'
                    : `确认${labels[confirmation.action]}`}
                </Button>
              )}
            </Space>
          </Form>
        ) : null}
      </Modal>
    </>
  );
}
