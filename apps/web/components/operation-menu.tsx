'use client';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Button, Dropdown, theme } from 'antd';
import './operation-menu.css';

export type OperationMenuItem = { key: string; label: string; danger?: boolean; disabled?: boolean };
/** Formal activity organizer-menu appearance, with explicit portal and keyboard handling. */
export default function OperationMenu({
  label,
  items,
  onAction,
  disabled = false
}: {
  label: string;
  items: OperationMenuItem[];
  onAction(key: string): void;
  disabled?: boolean;
}) {
  const { token } = theme.useToken(),
    id = useId();
  const [open, setOpen] = useState(false),
    [container, setContainer] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null),
    focusMenu = useRef(false);
  const expanded = open && !disabled;
  if (disabled && open) setOpen(false);
  useEffect(() => {
    if (!expanded || !container || !focusMenu.current) return;
    const frame = requestAnimationFrame(() => {
      container.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      focusMenu.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, container]);
  useEffect(() => {
    if (!expanded) return;
    // Hover can open this portal while focus remains on another menu trigger.
    // Capture Escape before that trigger's own handler stops propagation.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target instanceof Element ? event.target : null;
      const targetDialog = target?.closest('[role="dialog"], [role="alertdialog"]');
      const triggerDialog = trigger.current?.closest('[role="dialog"], [role="alertdialog"]');
      if (targetDialog && targetDialog !== triggerDialog && !container?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      focusMenu.current = false;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [expanded, container]);
  function close(focus = false) {
    setOpen(false);
    if (focus) trigger.current?.focus();
  }
  return (
    <span
      className="operation-menu-entry"
      data-home-card-independent
      onClick={(event) => event.stopPropagation()}
      onAuxClick={(event) => event.stopPropagation()}
    >
      <Dropdown
        open={expanded}
        disabled={disabled}
        trigger={['hover', 'click']}
        placement="bottomRight"
        arrow
        destroyOnHidden={false}
        onOpenChange={(next) => {
          if (!next && container?.matches(':hover')) return;
          setOpen(next);
        }}
        popupRender={() => (
          <div
            ref={setContainer}
            id={id}
            className="operation-menu-popup"
            role="menu"
            aria-label={label}
            data-home-card-independent
            style={
              {
                background: token.colorBgElevated,
                borderRadius: token.borderRadiusLG,
                boxShadow: token.boxShadowSecondary,
                '--operation-menu-hover-bg': token.controlItemBgHover
              } as CSSProperties
            }
            onPointerEnter={() => {
              if (!disabled) setOpen(true);
            }}
            onPointerLeave={() => close()}
            onClick={(event) => event.stopPropagation()}
            onAuxClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) close();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                close(true);
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
                );
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buttons.length - 1
                      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
                buttons[next]?.focus();
              }
            }}
          >
            {items.map((item) => (
              <Button
                key={item.key}
                htmlType="button"
                role="menuitem"
                danger={item.danger}
                disabled={disabled || item.disabled}
                onClick={() => {
                  if (disabled || item.disabled) return;
                  close(true);
                  onAction(item.key);
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
        )}
      >
        <Button
          ref={trigger}
          type="text"
          htmlType="button"
          className="operation-menu-trigger"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={expanded}
          aria-controls={expanded ? id : undefined}
          disabled={disabled}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
              event.preventDefault();
              focusMenu.current = true;
              setOpen(true);
            }
            if (event.key === 'Escape') close();
          }}
          icon={<span className="operation-menu-chevron" aria-hidden="true" />}
        />
      </Dropdown>
    </span>
  );
}
