'use client';
import { useState } from 'react';
import { Button, Cascader, Form, Input, Radio, Select } from 'antd';
import {
  ACTIVITY_JOBS,
  GAME_SERVER_REGIONS,
  TEAM_POSITIONS,
  jobMeetsSeat,
  type TeamDetail,
  type TeamSessionView
} from '@artzoo/domain';
import { MemberSearch } from './team-ui';
const servers = GAME_SERVER_REGIONS.map(({ region, servers }) => ({
  value: region,
  label: region,
  children: servers.map((server) => ({ value: server, label: server }))
}));
export default function TeamSessionPeople({
  team,
  session,
  busy,
  disabled,
  onCancel,
  onSubmit
}: {
  team: TeamDetail;
  session: TeamSessionView;
  busy: boolean;
  disabled: boolean;
  onCancel(): void;
  onSubmit(action: string, fields: Record<string, unknown>): Promise<boolean>;
}) {
  const [mode, setMode] = useState<'leave' | 'substitute'>('leave'),
    [kind, setKind] = useState<'REGISTERED' | 'EXTERNAL'>('REGISTERED');
  const [form] = Form.useForm(),
    position = Form.useWatch('position', form);
  const eligible = session.members.filter(
    (m) =>
      m.state === 'MEMBER' &&
      !m.leave &&
      team.seats.some((s) => s.member?.id && s.member.person.id === m.person.id) &&
      (team.isCreator || m.person.id === team.currentAccountId)
  );
  const vacancies = team.seats.filter(
    (s) =>
      !session.substitutes.some((m) => m.position === s.position) &&
      !session.members.some((m) => m.position === s.position && m.state === 'MEMBER')
  );
  return (
    <Form
      autoComplete="off"
      form={form}
      layout="vertical"
      disabled={disabled}
      preserve={false}
      onFinish={(v: {
        memberId: string;
        reason: string;
        position: number;
        job: string;
        accountId?: string;
        displayName?: string;
        gameLocation?: [string, string];
      }) => {
        void onSubmit(
          mode === 'leave' ? 'session-leaves' : 'substitutes',
          mode === 'leave'
            ? { sessionId: session.id, memberId: v.memberId, reason: v.reason }
            : {
                sessionId: session.id,
                position: v.position,
                job: v.job,
                kind,
                accountId: kind === 'REGISTERED' ? v.accountId : null,
                displayName: kind === 'EXTERNAL' ? v.displayName : null,
                gameRegion: kind === 'EXTERNAL' ? v.gameLocation?.[0] : null,
                gameServer: kind === 'EXTERNAL' ? v.gameLocation?.[1] : null
              }
        );
      }}
    >
      {team.isCreator ? (
        <Form.Item label="本期人员安排">
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            options={[
              { value: 'leave', label: '记录请假' },
              { value: 'substitute', label: '临时补位' }
            ]}
          />
        </Form.Item>
      ) : null}
      {mode === 'leave' ? (
        <>
          <Form.Item
            name="memberId"
            label={team.isCreator ? '请假队员' : '本期席位'}
            rules={[{ required: true, message: '请选择本场队员' }]}
          >
            <Select
              options={eligible.map((m) => ({
                value: m.id,
                label: TEAM_POSITIONS[m.position] + ' · ' + (m.person.displayName || '成员')
              }))}
            />
          </Form.Item>
          <Form.Item
            name="reason"
            label="请假原因"
            rules={[{ required: true, whitespace: true, message: '请填写请假原因' }]}
          >
            <Input.TextArea autoComplete="off" maxLength={1000} />
          </Form.Item>
        </>
      ) : (
        <>
          <Form.Item name="position" label="补位席位" rules={[{ required: true, message: '请选择本场空位' }]}>
            <Select
              options={vacancies.map((s) => ({ value: s.position, label: TEAM_POSITIONS[s.position] }))}
            />
          </Form.Item>
          <Form.Item label="临补成员">
            <Radio.Group
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              options={[
                { value: 'REGISTERED', label: '站内成员' },
                { value: 'EXTERNAL', label: '站外成员' }
              ]}
            />
          </Form.Item>
          {kind === 'REGISTERED' ? (
            <Form.Item
              name="accountId"
              label="站内成员"
              rules={[{ required: true, message: '请选择站内成员' }]}
            >
              <MemberSearch />
            </Form.Item>
          ) : (
            <>
              <Form.Item
                name="displayName"
                label="游戏昵称"
                rules={[{ required: true, whitespace: true, message: '请填写游戏昵称' }]}
              >
                <Input autoComplete="off" maxLength={30} />
              </Form.Item>
              <Form.Item
                name="gameLocation"
                label="大区 / 服务器"
                rules={[{ required: true, message: '请选择大区和服务器' }]}
              >
                <Cascader options={servers} displayRender={(labels) => labels.join(' / ')} />
              </Form.Item>
            </>
          )}
          <Form.Item name="job" label="本次职业" rules={[{ required: true, message: '请选择职业' }]}>
            <Select
              options={ACTIVITY_JOBS.filter(
                (j) => typeof position === 'number' && jobMeetsSeat(team.seats[position]!.requirement, j.name)
              ).map((j) => ({ value: j.name, label: j.name }))}
            />
          </Form.Item>
        </>
      )}
      <div className="team-actions">
        <Button disabled={busy} onClick={onCancel}>
          返回
        </Button>
        <Button
          type="primary"
          htmlType="submit"
          loading={busy}
          disabled={disabled || (mode === 'leave' ? !eligible.length : !vacancies.length)}
        >
          {mode === 'leave' ? '提交请假' : '保存临补'}
        </Button>
      </div>
    </Form>
  );
}
