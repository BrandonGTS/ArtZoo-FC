'use client';
import { useState } from 'react';
import { Button, Input } from 'antd';
import { useSharingCommand } from '../public-sharing/sharing-api';
import { useFeedbackMessage } from '../use-feedback-message';
import { GUEST_TEXT_ONLY_ERROR, guestTextContainsSticker } from './text-policy';
import './guest-contact.css';

export default function GuestContactForm({ onSubmitted }: { onSubmitted?: () => void }) {
  const [qq, setQq] = useState(''),
    [message, setMessage] = useState('');
  const { notify, contextHolder } = useFeedbackMessage();
  const command = useSharingCommand<{ submitted: true; replayed: boolean }>({
    notify,
    success(result) {
      if (result?.submitted !== true || typeof result.replayed !== 'boolean')
        throw new Error('Invalid response');
      setQq('');
      setMessage('');
      notify('success', '留言已提交');
      try {
        onSubmitted?.();
      } catch (error) {
        console.error('Guest contact success callback failed', error);
      }
    }
  });
  function submit() {
    if (command.locked) return;
    const draftMessage = message;
    if (!/^[1-9]\d{4,11}$/.test(qq.trim())) {
      command.setError('QQ号码须为5至12位数字，且不能以0开头');
      return;
    }
    if (!draftMessage.trim() || draftMessage.trim().length > 500) {
      command.setError('请填写500字以内的纯文本留言');
      return;
    }
    if (guestTextContainsSticker(draftMessage)) {
      command.setError(GUEST_TEXT_ONLY_ERROR);
      return;
    }
    void command.submit({
      kind: 'json',
      path: '/api/contact-requests',
      body: { qq: qq.trim(), message: draftMessage.trim(), submissionKey: crypto.randomUUID() }
    });
  }
  return (
    <form
      className="guest-contact-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {contextHolder}
      <label htmlFor="guest-contact-qq">
        QQ号码（必填）
        <Input
          id="guest-contact-qq"
          name="qq"
          aria-required="true"
          autoComplete="off"
          inputMode="numeric"
          maxLength={12}
          value={qq}
          disabled={command.locked}
          onChange={(event) => setQq(event.target.value)}
          aria-describedby="guest-contact-privacy"
        />
      </label>
      <label htmlFor="guest-contact-message">
        留言（必填）
        <Input.TextArea
          id="guest-contact-message"
          name="message"
          aria-required="true"
          autoComplete="off"
          rows={3}
          maxLength={500}
          showCount
          value={message}
          disabled={command.locked}
          onChange={(event) => setMessage(event.target.value)}
          aria-describedby="guest-contact-privacy"
        />
      </label>
      <p id="guest-contact-privacy" className="guest-contact-hint">
        仅支持文字留言。QQ和留言仅管理员可见，用于与你联系。
      </p>
      {command.unknown ? (
        <>
          <p role="status" className="guest-contact-hint">
            暂时无法确认结果，请重试确认。联系方式和留言已保留。
          </p>
          <Button type="primary" loading={command.busy} onClick={() => void command.retry()}>
            重试确认留言
          </Button>
        </>
      ) : (
        <Button type="primary" htmlType="submit" loading={command.busy} disabled={command.locked}>
          提交留言
        </Button>
      )}
    </form>
  );
}
