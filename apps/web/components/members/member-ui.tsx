'use client';

import Image from 'next/image';
import { Avatar, Card, Empty, Tag } from 'antd';
import type { MemberSummary } from '@artzoo/domain';
import { membershipLabels, ErrorNotice } from '../account/account-ui';
import { PageHeading } from '../home-content';
import './members.css';

export function MemberAvatar({
  member,
  size = 40
}: {
  member: Pick<MemberSummary, 'avatar' | 'membership'>;
  size?: number;
}) {
  return (
    <Avatar
      size={size}
      src={size > 128 ? member.avatar?.url : member.avatar?.smallUrl}
      alt=""
      className={`member-avatar member-avatar-${member.membership.toLowerCase()}`}
      icon={
        <Image
          src="/artzoo/icons/user-round.svg"
          alt=""
          width={size >= 80 ? 32 : 20}
          height={size >= 80 ? 32 : 20}
          unoptimized
        />
      }
    />
  );
}
export function MembershipTag({ membership }: Pick<MemberSummary, 'membership'>) {
  return (
    <Tag variant="outlined" className={`member-membership member-membership-${membership.toLowerCase()}`}>
      {membershipLabels[membership]}
    </Tag>
  );
}
export function memberLocation(member: Pick<MemberSummary, 'gameRegion' | 'gameServer'>) {
  return member.gameRegion && member.gameServer
    ? `${member.gameRegion} · ${member.gameServer}`
    : '尚未填写区服';
}
export function MemberPaper({
  children,
  variant = 'directory',
  className = ''
}: {
  children: React.ReactNode;
  variant?: 'directory' | 'profile';
  className?: string;
}) {
  return (
    <Card
      variant="borderless"
      classNames={{
        root: `paper-panel member-paper member-paper-${variant} ${className}`,
        body: 'member-paper-body'
      }}
    >
      {children}
    </Card>
  );
}
export function MemberLoadState({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading)
    return (
      <p role="status" className="member-note">
        正在读取资料…
      </p>
    );
  return error ? <ErrorNotice message={error} /> : null;
}
export function MemberEmptySection({
  title,
  decoration,
  description
}: {
  title: string;
  decoration: 'tomato' | 'cheese' | 'patty';
  description: string;
}) {
  return (
    <section className="home-section" aria-label={title}>
      <PageHeading decoration={decoration}>{title}</PageHeading>
      <MemberPaper>
        <div className="member-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={description}
            classNames={{
              root: 'section-empty',
              image: 'section-empty-image',
              description: 'section-empty-description'
            }}
          />
        </div>
      </MemberPaper>
    </section>
  );
}
