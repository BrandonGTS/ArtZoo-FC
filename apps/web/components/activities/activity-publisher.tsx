'use client';

import { useEffect, useRef, useState } from 'react';
import { useUserRouter as useRouter } from '../user-operation-provider';
import { toBeijingPicker } from '@artzoo/domain';
import { beijingPickerOffset } from '../beijing-picker';
import dayjs from 'dayjs';
import { useFeedbackMessage } from '../use-feedback-message';
import { useActivityResource } from './use-activity-resource';
import type { ActivityDetail, EditActivityInput } from '@artzoo/domain';
import { Alert, Button, Checkbox, Form, Input, type DatePickerProps } from 'antd';
import {
  AccountError,
  generateSeriesPeriods,
  ACTIVITY_LIMITS,
  activityAlbumName,
  dutyPresetSeats,
  type DutyCatalogList,
  type DutySeatTemplate,
  type DutySelectionInput,
  type DutyType,
  type PartyComposition,
  type ActivitySeriesInput,
  type ActivityScene,
  type ActivityMode,
  type ActivityCategory,
  type ActivityWriteResult,
  type CreateActivityInput,
  type SeatRequirement
} from '@artzoo/domain';
import { useAuthSession } from '../auth-session';
import { accountRequest, errorDetail } from '../account/api';
import { ErrorNotice } from '../account/account-ui';
import { PageHeading } from '../home-content';
import { ActivityHeading, ActivityLoadState, ActivityPaper, beijingFull } from './activity-ui';
import PublisherPreview from './activity-publisher-preview';
import PublisherBasicInformation from './activity-publisher-basic-information';
import PublisherTiming from './activity-publisher-timing';
import SeatPicker from './seat-picker';
import { repeatedWeekdays, templateSeatRole } from './publisher-rules';
import { splitActivityDescription, composeActivityDescription } from './activity-description';
import { useActivityEditFeedback } from './activity-edit-feedback';
import '../home-activities.css';
import './activity-publisher.css';
import './activity-album-fields.css';
import { useWishPublishing, publishWishActivity } from '../wishes/activity-publishing';

