import { Button, Form, Input } from 'antd';
import type { TeamDetail } from '@artzoo/domain';
import type { Op } from './team-workspace';

interface TeamEditPanelProps {
  readonly team: TeamDetail;
  readonly op: Pick<Op, 'revision'>;
  readonly busy: boolean;
  readonly changed: boolean;
  readonly send: (action: string, fields: Record<string, unknown>, keep?: boolean) => Promise<boolean>;
  readonly setOp: (value: null) => void;
}

export function TeamEditPanel({ team, op, busy, changed, send, setOp }: TeamEditPanelProps) {
  return (
    <Form
      autoComplete="off"
      key={'edit:' + op.revision}
      layout="vertical"
      disabled={busy || changed}
      initialValues={{
        name: team.name,
        description: team.description,
        dutyName: team.dutyName,
        progress: team.progress,
        strategy: team.strategy,
        commonTimes: team.commonTimes,
        qqGroupId: team.qqGroupId ?? ''
      }}
      onFinish={(v: Record<string, string>) =>
        void send('edits', { ...v, qqGroupId: v.qqGroupId?.trim() || null })
      }
    >
      <Form.Item
        name="name"
        label="队伍名称"
        rules={[{ required: true, whitespace: true, message: '请填写队伍名称' }, { max: 100 }]}
      >
        <Input autoComplete="off" maxLength={100} />
      </Form.Item>
      <Form.Item name="description" label="队伍简介">
        <Input.TextArea autoComplete="off" maxLength={2000} autoSize={{ minRows: 2, maxRows: 6 }} />
      </Form.Item>
      <Form.Item
        name="dutyName"
        label="具体副本"
        rules={[{ required: true, whitespace: true, message: '请填写具体副本' }, { max: 200 }]}
      >
        <Input autoComplete="off" maxLength={200} />
      </Form.Item>
      <Form.Item
        name="progress"
        label="进度"
        rules={[{ required: true, whitespace: true, message: '请填写进度' }, { max: 500 }]}
      >
        <Input autoComplete="off" maxLength={500} />
      </Form.Item>
      <Form.Item
        name="strategy"
        label="攻略"
        rules={[{ required: true, whitespace: true, message: '请填写攻略' }, { max: 2000 }]}
      >
        <Input autoComplete="off" maxLength={2000} />
      </Form.Item>
      <Form.Item
        name="commonTimes"
        label="时间"
        rules={[{ required: true, whitespace: true, message: '请填写时间' }, { max: 500 }]}
      >
        <Input autoComplete="off" maxLength={500} />
      </Form.Item>
      <Form.Item name="qqGroupId" label="队伍QQ群（选填）">
        <Input autoComplete="off" maxLength={100} />
      </Form.Item>
      <div className="team-actions">
        <Button disabled={busy} onClick={() => setOp(null)}>
          返回
        </Button>
        <Button type="primary" htmlType="submit" loading={busy}>
          保存修改
        </Button>
      </div>
    </Form>
  );
}
