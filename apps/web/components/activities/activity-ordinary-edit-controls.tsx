'use client';

import { useEffect, useRef, useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import { Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Space } from 'antd';
import { toBeijingPicker } from '@artzoo/domain';
import { beijingPickerTimestamp } from '../beijing-picker';
import type { ActivityDetail, ActivityWriteResult } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { composeActivityDescription, splitActivityDescription } from './activity-description';
import { serializeOrdinaryEditTime } from './activity-edit-time';
import './activity-publisher.css';

type Props = {
  activity: ActivityDetail;
  now: number;
  onRecoveryChange?(needed: boolean): void;
  onResult(result: ActivityWriteResult): void;
  onRefresh(): void;
  onFeedback(kind: 'success' | 'error', text: string): void;
};
type Fields = {
  title?: string;
  arrangement?: string;
  requirements?: string;
  startsAt?: Dayjs;
  endsAt?: Dayjs;
  registrationClosesAt?: Dayjs;
  location?: string;
  meetingInstructions?: string;
  capacityUnlimited?: boolean;
  capacity?: number | null;
};
type Payload = {
  idempotencyKey: string;
  expectedRevision: number;
  description: string;
  expectedPeriods?: { id: string; revision: number }[];
  title?: string;
  startsAt?: string;
  endsAt?: string;
  registrationClosesAt?: string;
  location?: string;
  meetingInstructions?: string;
  capacity?: number | null;
};
type Confirmation = {
  snapshot: ActivityDetail;
  action: 'description' | 'edit';
  key: string;
  values: Fields;
  previousDescription: string;
  expectedRevision: number;
  expectedPeriods?: { id: string; revision: number }[];
  request?: Payload;
  uncertain: boolean;
};
function picker(value: string) {
  return dayjs(toBeijingPicker(new Date(value)));
}
function serialized(value: Dayjs, original: string) {
  return serializeOrdinaryEditTime(value.format('YYYY-MM-DDTHH:mm'), original);
}
function instant(value: Dayjs, original: string) {
  const result = serialized(value, original);
  return result.length === 16 ? beijingPickerTimestamp(result + ':00') : Date.parse(result);
}
function fields(activity: ActivityDetail): Fields {
  const description = splitActivityDescription(activity.description);
  return {
    title: activity.title,
    arrangement: description.arrangement,
    requirements: description.requirements ?? '',
    startsAt: picker(activity.startsAt),
    endsAt: picker(activity.endsAt),
    registrationClosesAt: picker(activity.registrationClosesAt),
    location: activity.location ?? '',
    meetingInstructions: activity.meetingInstructions ?? '',
    capacityUnlimited: !!activity.capacityUnlimited,
    capacity: activity.capacityUnlimited ? null : activity.capacity
  };
}

export default function ActivityOrdinaryEditControls({
  activity,
  now,
  onResult,
  onRefresh,
  onFeedback,
  onRecoveryChange
}: Props) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const mounted = useRef(false),
    pending = useRef(false),
    liveKey = useRef<string | null>(null);
  const reading = useRef(false),
    readNonce = useRef(0),
    readAbort = useRef<AbortController | null>(null),
    latest = useRef({ activity, now });
  useEffect(() => {
    latest.current = { activity, now };
  }, [activity, now]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      liveKey.current = null;
      readAbort.current?.abort();
    };
  }, []);
  const offline = activity.scene === 'OFFLINE' && activity.mode !== 'SERIES';
  const series =
    activity.scene === 'GAME' && activity.mode === 'SERIES' && activity.series?.state === 'FORMED';
  const eligible =
    activity.isOrganizer &&
    !activity.cancelledAt &&
    (offline
      ? now < Date.parse(activity.startsAt)
      : series &&
        !!activity.series?.periods.some(
          (period) => !period.cancelledAt && now < Date.parse(period.startsAt)
        ));
  const changed =
    !!confirmation &&
    (confirmation.snapshot.id !== activity.id ||
      confirmation.snapshot.revision !== activity.revision ||
      (confirmation.action === 'description' &&
        JSON.stringify(
          confirmation.snapshot.series?.periods.map((period) => [period.id, period.revision])
        ) !== JSON.stringify(activity.series?.periods.map((period) => [period.id, period.revision]))));
  const uncertain = !!confirmation?.uncertain,
    disabled = busy || uncertain || changed || !eligible;
  useEffect(() => {
    onRecoveryChange?.(uncertain);
    return () => onRecoveryChange?.(false);
  }, [uncertain, onRecoveryChange]);
  async function open() {
    if (pending.current || reading.current) return;
    if (confirmation?.uncertain) {
      setVisible(true);
      return;
    }
    if (!eligible) return;
    const key = crypto.randomUUID();
    liveKey.current = key;
    if (offline) {
      setConfirmation({
        snapshot: activity,
        action: 'edit',
        key,
        values: fields(activity),
        previousDescription: activity.description,
        expectedRevision: activity.revision,
        uncertain: false
      });
      setVisible(true);
      return;
    }
    const target = activity.series?.periods
      .filter((period) => !period.cancelledAt && now < Date.parse(period.startsAt))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.number - b.number)[0];
    if (!target) return;
    const nonce = ++readNonce.current,
      controller = new AbortController();
    readAbort.current = controller;
    const currentRead = () => mounted.current && nonce === readNonce.current && liveKey.current === key;
    reading.current = true;
    setLoading(true);
    setVisible(true);
    setConfirmation(null);
    let fresh: ActivityDetail;
    try {
      fresh = await accountRequest<ActivityDetail>(`/api/activities/${encodeURIComponent(target.id)}`, {
        signal: controller.signal
      });
    } catch (failure) {
      if (!currentRead()) return;
      liveKey.current = null;
      setVisible(false);
      // Reads have no uncertain write to recover; leave no stale editor open.
      const detail = errorDetail(failure);
      onFeedback('error', detail.message);
      if (['UNAUTHENTICATED', 'FORBIDDEN', 'CONFLICT', 'NOT_FOUND'].includes(detail.code)) onRefresh();
      return;
    } finally {
      if (mounted.current && nonce === readNonce.current) {
        reading.current = false;
        readAbort.current = null;
        setLoading(false);
      }
    }
    if (!currentRead()) return;
    const current = latest.current,
      effectiveNow = Math.max(current.now, Date.parse(fresh.serverNow));
    const anchor = fresh.series?.periods.find((period) => period.id === activity.id);
    const future = fresh.series?.periods
      .filter((period) => !period.cancelledAt && effectiveNow < Date.parse(period.startsAt))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.number - b.number)[0];
    const changedWhileReading =
      current.activity.id !== activity.id ||
      current.activity.revision !== activity.revision ||
      JSON.stringify(current.activity.series?.periods) !== JSON.stringify(activity.series?.periods);
    if (
      changedWhileReading ||
      !current.activity.isOrganizer ||
      current.activity.cancelledAt ||
      current.activity.series?.state !== 'FORMED' ||
      fresh.id !== target.id ||
      !fresh.isOrganizer ||
      fresh.scene !== 'GAME' ||
      fresh.mode !== 'SERIES' ||
      fresh.series?.id !== activity.series?.id ||
      fresh.series?.state !== 'FORMED' ||
      fresh.cancelledAt ||
      !future ||
      future.id !== fresh.id ||
      !anchor ||
      anchor.cancelledAt
    ) {
      liveKey.current = null;
      setVisible(false);
      onFeedback('error', '活动已变化，请刷新详情后修改。');
      onRefresh();
      return;
    }
    setConfirmation({
      snapshot: activity,
      action: 'description',
      key,
      values: fields(fresh),
      previousDescription: fresh.description,
      expectedRevision: anchor.revision,
      expectedPeriods: fresh.series.periods.map((period) => ({ id: period.id, revision: period.revision })),
      uncertain: false
    });
  }
  function close() {
    if (pending.current) return;
    readNonce.current++;
    readAbort.current?.abort();
    readAbort.current = null;
    reading.current = false;
    setLoading(false);
    setVisible(false);
    if (!confirmation?.uncertain) {
      liveKey.current = null;
      setConfirmation(null);
    }
  }
  async function submit(values?: Fields) {
    if (
      !mounted.current ||
      pending.current ||
      !confirmation ||
      liveKey.current !== confirmation.key ||
      confirmation.snapshot.id !== activity.id
    )
      return;
    if (!confirmation.uncertain && (!eligible || changed)) return;
    const command = confirmation,
      original = command.snapshot;
    let request = command.uncertain ? command.request : undefined;
    if (!request) {
      if (!values) return;
      const description = composeActivityDescription(
        values.arrangement,
        values.requirements,
        command.previousDescription
      );
      if (description.length > 2000) return;
      request = { idempotencyKey: command.key, expectedRevision: command.expectedRevision, description };
      if (command.action === 'description') request.expectedPeriods = command.expectedPeriods;
      else {
        if (!values.startsAt || !values.endsAt || !values.registrationClosesAt) return;
        request = {
          ...request,
          title: values.title ?? '',
          location: values.location ?? '',
          meetingInstructions: values.meetingInstructions ?? '',
          startsAt: serialized(values.startsAt, original.startsAt),
          endsAt: serialized(values.endsAt, original.endsAt),
          registrationClosesAt: serialized(values.registrationClosesAt, original.registrationClosesAt),
          capacity: values.capacityUnlimited ? null : values.capacity
        };
      }
    }
    const body = request;
    pending.current = true;
    setBusy(true);
    let result: ActivityWriteResult;
    try {
      result = await accountRequest<ActivityWriteResult>(
        `/api/activities/${original.id}/ordinary-management/${command.action}`,
        { method: 'POST', body }
      );
    } catch (failure) {
      if (!mounted.current) return;
      const detail = errorDetail(failure),
        unknown = ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(detail.code);
      setConfirmation((current) =>
        current?.key === command.key
          ? {
              ...current,
              values: values ?? current.values,
              request: unknown ? body : undefined,
              uncertain: unknown
            }
          : current
      );
      onFeedback('error', detail.message);
      if (['UNAUTHENTICATED', 'FORBIDDEN', 'CONFLICT', 'NOT_FOUND'].includes(detail.code)) {
        liveKey.current = null;
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
    liveKey.current = null;
    setVisible(false);
    setConfirmation(null);
    onFeedback('success', command.action === 'description' ? '活动说明已更新' : '活动已修改');
    onResult(result);
  }
  const original = confirmation?.snapshot;
  return (
    <>
      {eligible || uncertain ? (
        <section className="activity-copy-section" aria-label="修改活动">
          <hr className="activity-detail-divider" />
          <Button
            htmlType="button"
            block
            loading={loading}
            disabled={busy || loading}
            onClick={() => void open()}
          >
            {uncertain ? '重试原提交' : offline ? '修改活动' : '修改活动说明'}
          </Button>
        </section>
      ) : null}
      <Modal
        open={visible && (!!confirmation || loading)}
        title={confirmation?.action === 'edit' ? '修改活动' : '修改活动说明'}
        footer={null}
        destroyOnHidden
        onCancel={close}
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
      >
        {loading ? <p role="status">正在读取活动说明…</p> : null}
        {confirmation && original ? (
          <Form<Fields>
            autoComplete="off"
            key={confirmation.key}
            layout="vertical"
            disabled={disabled}
            preserve={false}
            initialValues={confirmation.values}
            onFinish={(values) => void submit(values)}
          >
            {confirmation.action === 'description' ? (
              <p>保存后更新尚未开始的期次，已开始和历史内容保留。</p>
            ) : null}
            {confirmation.action === 'edit' ? (
              <>
                <h3 className="activity-publisher-section-title">基本信息</h3>
                <Form.Item
                  name="title"
                  label="活动名称"
                  rules={[
                    { required: true, whitespace: true, message: '请填写活动名称' },
                    { max: 100, message: '活动名称不能超过100字' }
                  ]}
                >
                  <Input autoComplete="off" maxLength={100} />
                </Form.Item>
                <Form.Item name="capacityUnlimited" valuePropName="checked">
                  <Checkbox>不限人数</Checkbox>
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(previous, current) =>
                    previous.capacityUnlimited !== current.capacityUnlimited
                  }
                >
                  {({ getFieldValue }) => (
                    <Form.Item
                      name="capacity"
                      label="人数上限"
                      dependencies={['capacityUnlimited']}
                      rules={[
                        {
                          validator: (_, value?: number | null) =>
                            getFieldValue('capacityUnlimited') ||
                            (Number.isInteger(value) &&
                              Number(value) >= Math.max(1, activity.registeredCount) &&
                              Number(value) <= 200)
                              ? Promise.resolve()
                              : Promise.reject(
                                  new Error(
                                    activity.registeredCount > 200
                                      ? '当前报名人数超过200人，请保留不限人数'
                                      : `人数上限须为${Math.max(1, activity.registeredCount)}至200人`
                                  )
                                )
                        }
                      ]}
                    >
                      <InputNumber
                        min={1}
                        max={200}
                        precision={0}
                        disabled={disabled || !!getFieldValue('capacityUnlimited')}
                      />
                    </Form.Item>
                  )}
                </Form.Item>
                <Form.Item
                  name="location"
                  label="活动地点"
                  rules={[
                    { required: true, whitespace: true, message: '请填写活动地点' },
                    { max: 500, message: '活动地点不能超过500字' }
                  ]}
                >
                  <Input autoComplete="off" maxLength={500} />
                </Form.Item>
              </>
            ) : null}
            {confirmation.action === 'edit' ? (
              <>
                <h3 className="activity-publisher-section-title">活动时间 · 北京时间</h3>
                <Form.Item
                  name="startsAt"
                  label="开始日期和时间（北京时间）"
                  rules={[
                    { required: true, message: '请选择开始日期和时间' },
                    {
                      validator: (_, value?: Dayjs) =>
                        !value || instant(value, original.startsAt) > now
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
                      validator: (_, value?: Dayjs) =>
                        !value ||
                        !getFieldValue('startsAt') ||
                        instant(value, original.endsAt) >
                          instant(getFieldValue('startsAt'), original.startsAt)
                          ? Promise.resolve()
                          : Promise.reject(new Error('结束时间须晚于开始时间'))
                    })
                  ]}
                >
                  <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" />
                </Form.Item>
                <Form.Item
                  name="registrationClosesAt"
                  label="报名截止（北京时间）"
                  dependencies={['startsAt']}
                  rules={[
                    { required: true, message: '请选择报名截止时间' },
                    ({ getFieldValue }) => ({
                      validator: (_, value?: Dayjs) => {
                        if (!value) return Promise.resolve();
                        const cutoff = instant(value, original.registrationClosesAt),
                          start = getFieldValue('startsAt') as Dayjs | undefined;
                        if (start && cutoff > instant(start, original.startsAt))
                          return Promise.reject(new Error('报名截止不能晚于开始时间'));
                        return Date.parse(original.registrationClosesAt) <= now && cutoff > now
                          ? Promise.reject(new Error('报名已截止，不能延长截止时间重新开放报名'))
                          : Promise.resolve();
                      }
                    })
                  ]}
                >
                  <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" />
                </Form.Item>
              </>
            ) : null}
            <h3 className="activity-publisher-section-title">活动安排</h3>
            <Form.Item
              name="arrangement"
              label="活动安排"
              rules={[{ max: 2000, message: '活动安排不能超过2000字' }]}
            >
              <Input.TextArea autoComplete="off" autoSize={{ minRows: 4, maxRows: 12 }} maxLength={2000} />
            </Form.Item>
            <Form.Item
              name="requirements"
              label="参与要求"
              dependencies={['arrangement']}
              rules={[
                ({ getFieldValue }) => ({
                  validator: (_, value?: string) =>
                    composeActivityDescription(
                      getFieldValue('arrangement'),
                      value,
                      confirmation.previousDescription
                    ).length <= 2000
                      ? Promise.resolve()
                      : Promise.reject(new Error('活动安排与参与要求合计不能超过2000字'))
                })
              ]}
            >
              <Input.TextArea autoComplete="off" autoSize={{ minRows: 3, maxRows: 8 }} maxLength={2000} />
            </Form.Item>
            {confirmation.action === 'edit' ? (
              <>
                {'          '}
                <Form.Item
                  name="meetingInstructions"
                  label="地址与集合说明"
                  rules={[{ max: 2000, message: '地址与集合说明不能超过2000字' }]}
                >
                  <Input.TextArea autoComplete="off" autoSize={{ minRows: 3, maxRows: 8 }} maxLength={2000} />
                </Form.Item>
              </>
            ) : null}
            {uncertain ? (
              <p role="status">暂未确认提交结果，请重试原提交。</p>
            ) : changed ? (
              <p role="alert">活动已变化，请返回并刷新详情。</p>
            ) : !eligible ? (
              <p role="alert">当前已不能修改，请返回并刷新详情。</p>
            ) : null}
            <Space wrap>
              <Button htmlType="button" disabled={busy} onClick={close}>
                返回
              </Button>
              {uncertain ? (
                <Button
                  htmlType="button"
                  type="primary"
                  loading={busy}
                  disabled={busy}
                  onClick={() => void submit()}
                >
                  重试原提交
                </Button>
              ) : (
                <Button htmlType="submit" type="primary" loading={busy} disabled={disabled}>
                  保存修改
                </Button>
              )}
            </Space>
          </Form>
        ) : null}
      </Modal>
    </>
  );
}