export type PickerDate = Exclude<NonNullable<DatePickerProps['value']>, unknown[]>;
export interface PublishForm {
  createAlbum?: boolean;
  scene: ActivityScene;
  mode: ActivityMode;
  location?: string;
  meetingInstructions?: string;
  registrationClosesAt?: PickerDate;
  capacityMode?: 'LIMITED' | 'UNLIMITED';
  durationMinutes?: number;
  weekdays?: number[];
  seriesEndKind?: 'COUNT' | 'DATE';
  periodCount?: number;
  seriesEndDate?: PickerDate;
  title: string;
  category: ActivityCategory;
  description?: string;
  requirements?: string;
  startsAt: PickerDate;
  endsAt: PickerDate;
  capacity: number;
  dutyType?: DutyType;
  dutyId?: string;
  customDutyName?: string;
  partyComposition?: PartyComposition;
}
function toBeijing(value: PickerDate) {
  return beijingPickerOffset(value.format('YYYY-MM-DDTHH:mm:00'));
}
export default function ActivityPublisher() {
  const { session, loading, error, refresh, openLogin } = useAuthSession();
  const owner = session?.user?.id;
  if (!owner)
    return (
      <main className="home-content activities-content" id="main-content">
        <ActivityHeading title="发布正式活动" />
        <ActivityLoadState loading={loading} error={error} retry={() => void refresh().catch(() => {})} />
        {!loading ? <Button onClick={() => openLogin('/activities/new')}>登录后发布活动</Button> : null}
      </main>
    );
  return <ActivityPublisherContent key={owner} />;
}
export function ActivityEditor({ id }: { id: string }) {
  const { session } = useAuthSession();
  const [reload, setReload] = useState(0);
  const router = useRouter();
  const notifyEdited = useActivityEditFeedback();
  const resource = useActivityResource<ActivityDetail>(
    `/api/activities/${encodeURIComponent(id)}?refresh=${reload}`
  );
  const { notify, contextHolder } = useFeedbackMessage();
  const activity = resource.data;
  if (!activity)
    return (
      <main className="home-content activities-content">
        <ActivityHeading title="修改活动" />
        <ActivityLoadState
          loading={resource.loading}
          error={resource.error}
          retry={() => setReload((value) => value + 1)}
        />
      </main>
    );
  if (
    !session?.user ||
    !activity.isOrganizer ||
    activity.cancelledAt ||
    Date.parse(activity.serverNow) >= Date.parse(activity.startsAt)
  ) {
    return (
      <main className="home-content activities-content">
        <ActivityHeading title="修改活动" />
        <p>仅发起者可以在活动开始前修改尚未取消的活动。</p>
        <Button type="link" className="activity-text-link" href={`/activities/${id}`}>
          返回活动详情
        </Button>
      </main>
    );
  }
  if (activity.scene === 'OFFLINE' || activity.mode === 'SERIES')
    return (
      <main className="home-content activities-content" id="main-content">
        <ActivityHeading title="修改活动" />
        <p>该活动不支持普通单次修改。</p>
        <Button type="link" className="activity-text-link" href={`/activities/${id}`}>
          返回活动详情
        </Button>
      </main>
    );
  return (
    <>
      {contextHolder}
      <ActivityPublisherContent
        key={session.user.id + ':' + activity.id + ':' + activity.revision}
        initialActivity={activity}
        onEdited={() => {
          notifyEdited();
          router.push(`/activities/${encodeURIComponent(id)}`);
        }}
        onEditFailure={(message) => notify('error', message)}
      />
    </>
  );
}
export function ActivityPublisherContent({
  initialActivity,
  onEdited,
  onEditFailure,
  guideSample
}: {
  initialActivity?: ActivityDetail;
  onEdited?(activity: ActivityDetail): void;
  onEditFailure?(message: string): void;
  guideSample?: { values: Partial<PublishForm>; template: DutySeatTemplate[] };
} = {}) {
  const router = useRouter();
  const wishSource = useWishPublishing();
  const { session, loading: authLoading } = useAuthSession();
  const [form] = Form.useForm<PublishForm>();
  const values = Form.useWatch([], { form, preserve: true }) as Partial<PublishForm> | undefined;
  const [seats, setSeats] = useState<(SeatRequirement | null)[]>(
    initialActivity?.seats.map((seat) => seat.requirement) ??
      guideSample?.template.map((seat) => seat.requirement) ??
      []
  );
  const [groupKeys, setGroupKeys] = useState<DutySeatTemplate['groupKey'][]>(
    initialActivity?.seats.map((seat) => seat.groupKey) ??
      guideSample?.template.map((seat) => seat.groupKey) ??
      []
  );
  const [seatTemplate, setSeatTemplate] = useState<readonly DutySeatTemplate[]>(
    initialActivity?.duty?.type === 'OTHER'
      ? dutyPresetSeats(initialActivity.duty.partyComposition)
      : (guideSample?.template ?? [])
  );
  const [manualWeekdays, setManualWeekdays] = useState<number[]>([]);
  const [catalog, setCatalog] = useState<DutyCatalogList | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    accountRequest<DutyCatalogList>('/api/activities/duties', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setCatalog(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setCatalogError(errorDetail(failure).message);
      });
    return () => controller.abort();
  }, []);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scene = values?.scene ?? initialActivity?.scene ?? 'GAME';
  const mode = scene === 'OFFLINE' ? 'SINGLE' : (values?.mode ?? initialActivity?.mode ?? 'SINGLE');
  const offline = scene === 'OFFLINE';
  const seriesMode = mode === 'SERIES';
  const category = offline ? 'SOCIAL' : values?.category || 'DUNGEON';
  const automaticWeekday = seriesMode && values?.startsAt ? values.startsAt.day() || 7 : null;
  useEffect(() => {
    if (!seriesMode) return;
    const next = repeatedWeekdays(manualWeekdays, automaticWeekday);
    if (JSON.stringify(form.getFieldValue('weekdays') ?? []) !== JSON.stringify(next))
      form.setFieldValue('weekdays', next);
  }, [form, seriesMode, automaticWeekday, manualWeekdays]);
  const startsAt = values?.startsAt ? toBeijing(values.startsAt) : null;
  const effectiveEnd =
    seriesMode && values?.startsAt && values.durationMinutes
      ? values.startsAt.add(values.durationMinutes, 'minute')
      : values?.endsAt;
  const endsAt = effectiveEnd ? toBeijing(effectiveEnd) : null;
  const cutoff = offline
    ? values?.registrationClosesAt
      ? beijingFull(toBeijing(values.registrationClosesAt))
      : '选择报名截止时间后显示'
    : startsAt
      ? beijingFull(new Date(Date.parse(startsAt) - 30 * 60000).toISOString())
      : '选择开始时间后显示';
  const canPublish = initialActivity ? initialActivity.isOrganizer : session?.user?.membership === 'MEMBER';
  const savedDescription = initialActivity ? splitActivityDescription(initialActivity.description) : null;
  const savedDuty = initialActivity?.duty;
  const savedCatalogDuty =
    savedDuty?.id && savedDuty.type !== 'OTHER'
      ? {
          ...savedDuty,
          id: savedDuty.id,
          type: savedDuty.type as Exclude<DutyType, 'OTHER'>,
          enabled: true,
          defaultSeats: savedDuty.finalSeats
        }
      : null;
  const selectedDuty =
    catalog?.items.find(
      (item) => item.enabled && item.id === values?.dutyId && item.type === values?.dutyType
    ) ??
    (savedCatalogDuty?.id === values?.dutyId && savedCatalogDuty?.type === values?.dutyType
      ? savedCatalogDuty
      : undefined);
  const effectiveSeatTemplate =
    initialActivity?.duty?.id && values?.dutyId === initialActivity.duty.id
      ? (catalog?.items.find((item) => item.id === values.dutyId)?.defaultSeats ?? seatTemplate)
      : seatTemplate;
  const customDuty = category === 'DUNGEON' && values?.dutyType === 'OTHER';
  const editableCapacity = offline
    ? values?.capacityMode !== 'UNLIMITED'
    : category === 'SOCIAL' || (customDuty && values?.partyComposition === 'CUSTOM');
  const catalogPending = !catalog && !catalogError;
  const dutyReady = offline || category === 'SOCIAL' || Boolean(catalog && (customDuty || selectedDuty));
  let periodPreview: ReturnType<typeof generateSeriesPeriods> = [];
  let periodError: string | null = null;
  if (
    seriesMode &&
    startsAt &&
    values?.durationMinutes &&
    values.weekdays?.length &&
    (values.seriesEndKind === 'DATE' ? values.seriesEndDate : values.periodCount)
  ) {
    try {
      periodPreview = generateSeriesPeriods(new Date(startsAt), {
        weekdays: values.weekdays,
        durationMinutes: values.durationMinutes,
        end:
          values.seriesEndKind === 'DATE'
            ? { kind: 'DATE', date: values.seriesEndDate!.format('YYYY-MM-DD') }
            : { kind: 'COUNT', count: values.periodCount! }
      });
    } catch (failure) {
      periodError =
        failure instanceof AccountError && failure.code === 'VALIDATION_ERROR'
          ? failure.message
          : '排期预览暂时无法生成，请稍后再操作。';
    }
  }
  function changeScene(next: ActivityScene) {
    form.setFieldsValue({
      scene: next,
      mode: 'SINGLE',
      category: next === 'OFFLINE' ? 'SOCIAL' : 'DUNGEON',
      capacity: undefined
    });
    resetDuty();
  }
  function applyTemplate(template: readonly DutySeatTemplate[]) {
    setSeatTemplate(template);
    setSeats(template.map((seat) => ({ ...seat.requirement })));
    setGroupKeys(template.map((seat) => seat.groupKey));
    form.setFieldValue('capacity', template.length || undefined);
    setError(null);
  }
  function resetDuty(nextType?: DutyType) {
    form.setFieldsValue({
      dutyId: undefined,
      customDutyName: undefined,
      partyComposition: nextType === 'OTHER' ? 'LIGHT' : undefined
    });
    applyTemplate(nextType === 'OTHER' ? dutyPresetSeats('LIGHT') : []);
  }
  function changeCategory(next: ActivityCategory) {
    form.setFieldValue('dutyType', undefined);
    resetDuty();
    if (next === 'SOCIAL')
      applyTemplate(Array.from({ length: 4 }, () => ({ groupKey: null, requirement: { kind: 'ANY' } })));
  }
  function resize(value: number | null) {
    if (offline) return;
    if (
      !editableCapacity ||
      value === null ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > ACTIVITY_LIMITS.seats
    )
      return;
    setSeats((current) => Array.from({ length: value }, (_, index) => current[index] ?? { kind: 'ANY' }));
    setGroupKeys(Array.from({ length: value }, () => null));
    setSeatTemplate([]);
  }
  async function publish(fields: PublishForm) {
    // A seeded guide uses this exact form, but can never enter the business command path.
    if (guideSample) return;
    if (pending.current) return;
    if (!canPublish) {
      setError('只有正式成员可以发起活动。');
      return;
    }
    if (!dutyReady) {
      setError(catalogError ? '副本目录读取失败，暂时无法发布副本活动。' : '请先选择副本类型和具体副本。');
      return;
    }
    let dutySelection: DutySelectionInput | null = null;
    if (!offline && fields.category === 'DUNGEON') {
      if (fields.dutyType === 'OTHER') {
        if (!fields.customDutyName?.trim() || !fields.partyComposition) {
          setError('请填写自定义副本名称并选择人数预设。');
          return;
        }
        dutySelection = {
          type: 'OTHER',
          name: fields.customDutyName.trim(),
          partyComposition: fields.partyComposition
        };
      } else {
        if (
          !selectedDuty ||
          fields.capacity !== selectedDuty.capacity ||
          seats.length !== selectedDuty.capacity
        ) {
          setError('副本人数与目录不一致，请重新选择副本。');
          return;
        }
        dutySelection = { type: selectedDuty.type, dutyId: selectedDuty.id };
      }
    }
    if (!offline && (!seats.length || seats.some((seat) => !seat))) {
      setError('请为每一个席位选择职能、职业或不限。');
      return;
    }
    const description = composeActivityDescription(
      fields.description,
      fields.requirements,
      initialActivity?.description
    );
    if (description.length > ACTIVITY_LIMITS.description) {
      setError(`活动安排与参与要求合计不能超过 ${ACTIVITY_LIMITS.description} 字。`);
      return;
    }
    const formatted = (value: PickerDate) =>
      initialActivity ? beijingPickerOffset(value.format('YYYY-MM-DDTHH:mm:ss')) : toBeijing(value);
    if (seriesMode && (periodError || !periodPreview.length)) {
      setError(periodError ? null : '请填写重复日期、每期时长和结束条件。');
      return;
    }
    const series: ActivitySeriesInput | undefined = seriesMode
      ? {
          weekdays: fields.weekdays!,
          durationMinutes: fields.durationMinutes!,
          end:
            fields.seriesEndKind === 'DATE'
              ? { kind: 'DATE', date: fields.seriesEndDate!.format('YYYY-MM-DD') }
              : { kind: 'COUNT', count: fields.periodCount! }
        }
      : undefined;
    const payload: Omit<CreateActivityInput, 'idempotencyKey'> = {
      ...(!initialActivity && fields.createAlbum
        ? { createAlbum: true, album: { name: activityAlbumName(fields.title), categoryId: null } }
        : {}),
      title: fields.title.trim(),
      category,
      description,
      dutySelection,
      startsAt: formatted(fields.startsAt),
      endsAt: formatted(seriesMode ? fields.startsAt.add(fields.durationMinutes!, 'minute') : fields.endsAt),
      seats: offline ? [] : (seats as SeatRequirement[]),
      ...(offline
        ? {
            scene: 'OFFLINE',
            mode: 'SINGLE',
            offline: {
              location: fields.location!.trim(),
              meetingInstructions: fields.meetingInstructions?.trim() ?? '',
              registrationClosesAt: formatted(fields.registrationClosesAt!),
              capacity: fields.capacityMode === 'UNLIMITED' ? null : fields.capacity
            }
          }
        : {}),
      ...(series ? { scene: 'GAME', mode: 'SERIES', series } : {})
    };
    const fingerprint = JSON.stringify(payload);
    if (uncertain && attempt.current?.fingerprint !== fingerprint) {
      setError('上次发布结果尚未确认，请先查看我的活动，或按原内容重试。');
      return;
    }
    if (!attempt.current || attempt.current.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = initialActivity
        ? await accountRequest<ActivityWriteResult>(`/api/activities/${initialActivity.id}`, {
            method: 'PATCH',
            body: {
              ...payload,
              idempotencyKey: attempt.current.key,
              expectedRevision: initialActivity.revision,
              seats: payload.seats.map((requirement, index) => ({
                id: initialActivity.seats[index]?.id ?? null,
                requirement
              }))
            } satisfies EditActivityInput
          })
        : wishSource
          ? await publishWishActivity(wishSource.id, { ...payload, idempotencyKey: attempt.current.key })
          : await accountRequest<ActivityWriteResult>('/api/activities', {
              method: 'POST',
              body: { ...payload, idempotencyKey: attempt.current.key } satisfies CreateActivityInput
            });
      if (!mounted.current) return;
      if (initialActivity) onEdited?.(result.activity);
      else router.push(`/activities/${result.activity.id}`);
    } catch (failure) {
      if (!mounted.current) return;
      const detail = errorDetail(failure);
      setError(detail.message);
      if (initialActivity) onEditFailure?.(detail.message);
      if (['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(detail.code)) setUncertain(true);
      if (detail.fieldErrors)
        form.setFields(
          Object.entries(detail.fieldErrors)
            .filter(([name]) =>
              [
                'title',
                'category',
                'startsAt',
                'endsAt',
                'dutyType',
                'dutyId',
                'customDutyName',
                'partyComposition',
                'capacity',
                'description',
                'requirements',
                'location',
                'meetingInstructions',
                'registrationClosesAt',
                'durationMinutes',
                'weekdays',
                'albumName',
                'albumCategoryId'
              ].includes(name)
            )
            .map(([name, message]) => ({ name: name as keyof PublishForm, errors: [message] }))
        );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="home-content activities-content activity-publisher-content" id="main-content">
      <ActivityHeading
        title={initialActivity ? '修改活动' : wishSource ? '创建关联正式活动' : '发布正式活动'}
      >
        <Button
          type="link"
          className="activity-text-link"
          href={
            initialActivity
              ? `/activities/${initialActivity.id}`
              : wishSource
                ? `/wishes/${wishSource.id}`
                : '/activities'
          }
        >
          {initialActivity ? '返回活动详情' : wishSource ? '返回心愿详情' : '返回正式活动'}
        </Button>
      </ActivityHeading>
      {!authLoading && !canPublish ? (
        <Alert type="info" title="只有正式成员可以发起正式活动；朋友可以报名参加活动。" />
      ) : null}
      <Form<PublishForm>
        autoComplete="off"
        form={form}
        layout="vertical"
        initialValues={
          initialActivity
            ? {
                scene: 'GAME',
                mode: 'SINGLE',
                title: initialActivity.title,
                category: initialActivity.category,
                description: savedDescription!.arrangement,
                requirements: savedDescription!.requirements ?? undefined,
                startsAt: dayjs(toBeijingPicker(new Date(initialActivity.startsAt), 'second')),
                endsAt: dayjs(toBeijingPicker(new Date(initialActivity.endsAt), 'second')),
                capacity: initialActivity.capacity,
                dutyType: savedDuty?.type,
                dutyId: savedDuty?.id ?? undefined,
                customDutyName: savedDuty?.type === 'OTHER' ? savedDuty.name : undefined,
                partyComposition: savedDuty?.partyComposition
              }
            : (guideSample?.values ?? {
                scene: 'GAME',
                mode: 'SINGLE',
                category: 'DUNGEON',
                capacityMode: 'LIMITED',
                seriesEndKind: 'COUNT',
                ...(wishSource ? { title: wishSource.title, description: wishSource.body } : {})
              })
        }
        onFinish={publish}
        disabled={busy || uncertain || !canPublish}
        scrollToFirstError={{ focus: true }}
        requiredMark={false}
      >
        <div className="activity-detail-layout">
          <div className="activity-publisher-main">
            <ActivityPaper>
              <PublisherBasicInformation
                initialActivity={initialActivity}
                offline={offline}
                category={category}
                catalogError={catalogError}
                catalogPending={catalogPending}
                catalog={catalog}
                busy={busy}
                uncertain={uncertain}
                canPublish={canPublish}
                customDuty={customDuty}
                values={values}
                savedCatalogDuty={savedCatalogDuty}
                form={form}
                applyTemplate={applyTemplate}
                selectedDuty={selectedDuty}
                editableCapacity={editableCapacity}
                changeScene={changeScene}
                changeCategory={changeCategory}
                resetDuty={resetDuty}
                resize={resize}
              />
              <PublisherTiming
                offline={offline}
                seriesMode={seriesMode}
                cutoff={cutoff}
                automaticWeekday={automaticWeekday}
                setManualWeekdays={setManualWeekdays}
                values={values}
                periodError={periodError}
                periodPreview={periodPreview}
                toBeijing={toBeijing}
              />
              <section className="activity-form-section">
                <h2 className="activity-publisher-section-title">活动安排</h2>
                <Form.Item
                  name="description"
                  label="活动安排"
                  rules={
                    initialActivity ? [] : [{ required: true, whitespace: true, message: '请填写活动安排' }]
                  }
                >
                  <Input.TextArea
                    data-help-target="activity-publish-arrangement"
                    autoComplete="off"
                    autoSize={{ minRows: 4, maxRows: 12 }}
                    maxLength={ACTIVITY_LIMITS.description}
                  />
                </Form.Item>
                <Form.Item
                  name="requirements"
                  label="参与要求"
                  rules={
                    initialActivity ? [] : [{ required: true, whitespace: true, message: '请填写参与要求' }]
                  }
                >
                  <Input.TextArea
                    data-help-target="activity-publish-requirements"
                    autoComplete="off"
                    autoSize={{ minRows: 3, maxRows: 8 }}
                    maxLength={ACTIVITY_LIMITS.description}
                  />
                </Form.Item>
              </section>
            </ActivityPaper>
            {!offline ? (
              <ActivityPaper className="activity-publisher-composition">
                <section className="activity-form-section">
                  <PageHeading decoration="tomato">队伍构成</PageHeading>
                  {!seats.length
                    ? null
                    : (groupKeys.includes('A') ? (['A', 'B', 'C'] as const) : [null]).map((group) => (
                        <div key={group || 'party'} className="activity-publisher-party">
                          {group ? <h3>{group}队 · 8人</h3> : null}
                          <div className="activity-seat-grid">
                            {seats.map((seat, index) =>
                              groupKeys[index] === group ? (
                                <SeatPicker
                                  key={index}
                                  value={seat}
                                  index={index}
                                  templateRole={templateSeatRole(effectiveSeatTemplate, index)}
                                  disabled={busy || uncertain || !canPublish || category === 'SOCIAL'}
                                  onChange={(value) =>
                                    setSeats((current) =>
                                      current.map((item, position) => (index === position ? value : item))
                                    )
                                  }
                                />
                              ) : null
                            )}
                          </div>
                        </div>
                      ))}
                </section>
              </ActivityPaper>
            ) : null}
          </div>
          <aside className="activity-publisher-aside">
            <ActivityPaper className="activity-summary activity-publisher-summary">
              <PublisherPreview
                scene={scene}
                mode={mode}
                category={category}
                offline={offline}
                seriesMode={seriesMode}
                customDuty={customDuty}
                values={values}
                startsAt={startsAt}
                endsAt={endsAt}
                periodCount={periodPreview.length}
                selectedDuty={selectedDuty}
                initialActivity={initialActivity}
                seats={seats}
              />
              <div className="activity-publisher-submit">
                <ErrorNotice message={error} />
                {uncertain ? (
                  <p role="status">
                    上次提交的结果尚未确认，已保留原内容。请先
                    <Button type="link" href="/me/activities" target="_blank">
                      查看我的活动
                    </Button>
                    ，或重试同一次发布。
                  </p>
                ) : null}
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={busy}
                  disabled={busy || !canPublish || !dutyReady}
                >
                  {initialActivity
                    ? uncertain
                      ? '重试本次修改'
                      : '保存修改'
                    : uncertain
                      ? '重试本次发布'
                      : '发布活动'}
                </Button>
              </div>
            </ActivityPaper>
            {!initialActivity ? (
              <ActivityPaper className="activity-album-fields">
                <section className="activity-form-section">
                  <PageHeading decoration="cheese">活动相册</PageHeading>
                  <Form.Item name="createAlbum" valuePropName="checked">
                    <Checkbox styles={{ root: { minHeight: 40, alignItems: 'center' } }}>
                      创建并关联活动相册
                    </Checkbox>
                  </Form.Item>
                  {values?.createAlbum ? (
                    <Form.Item label="相册名称">
                      <Input
                        autoComplete="off"
                        readOnly
                        value={activityAlbumName(values?.title || '')}
                        className="activity-album-name"
                        aria-label="自动生成的活动相册名称"
                      />
                    </Form.Item>
                  ) : null}
                </section>
              </ActivityPaper>
            ) : null}
          </aside>
        </div>
      </Form>
    </main>
  );
}
