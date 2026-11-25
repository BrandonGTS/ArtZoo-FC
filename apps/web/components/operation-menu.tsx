'use client';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Button, Dropdown, theme } from 'antd';
import './operation-menu.css';

export type OperationMenuItem = {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
};
type MenuEdge = 'first' | 'last';

function getMenuButtons(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
}

function focusMenuEdge(menu: HTMLElement, edge: MenuEdge) {
  const buttons = getMenuButtons(menu);
  (edge === 'first' ? buttons[0] : buttons.at(-1))?.focus();
}

/** Formal activity organizer-menu appearance, with explicit portal and keyboard handling. */
export default function OperationMenu({
  label,
  items,
  onAction,
  disabled = false,
  compositeKeyboard = false
}: {
  label: string;
  items: OperationMenuItem[];
  onAction(key: string): void;
  disabled?: boolean;
  compositeKeyboard?: boolean;
}) {
  const { token } = theme.useToken(),
    id = useId();
  const [open, setOpen] = useState(false),
    [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [touchTrigger, setTouchTrigger] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null),
    pendingFocus = useRef<MenuEdge | null>(null);
  const expanded = open && !disabled;
  if (disabled && open) setOpen(false);
  useEffect(() => {
    if (!expanded || !container || !pendingFocus.current) return;
    const frame = requestAnimationFrame(() => {
      const edge = pendingFocus.current;
      pendingFocus.current = null;
      if (edge) focusMenuEdge(container, edge);
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
      pendingFocus.current = null;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [expanded, container]);
  function close(focus = false) {
    pendingFocus.current = null;
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
        trigger={touchTrigger ? ['click'] : ['hover', 'click']}
        placement="bottomRight"
        arrow
        destroyOnHidden={false}
        onOpenChange={(next) => {
          if (!next && container?.matches(':hover')) return;
          if (next) setOpen(true);
          else close();
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
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch' && !disabled) setOpen(true);
            }}
            onPointerLeave={(event) => {
              // A touch emits pointerleave before the item's click.
              if (event.pointerType !== 'touch') close();
            }}
            onClick={(event) => event.stopPropagation()}
            onAuxClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) close();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (compositeKeyboard && event.key === 'Tab') {
                // The popup is portaled. Resume native tab order from its trigger.
                close(true);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                close(true);
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const buttons = getMenuButtons(event.currentTarget);
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
                tabIndex={compositeKeyboard ? -1 : undefined}
                className={item.className}
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
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') setTouchTrigger(false);
          }}
          onPointerDown={(event) => setTouchTrigger(event.pointerType === 'touch')}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !expanded) return;
            event.stopPropagation();
            if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
              event.preventDefault();
              const edge = compositeKeyboard && event.key === 'ArrowUp' ? 'last' : 'first';
              if (compositeKeyboard && expanded && container) {
                pendingFocus.current = null;
                focusMenuEdge(container, edge);
              } else {
                pendingFocus.current = edge;
                setOpen(true);
              }
            }
            if (event.key === 'Escape' || (compositeKeyboard && expanded && event.key === 'Tab')) close();
          }}
          icon={<span className="operation-menu-chevron" aria-hidden="true" />}
        />
      </Dropdown>
    </span>
  );
}
