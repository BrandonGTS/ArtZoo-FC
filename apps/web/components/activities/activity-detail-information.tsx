import Link from 'next/link';
import {
  DUTY_TYPE_LABELS,
  PARTY_COMPOSITION_LABELS,
  type ActivityDetail as ActivityDetailData
} from '@artzoo/domain';
import type { splitActivityDescription } from './activity-description';
import { ActivitySeriesPeriods } from './activity-series-controls';
import { beijingFull } from './activity-ui';

interface ActivityDetailInformationProps {
  readonly activity: Readonly<ActivityDetailData>;
  readonly isOffline: boolean;
  readonly isSeries: boolean;
  readonly description: Readonly<ReturnType<typeof splitActivityDescription>>;
}

export default function ActivityDetailInformation({
  activity,
  isOffline,
  isSeries,
  description
}: ActivityDetailInformationProps) {
  return (
    <>
      <section className="activity-detail-fact-group" aria-label="基本信息">
        <p className="activity-detail-field-label">
          <strong>基本信息</strong>
        </p>
        <dl className="activity-facts">
          {!isOffline && activity.duty ? (
            <>
              <div>
                <dt>具体副本</dt>
                <dd>{activity.duty.name}</dd>
              </div>
              <div>
                <dt>副本类型</dt>
                <dd>{DUTY_TYPE_LABELS[activity.duty.type]}</dd>
              </div>
              <div>
                <dt>队伍构成</dt>
                <dd>
                  {PARTY_COMPOSITION_LABELS[activity.duty.partyComposition]}
                  {activity.duty.partyComposition === 'CUSTOM' ? ` · ${activity.duty.capacity}人` : ''}
                </dd>
              </div>
            </>
          ) : null}
          <div>
            <dt>组织者</dt>
            <dd>
              <Link href={`/members/${activity.organizer.id}`}>
                {activity.organizer.displayName || '成员'}
              </Link>
            </dd>
          </div>
          {isOffline ? (
            <>
              <div>
                <dt>活动地点</dt>
                <dd>{activity.location}</dd>
              </div>
              {activity.meetingInstructions ? (
                <div>
                  <dt>集合说明</dt>
                  <dd className="activity-description">{activity.meetingInstructions}</dd>
                </div>
              ) : null}
              <div>
                <dt>人数上限</dt>
                <dd>{activity.capacityUnlimited ? '不限人数' : `${activity.capacity}人`}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </section>
      <section className="activity-detail-fact-group activity-detail-times" aria-label="时间信息">
        <p className="activity-detail-field-label">
          <strong>时间信息</strong>
        </p>
        <dl className="activity-facts">
          <div>
            <dt>开始时间</dt>
            <dd>{beijingFull(activity.startsAt)}</dd>
          </div>
          <div>
            <dt>预定结束</dt>
            <dd>{beijingFull(activity.endsAt)}</dd>
          </div>
          {!isSeries || activity.series?.periodNumber === 1 ? (
            <div>
              <dt>{isSeries ? '首期报名截止' : '报名截止'}</dt>
              <dd>
                {beijingFull(activity.registrationClosesAt)}
                {!isOffline ? '（开始前30分钟）' : ''}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
      <ActivitySeriesPeriods activity={activity} />
      {description.arrangement || !description.requirements ? (
        <section className="activity-detail-fact-group" aria-label="活动安排">
          <p className="activity-detail-field-label">
            <strong>活动安排</strong>
          </p>
          <p className="activity-description">{description.arrangement || '组织者尚未填写活动说明。'}</p>
        </section>
      ) : null}
      {description.requirements ? (
        <section className="activity-detail-fact-group" aria-label="参与要求">
          <p className="activity-detail-field-label">
            <strong>参与要求</strong>
          </p>
          <p className="activity-description">{description.requirements}</p>
        </section>
      ) : null}
    </>
  );
}
