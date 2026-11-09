'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Button, Dropdown, theme } from 'antd';
import {
  ACTIVITY_JOBS,
  activityStatus,
  jobMeetsSeat,
  type ActivityDetail as ActivityDetailData,
  type ActivityWriteResult
} from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { ErrorNotice } from '../account/account-ui';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import { useActivityResource } from './use-activity-resource';
import { PageHeading } from '../home-content';
import { ActivityTypeTag } from './activity-type-tag';
import ActivityManagementControls from './activity-management-controls';
import ActivityOrdinaryManagementControls from './activity-ordinary-management-controls';
import ActivitySeriesControls from './activity-series-controls';
import ActivityAlbumEntry from '../albums/activity-album-entry';
import ActivityAttendance from './activity-attendance';
import { splitActivityDescription } from './activity-description';
import './activity-detail-refinement.css';
import { ActivityHeading, ActivityLoadState, ActivityPaper } from './activity-ui';
import ActivityDetailInformation from './activity-detail-information';
import ActivityRegistrationDialog from './activity-registration-dialog';
import ActivityParticipationPanel from './activity-participation-panel';

export default function ActivityDetail({ id }: { id: string }) {
  const { session, loading, error, refresh, openLogin } = useAuthSession();
  const owner = session?.user?.id;
  if (!owner)
    return (
      <main className="home-content activities-content" id="main-content">
        <ActivityHeading title="活动详情" />
        <ActivityLoadState loading={loading} error={error} retry={() => void refresh().catch(() => {})} />
        {!loading ? <Button onClick={() => openLogin('/activities/' + id)}>登录后查看活动</Button> : null}
      </main>
    );
  return (
    <ActivityDetailContent
      key={[owner, session?.user?.membership, session?.user?.adminRole, id].join(':')}
      id={id}
    />
  );
}
function ActivityDetailContent({ id }: { id: string }) {
  const { session } = useAuthSession();
  const { token } = theme.useToken();
  const [reload, setReload] = useState(0);
  const [organizerRecoveryNeeded, setOrganizerRecoveryNeeded] = useState(false);
  const [organizerMenuOpen, setOrganizerMenuOpen] = useState(false);
  const organizerTrigger = useRef<HTMLButtonElement | null>(null);
  const focusOrganizerMenu = useRef(false);
  const resource = useActivityResource<ActivityDetailData>(
    `/api/activities/${encodeURIComponent(id)}?refresh=${reload}`
  );
  const [writeResult, setWriteResult] = useState<{ owner: string; activity: ActivityDetailData } | null>(
    null
  );
  const [seatId, setSeatId] = useState<string | undefined>();
  const [expectedSeatId, setExpectedSeatId] = useState<string | undefined>();
  const [job, setJob] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [organizerContainer, setOrganizerContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!organizerMenuOpen || !organizerContainer || !focusOrganizerMenu.current) return;
    const frame = requestAnimationFrame(() => {
      organizerContainer
        .querySelector<HTMLElement>('button:not(:disabled), a[href]:not([aria-disabled="true"])')
        ?.focus();
      focusOrganizerMenu.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [organizerMenuOpen, organizerContainer]);
  useEffect(() => {
    if (!organizerContainer) return;
    // Existing management controls portal into this DOM node from another React tree.
    // Listen on the DOM so their hover, click, focus and Escape reach the menu too.
    const enter = () => setOrganizerMenuOpen(true);
    const leave = () => setOrganizerMenuOpen(false);
    const click = (event: MouseEvent) => {
      const action = (event.target as HTMLElement | null)?.closest?.('button, a[href]');
      if (
        !action ||
        !organizerContainer.contains(action) ||
        action.matches(':disabled') ||
        action.getAttribute('aria-disabled') === 'true'
      )
        return;
      setOrganizerMenuOpen(false);
      organizerTrigger.current?.focus();
    };
    const blur = (event: FocusEvent) => {
      if (!organizerContainer.contains(event.relatedTarget as Node | null)) setOrganizerMenuOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOrganizerMenuOpen(false);
      organizerTrigger.current?.focus();
    };
    organizerContainer.addEventListener('pointerenter', enter);
    organizerContainer.addEventListener('pointerleave', leave);
    organizerContainer.addEventListener('click', click, true);
    organizerContainer.addEventListener('focusout', blur);
    organizerContainer.addEventListener('keydown', keydown);
    return () => {
      organizerContainer.removeEventListener('pointerenter', enter);
      organizerContainer.removeEventListener('pointerleave', leave);
      organizerContainer.removeEventListener('click', click, true);
      organizerContainer.removeEventListener('focusout', blur);
      organizerContainer.removeEventListener('keydown', keydown);
    };
  }, [organizerContainer]);
  const [seriesMoveRequest, setSeriesMoveRequest] = useState<Record<string, unknown> | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const { notify, contextHolder } = useFeedbackMessage();
  const [clock, setClock] = useState<{ anchor: string; elapsed: number } | null>(null);
  const ownedResult = writeResult && writeResult.owner === session?.user?.id ? writeResult.activity : null;
  const activity = ownedResult || resource.data;
  useEffect(() => {
    if (!activity) return;
    const anchor = activity.serverNow,
      received = performance.now();
    const timer = window.setInterval(() => setClock({ anchor, elapsed: performance.now() - received }), 1000);
    return () => window.clearInterval(timer);
  }, [activity]);
  const now = activity
    ? Date.parse(activity.serverNow) + (clock?.anchor === activity.serverNow ? clock.elapsed : 0)
    : 0;
  const status = activity?.cancelledAt
    ? 'CANCELLED'
    : activity
      ? activityStatus(
          new Date(activity.startsAt),
          new Date(activity.endsAt),
          new Date(now),
          !activity.capacityUnlimited && activity.registeredCount >= activity.capacity,
          new Date(activity.registrationClosesAt)
        )
      : 'OPEN';
  const isOffline = activity?.scene === 'OFFLINE';
  const isSeries = activity?.mode === 'SERIES' || !!activity?.series;
  const seriesOpen =
    !isSeries ||
    (!!activity?.series && activity.series.periodNumber === 1 && activity.series.state === 'RECRUITING');
  const ordinarySingle = !isOffline && !isSeries;
  const organizerHasActions =
    organizerRecoveryNeeded ||
    (!!activity?.isOrganizer &&
      !activity.cancelledAt &&
      ((!isSeries && now < Date.parse(activity.startsAt)) ||
        (activity.scene === 'GAME' &&
          isSeries &&
          ((activity.series?.state === 'RECRUITING' &&
            activity.series.periodNumber === 1 &&
            now < Date.parse(activity.startsAt)) ||
            (activity.series?.state === 'FORMED' &&
              activity.series.periods.some(
                (period) => !period.cancelledAt && now < Date.parse(period.startsAt)
              ))))));
  const description = splitActivityDescription(activity?.description ?? '');
  const pendingSeriesPeriod =
    activity?.series?.state === 'RECRUITING' && activity.series.periodNumber !== 1 && !activity.cancelledAt;
  const registrationSeat = activity?.seats.find((seat) => seat.id === seatId);
  const selectedSeat = registrationSeat && !registrationSeat.registration ? registrationSeat : undefined;
  const availableJobs = selectedSeat
    ? ACTIVITY_JOBS.filter((item) => jobMeetsSeat(selectedSeat.requirement, item.name))
    : [];
  const isMoving = !!activity?.myRegistration;
  const allowed = !!session?.user && status === 'OPEN' && seriesOpen && !(isOffline && isMoving);
  function chooseSeat(value: string | undefined) {
    if (
      !allowed ||
      isOffline ||
      busy ||
      pending.current ||
      seriesMoveRequest ||
      (registrationOpen && value !== seatId)
    )
      return;
    if (value === undefined) {
      setSeatId(undefined);
      setExpectedSeatId(undefined);
      setJob(undefined);
      setError(null);
      return;
    }
    if (!activity?.seats.some((seat) => seat.id === value && !seat.registration)) return;
    if (value === seatId) {
      setRegistrationOpen(true);
      return;
    }
    setSeatId(value);
    setExpectedSeatId(activity.myRegistration?.seatId);
    setJob(undefined);
    setError(null);
    setRegistrationOpen(true);
  }
  async function submitRegistration() {
    if (pending.current || !activity || (!seriesMoveRequest && (!allowed || (!isOffline && !selectedSeat))))
      return;
    if (
      !seriesMoveRequest &&
      isMoving &&
      (!expectedSeatId || expectedSeatId !== activity.myRegistration?.seatId)
    ) {
      setSeatId(undefined);
      setExpectedSeatId(undefined);
      setJob(undefined);
      setError('你的报名席位已更新，请重新选择目标席位。');
      return;
    }
    if (
      !seriesMoveRequest &&
      !isOffline &&
      activity.category === 'DUNGEON' &&
      !availableJobs.some((item) => item.name === job)
    ) {
      setError('请选择符合席位要求的职业。');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const body = seriesMoveRequest ?? {
        seatId: isOffline ? null : selectedSeat!.id,
        job: isOffline || activity.category === 'SOCIAL' ? null : job
      };
      const seriesMove = !!seriesMoveRequest || !!(isSeries && isMoving);
      const request =
        seriesMoveRequest ??
        (seriesMove
          ? {
              ...body,
              expectedSeatId,
              expectedRegistrationId: activity.myRegistration!.id,
              expectedRevision: activity.revision,
              idempotencyKey: crypto.randomUUID()
            }
          : isMoving
            ? { ...body, expectedSeatId }
            : body);
      if (seriesMove && !seriesMoveRequest) setSeriesMoveRequest(request);
      const result = await accountRequest<ActivityWriteResult>(
        seriesMove ? `/api/activities/${id}/ordinary-management/move` : `/api/activities/${id}/registrations`,
        {
          method: seriesMove ? 'POST' : isMoving ? 'PATCH' : 'POST',
          body: request
        }
      );
      if (!mounted.current) return;
      setSeriesMoveRequest(null);
      setRegistrationOpen(false);
      setWriteResult({ owner: session!.user!.id, activity: result.activity });
      notify('success', seriesMove || isMoving ? '换席位成功' : '报名成功');
      setSeatId(undefined);
      setExpectedSeatId(undefined);
      setJob(undefined);
    } catch (failure) {
      if (!mounted.current) return;
      const detail = errorDetail(failure);
      if (
        (seriesMoveRequest || (isSeries && isMoving)) &&
        ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR'].includes(detail.code)
      ) {
        setError('换位结果尚未确认，请重试原提交。');
        notify('error', detail.message);
        return;
      }
      setSeriesMoveRequest(null);
      setError(detail.message);
      if (isSeries && isMoving) notify('error', detail.message);
      setSeatId(undefined);
      setExpectedSeatId(undefined);
      setJob(undefined);
      setWriteResult(null);
      setReload((value) => value + 1);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <main
      className="home-content activities-content"
      id="main-content"
      style={
        {
          '--activity-seat-empty-bg': token.colorFillSecondary,
          '--activity-seat-empty-border': token.colorPrimaryBorder,
          '--activity-seat-occupied-bg': `color-mix(in srgb, ${token.colorError} 12%, ${token.colorBgContainer})`,
          '--activity-seat-occupied-border': token.colorErrorBorder
        } as CSSProperties
      }
    >
      {contextHolder}
      <ActivityHeading title="活动详情">
        <Link className="activity-text-link" href="/activities">
          返回正式活动
        </Link>
      </ActivityHeading>
      <ActivityLoadState
        loading={resource.loading && !ownedResult}
        error={resource.error}
        retry={() => {
          setWriteResult(null);
          setReload((value) => value + 1);
        }}
      />
      {activity ? (
        <>
          <div className="activity-detail-layout activity-detail-refined">
            <div className="activity-detail-main home-section">
              <ActivityPaper className="activity-detail-copy">
                <div className="activity-detail-title-row">
                  <div className="activity-title-row">
                    <ActivityTypeTag
                      type={isSeries ? 'long-term' : 'single'}
                      scene={activity.scene}
                      mode={activity.mode}
                    />
                    <h2 className="activity-detail-title">{activity.title}</h2>
                  </div>
                  {activity.isOrganizer || organizerRecoveryNeeded ? (
                    <span className="activity-detail-organizer-entry" hidden={!organizerHasActions}>
                      <Dropdown
                        open={organizerMenuOpen && organizerHasActions}
                        onOpenChange={(nextOpen) => {
                          if (!nextOpen && organizerContainer?.matches(':hover')) return;
                          setOrganizerMenuOpen(nextOpen);
                        }}
                        trigger={['hover', 'click']}
                        placement="bottomRight"
                        arrow
                        destroyOnHidden={false}
                        popupRender={() => (
                          <div
                            ref={setOrganizerContainer}
                            className="activity-detail-organizer-menu"
                            role="group"
                            aria-label="活动管理操作"
                            style={
                              {
                                background: token.colorBgElevated,
                                borderRadius: token.borderRadiusLG,
                                boxShadow: token.boxShadowSecondary,
                                '--activity-menu-hover-bg': token.controlItemBgHover
                              } as CSSProperties
                            }
                          />
                        )}
                      >
                        <Button
                          ref={organizerTrigger}
                          type="text"
                          htmlType="button"
                          className="activity-detail-menu-trigger"
                          aria-label="活动管理操作"
                          aria-expanded={organizerMenuOpen && organizerHasActions}
                          aria-haspopup="true"
                          onKeyDown={(event) => {
                            if (['ArrowDown', 'Enter', ' '].includes(event.key)) {
                              event.preventDefault();
                              focusOrganizerMenu.current = true;
                              setOrganizerMenuOpen(true);
                            }
                            if (event.key === 'Escape') setOrganizerMenuOpen(false);
                          }}
                          icon={<span className="activity-detail-menu-chevron" aria-hidden="true" />}
                        />
                      </Dropdown>
                    </span>
                  ) : null}
                </div>
                <ActivityDetailInformation
                  activity={activity}
                  isOffline={isOffline}
                  isSeries={isSeries}
                  description={description}
                />
                {isSeries && organizerContainer
                  ? createPortal(
                      <ActivitySeriesControls
                        activity={activity}
                        now={now}
                        onFeedback={notify}
                        onRefresh={() => {
                          setWriteResult(null);
                          setReload((value) => value + 1);
                        }}
                        onResult={(result) => {
                          setWriteResult({ owner: session!.user!.id, activity: result.activity });
                          setSeatId(undefined);
                          setExpectedSeatId(undefined);
                          setJob(undefined);
                          setError(null);
                        }}
                      />,
                      organizerContainer
                    )
                  : null}
              </ActivityPaper>
              <ActivityPaper className="activity-detail-participation">
                <section className="activity-copy-section" aria-label="队伍构成">
                  <ActivityParticipationPanel
                    activity={activity}
                    pendingSeriesPeriod={pendingSeriesPeriod}
                    isSeries={isSeries}
                    seriesOpen={seriesOpen}
                    isOffline={isOffline}
                    isMoving={isMoving}
                    seriesMoveRequest={seriesMoveRequest}
                    status={status}
                    selectedSeat={selectedSeat}
                    availableJobs={availableJobs}
                    job={job}
                    allowed={allowed}
                    busy={busy}
                    chooseSeat={chooseSeat}
                    setError={setError}
                    setRegistrationOpen={setRegistrationOpen}
                  />
                  {!registrationOpen ? <ErrorNotice message={error} /> : null}
                  {ordinarySingle ? (
                    <ActivityManagementControls
                      organizerContainer={organizerContainer}
                      activity={activity}
                      now={now}
                      onFeedback={notify}
                      onRefresh={() => {
                        setWriteResult(null);
                        setReload((value) => value + 1);
                      }}
                      onResult={(result) => {
                        setWriteResult({ owner: session!.user!.id, activity: result.activity });
                        setSeatId(undefined);
                        setExpectedSeatId(undefined);
                        setJob(undefined);
                        setError(null);
                      }}
                    />
                  ) : null}
                  {isOffline || isSeries ? (
                    <ActivityOrdinaryManagementControls
                      organizerContainer={organizerContainer}
                      onRecoveryChange={setOrganizerRecoveryNeeded}
                      activity={activity}
                      now={now}
                      onFeedback={notify}
                      onRefresh={() => {
                        setWriteResult(null);
                        setReload((value) => value + 1);
                      }}
                      onResult={(result) => {
                        setWriteResult({ owner: session!.user!.id, activity: result.activity });
                        setSeriesMoveRequest(null);
                        setSeatId(undefined);
                        setExpectedSeatId(undefined);
                        setJob(undefined);
                        setError(null);
                      }}
                    />
                  ) : null}
                </section>
              </ActivityPaper>
            </div>
            <aside className="activity-detail-records" aria-label="活动记录">
              {ordinarySingle ? (
                <ActivityAttendance
                  key={`attendance:${activity.revision}`}
                  id={activity.id}
                  now={now}
                  onFeedback={notify}
                  onChanged={() => {
                    setWriteResult(null);
                    setReload((value) => value + 1);
                  }}
                />
              ) : null}
              <ActivityPaper className="activity-detail-album">
                <section className="activity-copy-section" aria-label="活动相册">
                  <PageHeading decoration="cheese">活动相册</PageHeading>
                  <ActivityAlbumEntry
                    activityId={id}
                    primary={isOffline ? 'OFFLINE' : 'GAME'}
                    canCreate={activity.isOrganizer}
                  />
                </section>
              </ActivityPaper>
            </aside>
          </div>
          <ActivityRegistrationDialog
            activity={activity}
            registrationOpen={registrationOpen}
            isMoving={isMoving}
            isOffline={isOffline}
            retryingMove={!!seriesMoveRequest}
            busy={busy}
            registrationSeat={registrationSeat}
            selectedSeat={selectedSeat}
            availableJobs={availableJobs}
            job={job}
            allowed={allowed}
            error={error}
            onCancel={() => {
              if (!pending.current) setRegistrationOpen(false);
            }}
            onReturn={() => setRegistrationOpen(false)}
            onChooseJob={(name) => {
              if (!pending.current && selectedSeat && !busy && !seriesMoveRequest && allowed) setJob(name);
            }}
            onSubmit={submitRegistration}
          />
        </>
      ) : null}
    </main>
  );
}
