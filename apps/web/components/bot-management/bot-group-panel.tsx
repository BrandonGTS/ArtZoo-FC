'use client';
import { useState } from 'react';
import { Button, Input, Modal, Switch, Tag, theme } from 'antd';
import { useManagementCommand } from '../admin-management/management-api';
import { ErrorNotice } from '../account/account-ui';
export interface BotGroupSummary {
  id: string;
  label: string;
  groupOpenId: string;
  enabled: boolean;
  generation: number;
  enabledAt: string | null;
}
export interface BotGroupList {
  available: boolean;
  revision: number;
  groups: BotGroupSummary[];
  adopted: boolean;
}
type Challenge = { challengeId: string; browserProof: string; publicCode: string; expiresAt: string };
export function BotGroupPanel({
  data,
  reload,
  disabled = false
}: {
  data: BotGroupList | null;
  reload(): void;
  disabled?: boolean;
}) {
  const { token } = theme.useToken(),
    [label, setLabel] = useState(''),
    [challenge, setChallenge] = useState<Challenge | null>(null),
    [receipt, setReceipt] = useState(''),
    [proof, setProof] = useState<string | null>(null),
    [proven, setProven] = useState(false),
    [toggle, setToggle] = useState<BotGroupSummary | null>(null);
  const command = useManagementCommand<Record<string, unknown>>({
    success(value, request) {
      if (request.kind !== 'json') throw new Error('invalid response');
      const path = request.path;
      if (path.endsWith('group-initiate')) {
        setChallenge(value as unknown as Challenge);
        setProof(null);
        setProven(false);
        setReceipt('');
      } else if (path.endsWith('group-select')) {
        setProof(String(value.proof));
      } else if (path.endsWith('group-progress')) {
        setProven(value.proven === true);
        if (value.proven !== true) command.setError('尚未收到本人群内确认');
      } else {
        setChallenge(null);
        setProof(null);
        setProven(false);
        setReceipt('');
        setToggle(null);
        reload();
      }
    }
  });
  const busy = disabled || command.locked;
  const body = () => ({ challengeId: challenge!.challengeId, browserProof: challenge!.browserProof });
  function submit(action: string, values: Record<string, unknown>) {
    void command.submit({
      kind: 'json',
      method: 'POST',
      path: '/api/admin/bot-management/group-' + action,
      body: values
    });
  }
  return (
    <section className="bot-group-panel">
      <h2>绑定群</h2>
      <ErrorNotice message={command.error} />
      <div className="bot-group-list">
        {data?.groups.map((g) => (
          <div className="bot-group-row" key={g.id}>
            <span>{g.label}</span>
            <Tag variant="solid" color={g.enabled && data.adopted ? token.colorSuccess : undefined}>
              {g.enabled ? (data.adopted ? '已启用' : '等待机器人采用') : '已停用'}
            </Tag>
            <Switch
              aria-label={'启用群 ' + g.label}
              checked={g.enabled}
              disabled={busy || !data.available || g.id === 'legacy'}
              onChange={() => setToggle(g)}
            />
          </div>
        ))}
      </div>
      {!challenge ? (
        <div className="bot-group-create">
          <Input
            aria-label="群名称"
            placeholder="群名称"
            maxLength={60}
            value={label}
            disabled={busy || !data?.available}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button
            disabled={busy || !data?.available || !label.trim()}
            onClick={() => submit('initiate', { label: label.trim() })}
          >
            绑定群
          </Button>
        </div>
      ) : (
        <div className="bot-group-proof">
          <p>在目标群由本人 @机器人，发送：</p>
          <Input
            aria-label="发起群绑定命令"
            readOnly
            autoComplete="off"
            value={'绑定群 ' + challenge.publicCode}
          />
          {!proof ? (
            <>
              <Input
                aria-label="本人群消息校验码"
                autoComplete="off"
                placeholder="机器人回复本人消息的校验码"
                value={receipt}
                disabled={busy}
                onChange={(e) => setReceipt(e.target.value)}
              />
              <Button
                disabled={busy || !receipt.trim()}
                onClick={() =>
                  submit('select', { ...body(), receiptCode: receipt.trim(), ownReplyConfirmed: true })
                }
              >
                已核对本人回复，继续
              </Button>
            </>
          ) : (
            <>
              <p>用同一QQ群身份 @机器人，发送：</p>
              <Input aria-label="确认群绑定命令" readOnly autoComplete="off" value={'确认群 ' + proof} />
              {!proven ? (
                <Button disabled={busy} onClick={() => submit('progress', body())}>
                  检查群内确认
                </Button>
              ) : (
                <Button
                  type="primary"
                  disabled={busy}
                  onClick={() => submit('confirm', { ...body(), confirmed: true })}
                >
                  确认绑定并保持停用
                </Button>
              )}
            </>
          )}
          <Button
            disabled={busy}
            onClick={() => {
              setChallenge(null);
              setProof(null);
              setProven(false);
              setReceipt('');
            }}
          >
            取消
          </Button>
        </div>
      )}
      {command.unknown ? (
        <Button onClick={() => void command.retry()} disabled={command.busy}>
          确认操作结果
        </Button>
      ) : null}
      <Modal
        title={toggle?.enabled ? '停用此群？' : '启用此群？'}
        open={!!toggle}
        okText="确认"
        cancelText="取消"
        confirmLoading={command.busy}
        closable={!busy}
        mask={{ closable: !busy }}
        onCancel={() => {
          if (!busy) setToggle(null);
        }}
        onOk={() => {
          if (toggle)
            submit('toggle', {
              groupId: toggle.id,
              enabled: !toggle.enabled,
              generation: toggle.generation,
              confirmed: true,
              idempotencyKey: crypto.randomUUID()
            });
        }}
      >
        <p>{toggle?.label}</p>
        <p>
          {toggle?.enabled
            ? '停止新通知、身份绑定和报名；未发送队列取消。在途消息可能已发出。'
            : '发送当前已开启的活动通知，并接受身份绑定与报名。不补历史通知。'}
        </p>
      </Modal>
    </section>
  );
}
