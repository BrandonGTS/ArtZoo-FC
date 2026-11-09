'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Avatar, Card, Empty, Tooltip } from 'antd';
import { beijingDateKey, isAwaitingSeriesRoster } from '@artzoo/domain';
import type { ActivityPerson, ActivityStatus, ActivitySummary, SeatRequirement } from '@artzoo/domain';
import { PageHeading } from '../home-content';
import { ActivityTypeTag } from './activity-type-tag';
import { ErrorNotice } from '../account/account-ui';
import { JOBS } from '../members/job-catalog';
import tank from './assets/tank.png';
import healer from './assets/healer.png';
import damage from './assets/damage.png';
import any from './assets/any.png';
import './activities.css';

export const categoryLabels = { DUNGEON: '副本活动', SOCIAL: '非副本聚会' } as const;
export const statusLabels: Record<ActivityStatus, string> = {
  OPEN: '招募中',
  FULL: '满员',
  REGISTRATION_CLOSED: '报名已截止',
  IN_PROGRESS: '已到开始时间',
  TIME_ENDED: '已到预定结束时间',
  CANCELLED: '已取消'
};
export const roles = [
  { value: 'TANK', label: '防护', icon: tank },
  { value: 'HEALER', label: '治疗', icon: healer },
  { value: 'DAMAGE', label: '输出', icon: damage }
] as const;
export const anyIcon = any;
export function beijingDate(value: string | number | Date) {
  return beijingDateKey(new Date(value));
}
export function beijingTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}
export function beijingFull(value: string) {
  return beijingDate(value).replaceAll('-', '/') + ' ' + beijingTime(value);
}
export function requirementLabel(value: SeatRequirement | null) {
  if (!value) return '空位';
  return value.kind === 'ANY'
    ? '不限'
    : value.kind === 'JOB'
      ? value.job
      : roles.find((role) => role.value === value.role)!.label;
}
export function RequirementIcon({ value }: { value: SeatRequirement | null }) {
  if (!value) return null;
  const icon =
    value.kind === 'ANY'
      ? any
      : value.kind === 'ROLE'
        ? roles.find((role) => role.value === value.role)!.icon
        : JOBS.find((job) => job.name === value.job)?.icon;
  return icon ? <Image src={icon} alt="" width={24} height={24} unoptimized /> : null;
}
export function ActivityPaper({
  children,
  className = ''
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card
      variant="borderless"
      classNames={{
        root: `paper-panel paper-activity activity-paper ${className}`,
        body: 'activity-paper-body'
      }}
    >
      {children}
    </Card>
  );
}
export function ActivityHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="activity-page-heading">
      <PageHeading level={1} decoration="burger">
        {title}
      </PageHeading>
      {children}
    </div>
  );
}
export function ActivityLoadState({
  loading,
  error
}: {
  loading: boolean;
  error: string | null;
  retry(): void;
}) {
  return loading ? (
    <p className="activity-note" role="status">
      正在读取活动…
    </p>
  ) : error ? (
    <div className="activity-load-error">
      <ErrorNotice message={error} />
    </div>
  ) : null;
}
export function ActivityEmpty({ text }: { text: string }) {
  return (
    <div className="activity-empty">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />
    </div>
  );
}
export function ActivityAvatars({ participants }: { participants: ActivityPerson[] }) {
  return (
    <div className="activity-avatars" aria-label={`已报名 ${participants.length} 人`}>
      {participants.map((person) => (
        <Tooltip key={person.id} title={person.displayName || '成员'} trigger={['hover', 'focus']}>
          <Link href={`/members/${person.id}`} aria-label={person.displayName || '成员'}>
            <Avatar
              size={28}
              src={person.avatarUrl}
              icon={<Image src="/artzoo/icons/user-round.svg" alt="" width={18} height={18} unoptimized />}
            />
          </Link>
        </Tooltip>
      ))}
    </div>
  );
}
export function ActivityCard({ activity }: { activity: ActivitySummary }) {
  return (
    <ActivityPaper className="activity-card">
      <div className="activity-title-row">
        <ActivityTypeTag scene={activity.scene} mode={activity.mode} />
        <h3>{activity.title}</h3>
      </div>
      {activity.series ? (
        <p className="activity-note">
          第{activity.series.periodNumber} / {activity.series.totalPeriods}期
        </p>
      ) : null}
      <p className={`activity-status activity-status-${activity.status.toLowerCase()}`}>
        {beijingFull(activity.startsAt)} ·{' '}
        {isAwaitingSeriesRoster(activity) ? (
          '待首期成团 · 仅首期招募'
        ) : (
          <>
            {statusLabels[activity.status]} · {activity.registeredCount}/
            {activity.capacityUnlimited ? '不限人数' : `${activity.capacity}人`}
          </>
        )}
      </p>
      <Link className="activity-text-link" href={`/activities/${activity.id}`}>
        查看详情
      </Link>
    </ActivityPaper>
  );
}
