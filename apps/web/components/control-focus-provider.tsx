'use client';

import { useEffect } from 'react';
import { installControlFocus } from './control-focus';

export default function ControlFocusProvider() {
  useEffect(() => installControlFocus(document), []);
  return null;
}
