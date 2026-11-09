import type { GlobalToken } from 'antd';
import type { ActivityMode, ActivityScene } from '@artzoo/domain';

type TypeColors = Pick<GlobalToken, 'colorPrimary' | 'colorInfo' | 'colorError' | 'colorWarning'>;
type TypeOptions = { type?: 'single' | 'long-term'; scene?: ActivityScene; mode?: ActivityMode };

export function getActivityTypeAppearance(
  token: TypeColors,
  { type = 'single', scene = 'GAME', mode }: TypeOptions = {}
) {
  const appearances = {
    GAME: {
      SINGLE: { label: '普通单次', color: token.colorPrimary },
      SERIES: { label: '普通长期', color: token.colorError }
    },
    OFFLINE: {
      SINGLE: { label: '线下单次', color: token.colorInfo },
      SERIES: { label: '线下长期', color: token.colorWarning }
    }
  };
  const longTerm = mode ? mode === 'SERIES' : type === 'long-term';
  return appearances[scene][longTerm ? 'SERIES' : 'SINGLE'];
}
