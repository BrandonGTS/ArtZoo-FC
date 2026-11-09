import { Button, Form, Radio } from 'antd';
import type { TeamSessionView } from '@artzoo/domain';
import { beijingDate, beijingTime, beijingFull } from '../activities/activity-ui';
import type { Op } from './team-workspace';

interface TeamFeedbackPanelProps {
  readonly op: Pick<Op, 'revision'>;
  readonly busy: boolean;
  readonly changed: boolean;
  readonly proposed: TeamSessionView[];
  readonly notify: (kind: 'success' | 'error', message: string) => void;
  readonly setOp: (value: null) => void;
  readonly send: (action: string, fields: Record<string, unknown>, keep?: boolean) => Promise<boolean>;
}

export function TeamFeedbackPanel({
  op,
  busy,
  changed,
  proposed,
  notify,
  setOp,
  send
}: TeamFeedbackPanelProps) {
  return (
    <Form
      autoComplete="off"
      key={'feedback:' + op.revision}
      layout="vertical"
      disabled={busy || changed}
      initialValues={{
        choices: Object.fromEntries(proposed.map((s) => [s.id, s.myChoice ?? undefined]))
      }}
      onFinish={(v: { choices?: Record<string, 'CAN' | 'CANNOT'> }) => {
        const choices = proposed.flatMap((s) =>
          v.choices?.[s.id] && v.choices[s.id] !== s.myChoice
            ? [{ sessionId: s.id, timeVersion: s.timeVersion, choice: v.choices[s.id] }]
            : []
        );
        if (!choices.length) {
          notify('success', '反馈未变化');
          setOp(null);
          return;
        }
        void send('feedback', { choices });
      }}
    >
      {proposed.map((s) => (
        <div className="team-feedback-edit-row" key={s.id}>
          <div>
            <p>{beijingDate(s.startsAt)}</p>
            <p className="auxiliary">
              {beijingTime(s.startsAt)}–{beijingTime(s.endsAt)}
            </p>
          </div>
          <Form.Item name={['choices', s.id]} noStyle>
            <Radio.Group aria-label={beijingFull(s.startsAt) + '反馈'}>
              <Radio value="CAN">可参加</Radio>
              <Radio value="CANNOT">不可参加</Radio>
            </Radio.Group>
          </Form.Item>
          <span className="auxiliary">{s.myChoice ? '已填写' : '未反馈'}</span>
        </div>
      ))}
      <div className="team-actions">
        <Button onClick={() => setOp(null)} disabled={busy}>
          返回
        </Button>
        <Button htmlType="submit" type="primary" loading={busy}>
          保存反馈
        </Button>
      </div>
    </Form>
  );
}
