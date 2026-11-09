'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Avatar, Button, Card, Select } from 'antd';
import {
  ACTIVITY_JOBS,
  TEAM_POSITIONS,
  type TeamSeatView,
  type SeatRequirement,
  type MemberList,
  type TeamPerson
} from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { RequirementIcon, requirementLabel } from '../activities/activity-ui';
import './teams.css';

export const requirementOptions = [
  ...(['TANK', 'HEALER', 'DAMAGE'] as const).map((role, i) => ({
    value: 'ROLE:' + role,
    label: ['防护职能', '治疗职能', '输出职能'][i]
  })),
  ...ACTIVITY_JOBS.map((job) => ({ value: 'JOB:' + job.name, label: job.name }))
];
export const requirementValue = (r: SeatRequirement) =>
  r.kind === 'JOB' ? 'JOB:' + r.job : r.kind === 'ROLE' ? 'ROLE:' + r.role : '';
export function requirementInput(value: string): SeatRequirement {
  return value.startsWith('JOB:')
    ? { kind: 'JOB', job: value.slice(4) }
    : { kind: 'ROLE', role: value.slice(5) as 'TANK' | 'HEALER' | 'DAMAGE' };
}
export function TeamPaper({
  children,
  side = 'left',
  className = ''
}: {
  children: React.ReactNode;
  side?: 'left' | 'right' | 'session';
  className?: string;
}) {
  return (
    <Card
      variant="borderless"
      className={`paper-panel team-paper team-paper-${side} ${className}`}
      styles={{ body: { padding: 24 } }}
    >
      {children}
    </Card>
  );
}
export function TeamPersonLink({ person }: { person: { id: string; displayName: string | null } }) {
  return (
    <div className="team-seat-member">
      <Avatar
        size={28}
        icon={<Image src="/artzoo/teams/user-round.svg" alt="" width={16} height={16} unoptimized />}
      />
      <Link href={`/members/${person.id}`}>{person.displayName || '成员'}</Link>
    </div>
  );
}
export function TeamAuthor({ person }: { person: TeamPerson }) {
  return (
    <div className="team-author">
      <Link className="team-author-profile" href={`/members/${person.id}`}>
        <Avatar
          size={28}
          src={person.avatarUrl}
          icon={<Image src="/artzoo/icons/user-round.svg" alt="" width={18} height={18} unoptimized />}
        />
        <span>{person.displayName || '成员'}</span>
      </Link>
      <span className="team-author-server" title={person.gameServer || ''}>
        {person.gameServer || '未填写服务器'}
      </span>
    </div>
  );
}
export function TeamFact({
  kind,
  label,
  value
}: {
  kind: 'duty' | 'progress' | 'strategy' | 'time';
  label?: string;
  value: string;
}) {
  return (
    <p
      className="home-activity-fact team-recruitment-fact"
      title={label ? `${label}：${value || '未填写'}` : value || '未填写副本'}
    >
      {kind === 'time' ? (
        <Image src="/artzoo/icons/calendar-days.svg" alt="" width={20} height={20} unoptimized />
      ) : (
        <svg
          className="home-activity-fact-icon"
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.67"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {kind === 'duty' ? (
            <path d="M3 17h14M5 17V6l5-3 5 3v11M8 17v-5h4v5M8 7h.01M12 7h.01" />
          ) : kind === 'progress' ? (
            <>
              <path d="M4 17V4M4 5c4-4 8 4 12 0v7c-4 4-8-4-12 0" />
            </>
          ) : (
            <>
              <path d="M3 4h5c1 0 2 1 2 2v11c0-2-1-3-3-3H3zM17 4h-5c-1 0-2 1-2 2v11c0-2 1-3 3-3h4z" />
            </>
          )}
        </svg>
      )}
      <span>
        {label ? `${label}：` : ''}
        {value || (label ? '未填写' : '未填写副本')}
      </span>
    </p>
  );
}
export function TeamCompactRoster({ seats }: { seats: TeamSeatView[] }) {
  return (
    <div className="team-compact-roster" aria-label="当前构成">
      {seats.map((seat) => (
        <span
          key={seat.id}
          title={`${TEAM_POSITIONS[seat.position]}${seat.member ? ' · ' + seat.member.job : ''}`}
        >
          <span>{TEAM_POSITIONS[seat.position]}</span>
          {seat.member ? <RequirementIcon value={{ kind: 'JOB', job: seat.member.job }} /> : null}
        </span>
      ))}
    </div>
  );
}
export function TeamRoster({
  seats,
  recruiting = true,
  canApply = false,
  directJoin = false,
  onApply
}: {
  seats: TeamSeatView[];
  recruiting?: boolean;
  canApply?: boolean;
  directJoin?: boolean;
  onApply?(position: number): void;
}) {
  return (
    <div className="activity-registration-grid team-detail-roster">
      {seats.map((seat) => {
        const requirement = seat.member ? { kind: 'JOB' as const, job: seat.member.job } : seat.requirement;
        const waiting = !seat.member && seat.pendingApplicationCount > 0;
        const content = (
          <>
            <span className="activity-detail-seat-icon">
              <RequirementIcon value={requirement} />
            </span>
            <span className="activity-seat-label team-detail-position">{TEAM_POSITIONS[seat.position]}</span>
            {seat.member ? (
              <Link className="team-seat-approved-name" href={`/members/${seat.member.person.id}`}>
                {seat.member.person.displayName || '成员'}
              </Link>
            ) : (
              <span className={waiting ? 'team-seat-pending-name' : 'team-seat-empty-name'}>
                {waiting
                  ? '已有申请'
                  : recruiting
                    ? directJoin
                      ? '空位 · 可报名'
                      : '空位 · 可申请'
                    : '空位'}
              </span>
            )}
          </>
        );
        return seat.member ? (
          <div
            key={seat.id}
            className="activity-registration-seat activity-registration-seat-occupied"
            aria-label={`${TEAM_POSITIONS[seat.position]} · ${seat.member.job} · 正式队员`}
          >
            {content}
          </div>
        ) : (
          <Button
            key={seat.id}
            htmlType="button"
            className={`activity-registration-seat activity-registration-seat-button activity-registration-seat-empty ${waiting ? 'team-seat-pending' : ''}`}
            classNames={{ content: 'activity-registration-seat-content' }}
            disabled={!recruiting || !canApply}
            aria-label={`${TEAM_POSITIONS[seat.position]} · ${requirementLabel(requirement)} · ${waiting ? '已有申请' : '空位'}`}
            aria-haspopup="dialog"
            onClick={() => onApply?.(seat.position)}
          >
            {content}
          </Button>
        );
      })}
    </div>
  );
}
export function MemberSearch({
  value,
  onChange,
  disabled,
  popupClassName
}: {
  value?: string;
  onChange?(id: string | undefined): void;
  disabled?: boolean;
  popupClassName?: string;
}) {
  const [query, setQuery] = useState(''),
    [searchRequested, setSearchRequested] = useState(false),
    [members, setMembers] = useState<MemberList['items']>([]),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      void accountRequest<MemberList>('/api/members?query=' + encodeURIComponent(query), {
        signal: controller.signal,
        userInitiated: searchRequested
      })
        .then((result) => {
          if (!controller.signal.aborted) setMembers(result.items);
        })
        .catch((failure) => {
          if (!controller.signal.aborted) {
            setMembers([]);
            setError(errorDetail(failure).message);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchRequested]);
  return (
    <>
      <Select
        aria-label="搜索站内成员"
        classNames={popupClassName ? { popup: { root: popupClassName } } : undefined}
        allowClear
        showSearch={{
          onSearch: (value) => {
            setSearchRequested(true);
            setQuery(value);
          },
          filterOption: false
        }}
        placeholder="搜索站内成员"
        value={value}
        onChange={onChange}
        disabled={disabled}
        loading={loading}
        style={{ width: '100%' }}
        options={members.map((member) => ({
          value: member.id,
          label: `${member.displayName || '成员'} · ${member.gameRegion || ''}/${member.gameServer || ''}`
        }))}
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
