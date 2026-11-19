import * as React from 'react';

/**
 * Menus for the annotation controls: a `role="menu"` popup under its
 * button (the toolbar's Shape, Outline and ⋯ menus, the selection bar's
 * actions), its items and how it closes.
 */

const colors = {
    border: '#cfcfcf',
    hover: '#eef4fb',
    muted: '#595959',
    text: '#222',
} as const;

/** Focusable items of a menu or the toolbar, in order. */
export function focusables(root: HTMLElement | null, selector: string) {
    return root
        ? Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
              element =>
                  !(element as HTMLButtonElement).disabled &&
                  element.getAttribute('aria-disabled') !== 'true'
          )
        : [];
}

/**
 * Closes a popup on a press outside it (and outside its button) or on
 * Escape; Escape and a pick return focus to the button.
 */
export function usePopupDismiss(
    open: boolean,
    close: (returnFocus: boolean) => void,
    popup: React.RefObject<HTMLElement>,
    anchor: React.RefObject<HTMLElement>
) {
    React.useEffect(() => {
        if (!open) return;
        const onPress = (event: MouseEvent) => {
            const target = event.target as Node;
            if (
                popup.current?.contains(target) ||
                anchor.current?.contains(target)
            ) {
                return;
            }
            close(false);
        };
        document.addEventListener('mousedown', onPress);
        return () => document.removeEventListener('mousedown', onPress);
    }, [open, close, popup, anchor]);
}

/**
 * A menu of `role="menu"` under its button: arrow keys, Home and End move
 * between its items, Escape and Tab close it, and focus returns to the
 * button after Escape or a pick.
 */
export function Menu({
    open,
    label,
    testId,
    anchor,
    onClose,
    align = 'left',
    children,
}: {
    open: boolean;
    label: string;
    testId: string;
    anchor: React.RefObject<HTMLElement>;
    onClose: (returnFocus: boolean) => void;
    align?: 'left' | 'right';
    children: React.ReactNode;
}) {
    const ref = React.useRef<HTMLDivElement>(null);
    usePopupDismiss(open, onClose, ref, anchor);
    React.useEffect(() => {
        if (!open) return;
        const items = focusables(ref.current, '[role^="menuitem"]');
        (
            items.find(item => item.getAttribute('aria-checked') === 'true') ||
            items[0]
        )?.focus();
    }, [open]);
    if (!open) return null;
    const onKeyDown = (event: React.KeyboardEvent) => {
        const items = focusables(ref.current, '[role^="menuitem"]');
        const index = items.indexOf(document.activeElement as HTMLElement);
        let next: HTMLElement | undefined;
        switch (event.key) {
            case 'ArrowDown':
                next = items[(index + 1) % items.length];
                break;
            case 'ArrowUp':
                next = items[(index - 1 + items.length) % items.length];
                break;
            case 'Home':
                next = items[0];
                break;
            case 'End':
                next = items[items.length - 1];
                break;
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                onClose(true);
                return;
            case 'Tab':
                onClose(false);
                return;
            default:
                return;
        }
        event.preventDefault();
        event.stopPropagation();
        next?.focus();
    };
    return (
        <div
            ref={ref}
            role="menu"
            aria-label={label}
            data-testid={testId}
            onKeyDown={onKeyDown}
            style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                [align]: 0,
                minWidth: 180,
                padding: 4,
                background: '#fff',
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                zIndex: 30,
            }}
        >
            {children}
        </div>
    );
}

export function menuItemStyle(checked = false): React.CSSProperties {
    return {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '5px 8px',
        border: 'none',
        borderRadius: 3,
        background: checked ? colors.hover : 'transparent',
        color: colors.text,
        fontSize: 12,
        fontWeight: checked ? 600 : 400,
        textAlign: 'left',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
    };
}

export function MenuSeparator() {
    return (
        <div
            role="separator"
            style={{ height: 1, margin: '4px 0', background: colors.border }}
        />
    );
}

/** A heading for a group of menu items; not focusable. */
export function MenuHeading({ children }: { children: React.ReactNode }) {
    return (
        <div
            role="presentation"
            style={{
                padding: '4px 8px 2px',
                fontSize: 10,
                color: colors.muted,
            }}
        >
            {children}
        </div>
    );
}
