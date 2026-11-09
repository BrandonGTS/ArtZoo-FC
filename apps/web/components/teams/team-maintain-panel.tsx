import type { ComponentType } from 'react';
import { Button, Form, Select } from 'antd';
import {
  ACTIVITY_JOBS,
  TEAM_POSITIONS,
  jobMeetsSeat,
  type TeamDetail,
  type TeamSeatView
} from '@artzoo/domain';
import { MemberSearch } from './team-ui';
import type { Op } from './team-workspace';

interface TeamMaintainPanelProps {
  readonly team: TeamDetail;
  readonly available: TeamSeatView[];
  readonly op: Pick<Op, 'revision'>;
  readonly busy: boolean;
  readonly changed: boolean;
  readonly membersExpanded: boolean;
  readonly setMembersExpanded: (fn: (value: boolean) => boolean) => void;
  readonly Disclosure: ComponentType<{ label: string; expanded: boolean; controls: string; onClick(): void }>;
  readonly open: (kind: Op['kind'], sessionId?: string, memberId?: string) => void;
  readonly send: (action: string, fields: Record<string, unknown>, keep?: boolean) => Promise<boolean>;
}

export function TeamMaintainPanel({
  team,
  available,
  op,
  busy,
  changed,
  membersExpanded,
  setMembersExpanded,
  Disclosure,
  open,
  send
}: TeamMaintainPanelProps) {
  return (
    <>
      <div className="team-maintain-heading">
        <h4>
          {team.name} · 长期成员 {8 - available.length}/8
        </h4>
        <Disclosure
          label={membersExpanded ? '收起长期成员' : '展开长期成员'}
          expanded={membersExpanded}
          controls={'team-maintain-members-' + team.id}
          onClick={() => setMembersExpanded((value) => !value)}
        />
      </div>
      {membersExpanded ? (
        <div id={'team-maintain-members-' + team.id}>
          {team.seats.map((s) => (
            <div className="team-member-row" key={s.id}>
              <span className="team-role-label">{TEAM_POSITIONS[s.position]}</span>
              <span>{s.member ? `${s.member.person.displayName || '成员'} · ${s.member.job}` : '空位'}</span>
              {s.member && s.member.person.id !== team.creator.id ? (
                <Button
                  type="link"
                  danger
                  className="activity-text-link"
                  disabled={busy || changed}
                  onClick={() => open('remove', undefined, s.member!.id)}
                >
                  移除
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {available.length ? (
        <Form
          autoComplete="off"
          key={'member:' + op.revision}
          layout="vertical"
          disabled={busy || changed}
          onFinish={(v: { position: number; memberId: string; job: string }) => void send('members', v, true)}
        >
          <Form.Item name="position" label="补充席位" rules={[{ required: true, message: '请选择席位' }]}>
            <Select
              options={available.map((s) => ({
                value: s.position,
                label: TEAM_POSITIONS[s.position]
              }))}
            />
          </Form.Item>
          <Form.Item name="memberId" label="站内成员" rules={[{ required: true, message: '请选择站内成员' }]}>
            <MemberSearch />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.position !== b.position}>
            {({ getFieldValue }) => (
              <Form.Item name="job" label="职业" rules={[{ required: true, message: '请选择职业' }]}>
                <Select
                  options={ACTIVITY_JOBS.filter((job) => {
                    const seat = team.seats[getFieldValue('position') as number];
                    return !!seat && jobMeetsSeat(seat.requirement, job.name);
                  }).map((job) => ({ value: job.name, label: job.name }))}
                />
              </Form.Item>
            )}
          </Form.Item>
          <div className="team-actions team-maintain-actions">
            <Button type="primary" htmlType="submit" loading={busy}>
              补充成员
            </Button>
          </div>
        </Form>
      ) : null}
    </>
  );
}
