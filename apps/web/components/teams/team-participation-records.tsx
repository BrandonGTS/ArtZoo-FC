'use client';
import { Button, Form, Input, Radio, Select } from 'antd';
import { TEAM_POSITIONS, type TeamSessionView, type TeamParticipationChangeView } from '@artzoo/domain';
import { beijingFull } from '../activities/activity-ui';
export const participationStatus: Record<string, string> = { PRESENT: '参加', LEAVE: '请假', ABSENT: '缺席' };
export function ParticipationLog({ records }: { records: TeamParticipationChangeView[] }) {
  return records.length ? (
    <div className="team-record-log">
      {records.map((r, i) => (
        <p className="team-description auxiliary" key={r.id}>
          {i === 0 ? '当前记录' : '历史记录'}：{participationStatus[r.status]} ·{' '}
          {r.actor.displayName || '成员'} · {beijingFull(r.recordedAt)} · {r.reason}
        </p>
      ))}
    </div>
  ) : null;
}
export default function ParticipationForm({
  session,
  busy,
  disabled,
  onCancel,
  onSubmit
}: {
  session: TeamSessionView;
  busy: boolean;
  disabled: boolean;
  onCancel(): void;
  onSubmit(fields: Record<string, unknown>): Promise<boolean>;
}) {
  const targets = [
    ...session.members.map((m) => ({
      value: 'MEMBER:' + m.id,
      label: `${TEAM_POSITIONS[m.position]} · ${m.person.displayName || '成员'}`
    })),
    ...session.substitutes.map((m) => ({
      value: 'SUBSTITUTE:' + m.id,
      label: `${TEAM_POSITIONS[m.position]} · ${m.person?.displayName || m.displayName} · 临时补位`
    }))
  ];
  return (
    <Form
      autoComplete="off"
      layout="vertical"
      disabled={disabled}
      onFinish={(v: { target: string; status: string; reason: string }) => {
        const [targetKind, targetId] = v.target.split(':');
        void onSubmit({ sessionId: session.id, targetKind, targetId, status: v.status, reason: v.reason });
      }}
    >
      <p>
        {beijingFull(session.startsAt)}–{beijingFull(session.endsAt)}
      </p>
      <Form.Item name="target" label="参与人员" rules={[{ required: true, message: '请选择本场人员' }]}>
        <Select options={targets} />
      </Form.Item>
      <Form.Item name="status" label="参与记录" rules={[{ required: true, message: '请选择参与记录' }]}>
        <Radio.Group
          options={[
            { value: 'PRESENT', label: '参加' },
            { value: 'LEAVE', label: '请假' },
            { value: 'ABSENT', label: '缺席' }
          ]}
        />
      </Form.Item>
      <Form.Item
        name="reason"
        label="补记 / 更正原因"
        rules={[{ required: true, whitespace: true, message: '请填写原因' }]}
      >
        <Input.TextArea autoComplete="off" maxLength={1000} />
      </Form.Item>
      <div className="team-actions">
        <Button disabled={busy} onClick={onCancel}>
          返回
        </Button>
        <Button type="primary" htmlType="submit" loading={busy} disabled={disabled}>
          保存记录
        </Button>
      </div>
    </Form>
  );
}
