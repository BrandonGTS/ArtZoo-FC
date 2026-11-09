'use client';

import { createElement, Fragment, useCallback, useId, useRef } from 'react';
import { Button, message, theme } from 'antd';

export const FEEDBACK_DURATION_SECONDS = 5;

// Figma 421:3443 uses AntD Message with the site's existing colors and typography.
export function useFeedbackMessage() {
  const { token } = theme.useToken();
  const [messageApi, contextHolder] = message.useMessage({
    top: 24,
    duration: FEEDBACK_DURATION_SECONDS,
    pauseOnHover: false,
    styles: { list: { position: 'fixed' } }
  });
  const instanceId = useId();
  const sequence = useRef(0);
  const notify = useCallback(
    (
      type: 'success' | 'error' | 'warning' | 'info',
      content: string,
      action?: { label: string; onClick: () => void; secondary?: { label: string; onClick: () => void } }
    ) => {
      const key = `${instanceId}-feedback-${++sequence.current}`;
      const color = {
        success: token.colorSuccess,
        error: token.colorError,
        warning: token.colorWarning,
        info: token.colorInfo
      }[type];
      void messageApi.open({
        type,
        content: action
          ? createElement(
              Fragment,
              null,
              content,
              createElement(
                Button,
                {
                  type: 'link',
                  danger: true,
                  size: 'small',
                  onClick: (event) => {
                    event.stopPropagation();
                    action.onClick();
                  }
                },
                action.label
              ),
              action.secondary
                ? createElement(
                    Button,
                    {
                      type: 'link',
                      danger: true,
                      size: 'small',
                      onClick: (event) => {
                        event.stopPropagation();
                        action.secondary!.onClick();
                      }
                    },
                    action.secondary.label
                  )
                : null
            )
          : content,
        key,
        duration: action ? 0 : FEEDBACK_DURATION_SECONDS,
        pauseOnHover: false,
        styles: {
          root: {
            width: 280,
            maxWidth: 'calc(100vw - 32px)',
            minHeight: 48,
            boxSizing: 'border-box',
            padding: '10px 16px',
            border: `1px solid ${color}`,
            borderRadius: token.borderRadius,
            background: { success: '#E5EEDB', error: '#F7E4DC', warning: '#F8EDCE', info: '#E4EEEC' }[type],
            boxShadow: token.boxShadowSecondary,
            cursor: 'pointer'
          },
          wrapper: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 },
          icon: { color, fontSize: 20, flexShrink: 0 },
          title: {
            color,
            fontFamily: token.fontFamily,
            fontSize: token.fontSize,
            lineHeight: token.lineHeight,
            textAlign: 'center',
            minWidth: 0,
            overflowWrap: 'anywhere',
            whiteSpace: 'normal'
          }
        },
        onClick: () => messageApi.destroy(key)
      });
      return () => messageApi.destroy(key);
    },
    [instanceId, messageApi, token]
  );
  return { notify, contextHolder };
}
