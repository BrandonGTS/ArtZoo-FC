'use client';

import { Button } from 'antd';
import { TEAM_POSITIONS, type TeamDetail, type TeamSessionView } from '@artzoo/domain';
import { ParticipationLog } from './team-participation-records';

type TeamHistoryPanelProps = {
  team: Pick<TeamDetail, 'sessions' | 'isCreator'>;
  now: number;
  open(kind: 'records', sessionId: string): void;
  sessionRange(session: TeamSessionView): string;
};

export function TeamHistoryPanel({ team, now, open, sessionRange }: TeamHistoryPanelProps) {
  // Preserve the moved JSX, including its explicit whitespace.
  // prettier-ignore
  return (
              <>
                {!team.sessions?.some((s) => s.state === 'CANCELLED' || Date.parse(s.endsAt) <= now) ? (
                  <p>暂无历史排期。</p>
                ) : (
                  team.sessions
                    .filter((s) => s.state === 'CANCELLED' || Date.parse(s.endsAt) <= now)
                    .map((s) => (
                      <section className="team-history-row" key={s.id}>
                        <h4>
                          {sessionRange(s)} · {s.state === 'CANCELLED' ? '已取消' : '已结束'}
                        </h4>
                        {s.members.map((m) => (
                          <div key={m.id}>
                            <p>
                              {TEAM_POSITIONS[m.position]} · {m.person.displayName || '成员'} · {m.job}
                              {m.leave
                                ? ` · 原请假：${m.leave.reason}`
                                : m.state === 'NEEDS_SUBSTITUTE'
                                  ? ' · 待补位'
                                  : ''}
                            </p>
                            <ParticipationLog records={m.records} />
                          </div>
                        ))}
                        {s.substitutes.map((m) => (
                          <div key={m.id}>
                            <p>
                              {TEAM_POSITIONS[m.position]} · {m.person?.displayName || m.displayName} ·{' '}
                              {m.job} · 临时补位
                            </p>
                            <ParticipationLog records={m.records} />
                          </div>
                        ))}
                        {team.isCreator && s.state === 'CONFIRMED' && Date.parse(s.endsAt) <= now ? (
                          <Button onClick={() => open('records', s.id)}>补记 / 更正记录</Button>
                        ) : null}
                      </section>
                    ))
                )}
              </>
  );
}
