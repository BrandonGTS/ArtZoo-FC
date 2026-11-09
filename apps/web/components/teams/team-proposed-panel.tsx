import type { ComponentType, ReactNode } from 'react';
import type { TeamDetail, TeamSessionView } from '@artzoo/domain';
import { Button } from 'antd';
import OperationMenu from '../operation-menu';
import { PageHeading } from '../home-content';
import { ActivityPaper, beijingFull } from '../activities/activity-ui';
import type { Op } from './team-workspace';

interface TeamProposedPanelProps {
  readonly team: TeamDetail;
  readonly canManage: boolean;
  readonly active: boolean;
  readonly proposed: TeamSessionView[];
  readonly shownFeedback: string[];
  readonly open: (kind: Op['kind'], sessionId?: string) => void;
  readonly sessionRange: (session: TeamSessionView) => string;
  readonly feedbackCounts: (session: TeamSessionView) => ReactNode;
  readonly Disclosure: ComponentType<{ label: string; expanded: boolean; controls: string; onClick(): void }>;
  readonly toggle: (value: string, set: (fn: (values: string[]) => string[]) => void) => void;
  readonly setShownFeedback: (fn: (values: string[]) => string[]) => void;
  readonly choiceText: (choice: string | null) => string;
}

export function TeamProposedPanel({
  team,
  canManage,
  active,
  proposed,
  shownFeedback,
  open,
  sessionRange,
  feedbackCounts,
  Disclosure,
  toggle,
  setShownFeedback,
  choiceText
}: TeamProposedPanelProps) {
  return (
    <ActivityPaper className="team-workspace-proposals">
      <section className="team-stack">
        <div className="team-section-heading">
          <PageHeading decoration="cheese">{canManage ? '创建排期' : '队伍排期'}</PageHeading>
          {canManage ? (
            <OperationMenu
              label="创建排期操作"
              items={[
                { key: 'weekly', label: '安排下周排期' },
                { key: 'propose', label: '添加单场排期' }
              ]}
              onAction={(key) => open(key as Op['kind'])}
            />
          ) : null}
        </div>
        {active && team.isMember && proposed.length ? (
          <div className="team-actions team-feedback-entry">
            <Button type="primary" onClick={() => open('feedback')}>
              填写可参加时间
            </Button>
          </div>
        ) : null}
        {proposed.length ? (
          <div className="team-feedback-list">
            {proposed.map((s) => (
              <section className="team-proposed-session team-stack" key={s.id}>
                <div className="team-session-heading">
                  <div>
                    <h4>{sessionRange(s)}</h4>
                    {feedbackCounts(s)}
                  </div>
                  {canManage ? (
                    <OperationMenu
                      label={beijingFull(s.startsAt) + '待确认排期操作'}
                      items={[
                        { key: 'adjust', label: '修改本场排期' },
                        { key: 'confirm', label: '确认本场' },
                        { key: 'cancel', label: '取消本场', danger: true }
                      ]}
                      onAction={(key) => open(key as Op['kind'], s.id)}
                    />
                  ) : null}
                </div>
                <div className="team-feedback-disclosure">
                  <span>成员反馈</span>
                  <Disclosure
                    label={shownFeedback.includes(s.id) ? '收起反馈' : '查看反馈'}
                    expanded={shownFeedback.includes(s.id)}
                    controls={'team-feedback-' + s.id}
                    onClick={() => toggle(s.id, setShownFeedback)}
                  />
                </div>
                {shownFeedback.includes(s.id) ? (
                  <div id={'team-feedback-' + s.id} className="team-feedback-people">
                    {s.feedback.map((f) => (
                      <div className="team-person-feedback" key={f.person.id}>
                        <span>{f.person.displayName || '成员'}</span>
                        <span
                          className={
                            f.choice === 'CAN'
                              ? 'team-feedback-can'
                              : f.choice === 'CANNOT'
                                ? 'team-feedback-cannot'
                                : 'auxiliary'
                          }
                        >
                          {choiceText(f.choice)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
          </div>
        ) : (
          <p>{active ? '暂无待确认排期。' : '固定队已解散。'}</p>
        )}
      </section>
    </ActivityPaper>
  );
}
