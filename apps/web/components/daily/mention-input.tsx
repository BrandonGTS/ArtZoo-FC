import { useState } from 'react';
import { Button } from 'antd';
import type { MemberList, MemberProfile } from '@artzoo/domain';
import { MemberSearch } from '../teams/team-ui';
import { accountRequest } from '../account/api';
import { mentionLabel, containsMention } from '../../server/daily/contract';
import { dailyError } from './use-command';
import DailyToolbarIcon from './daily-toolbar-icon';
export default function MentionInput({
  onChange,
  disabled,
  popupClassName,
  compact = false
}: {
  onChange(label: string, id: string): void;
  disabled: boolean;
  popupClassName?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  async function select(id: string | undefined) {
    if (!id || busy) return;
    setBusy(true);
    setError(null);
    try {
      const p = await accountRequest<MemberProfile>('/api/members/' + id),
        matches = await accountRequest<MemberList>(
          '/api/members?query=' + encodeURIComponent(p.displayName ?? '')
        );
      if (!p.displayName) throw new Error('成员尚未填写昵称');
      const label = mentionLabel(p, matches.items.filter((x) => x.displayName === p.displayName).length > 1);
      onChange(label, id);
      setOpen(false);
    } catch (e) {
      setError(dailyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="daily-mention">
      <Button
        type={compact ? 'text' : 'default'}
        aria-label="提及成员"
        icon={compact ? <DailyToolbarIcon kind="mention" /> : undefined}
        disabled={disabled || busy}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {compact ? null : '@成员'}
      </Button>
      {open ? (
        <div className="daily-member-search">
          <MemberSearch
            popupClassName={popupClassName}
            disabled={disabled || busy}
            onChange={(value) => void select(value)}
          />
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

export async function activeMentions(body: string, selected: string[]) {
  if (!selected.length) return [];
  const { items } = await accountRequest<MemberList>('/api/members');
  return selected.filter((id) => {
    const person = items.find((p) => p.id === id);
    return (
      person?.displayName &&
      containsMention(
        body,
        mentionLabel(person, items.filter((p) => p.displayName === person.displayName).length > 1)
      )
    );
  });
}
