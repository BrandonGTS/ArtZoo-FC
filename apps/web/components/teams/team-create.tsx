'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Card, Form, Input, Select } from 'antd';
import {
  DUTY_TYPES,
  TEAM_POSITIONS,
  type DutyCatalogList,
  type DutyType,
  type TeamSeatInput,
  type TeamSeatView,
  type TeamWriteResult
} from '@artzoo/domain';
import { useAuthSession } from '../auth-session';
import { accountRequest, errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import { PageHeading } from '../home-content';
import { ActivityHeading, ActivityPaper, RequirementIcon, requirementLabel } from '../activities/activity-ui';
import { rememberCreatedTeam } from './team-feedback';
import { TeamAuthor, TeamFact, TeamCompactRoster } from './team-ui';
import SeatPicker from '../activities/seat-picker';
import '../activities/activity-publisher.css';
import '../home-activities.css';
import './team-create.css';

interface TeamCreateFields {
  name: string;
  description?: string;
  dutyName: string;
  progress: string;
  strategy: string;
  commonTimes: string;
  qqGroupId?: string;
}
export default function TeamCreate() {
  const { session } = useAuthSession();
  return session?.user ? <OwnedTeamCreate key={session.user.id} /> : null;
}
function OwnedTeamCreate() {
  const { session, avatar } = useAuthSession(),
    router = useRouter(),
    { notify, contextHolder } = useFeedbackMessage();
  const [form] = Form.useForm<TeamCreateFields>(),
    values = Form.useWatch([], form);
  const [busy, setBusy] = useState(false),
    [seats, setSeats] = useState<Pick<TeamSeatInput, 'position' | 'requirement'>[]>(() =>
      TEAM_POSITIONS.map((_, position) => ({
        position,
        requirement: { kind: 'ROLE', role: position < 2 ? 'TANK' : position < 4 ? 'HEALER' : 'DAMAGE' }
      }))
    );
  const [dutyType, setDutyType] = useState<DutyType>(),
    [catalog, setCatalog] = useState<DutyCatalogList | null>(null),
    [catalogError, setCatalogError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void accountRequest<DutyCatalogList>('/api/activities/duties', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setCatalog(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setCatalogError(errorDetail(failure).message);
      });
    return () => controller.abort();
  }, []);
  const pending = useRef(false),
    attempt = useRef<{ signature: string; key: string } | null>(null),
    uncertain = useRef(false);
  const allowed = session?.user?.membership === 'MEMBER';
  function patch(position: number, value: Partial<Pick<TeamSeatInput, 'requirement'>>) {
    setSeats((current) => current.map((seat, index) => (index === position ? { ...seat, ...value } : seat)));
  }
  async function submit(fields: TeamCreateFields) {
    if (!allowed || pending.current) return;
    const body = {
      name: fields.name,
      description: fields.description ?? '',
      dutyName: fields.dutyName,
      progress: fields.progress,
      strategy: fields.strategy,
      commonTimes: fields.commonTimes,
      qqGroupId: fields.qqGroupId?.trim() || null,
      seats
    };
    const signature = JSON.stringify(body);
    if (uncertain.current && attempt.current?.signature !== signature) {
      notify('error', '上次建队结果尚未确认，请按原内容重试或查看我的队伍。');
      return;
    }
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    pending.current = true;
    setBusy(true);
    try {
      const result = await accountRequest<TeamWriteResult>('/api/teams', {
        method: 'POST',
        body: { ...body, idempotencyKey: attempt.current!.key }
      });
      if (!mounted.current) return;
      rememberCreatedTeam(session!.user!.id, result.team.id);
      router.push('/teams/' + result.team.id);
    } catch (failure) {
      if (!mounted.current) return;
      const error = errorDetail(failure);
      uncertain.current = ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(error.code);
      if (!uncertain.current) attempt.current = null;
      notify('error', error.message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const previewSeats: TeamSeatView[] = seats.map((seat) => ({
    id: String(seat.position),
    position: seat.position,
    requirement: seat.requirement,
    pendingApplicationCount: 0,
    member: null
  }));
  return (
    <main className="home-content teams-content" id="main-content">
      {contextHolder}
      <ActivityHeading title="创建固定队">
        <Link className="activity-text-link" href="/teams">
          返回队伍招募
        </Link>
      </ActivityHeading>
      <Form
        autoComplete="off"
        form={form}
        layout="vertical"
        onFinish={submit}
        disabled={busy || !allowed}
        requiredMark={false}
        initialValues={{ description: '', commonTimes: '', qqGroupId: '' }}
      >
        <div className="activity-detail-layout team-create-layout">
          <div className="team-create-main">
            <ActivityPaper className="team-create-information">
              <section className="team-create-section">
                <h2 className="activity-publisher-section-title">基本信息</h2>
                <Form.Item
                  name="name"
                  label="队伍名称"
                  rules={[{ required: true, whitespace: true, message: '请填写队伍名称' }, { max: 100 }]}
                >
                  <Input autoComplete="off" maxLength={100} />
                </Form.Item>
                <Form.Item name="description" label="队伍简介">
                  <Input.TextArea autoComplete="off" maxLength={2000} autoSize={{ minRows: 3, maxRows: 8 }} />
                </Form.Item>
                <div className="team-create-columns">
                  <Form.Item label="副本类型">
                    <Select
                      aria-label="副本类型"
                      value={dutyType}
                      placeholder="选择副本类型"
                      options={DUTY_TYPES.map((type) => ({
                        ...type,
                        disabled: type.value !== 'OTHER' && !catalog
                      }))}
                      onChange={(value: DutyType) => {
                        setDutyType(value);
                        form.setFieldValue('dutyName', undefined);
                      }}
                    />
                  </Form.Item>
                  <Form.Item
                    name="dutyName"
                    label="具体副本"
                    rules={[
                      { required: true, whitespace: true, message: '请填写或选择具体副本' },
                      { max: 200 }
                    ]}
                  >
                    {dutyType === 'OTHER' ? (
                      <Input autoComplete="off" maxLength={200} placeholder="填写其他副本名称" />
                    ) : (
                      <Select
                        aria-label="具体副本"
                        placeholder={dutyType ? '搜索并选择副本' : '先选择副本类型'}
                        disabled={!dutyType || !catalog || busy || !allowed}
                        showSearch={{ optionFilterProp: 'label' }}
                        notFoundContent="没有符合条件的副本"
                        options={(catalog?.items ?? [])
                          .filter((item) => item.enabled && item.type === dutyType)
                          .map((item) => ({ value: item.name, label: item.name }))}
                      />
                    )}
                  </Form.Item>
                </div>
                {catalogError ? (
                  <p role="status">副本目录读取失败：{catalogError}，可选择“其他”填写副本名称。</p>
                ) : null}
                <Form.Item
                  name="progress"
                  label="进度"
                  rules={[{ required: true, whitespace: true, message: '请填写进度' }, { max: 500 }]}
                >
                  <Input autoComplete="off" maxLength={500} />
                </Form.Item>
                <Form.Item
                  name="strategy"
                  label="攻略"
                  rules={[{ required: true, whitespace: true, message: '请填写攻略' }, { max: 2000 }]}
                >
                  <Input autoComplete="off" maxLength={2000} />
                </Form.Item>
                <Form.Item name="qqGroupId" label="队伍QQ群（选填）">
                  <Input autoComplete="off" maxLength={100} />
                </Form.Item>
              </section>
              <section className="team-create-section team-create-time">
                <h2 className="activity-publisher-section-title">活动时间</h2>
                <Form.Item
                  name="commonTimes"
                  label="时间"
                  rules={[{ required: true, whitespace: true, message: '请填写活动时间' }, { max: 500 }]}
                >
                  <Input
                    autoComplete="off"
                    maxLength={500}
                    placeholder="例如：周二、周五晚间，具体时间可协调"
                  />
                </Form.Item>
              </section>
            </ActivityPaper>
            <ActivityPaper className="team-create-composition">
              <section className="team-create-section">
                <PageHeading decoration="patty">队伍构成</PageHeading>
                <div className="activity-seat-grid team-create-requirements">
                  {seats.map((seat) => (
                    <SeatPicker
                      key={seat.position}
                      index={seat.position}
                      value={seat.requirement}
                      disabled={busy || !allowed}
                      allowAny={false}
                      onChange={(value) => {
                        if (value && value.kind !== 'ANY') patch(seat.position, { requirement: value });
                      }}
                    />
                  ))}
                </div>
              </section>
            </ActivityPaper>
          </div>
          <aside className="team-create-preview team-list" aria-label="固定队实时预览">
            <Card
              variant="borderless"
              classNames={{
                root: 'paper-panel paper-activity home-activity-card team-recruitment-card',
                body: 'home-activity-card-body team-recruitment-body'
              }}
            >
              {session?.user ? (
                <TeamAuthor person={{ ...session.user, avatarUrl: avatar?.smallUrl ?? null }} />
              ) : null}
              <div className="home-activity-title team-recruitment-title">
                <h3 title={values?.name}>{values?.name?.trim() || '队伍名称'}</h3>
              </div>
              <TeamFact kind="duty" value={values?.dutyName ?? ''} />
              <TeamFact kind="progress" label="进度" value={values?.progress ?? ''} />
              <TeamFact kind="strategy" label="攻略" value={values?.strategy ?? ''} />
              <TeamFact kind="time" label="时间" value={values?.commonTimes ?? ''} />
              <div className="team-current-composition">
                <p>当前构成</p>
                <TeamCompactRoster seats={previewSeats} />
              </div>
              <div className="team-required-jobs">
                <span>需求职业</span>
                <div aria-label="需求职业">
                  {seats.map((seat) => (
                    <span key={seat.position} title={requirementLabel(seat.requirement)}>
                      <RequirementIcon value={seat.requirement} />
                    </span>
                  ))}
                </div>
              </div>
              <div className="team-create-submit">
                <Button type="primary" htmlType="submit" block disabled={!allowed || busy}>
                  创建固定队
                </Button>
                {!allowed ? <p>仅正式成员可以创建固定队。</p> : null}
              </div>
            </Card>
          </aside>
        </div>
      </Form>
    </main>
  );
}
