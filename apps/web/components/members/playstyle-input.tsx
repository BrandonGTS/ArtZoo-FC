'use client';

import { Input } from 'antd';

// Newlines map to the saved array without splitting legacy punctuation.
export function PlaystyleInput({
  value = [],
  onChange,
  disabled,
  id
}: {
  value?: string[];
  onChange?: (value: string[]) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Input.TextArea
      autoComplete="off"
      id={id}
      disabled={disabled}
      value={value.join('\n')}
      onChange={(event) => onChange?.(event.target.value.split('\n'))}
      autoSize={{ minRows: 4, maxRows: 10 }}
      placeholder="说说你喜欢的玩法"
    />
  );
}
