import Link from 'next/link';
import { Button } from 'antd';
import type { ACTIVITY_JOBS, activityStatus, ActivityDetail } from '@artzoo/domain';
import { PageHeading } from '../home-content';
import { RequirementIcon, requirementLabel } from './activity-ui';

interface ActivityParticipationPanelProps {
  readonly activity: ActivityDetail;
  readonly pendingSeriesPeriod: boolean;
  readonly isSeries: boolean;
  readonly seriesOpen: boolean;
  readonly isOffline: boolean;
  readonly isMoving: boolean;
  readonly seriesMoveRequest: Record<string, unknown> | null;
  readonly status: ReturnType<typeof activityStatus> | 'CANCELLED';
  readonly selectedSeat: ActivityDetail['seats'][number] | undefined;
  readonly availableJobs: ReadonlyArray<Pick<(typeof ACTIVITY_JOBS)[number], 'name'>>;
  readonly job: string | undefined;
  readonly allowed: boolean;
  readonly busy: boolean;
  readonly chooseSeat: (value: string | undefined) => void;
  readonly setError: (value: string | null) => void;
  readonly setRegistrationOpen: (value: boolean) => void;
}

export default function ActivityParticipationPanel({
  activity,
  pendingSeriesPeriod,
  isSeries,
  seriesOpen,
  isOffline,
  isMoving,
  seriesMoveRequest,
  status,
  selectedSeat,
  availableJobs,
  job,
  allowed,
  busy,
  chooseSeat,
  setError,
  setRegistrationOpen
}: ActivityParticipationPanelProps) {
  return (
    <>
      <PageHeading decoration="tomato">
        {pendingSeriesPeriod ? (
          '队伍构成 · 待首期成团'
        ) : (
          <>
            队伍构成 · {activity.registeredCount}/
            {activity.capacityUnlimited ? '不限人数' : activity.capacity}
          </>
        )}
      </PageHeading>
      <div className="activity-detail-participation-status">
        {activity.cancelledAt && !isSeries ? <p>活动已取消，报名与操作历史保留。</p> : null}
        {activity.myParticipation?.status === 'WITHDRAWN' ? (
          <p>你已退出报名。</p>
        ) : activity.myParticipation?.status === 'CANCELLED' ? (
          <p>该活动的报名已随取消关闭。</p>
        ) : null}
        {isSeries && !seriesOpen ? (
          <p>
            {activity.series?.state === 'FORMED'
              ? activity.cancelledAt
                ? '本期已取消，报名与操作历史保留。'
                : '本期沿用成团时锁定的成员名单。'
              : activity.series?.state === 'CANCELLED'
                ? '整项活动已取消，报名与操作历史保留。'
                : '请前往首期报名。'}
            {activity.series && activity.series.periodNumber !== 1 ? (
              <>
                {' '}
                <Link className="activity-text-link" href={`/activities/${activity.series.periods[0]?.id}`}>
                  查看首期
                </Link>
              </>
            ) : null}
          </p>
        ) : isOffline && isMoving ? null : !seriesMoveRequest && status !== 'OPEN' ? (
          <p>
            {status === 'FULL'
              ? isMoving
                ? '当前没有可更换的空席位。'
                : isOffline
                  ? '报名人数已满。'
                  : '当前席位已满。'
              : isMoving
                ? '已过报名截止时间，无法更换席位。'
                : '报名已截止。'}
          </p>
        ) : null}
      </div>
      <div className="activity-registration-grid">
        {pendingSeriesPeriod ? (
          <p>成员名单将在首期确认成团后同步。</p>
        ) : isOffline ? (
          activity.seats
            .filter((seat) => seat.registration)
            .map((seat) => (
              <div key={seat.id} className="activity-registration-seat activity-registration-seat-occupied">
                <Link href={`/members/${seat.registration!.participant.id}`}>
                  {seat.registration!.participant.displayName || '成员'}
                </Link>
              </div>
            ))
        ) : (
          activity.seats.map((seat) => {
            const seatLabel = `${seat.groupKey ? seat.groupKey + '队 · ' : ''}席位${seat.groupKey ? (seat.position % 8) + 1 : seat.position + 1}`;
            const selected = selectedSeat?.id === seat.id;
            const concreteJob =
              seat.registration?.job ||
              (selected && availableJobs.some((item) => item.name === job) ? job : undefined);
            const displayedRequirement = concreteJob
              ? { kind: 'JOB' as const, job: concreteJob }
              : seat.requirement;
            return seat.registration ? (
              <div
                key={seat.id}
                className="activity-registration-seat activity-registration-seat-occupied"
                aria-label={`${seatLabel} · ${requirementLabel(displayedRequirement)}`}
              >
                <span className="activity-detail-seat-icon">
                  <RequirementIcon value={displayedRequirement} />
                </span>
                <span className="activity-seat-label">{requirementLabel(displayedRequirement)}</span>
                <Link href={`/members/${seat.registration.participant.id}`}>
                  {seat.registration.participant.displayName || '成员'}
                </Link>
              </div>
            ) : (
              <Button
                key={seat.id}
                htmlType="button"
                className="activity-registration-seat activity-registration-seat-button activity-registration-seat-empty"
                classNames={{ content: 'activity-registration-seat-content' }}
                aria-label={`${seatLabel} · ${requirementLabel(seat.requirement)} · 空位`}
                aria-pressed={selected}
                aria-haspopup="dialog"
                aria-controls={allowed ? 'activity-registration-form' : undefined}
                disabled={!allowed || busy || !!seriesMoveRequest}
                onClick={() => chooseSeat(seat.id)}
              >
                <span className="activity-detail-seat-icon">
                  <RequirementIcon value={displayedRequirement} />
                </span>
                <span className="activity-seat-label">{requirementLabel(displayedRequirement)}</span>
              </Button>
            );
          })
        )}
      </div>
      {isOffline && allowed ? (
        <Button
          type="primary"
          className="activity-detail-offline-register"
          onClick={() => {
            setError(null);
            setRegistrationOpen(true);
          }}
        >
          报名参加活动
        </Button>
      ) : null}
      {seriesMoveRequest ? <Button onClick={() => setRegistrationOpen(true)}>重试原换位</Button> : null}
    </>
  );
}
