'use client';

import type { ReactNode } from 'react';
import type { TeamDetail } from '@artzoo/domain';
import Link from 'next/link';
import { ActivityPaper } from '../activities/activity-ui';

export default function TeamInformation({ team, children }: { team: TeamDetail; children: ReactNode }) {
  return (
    <ActivityPaper className="activity-detail-copy team-detail-information">
      <div className="activity-detail-title-row">
        <div className="activity-title-row">
          <h3 className="activity-detail-title team-information-title">{team.name}</h3>
        </div>
        {children}
      </div>
      <section className="activity-detail-fact-group" aria-label="基本信息">
        <p className="activity-detail-field-label">
          <strong>基本信息</strong>
        </p>
        <dl className="activity-facts">
          <div>
            <dt>组织者</dt>
            <dd>
              <Link href={`/members/${team.creator.id}`}>{team.creator.displayName || '成员'}</Link>
            </dd>
          </div>
          <div>
            <dt>具体副本</dt>
            <dd>{team.dutyName || '未填写'}</dd>
          </div>
          {team.description ? (
            <div>
              <dt>队伍简介</dt>
              <dd className="team-description">{team.description}</dd>
            </div>
          ) : null}
          {team.qqGroupId ? (
            <div>
              <dt>队伍QQ群</dt>
              <dd>{team.qqGroupId}</dd>
            </div>
          ) : null}
        </dl>
      </section>
      <section className="activity-detail-fact-group" aria-label="攻略安排">
        <p className="activity-detail-field-label">
          <strong>攻略安排</strong>
        </p>
        <dl className="activity-facts">
          <div>
            <dt>进度</dt>
            <dd className="team-description">{team.progress || '未填写'}</dd>
          </div>
          <div>
            <dt>攻略</dt>
            <dd className="team-description">{team.strategy || '未填写'}</dd>
          </div>
          <div>
            <dt>时间</dt>
            <dd className="team-description">{team.commonTimes || '未填写'}</dd>
          </div>
        </dl>
      </section>
    </ActivityPaper>
  );
}
