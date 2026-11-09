'use client';

import type { ComponentType } from 'react';
import { TEAM_POSITIONS, type TeamDetail, type TeamSessionView } from '@artzoo/domain';
import OperationMenu from '../operation-menu';
import { PageHeading } from '../home-content';
import { ActivityPaper, RequirementIcon, beijingFull } from '../activities/activity-ui';
import { TeamPersonLink } from './team-ui';

type Op = { kind: 'history' | 'adjust' | 'people' | 'cancel' };

type ConfirmedPanelProps = {
  team: TeamDetail;
  workspace: boolean;
  canManage: boolean;
  active: boolean;
  confirmed: TeamSessionView[];
  expanded: string[];
  now: number;
  open(kind: 'history' | 'adjust' | 'people' | 'cancel', sessionId?: string): void;
  toggle(value: string, set: (fn: (values: string[]) => string[]) => void): void;
  setExpanded(fn: (values: string[]) => string[]): void;
  Disclosure: ComponentType<{
    label: string;
    expanded: boolean;
    controls: string;
    onClick(): void;
  }>;
  SubstituteLabel: ComponentType<{ value: TeamSessionView['substitutes'][number] }>;
  sessionRange(session: TeamSessionView): string;
};

export function TeamConfirmedPanel({
  team,
  workspace,
  canManage,
  active,
  confirmed,
  expanded,
  now,
  open,
  toggle,
  setExpanded,
  Disclosure,
  SubstituteLabel,
  sessionRange
}: ConfirmedPanelProps) {
  return (
    <ActivityPaper className="team-workspace-schedule">
      <section className="team-stack">
        <div className="team-section-heading">
          <PageHeading decoration="tomato">已定排期</PageHeading>
          {workspace ? (
            <OperationMenu
              label="已定排期操作"
              items={[{ key: 'history', label: '历史排期' }]}
              onAction={() => open('history')}
            />
          ) : null}
        </div>
        {!confirmed.length ? (
          <p>暂无已定排期。</p>
        ) : (
          confirmed.map((s) => {
            const isOpen = expanded.includes(s.id);
            const changes = s.members.filter((m) => m.state === 'NEEDS_SUBSTITUTE'),
              extraSubstitutes = s.substitutes.filter(
                (v) => !s.members.some((m) => m.position === v.position)
              );
            const sessionMenu = [
              ...(canManage && Date.parse(s.startsAt) > now
                ? [{ key: 'adjust', label: '修改本场排期' }]
                : []),
              ...(active &&
              Date.parse(s.startsAt) > now &&
              (team.isCreator ||
                s.members.some(
                  (m) => m.person.id === team.currentAccountId && m.state === 'MEMBER' && !m.leave
                ))
                ? [{ key: 'people', label: team.isCreator ? '请假 / 临时补位' : '本期请假' }]
                : []),
              ...(canManage && Date.parse(s.startsAt) > now
                ? [{ key: 'cancel', label: '取消本场排期', danger: true }]
                : [])
            ];
            return (
              <section className="team-confirmed-session team-stack" key={s.id}>
                <div className="team-session-heading">
                  <div>
                    <h4>{sessionRange(s)}</h4>
                    <div className="team-session-name">
                      <span>{team.name}</span>
                      <Disclosure
                        label={isOpen ? '收起本期人员' : '展开本期人员'}
                        expanded={isOpen}
                        controls={'team-session-' + s.id}
                        onClick={() => toggle(s.id, setExpanded)}
                      />
                    </div>
                  </div>
                  {sessionMenu.length ? (
                    <OperationMenu
                      label={beijingFull(s.startsAt) + '排期操作'}
                      items={sessionMenu}
                      onAction={(key) => open(key as Op['kind'], s.id)}
                    />
                  ) : null}
                </div>
                {isOpen ? (
                  <div id={'team-session-' + s.id} className="team-stack">
                    <div className="team-section-heading">
                      <h4>参加成员</h4>
                      <span className="auxiliary">
                        {s.members.filter((m) => m.state === 'MEMBER').length}名队员
                        {s.substitutes.length ? ` + ${s.substitutes.length}名临时补位` : null}
                      </span>
                    </div>
                    <div className="team-scheduled-members">
                      {s.members
                        .filter((m) => m.state === 'MEMBER')
                        .map((m) => (
                          <div className="team-session-member" key={m.id}>
                            <span className="auxiliary">{TEAM_POSITIONS[m.position]}</span>
                            <TeamPersonLink person={m.person} />
                            <span className="team-session-job">
                              <RequirementIcon value={{ kind: 'JOB', job: m.job }} />
                              {m.job}
                            </span>
                          </div>
                        ))}
                    </div>
                    {changes.length || extraSubstitutes.length ? (
                      <>
                        <hr className="activity-detail-divider" />
                        <div className="team-stack" aria-label="请假与临时补位">
                          {changes.map((m) => (
                            <div className="team-session-change" key={m.id}>
                              <span className="team-role-label">{TEAM_POSITIONS[m.position]}</span>
                              <div>
                                <p>
                                  {m.person.displayName || '成员'} · {m.job} · {m.leave ? '请假' : '待补位'}
                                </p>
                                {m.leave ? (
                                  <p className="auxiliary team-description">{m.leave.reason}</p>
                                ) : null}
                              </div>
                              {s.substitutes.find((v) => v.position === m.position) ? (
                                <SubstituteLabel
                                  value={s.substitutes.find((v) => v.position === m.position)!}
                                />
                              ) : null}
                            </div>
                          ))}
                          {extraSubstitutes.map((v) => (
                            <div className="team-session-change" key={v.id}>
                              <span className="team-role-label">{TEAM_POSITIONS[v.position]}</span>
                              <SubstituteLabel value={v} />
                            </div>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </section>
    </ActivityPaper>
  );
}
