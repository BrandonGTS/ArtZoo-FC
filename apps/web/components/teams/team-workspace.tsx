'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { Button, Form, Input, Select, theme, Modal as AntModal } from 'antd';
import OperationMenu from '../operation-menu';
import {
  ACTIVITY_JOBS,
  TEAM_POSITIONS,
  jobMeetsSeat,
  teamCycleWindow,
  type TeamDetail,
  type TeamSeatView,
  type TeamSummary,
  type TeamSessionView,
  type TeamWriteResult
} from '@artzoo/domain';
import { useAuthSession } from '../auth-session';
import { accountRequest, errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import { PageHeading } from '../home-content';
import {
  ActivityHeading,
  ActivityLoadState,
  ActivityPaper,
  RequirementIcon,
  beijingFull,
  beijingDate,
  beijingTime
} from '../activities/activity-ui';
import TeamInformation from './team-information';
import { TeamConfirmedPanel } from './team-confirmed-panel';
import { TeamHistoryPanel } from './team-history-panel';
import { TeamProposedPanel } from './team-proposed-panel';
import { TeamApplicationReviewList } from './team-application-review-list';
import { TeamEditPanel } from './team-edit-panel';
import { TeamMaintainPanel } from './team-maintain-panel';
import { TeamFeedbackPanel } from './team-feedback-panel';
import { useTeamOperationState } from './use-team-operation-state';
import { useActivityResource } from '../activities/use-activity-resource';
import { consumeCreatedTeam } from './team-feedback';
import { TeamRoster, TeamPersonLink } from './team-ui';
import TeamSessionPeople from './team-session-people';
import { SingleSessionForm, WeeklySessionForm } from './team-session-form';
import ParticipationForm from './team-participation-records';
import Modal from '../ui/paper-modal';
import '../albums/albums.css';
import '../activities/activity-detail-refinement.css';

export type Op = {
  kind:
    | 'apply'
    | 'review'
    | 'maintain'
    | 'propose'
    | 'adjust'
    | 'feedback'
    | 'confirm'
    | 'cancel'
    | 'leave'
    | 'remove'
    | 'dissolve'
    | 'people'
    | 'history'
    | 'weekly'
    | 'records'
    | 'schedule'
    | 'edit'
    | 'withdraw'
    | 'completeRecruitment'
    | 'deleteRecruitment';
  revision: number;
  sessionId?: string;
  memberId?: string;
  cycleStart?: string;
  position?: number;
};
const labels = {
  review: '审核申请',
  completeRecruitment: '完成招募',
  deleteRecruitment: '删除招募',
  schedule: '队伍排期',
  edit: '修改队伍',
  withdraw: '撤回入队申请',
  apply: '申请入队',
  maintain: '维护成员',
  propose: '添加单场排期',
  adjust: '调整单场排期',
  feedback: '填写可参加时间',
  confirm: '确认本场排期',
  cancel: '取消当前排期',
  leave: '离开固定队',
  remove: '移除队员',
  dissolve: '解散固定队',
  people: '请假 / 临时补位',
  history: '历史排期',
  weekly: '安排下周排期',
  records: '补记 / 更正参与记录'
};
const choiceText = (choice: string | null) =>
  choice === 'CAN' ? '可参加' : choice === 'CANNOT' ? '不可参加' : '未反馈';
export default function TeamWorkspace({
  id,
  choices,
  onSelect,
  onExit,
  userInitiated = false
}: {
  id: string;
  choices?: TeamSummary[];
  onSelect?(id: string): void;
  onExit?(): void;
  userInitiated?: boolean;
}) {
  const { session } = useAuthSession(),
    actor = session?.user?.id;
  return actor ? (
    <OwnedTeamWorkspace
      key={actor + ':' + id}
      id={id}
      choices={choices}
      onSelect={onSelect}
      onExit={onExit}
      userInitiated={userInitiated}
    />
  ) : null;
}
function OwnedTeamWorkspace({
  id,
  choices,
  onSelect,
  onExit,
  userInitiated = false
}: {
  id: string;
  choices?: TeamSummary[];
  onSelect?(id: string): void;
  onExit?(): void;
  userInitiated?: boolean;
}) {
  const { token } = theme.useToken();
  const [reload, setReload] = useState(0),
    resource = useActivityResource<TeamDetail>(`/api/teams/${id}?refresh=${reload}`, {
      userInitiated: userInitiated || reload > 0
    }),
    [result, setResult] = useState<TeamDetail | null>(null),
    team = result ?? resource.data;
  const { notify, contextHolder } = useFeedbackMessage(),
    [op, setOp, busy, setBusy, retryAvailable, setRetryAvailable] = useTeamOperationState<Op>(),
    [expanded, setExpanded] = useState<string[]>([]),
    [shownFeedback, setShownFeedback] = useState<string[]>([]),
    [membersExpanded, setMembersExpanded] = useState(false);
  const pending = useRef(false),
    mounted = useRef(false),
    attempt = useRef<{
      signature: string;
      key: string;
      action: string;
      fields: Record<string, unknown>;
      keep: boolean;
      operation: Op;
    } | null>(null),
    uncertain = useRef(false);
  const [elapsed, setElapsed] = useState<{ anchor: string; ms: number } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!team) return;
    const anchor = team.serverNow,
      received = performance.now(),
      timer = window.setInterval(() => setElapsed({ anchor, ms: performance.now() - received }), 1000);
    return () => window.clearInterval(timer);
  }, [team]);
  useEffect(() => {
    if (!team?.isCreator) return;
    if (consumeCreatedTeam(team.creator.id, team.id)) notify('success', '固定队已创建');
  }, [team?.id, team?.isCreator, team?.creator.id, notify]);
  const now = team ? Date.parse(team.serverNow) + (elapsed?.anchor === team.serverNow ? elapsed.ms : 0) : 0;
  const changed =
    !!op &&
    (op.revision !== team?.revision ||
      (op.kind === 'weekly' && op.cycleStart !== teamCycleWindow(new Date(now), 1).startsAt.toISOString()));
  function open(kind: Op['kind'], sessionId?: string, memberId?: string, position?: number) {
    if (uncertain.current && attempt.current) {
      setOp(attempt.current.operation);
      notify('error', '上次提交结果尚未确认，请重试原提交或刷新查看。');
      return;
    }
    if (team && !pending.current) {
      if (kind === 'review' && (team.state !== 'ACTIVE' || team.recruitmentCompletedAt || !team.isCreator))
        return;
      if (kind === 'maintain') setMembersExpanded(false);
      setOp({
        kind,
        revision: team.revision,
        sessionId,
        memberId,
        position,
        ...(kind === 'weekly' ? { cycleStart: teamCycleWindow(new Date(now), 1).startsAt.toISOString() } : {})
      });
    }
  }
  async function send(action: string, fields: Record<string, unknown>, keep = false) {
    if (!team || !op || (changed && !uncertain.current) || pending.current) return false;
    const body = { ...fields, expectedRevision: op.revision },
      signature = JSON.stringify({ action, body });
    if (uncertain.current && attempt.current?.signature !== signature) {
      notify('error', '上次提交结果尚未确认，请按原内容重试或刷新查看。');
      return false;
    }
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID(), action, fields, keep, operation: op };
    pending.current = true;
    setBusy(true);
    try {
      const response = await accountRequest<TeamWriteResult>(`/api/teams/${team.id}/${action}`, {
        method: 'POST',
        body: { ...body, idempotencyKey: attempt.current!.key }
      });
      if (!mounted.current) return false;
      uncertain.current = false;
      setRetryAvailable(false);
      attempt.current = null;
      setResult(response.team);
      notify('success', action === 'applications' && team.isCreator ? '已报名入队' : '已保存');
      setOp(keep ? { kind: op.kind, revision: response.team.revision } : null);
      if (
        choices &&
        (response.team.state !== 'ACTIVE' ||
          !response.team.recruitmentCompletedAt ||
          (!response.team.isCreator && !response.team.isMember))
      )
        onExit?.();
      return true;
    } catch (failure) {
      if (!mounted.current) return false;
      const error = errorDetail(failure);
      notify('error', error.message);
      uncertain.current = ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(error.code);
      setRetryAvailable(uncertain.current);
      if (!uncertain.current) attempt.current = null;
      const duplicateSession =
        error.code === 'CONFLICT' &&
        ['sessions', 'session-edits', 'session-batches'].includes(action) &&
        error.message.includes('已存在完全相同时间的未取消场次');
      if (!duplicateSession && ['CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)) {
        setOp(null);
        setResult(null);
        setReload((v) => v + 1);
      }
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const toggle = (value: string, set: (fn: (values: string[]) => string[]) => void) =>
    set((values) => (values.includes(value) ? values.filter((v) => v !== value) : [...values, value]));
  if (!team)
    return (
      <main className="home-content teams-content" id="main-content">
        {contextHolder}
        <ActivityHeading title="队伍详情" />
        <ActivityLoadState
          loading={resource.loading}
          error={resource.error}
          retry={() => {
            setResult(null);
            setReload((v) => v + 1);
          }}
        />
      </main>
    );
  const workspace = !!choices,
    recruiting = team.state === 'ACTIVE' && !team.recruitmentCompletedAt;
  const active = team.state === 'ACTIVE',
    canManage = active && team.isCreator,
    internal = team.isCreator || team.isMember,
    available = team.seats.filter((s) => !s.member),
    future = team.sessions?.filter((s) => s.state !== 'CANCELLED' && Date.parse(s.startsAt) > now) ?? [];
  const proposed = future.filter((s) => s.state === 'PROPOSED'),
    confirmed = team.sessions?.filter((s) => s.state === 'CONFIRMED' && Date.parse(s.endsAt) > now) ?? [];
  const minePending = team.applications.find(
      (a) => a.state === 'PENDING' && a.person.id === team.currentAccountId
    ),
    canApply = recruiting && !team.isMember && !minePending;
  const selectedSession = team.sessions?.find((s) => s.id === op?.sessionId),
    applicationStates: Record<string, string> = {
      PENDING: '待处理',
      ACCEPTED: '已接受',
      REJECTED: '已拒绝',
      CANCELLED: '已终止'
    };
  function feedbackCounts(s: TeamSessionView) {
    return (
      <>
        <p className="auxiliary">
          已反馈 {s.feedback.filter((f) => f.choice).length}/{s.feedback.length}
        </p>
        <p className="team-feedback-can">可参加 {s.feedback.filter((f) => f.choice === 'CAN').length}人</p>
      </>
    );
  }
  const surfaceColors = {
    '--activity-seat-empty-bg': token.colorFillSecondary,
    '--activity-seat-empty-border': token.colorPrimaryBorder,
    '--activity-seat-occupied-bg': `color-mix(in srgb, ${token.colorError} 12%, ${token.colorBgContainer})`,
    '--activity-seat-occupied-border': token.colorErrorBorder,
    '--team-pending-bg': `color-mix(in srgb, ${token.colorWarning} 12%, ${token.colorBgContainer})`,
    '--team-pending-border': token.colorWarningBorder,
    '--team-pending-name': token.colorWarning,
    '--team-approved-name': token.colorError
  } as CSSProperties;
  const informationMenu = workspace ? (
    canManage || (active && team.isMember) ? (
      <OperationMenu
        label="固定队管理操作"
        items={
          canManage
            ? [
                { key: 'edit', label: '修改队伍' },
                { key: 'dissolve', label: '解散固定队', danger: true }
              ]
            : [{ key: 'leave', label: '离开固定队', danger: true }]
        }
        onAction={(key) => open(key as Op['kind'])}
      />
    ) : null
  ) : canManage ? (
    <OperationMenu
      label="固定队管理操作"
      items={
        recruiting
          ? [
              { key: 'edit', label: '修改招募' },
              { key: 'review', label: '审核申请' },
              { key: 'completeRecruitment', label: '完成招募' },
              { key: 'deleteRecruitment', label: '删除招募', danger: true }
            ]
          : [
              { key: 'edit', label: '修改队伍' },
              { key: 'maintain', label: '维护成员' },
              { key: 'schedule', label: '队伍排期' },
              { key: 'history', label: '历史排期' },
              { key: 'dissolve', label: '解散固定队', danger: true }
            ]
      }
      onAction={(key) => open(key as Op['kind'])}
    />
  ) : null;
  const information = <TeamInformation team={team}>{informationMenu}</TeamInformation>;
  const composition = (
    <ActivityPaper className="activity-detail-participation team-detail-participation">
      <section className="activity-copy-section" aria-label="队伍构成">
        <div className="team-section-heading">
          <PageHeading decoration="tomato">
            队伍构成 · {team.seats.filter((s) => s.member).length}/8
          </PageHeading>
          {workspace && canManage ? (
            <OperationMenu
              label="队伍构成操作"
              items={[{ key: 'maintain', label: '维护成员' }]}
              onAction={() => open('maintain')}
            />
          ) : null}
        </div>
        {!active ? <p>固定队已解散，成员与排期历史保留。</p> : null}
        <TeamRoster
          seats={team.seats}
          recruiting={workspace ? false : recruiting}
          canApply={!workspace && canApply}
          directJoin={team.isCreator}
          onApply={(position) => open('apply', undefined, undefined, position)}
        />
        {!workspace && minePending ? (
          <div className="team-my-application">
            <p>
              你已申请 {TEAM_POSITIONS[minePending.seatPosition]} · {minePending.job}
              ，等待审核。如需更换席位，请先撤回此申请。
            </p>
            <Button onClick={() => open('withdraw', minePending.id)}>撤回申请</Button>
          </div>
        ) : null}
        {!workspace && !internal && !minePending
          ? team.applications
              .filter((a) => a.person.id === team.currentAccountId)
              .map((a) => (
                <p key={a.id}>
                  {TEAM_POSITIONS[a.seatPosition]} · {a.job} · {applicationStates[a.state] || a.state}
                </p>
              ))
          : null}
        {!workspace && active && team.isMember && !team.isCreator ? (
          <div className="activity-copy-section">
            <Button danger className="team-leave-button" disabled={busy} onClick={() => open('leave')}>
              离开固定队
            </Button>
          </div>
        ) : null}
      </section>
    </ActivityPaper>
  );
  const confirmedPanel = (
    <TeamConfirmedPanel
      team={team}
      workspace={workspace}
      canManage={canManage}
      active={active}
      confirmed={confirmed}
      expanded={expanded}
      now={now}
      open={open}
      toggle={toggle}
      setExpanded={setExpanded}
      Disclosure={Disclosure}
      SubstituteLabel={SubstituteLabel}
      sessionRange={sessionRange}
    />
  );
  const proposedPanel = (
    <TeamProposedPanel
      team={team}
      canManage={canManage}
      active={active}
      proposed={proposed}
      shownFeedback={shownFeedback}
      open={open}
      sessionRange={sessionRange}
      feedbackCounts={feedbackCounts}
      Disclosure={Disclosure}
      toggle={toggle}
      setShownFeedback={setShownFeedback}
      choiceText={choiceText}
    />
  );
  const schedulePanels = (
    <div className="team-layout team-workspace-layout activity-detail-refined" style={surfaceColors}>
      {workspace ? (
        <>
          <div className="team-workspace-column">
            {information}
            {composition}
          </div>
          <div className="team-workspace-column">
            {confirmedPanel}
            {proposedPanel}
          </div>
        </>
      ) : (
        <>
          {confirmedPanel}
          {proposedPanel}
        </>
      )}
    </div>
  );
  const pendingApplications = team.applications.filter((a) => a.state === 'PENDING');
  const applicationRows =
    recruiting && canManage ? (
      <TeamApplicationReviewList
        pendingApplications={pendingApplications}
        busy={busy}
        changed={changed}
        retryAvailable={retryAvailable}
        send={send}
      />
    ) : null;
  return (
    <main className="home-content teams-content" id="main-content">
      {contextHolder}
      <ActivityHeading title={!active ? '已解散的队伍' : workspace ? '我的队伍' : '队伍详情'}>
        <div className="team-actions team-current-team">
          {choices && onSelect ? (
            <>
              <span>当前队伍</span>
              <Select
                aria-label="当前队伍"
                value={team.id}
                className="team-current-team-select"
                classNames={{
                  content: 'team-current-team-value',
                  popup: { root: 'team-current-team-popup' }
                }}
                virtual={false}
                options={choices.map((t) => ({ value: t.id, label: t.name }))}
                onChange={onSelect}
              />
            </>
          ) : (
            <Link className="activity-text-link" href="/teams">
              返回队伍招募
            </Link>
          )}
        </div>
      </ActivityHeading>
      <ActivityLoadState
        loading={resource.loading && !result}
        error={resource.error}
        retry={() => {
          setResult(null);
          setReload((v) => v + 1);
        }}
      />
      {workspace && internal && team.recruitmentCompletedAt ? (
        schedulePanels
      ) : (
        <div className="team-detail-panels activity-detail-refined" style={surfaceColors}>
          {information}
          {composition}
        </div>
      )}
      <AntModal
        open={op?.kind === 'leave'}
        title="确认离开固定队"
        onCancel={() => {
          if (!pending.current) setOp(null);
        }}
        onOk={() => void send('leave', { confirmed: true })}
        okText="确认离队"
        cancelText="返回"
        okButtonProps={{ disabled: busy || changed }}
        cancelButtonProps={{ disabled: busy }}
        mask={{ closable: !busy }}
        keyboard={!busy}
      >
        <p>离开后将释放长期席位，未来已确认场次的原席位将待补位，历史记录保留。</p>
      </AntModal>
      <Modal
        open={!!op && op.kind !== 'leave'}
        destroyOnHidden
        className={`${op && ['edit', 'review', 'maintain', 'weekly', 'propose', 'adjust'].includes(op.kind) ? 'team-edit-modal' : 'album-modal'} team-modal ${op?.kind === 'apply' ? 'activity-detail-registration-modal' : ''}`}
        title={
          op ? (
            <PageHeading
              decoration={
                op.kind === 'feedback' || op.kind === 'history'
                  ? 'patty'
                  : op.kind === 'maintain' || op.kind === 'review' || op.kind === 'apply'
                    ? 'tomato'
                    : 'cheese'
              }
            >
              {op.kind === 'people' && !team.isCreator
                ? '本期请假'
                : op.kind === 'apply' && team.isCreator
                  ? '报名入队'
                  : labels[op.kind]}
            </PageHeading>
          ) : null
        }
        width={
          op?.kind === 'schedule'
            ? 1120
            : op?.kind === 'feedback' || op?.kind === 'history' || op?.kind === 'weekly'
              ? 824
              : 584
        }
        footer={null}
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
        onCancel={() => {
          if (!pending.current) setOp(null);
        }}
      >
        {changed ? (
          <p role="alert">
            {retryAvailable
              ? '上次提交结果尚未确认，请重试原提交。'
              : '队伍信息或周排期范围已变化，请关闭后重新确认。'}
          </p>
        ) : null}
        {op && retryAvailable ? (
          <div className="team-actions">
            <Button
              loading={busy}
              onClick={() => {
                const prior = attempt.current;
                if (prior) void send(prior.action, prior.fields, prior.keep);
              }}
            >
              重试原提交
            </Button>
          </div>
        ) : null}
        {op ? (
          <div className="team-dialog-fields">
            {op.kind === 'schedule' && internal ? schedulePanels : null}
            {op.kind === 'history' ? (
              <TeamHistoryPanel team={team} now={now} open={open} sessionRange={sessionRange} />
            ) : null}

            {op.kind === 'records' && selectedSession ? (
              <ParticipationForm
                key={selectedSession.id + ':' + op.revision}
                session={selectedSession}
                busy={busy}
                disabled={
                  busy ||
                  changed ||
                  selectedSession.state !== 'CONFIRMED' ||
                  Date.parse(selectedSession.endsAt) > now
                }
                onCancel={() => setOp(null)}
                onSubmit={(v) => send('participation-records', v)}
              />
            ) : null}
            {op.kind === 'people' && selectedSession ? (
              <TeamSessionPeople
                key={selectedSession.id + ':' + op.revision}
                team={team}
                session={selectedSession}
                busy={busy}
                disabled={busy || changed || Date.parse(selectedSession.startsAt) <= now}
                onCancel={() => setOp(null)}
                onSubmit={(action, v) => send(action, v)}
              />
            ) : null}
            {op.kind === 'remove' || op.kind === 'dissolve' ? (
              <>
                <h4>
                  {team.name}
                  {op.kind === 'remove'
                    ? ` · ${team.seats.find((s) => s.member?.id === op.memberId)?.member?.person.displayName || '队员'}`
                    : ''}
                </h4>
                <p>
                  {op.kind === 'dissolve'
                    ? '确认解散固定队？招募将停止，未开始排期将取消，历史记录保留。'
                    : op.kind === 'remove'
                      ? '确认移除这位队员？长期席位将释放，未来已确认场次的原席位将待补位，历史记录保留。'
                      : '确认离开固定队？长期席位将释放，未来已确认场次的原席位将待补位，历史记录保留。'}
                </p>
                <div className="team-actions">
                  <Button disabled={busy} onClick={() => setOp(null)}>
                    返回
                  </Button>
                  <Button
                    danger
                    type="primary"
                    loading={busy}
                    disabled={changed}
                    onClick={() =>
                      void send(op.kind === 'remove' ? 'member-removals' : op.kind, {
                        confirmed: true,
                        ...(op.kind === 'remove' ? { membershipId: op.memberId } : {})
                      })
                    }
                  >
                    {op.kind === 'dissolve' ? '确认解散' : op.kind === 'remove' ? '确认移除' : '确认离队'}
                  </Button>
                </div>
              </>
            ) : null}

            {op.kind === 'completeRecruitment' || op.kind === 'deleteRecruitment' ? (
              <>
                <h4>{team.name}</h4>
                <p>
                  {op.kind === 'completeRecruitment'
                    ? '确认完成招募？允许未满员完成；将停止新申请，终止所有待审申请，现有队员与排期保留。'
                    : '确认删除招募？队伍将解散，待审申请终止，未开始排期取消，成员与历史记录保留。'}
                </p>
                <div className="activity-detail-confirm-actions">
                  <Button disabled={busy} onClick={() => setOp(null)}>
                    返回
                  </Button>
                  <Button
                    type="primary"
                    danger={op.kind === 'deleteRecruitment'}
                    loading={busy}
                    disabled={changed || !recruiting}
                    onClick={() =>
                      void send(
                        op.kind === 'completeRecruitment' ? 'recruitment-completion' : 'recruitment-deletion',
                        { confirmed: true }
                      )
                    }
                  >
                    {op.kind === 'completeRecruitment' ? '确认完成招募' : '确认删除招募'}
                  </Button>
                </div>
              </>
            ) : null}
            {op.kind === 'apply' ? (
              <TeamApplicationForm
                key={'apply:' + op.revision + ':' + op.position}
                seats={available}
                directJoin={team.isCreator}
                initialPosition={op.position}
                busy={busy}
                disabled={busy || changed || !canApply}
                onCancel={() => setOp(null)}
                onSubmit={(v) => send('applications', v)}
              />
            ) : null}
            {op.kind === 'withdraw' && minePending ? (
              <>
                <p>
                  确认撤回 {TEAM_POSITIONS[minePending.seatPosition]} 的入队申请？撤回后可申请其他空席位。
                </p>
                <div className="team-actions">
                  <Button disabled={busy} onClick={() => setOp(null)}>
                    返回
                  </Button>
                  <Button
                    type="primary"
                    loading={busy}
                    disabled={changed || op.sessionId !== minePending.id}
                    onClick={() => void send('application-withdrawals', { applicationId: minePending.id })}
                  >
                    确认撤回
                  </Button>
                </div>
              </>
            ) : null}
            {op.kind === 'edit' && canManage ? (
              <TeamEditPanel team={team} op={op} busy={busy} changed={changed} send={send} setOp={setOp} />
            ) : null}
            {op.kind === 'maintain' ? (
              <TeamMaintainPanel
                team={team}
                available={available}
                op={op}
                busy={busy}
                changed={changed}
                membersExpanded={membersExpanded}
                setMembersExpanded={setMembersExpanded}
                Disclosure={Disclosure}
                open={open}
                send={send}
              />
            ) : null}
            {op.kind === 'review' && recruiting && canManage ? (
              <>
                {applicationRows}
                <div className="team-actions">
                  <Button disabled={busy} onClick={() => setOp(null)}>
                    关闭
                  </Button>
                </div>
              </>
            ) : null}
            {op.kind === 'weekly' && op.cycleStart ? (
              <WeeklySessionForm
                key={'weekly:' + op.revision}
                team={team}
                cycle={teamCycleWindow(new Date(op.cycleStart), 0)}
                disabled={busy || changed || retryAvailable}
                busy={busy}
                onCancel={() => setOp(null)}
                onSubmit={(v) => send('session-batches', v)}
              />
            ) : null}
            {op.kind === 'propose' || op.kind === 'adjust' ? (
              <SingleSessionForm
                key={op.kind + ':' + op.revision + ':' + (op.sessionId ?? '')}
                team={team}
                future={future}
                {...(op.kind === 'adjust' ? { editing: { sessionId: op.sessionId } } : {})}
                disabled={busy || changed || retryAvailable}
                busy={busy}
                onCancel={() => setOp(null)}
                onSubmit={(v, editing) => send(editing ? 'session-edits' : 'sessions', v)}
              />
            ) : null}
            {op.kind === 'feedback' ? (
              <TeamFeedbackPanel
                op={op}
                busy={busy}
                changed={changed}
                proposed={proposed}
                notify={notify}
                setOp={setOp}
                send={send}
              />
            ) : null}
            {(op.kind === 'confirm' || op.kind === 'cancel') && selectedSession ? (
              <>
                <h4>{team.name}</h4>
                <p>{sessionRange(selectedSession)}</p>
                {op.kind === 'confirm' ? (
                  <>
                    {feedbackCounts(selectedSession)}
                    <p>
                      不可参加 {selectedSession.feedback.filter((f) => f.choice === 'CANNOT').length}人 ·
                      未反馈 {selectedSession.feedback.filter((f) => !f.choice).length}人
                    </p>
                  </>
                ) : (
                  <p>确认取消本场排期？后续排期保持不变。</p>
                )}
                <div className="team-actions">
                  <Button disabled={busy} onClick={() => setOp(null)}>
                    返回
                  </Button>
                  <Button
                    type="primary"
                    danger={op.kind === 'cancel'}
                    loading={busy}
                    disabled={changed || Date.parse(selectedSession.startsAt) <= now}
                    onClick={() =>
                      void send(op.kind === 'confirm' ? 'confirm' : 'cancel-session', {
                        sessionId: selectedSession.id,
                        ...(op.kind === 'cancel' ? { confirmed: true } : {})
                      })
                    }
                  >
                    {op.kind === 'confirm' ? '确认本场' : '确认取消'}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </main>
  );
}
function TeamApplicationForm({
  seats,
  directJoin = false,
  initialPosition,
  busy,
  disabled,
  onCancel,
  onSubmit
}: {
  seats: TeamSeatView[];
  directJoin?: boolean;
  initialPosition?: number;
  busy: boolean;
  disabled: boolean;
  onCancel(): void;
  onSubmit(fields: Record<string, unknown>): Promise<boolean>;
}) {
  const [form] = Form.useForm(),
    position = Form.useWatch('position', form),
    seat = seats.find((s) => s.position === (position ?? initialPosition));
  const exactJob = seat?.requirement.kind === 'JOB' ? seat.requirement.job : null;
  return (
    <Form
      autoComplete="off"
      form={form}
      layout="vertical"
      disabled={disabled}
      initialValues={{ position: initialPosition }}
      onFinish={(v: { position: number; job?: string; note: string }) =>
        void onSubmit({ position: v.position, job: exactJob ?? v.job, note: v.note.trim() })
      }
    >
      <Form.Item
        name="position"
        hidden={initialPosition !== undefined}
        label={directJoin ? '报名席位' : '申请席位'}
        rules={[{ required: true, message: '请选择席位' }]}
      >
        <Select
          options={seats.map((s) => ({ value: s.position, label: TEAM_POSITIONS[s.position] }))}
          onChange={() => form.setFieldValue('job', undefined)}
        />
      </Form.Item>
      <Form.Item
        name="job"
        label="参加职业"
        rules={exactJob ? [] : [{ required: true, message: '请选择职业' }]}
      >
        <TeamJobPicker
          exactJob={exactJob}
          jobs={ACTIVITY_JOBS.filter((job) => !!seat && jobMeetsSeat(seat.requirement, job.name)).map(
            (job) => job.name
          )}
          disabled={disabled}
        />
      </Form.Item>
      {directJoin ? <p>报名后直接成为正式队员，无需审核；每人只能占用一个席位。</p> : null}
      <Form.Item
        name="note"
        label="入队说明"
        rules={[{ required: true, whitespace: true, message: '请填写入队说明' }, { max: 1000 }]}
      >
        <Input.TextArea autoComplete="off" maxLength={1000} autoSize={{ minRows: 3, maxRows: 6 }} />
      </Form.Item>
      <div className="activity-detail-confirm-actions">
        <Button disabled={busy} onClick={onCancel}>
          返回
        </Button>
        <Button htmlType="submit" type="primary" loading={busy}>
          {directJoin ? '确认报名' : '提交申请'}
        </Button>
      </div>
    </Form>
  );
}
function TeamJobPicker({
  jobs,
  value,
  onChange,
  disabled,
  exactJob
}: {
  jobs: string[];
  value?: string;
  onChange?(value: string): void;
  disabled: boolean;
  exactJob: string | null;
}) {
  return (
    <div className="activity-registration-job-grid" role="group" aria-label="参加职业">
      {jobs.map((job) => (
        <Button
          key={job}
          htmlType="button"
          className="activity-registration-job-option"
          aria-label={job}
          aria-pressed={(exactJob ?? value) === job}
          disabled={disabled}
          onClick={() => onChange?.(job)}
        >
          <span className="activity-registration-job-content">
            <RequirementIcon value={{ kind: 'JOB', job }} />
            <span className="activity-registration-job-name">{job}</span>
          </span>
        </Button>
      ))}
    </div>
  );
}
function Disclosure({
  label,
  expanded,
  controls,
  onClick
}: {
  label: string;
  expanded: boolean;
  controls: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="team-content-disclosure"
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      onClick={onClick}
    >
      <span className={`team-content-chevron ${expanded ? 'is-expanded' : ''}`} aria-hidden="true" />
    </button>
  );
}
function sessionRange(session: TeamSessionView) {
  return (
    beijingFull(session.startsAt) +
    '–' +
    (beijingDate(session.startsAt) === beijingDate(session.endsAt)
      ? beijingTime(session.endsAt)
      : beijingFull(session.endsAt))
  );
}

function SubstituteLabel({ value }: { value: TeamSessionView['substitutes'][number] }) {
  return (
    <div>
      {value.person ? <TeamPersonLink person={value.person} /> : <p>{value.displayName}</p>}
      <p className="auxiliary">
        {value.person ? null : `${value.gameRegion} / ${value.gameServer} · `}
        {value.job} · 临时补位
      </p>
    </div>
  );
}
