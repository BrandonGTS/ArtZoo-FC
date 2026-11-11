'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Modal, Select } from 'antd';
import { accountRequest } from '../account/api';
import { markBackgroundRequest } from '../user-operation';
import { useFeedbackMessage } from '../use-feedback-message';
import { MemberPaper } from './member-ui';

type Binding = {
  id: string;
  version: number;
  groupOpenId: string;
  confirmedAt: string;
  label: string;
};
type Status = {
  enabled: boolean;
  groups: Array<{ groupOpenId: string; label: string }>;
  bindings: Binding[];
};
type Initiated = { requestId: string; key: string; expiresAt: string };
type Pending = { requestId: string; groupOpenId: string; label: string; expiresAt: string };
type Progress = { state: 'PENDING' | 'BOUND' | 'EXPIRED' | 'REVOKED'; expiresAt: string; bindingId?: string };

class BindingReadError extends Error {
  constructor(readonly status: number) {
    super('QQ binding read failed');
  }
}

// Background reads must not enter the site's foreground waiting indicator.
async function readBinding<T>(url: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(),
    abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 10000);
  try {
    const response = await fetch(
      url,
      markBackgroundRequest({ credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    );
    if (!response.ok) throw new BindingReadError(response.status);
    const payload = (await response.json()) as { ok: boolean; data?: T };
    if (!payload || payload.ok !== true || payload.data === undefined)
      throw new BindingReadError(response.status);
    return payload.data;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function QqBindingSettings() {
  const [status, setStatus] = useState<Status | null>(null),
    [statusReady, setStatusReady] = useState(false);
  const [group, setGroup] = useState(''),
    [pending, setPending] = useState<Pending | null>(null);
  const [key, setKey] = useState(''),
    [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false),
    [unlink, setUnlink] = useState<Binding | null>(null);
  const [notice, setNotice] = useState(''),
    [loadFailed, setLoadFailed] = useState(false);
  const [pollProblem, setPollProblem] = useState(false),
    [copyFailed, setCopyFailed] = useState(false);
  const active = useRef(false),
    mounted = useRef(false),
    pendingRef = useRef<Pending | null>(null);
  const statusRevision = useRef(0),
    commandBox = useRef<HTMLDivElement>(null);
  const { notify, contextHolder } = useFeedbackMessage(),
    groupLabelId = useId(),
    commandHelpId = useId();
  const feedback = useRef(notify);
  useEffect(() => {
    feedback.current = notify;
  }, [notify]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const revision = ++statusRevision.current;
    if (mounted.current) setStatusReady(false);
    const value = await readBinding<Status>('/api/me/qq-binding', signal);
    if (!mounted.current || revision !== statusRevision.current || signal?.aborted) return;
    setStatus(value);
    setStatusReady(true);
    setLoadFailed(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => {
      if (!controller.signal.aborted && mounted.current) {
        setLoadFailed(true);
        feedback.current('error', '绑定状态读取失败，请刷新页面后查看');
      }
    });
    return () => {
      mounted.current = false;
      controller.abort();
      pendingRef.current = null;
    };
  }, [refresh]);

  const clearPending = useCallback((requestId: string, message: string) => {
    if (!mounted.current || pendingRef.current?.requestId !== requestId) return false;
    pendingRef.current = null;
    setPending(null);
    setKey('');
    setSecondsLeft(0);
    setCopyFailed(false);
    setPollProblem(false);
    setNotice(message);
    return true;
  }, []);

  const refreshAfterChange = useCallback(async () => {
    try {
      await refresh();
    } catch {
      if (mounted.current) {
        setLoadFailed(true);
        feedback.current('error', '绑定列表读取失败，请刷新页面后查看');
      }
    }
  }, [refresh]);

  useEffect(() => {
    if (!pending) return;
    let disposed = false,
      pollTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const expiresAt = Date.parse(pending.expiresAt);
    const current = () => !disposed && mounted.current && pendingRef.current?.requestId === pending.requestId;
    const stopRead = () => {
      clearTimeout(pollTimer);
      controller?.abort();
      controller = null;
    };
    const finish = (message: string, bound = false) => {
      if (!current() || !clearPending(pending.requestId, message)) return;
      stopRead();
      if (bound) feedback.current('success', 'QQ群身份已绑定');
      void refreshAfterChange();
    };
    const expire = () => finish('密钥已过期。');
    const expiryTimer = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    const tick = () => {
      if (!current()) return;
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (!remaining) expire();
    };
    const clockTimer = setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, 1000);

    async function check() {
      if (!current() || document.visibilityState !== 'visible' || controller) return;
      clearTimeout(pollTimer);
      if (Date.now() >= expiresAt) {
        expire();
        return;
      }
      const readController = new AbortController();
      controller = readController;
      try {
        const query = new URLSearchParams({ requestId: pending!.requestId, group: pending!.groupOpenId });
        const value = await readBinding<Progress>(
          `/api/me/qq-binding/progress?${query}`,
          readController.signal
        );
        if (!current() || readController.signal.aborted) return;
        if (value.state === 'BOUND') finish('QQ群身份已绑定。', true);
        else if (value.state === 'EXPIRED') expire();
        else if (value.state === 'REVOKED') finish('密钥已撤销，请重新生成。');
        else setPollProblem(value.state !== 'PENDING');
      } catch (reason) {
        if (!current() || document.visibilityState !== 'visible') return;
        if (reason instanceof BindingReadError && reason.status === 401) {
          clearPending(pending!.requestId, '登录已失效，请重新登录后查看绑定状态。');
          stopRead();
          setStatus(null);
          setStatusReady(false);
          setLoadFailed(true);
        } else if (controller === readController) setPollProblem(true);
      } finally {
        if (controller === readController) {
          controller = null;
          if (current() && document.visibilityState === 'visible')
            pollTimer = setTimeout(() => void check(), 3000);
        }
      }
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') stopRead();
      else {
        tick();
        void check();
      }
    };
    const onFocus = () => {
      tick();
      void check();
    };
    tick();
    void check();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      stopRead();
      clearTimeout(expiryTimer);
      clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [pending, clearPending, refreshAfterChange]);

  async function run(action: () => Promise<void>, failureMessage: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    try {
      await action();
    } catch {
      if (mounted.current) feedback.current('error', failureMessage);
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const selectedGroup = status?.groups.find((item) => item.groupOpenId === group) ?? status?.groups[0];
  const occupied = status?.bindings.find((binding) => binding.groupOpenId === selectedGroup?.groupOpenId);
  const command = key ? `绑定 ${key}` : '';
  const remaining = `${Math.floor(secondsLeft / 60)}分${String(secondsLeft % 60).padStart(2, '0')}秒`;

  async function initiate() {
    if (!statusReady || !status?.enabled || !selectedGroup || occupied || pendingRef.current) return;
    const target = selectedGroup;
    await run(async () => {
      const value = await accountRequest<Initiated>('/api/me/qq-binding/initiate', {
        method: 'POST',
        body: { groupOpenId: target.groupOpenId }
      });
      if (!mounted.current) return;
      const expiresAt = Date.parse(value.expiresAt);
      if (
        !value.requestId ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.key) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      ) {
        setNotice('未取得有效密钥，请重新生成。');
        return;
      }
      const next = {
        requestId: value.requestId,
        groupOpenId: target.groupOpenId,
        label: target.label,
        expiresAt: value.expiresAt
      };
      pendingRef.current = next;
      setPending(next);
      setKey(value.key);
      setSecondsLeft(Math.ceil((expiresAt - Date.now()) / 1000));
      setNotice('');
      setPollProblem(false);
      setCopyFailed(false);
    }, '生成密钥未成功，请确认登录、目标群及已有绑定后重试');
  }

  async function copyCommand() {
    const requestId = pendingRef.current?.requestId;
    if (!requestId || !command || !pending || Date.now() >= Date.parse(pending.expiresAt)) return;
    try {
      await navigator.clipboard.writeText(command);
      if (mounted.current && pendingRef.current?.requestId === requestId) {
        setCopyFailed(false);
        feedback.current('success', '命令已复制，请在所选QQ群手动@机器人后粘贴发送');
      }
    } catch {
      if (mounted.current && pendingRef.current?.requestId === requestId) {
        const input = commandBox.current?.querySelector('input');
        input?.focus();
        input?.select();
        setCopyFailed(true);
        feedback.current('error', '无法自动复制，已选中命令，请手动复制');
      }
    }
  }

  return (
    <MemberPaper variant="profile" className="member-editor-paper qq-binding-paper">
      {contextHolder}
      <h3>QQ群身份绑定</h3>
      {status?.bindings.map((binding) => (
        <div key={binding.id} className="qq-binding-row">
          <span>{binding.label}</span>
          <Button danger disabled={busy || !statusReady || !!pending} onClick={() => setUnlink(binding)}>
            解绑
          </Button>
        </div>
      ))}
      {!status ? (
        <p>{loadFailed ? '绑定状态读取失败，请刷新页面后查看。' : '正在读取绑定状态…'}</p>
      ) : !status.enabled ? (
        <p>QQ群身份绑定暂不可用</p>
      ) : (
        <div className="qq-binding-steps">
          {!pending ? (
            <>
              <span id={groupLabelId}>目标群</span>
              <Select
                aria-labelledby={groupLabelId}
                style={{ width: '100%', minWidth: 0 }}
                value={selectedGroup?.groupOpenId}
                disabled={busy || !statusReady || !status.groups.length}
                placeholder="暂无可绑定的群"
                options={status.groups.map((item) => ({ value: item.groupOpenId, label: item.label }))}
                onChange={(value) => {
                  setGroup(value);
                  setNotice('');
                }}
              />
              {occupied ? <p>所选群已绑定，请先解绑后再生成密钥。</p> : null}
              <Button
                type="primary"
                disabled={busy || !statusReady || !selectedGroup || !!occupied}
                aria-busy={busy}
                onClick={() => void initiate()}
              >
                生成一次性密钥
              </Button>
            </>
          ) : (
            <>
              <p>目标群：{pending.label}</p>
              <p>密钥相当于临时授权，请勿转发；请仅在所选群本人使用</p>
              <p>有效期5分钟，剩余{remaining}。</p>
              <div ref={commandBox}>
                <Input
                  aria-label="群身份绑定命令"
                  aria-describedby={commandHelpId}
                  autoComplete="off"
                  spellCheck={false}
                  readOnly
                  value={command}
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
              </div>
              <p id={commandHelpId}>请先在所选QQ群手动@机器人，再粘贴发送以上命令。</p>
              <p className="member-note">点击命令框可全选并手动复制。关闭或刷新页面后，需重新生成密钥。</p>
              <Button disabled={busy || !key} onClick={() => void copyCommand()}>
                复制绑定命令
              </Button>
              {copyFailed ? <p role="status">命令已选中，请使用系统复制操作。</p> : null}
              {pollProblem ? (
                <p role="status">暂时无法查询绑定结果，恢复连接后会继续检查；请勿重复发送命令。</p>
              ) : null}
              <Button
                disabled={busy}
                aria-busy={busy}
                onClick={() =>
                  void run(async () => {
                    const request = pendingRef.current;
                    if (!request) return;
                    try {
                      await accountRequest('/api/me/qq-binding/cancel', {
                        method: 'POST',
                        body: { requestId: request.requestId, groupOpenId: request.groupOpenId }
                      });
                    } catch (reason) {
                      if (pendingRef.current?.requestId !== request.requestId) return;
                      throw reason;
                    }
                    if (clearPending(request.requestId, '密钥已撤销。')) await refreshAfterChange();
                  }, '撤销结果暂未确认，请勿继续使用密钥；等待状态更新或过期后再生成')
                }
              >
                撤销密钥
              </Button>
            </>
          )}
        </div>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {status && loadFailed ? <p>绑定列表读取失败，请刷新页面后查看。</p> : null}
      <Modal
        title="解除QQ群身份绑定"
        open={!!unlink}
        okText="确认解绑"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: busy }}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        mask={{ closable: !busy }}
        onCancel={() => {
          if (!busy) setUnlink(null);
        }}
        onOk={() =>
          void run(async () => {
            if (!unlink || pendingRef.current) return;
            await accountRequest('/api/me/qq-binding/unlink', {
              method: 'POST',
              body: {
                bindingId: unlink.id,
                version: unlink.version,
                confirmed: true,
                groupOpenId: unlink.groupOpenId
              }
            });
            if (!mounted.current) return;
            setUnlink(null);
            setNotice('QQ群身份已解绑。');
            feedback.current('success', 'QQ群身份已解绑');
            await refreshAfterChange();
          }, '解绑结果暂未确认，请刷新页面核对当前绑定后再操作')
        }
      >
        <p>解绑后，此QQ群身份不能通过机器人报名。网站已有报名保持不变。</p>
      </Modal>
    </MemberPaper>
  );
}
