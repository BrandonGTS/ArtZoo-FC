'use client';

import { Tag, theme } from 'antd';
import type { ActivityMode, ActivityScene } from '@artzoo/domain';
import { getActivityTypeAppearance } from './activity-type-appearance';

export function ActivityTypeTag({
  type = 'single',
  scene = 'GAME',
  mode
}: {
  type?: 'single' | 'long-term';
  scene?: ActivityScene;
  mode?: ActivityMode;
}) {
  const { token } = theme.useToken();
  const appearance = getActivityTypeAppearance(token, { type, scene, mode });
  return (
    <Tag color={appearance.color} variant="solid">
      {appearance.label}
    </Tag>
  );
}
