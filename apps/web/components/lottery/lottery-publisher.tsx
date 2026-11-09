'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useUserRouter as useRouter } from '../user-operation-provider';
import { beijingDateKey, toBeijingPicker } from '@artzoo/domain';
import { beijingPickerOffset, beijingPickerTimestamp } from '../beijing-picker';
import dayjs, { type Dayjs } from 'dayjs';
import { Button, DatePicker, Form, Input, InputNumber, Select, Modal } from 'antd';
import { useAuthSession } from '../auth-session';
import { ActivityHeading } from '../activities/activity-ui';
import { accountRequest, errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import {
  prizeCount,
  validateLottery,
  beijingMonth,
  monthlyLotteryWindow,
  earliestMonthlyDrawAt,
  type LotteryInput,
  type LotteryView
} from '../../server/lottery/contract';
import { LoadState, LotteryPaper } from './lottery-ui';
import LotteryCard from './lottery-card';
import LotteryPrizeUpload from './lottery-prize-upload';
import '../activities/activity-publisher.css';
import {
  PUBLICATION_UNKNOWN,
  readPublicationAttempt,
  savePublicationAttempt,
  clearPublicationAttempt,
  publicationRemainsUnknown,
  type PublicationAttempt
} from './publication-recovery';
type Values = Omit<LotteryInput, 'idempotencyKey' | 'drawAt' | 'month'> & { month?: Dayjs; drawDate?: Dayjs };
const initial: Values = {
  title: '',
  kind: 'ORDINARY',
  mode: 'MANUAL',
  audience: 'MEMBER',
  minDays: null,
  prizes: [{ name: '', quantity: 1 }]
};
const subscribeHydration = () => () => {};
export default function LotteryPublisher({ demoValues }: { demoValues?: Partial<Values> } = {}) {
  const hydrated = useSyncExternalStore(
      subscribeHydration,
      () => true,
      () => false
    ),
    { session } = useAuthSession();
  // Mount an account-scoped form only after browser storage is available. A different
  // account receives fresh state, and cannot retry another account's saved request.
  return hydrated ? (
    <LotteryPublicationForm key={session?.user?.id ?? 'anonymous'} demoValues={demoValues} />
  ) : (
    <main className="home-content lottery-content" id="main-content">
      <ActivityHeading title="发布抽奖" />
      <LoadState loading error={null} />
    </main>
  );
}
function LotteryPublicationForm({ demoValues }: { demoValues?: Partial<Values> }) {
  const { session } = useAuthSession(),
    owner = session?.user?.id ?? null;
  const [restored] = useState(() => {
    try {
      return owner && !demoValues ? readPublicationAttempt(owner) : null;
    } catch {
      return null;
    }
  });
  const startingValues: Values = restored
    ? {
        ...structuredClone(restored.body),
        month: restored.body.month ? dayjs(restored.body.month + '-01') : undefined,
        drawDate: dayjs(restored.body.drawAt.slice(0, 19))
      }
    : { ...initial, ...demoValues };
  const [form] = Form.useForm<Values>(),
    values = Form.useWatch([], form) ?? startingValues,
    router = useRouter(),
    [busy, setBusy] = useState(false),
    { notify, contextHolder } = useFeedbackMessage();
  const [uncertain, setUncertain] = useState(!!restored),
    [completed, setCompleted] = useState(false),
    attempt = useRef<PublicationAttempt | null>(restored),
    inFlight = useRef(false),
    mounted = useRef(true);
  const [uploading, setUploading] = useState(0),
    [removePrize, setRemovePrize] = useState<number | null>(null);
  const [calendarNow, setCalendarNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const now = new Date();
      setCalendarNow(now);
      const today = beijingDateKey(now);
      const next = beijingPickerTimestamp(today + 'T00:00:00') + 86400000;
      clearTimeout(timer);
      timer = setTimeout(update, Math.max(100, next - now.getTime() + 100));
    };
    const activate = () => {
      if (document.visibilityState === 'visible') update();
    };
    update();
    window.addEventListener('focus', activate);
    document.addEventListener('visibilitychange', activate);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', activate);
      document.removeEventListener('visibilitychange', activate);
    };
  }, []);
  const ready = !!owner,
    locked = busy || uncertain || completed || !ready || uploading > 0;
  const restoredNotice = useRef(false);
  useEffect(() => {
    if (restored && !restoredNotice.current) {
      restoredNotice.current = true;
      notify('warning', PUBLICATION_UNKNOWN);
    }
  }, [restored, notify]);
  const monthly = values.kind === 'MONTHLY',
    monthMax = values.month ? monthlyLotteryWindow(values.month.format('YYYY-MM'), calendarNow).maxDays : 31,
    prizes = values.prizes ?? [],
    winners = prizeCount(prizes.map((p) => ({ ...p, quantity: p.quantity || 0 })));
  const canCreate =
    session?.user?.membership === 'MEMBER' || (session?.user && session.user.adminRole !== 'NONE');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function send(current: PublicationAttempt) {
    if (inFlight.current || !ready || current.owner !== owner || completed) return;
    const wasUnknown = current.uncertain;
    // Persist before POST: a lost response or reload must not mint another key.
    try {
      savePublicationAttempt(current);
    } catch {
      notify('error', '发布状态暂时无法保留，请刷新页面后重试。');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await accountRequest<{ lottery: LotteryView }>('/api/lotteries', {
        method: 'POST',
        body: current.body
      });
      if (!mounted.current) return;
      setCompleted(true);
      try {
        clearPublicationAttempt(current.owner);
      } catch {
        /* Keep a recoverable replay if storage is temporarily unavailable. */
      }
      notify('success', '抽奖已发布');
      router.push('/lotteries/' + result.lottery.id);
    } catch (e) {
      if (!mounted.current) return;
      const detail = errorDetail(e),
        unknown = publicationRemainsUnknown(wasUnknown, detail.code, detail.fieldErrors);
      current.uncertain = unknown;
      setUncertain(unknown);
      if (!unknown) {
        attempt.current = null;
        try {
          clearPublicationAttempt(current.owner);
        } catch {
          /* A retained old key is safer than an unchecked new submission. */
        }
      }
      const message = unknown ? PUBLICATION_UNKNOWN : detail.message;
      notify('error', message);
    } finally {
      if (mounted.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function submit(v: Values) {
    if (inFlight.current || !ready || completed) return;
    if (attempt.current?.uncertain) {
      await send(attempt.current);
      return;
    }
    if (!v.drawDate) {
      notify('error', '请选择开奖日期和时间');
      return;
    }
    try {
      const body = validateLottery(
        {
          idempotencyKey: crypto.randomUUID(),
          title: v.title,
          kind: v.kind,
          mode: v.mode,
          audience: v.audience,
          month: v.kind === 'MONTHLY' ? (v.month?.format('YYYY-MM') ?? null) : null,
          minDays: v.kind === 'MONTHLY' ? v.minDays : null,
          prizes: v.prizes,
          drawAt: beijingPickerOffset(v.drawDate.format('YYYY-MM-DDTHH:mm') + ':00')
        },
        new Date()
      );
      const current = { owner: owner!, body: structuredClone(body), uncertain: false };
      attempt.current = current;
      await send(current);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '请检查抽奖设置');
    }
  }
  const publish = (
    <div className="lottery-preview-actions">
      {uncertain ? (
        <p className="lottery-error" role="alert">
          {PUBLICATION_UNKNOWN}发布可能已成功，重试将沿用原请求。
        </p>
      ) : null}
      <Button
        type="primary"
        onClick={() => {
          if (uncertain) {
            if (attempt.current) void send(attempt.current);
          } else form.submit();
        }}
        loading={busy}
        disabled={busy || !ready || completed || uploading > 0}
      >
        {uncertain ? '重试本次发布' : '发布抽奖'}
      </Button>
    </div>
  );
  return (
    <main className="home-content lottery-content" id="main-content">
      {contextHolder}
      <ActivityHeading title="发布抽奖">
        <Link className="activity-text-link" href="/lotteries">
          ← 返回抽奖
        </Link>
      </ActivityHeading>
      {!canCreate ? (
        <p role="alert">仅正式成员和管理员可以发起抽奖。</p>
      ) : (
        <div className="lottery-layout lottery-publish">
          <LotteryPaper>
            <Form
              autoComplete="off"
              form={form}
              layout="vertical"
              initialValues={startingValues}
              onFinish={submit}
              disabled={locked}
              className="lottery-form"
            >
              <section className="lottery-form-group">
                <h3>基本信息</h3>
                <div className="lottery-setting-field">
                  <span className="lottery-setting-label">标题</span>
                  <Form.Item
                    name="title"
                    rules={[
                      { required: true, whitespace: true, message: '请填写标题' },
                      { max: 80, message: '标题最多80字' }
                    ]}
                  >
                    <Input autoComplete="off" aria-label="标题" maxLength={80} />
                  </Form.Item>
                </div>
                <div className="lottery-setting-field">
                  <span className="lottery-setting-label">抽奖类型</span>
                  <Form.Item name="kind">
                    <Select
                      aria-label="抽奖类型"
                      onChange={(kind) => form.setFieldValue('mode', kind === 'MONTHLY' ? 'AUTO' : 'MANUAL')}
                      options={[
                        { value: 'ORDINARY', label: '普通抽奖' },
                        { value: 'MONTHLY', label: '月签到抽奖' }
                      ]}
                    />
                  </Form.Item>
                </div>
                <div className="lottery-setting-field">
                  <span className="lottery-setting-label">参与方式</span>
                  <Form.Item name="mode">
                    <Select
                      aria-label="参与方式"
                      disabled
                      options={[
                        { value: 'MANUAL', label: '主动参加' },
                        { value: 'AUTO', label: '符合条件自动纳入' }
                      ]}
                    />
                  </Form.Item>
                </div>
                <div className="lottery-setting-field">
                  <span className="lottery-setting-label">资格范围</span>
                  <Form.Item name="audience">
                    <Select
                      aria-label="资格范围"
                      options={[
                        { value: 'MEMBER', label: '仅正式成员' },
                        { value: 'MEMBER_FRIEND', label: '正式成员与朋友' }
                      ]}
                    />
                  </Form.Item>
                </div>
                {monthly ? (
                  <div className="lottery-month-fields">
                    <Form.Item
                      name="month"
                      label="签到月份"
                      rules={[
                        { required: true, message: '请选择签到月份' },
                        {
                          validator: (_, value) =>
                            !value || value.format('YYYY-MM') >= beijingMonth(new Date())
                              ? Promise.resolve()
                              : Promise.reject(new Error('请选择当月或未来签到月份'))
                        }
                      ]}
                    >
                      <DatePicker
                        classNames={{ popup: { root: 'activity-publisher-date-popup' } }}
                        popupAlign={{
                          offset: [0, 0],
                          overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true }
                        }}
                        picker="month"
                        placeholder="选择月份"
                        disabledDate={(d) => d.format('YYYY-MM') < beijingMonth(new Date())}
                      />
                    </Form.Item>
                    <Form.Item
                      name="minDays"
                      label="当月至少签到 N 天"
                      dependencies={['month']}
                      rules={[
                        { required: true, message: '请填写签到门槛' },
                        {
                          validator: (_, value) =>
                            value == null ||
                            (Number.isInteger(value) &&
                              value >= 1 &&
                              value <=
                                (form.getFieldValue('month')
                                  ? monthlyLotteryWindow(
                                      form.getFieldValue('month').format('YYYY-MM'),
                                      new Date()
                                    ).maxDays
                                  : 31))
                              ? Promise.resolve()
                              : Promise.reject(
                                  new Error(
                                    `签到天数需为1–${form.getFieldValue('month') ? monthlyLotteryWindow(form.getFieldValue('month').format('YYYY-MM'), new Date()).maxDays : 31}`
                                  )
                                )
                        }
                      ]}
                    >
                      <InputNumber min={1} max={monthMax} precision={0} placeholder="填写 N" />
                    </Form.Item>
                  </div>
                ) : null}
              </section>
              <section className="lottery-form-group">
                <h3>抽奖时间</h3>
                <div className="lottery-setting-field">
                  <span className="lottery-setting-label">开奖时间</span>
                  <Form.Item
                    name="drawDate"
                    dependencies={['kind', 'month', 'minDays']}
                    rules={[
                      { required: true, message: '请选择开奖日期和时间' },
                      {
                        validator: (_, value) => {
                          const month = form.getFieldValue('month'),
                            n = form.getFieldValue('minDays');
                          if (
                            !value ||
                            form.getFieldValue('kind') !== 'MONTHLY' ||
                            !month ||
                            !Number.isInteger(n) ||
                            n < 1 ||
                            n > monthlyLotteryWindow(month.format('YYYY-MM'), new Date()).maxDays
                          )
                            return Promise.resolve();
                          const earliest = earliestMonthlyDrawAt(month.format('YYYY-MM'), n, new Date());
                          return beijingPickerTimestamp(value.format('YYYY-MM-DDTHH:mm') + ':00') >=
                            earliest.getTime()
                            ? Promise.resolve()
                            : Promise.reject(
                                new Error(
                                  '开奖时间不得早于 ' +
                                    toBeijingPicker(earliest).replace('T', ' ') +
                                    '（北京时间）'
                                )
                              );
                        }
                      }
                    ]}
                  >
                    <DatePicker
                      classNames={{ popup: { root: 'activity-publisher-date-popup' } }}
                      popupAlign={{
                        offset: [0, 0],
                        overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true }
                      }}
                      aria-label="开奖时间（北京时间）"
                      showTime={{ format: 'HH:mm' }}
                      format="YYYY年MM月DD日 HH:mm"
                      placeholder="选择开奖日期和时间（北京时间）"
                    />
                  </Form.Item>
                </div>
              </section>
              <section className="lottery-form-group">
                <h3>奖品</h3>
                <Form.List name="prizes">
                  {(fields, { add, remove }) => (
                    <div className="lottery-stack">
                      {fields.map(({ key: fieldKey, name, ...rest }) => (
                        <div className="lottery-prize-field" key={fieldKey}>
                          <Form.Item {...rest} name={[name, 'imageUrl']} label="图片">
                            <LotteryPrizeUpload
                              disabled={locked}
                              onBusyChange={(value) =>
                                setUploading((count) => Math.max(0, count + (value ? 1 : -1)))
                              }
                            />
                          </Form.Item>
                          <Form.Item
                            {...rest}
                            name={[name, 'name']}
                            label="奖品描述"
                            rules={[
                              { required: true, whitespace: true, message: '请填写奖品描述' },
                              { max: 80, message: '奖品描述最多80字' }
                            ]}
                          >
                            <Input autoComplete="off" maxLength={80} />
                          </Form.Item>
                          <Form.Item
                            {...rest}
                            name={[name, 'quantity']}
                            label="份数"
                            rules={[{ required: true, message: '请填写份数' }]}
                          >
                            <InputNumber min={1} max={1000} precision={0} />
                          </Form.Item>
                          {fields.length > 1 ? (
                            <Button
                              type="text"
                              danger
                              onClick={() => setRemovePrize(name)}
                              aria-label={`移除奖品${name + 1}`}
                            >
                              移除
                            </Button>
                          ) : null}
                        </div>
                      ))}
                      <div>
                        <Button
                          onClick={() => add({ name: '', quantity: 1 })}
                          disabled={locked || fields.length >= 20}
                        >
                          ＋ 添加奖品
                        </Button>
                      </div>
                      <Modal
                        open={removePrize !== null}
                        title="移除奖品"
                        onCancel={() => setRemovePrize(null)}
                        onOk={() => {
                          if (removePrize !== null && !locked) {
                            remove(removePrize);
                            setRemovePrize(null);
                          }
                        }}
                        okText="确认移除"
                        cancelText="取消"
                        okButtonProps={{ danger: true, disabled: locked }}
                      >
                        <p>确认移除这项奖品？</p>
                      </Modal>
                    </div>
                  )}
                </Form.List>
                <div className="lottery-setting-field lottery-winner-count">
                  <span className="lottery-setting-label">中奖人数</span>
                  <Form.Item>
                    <InputNumber value={winners} disabled aria-label="中奖人数" />
                  </Form.Item>
                </div>
              </section>
            </Form>
          </LotteryPaper>
          <aside className="lottery-preview" aria-label="实时预览">
            <LotteryCard
              motion={false}
              row={{
                title: values.title,
                kind: values.kind,
                mode: values.mode,
                audience: values.audience,
                month: values.month?.format('YYYY-MM') ?? null,
                minDays: values.minDays,
                prizes: prizes.map((p) => ({ ...p, quantity: p.quantity || 0 })),
                drawAt: values.drawDate
                  ? beijingPickerOffset(values.drawDate.format('YYYY-MM-DDTHH:mm') + ':00')
                  : undefined,
                creator: { id: owner ?? '', displayName: session?.user?.displayName || '成员' },
                participation: '尚未发布'
              }}
              footer={publish}
            />
          </aside>
        </div>
      )}
    </main>
  );
}
