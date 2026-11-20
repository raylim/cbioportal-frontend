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

/** The items of `menu` itself, not those of a submenu inside it. */
function ownItems(menu: HTMLElement | null): HTMLElement[] {
    return focusables(menu, '[role^="menuitem"]').filter(
        item => item.parentElement?.closest('[role="menu"]') === menu
    );
}

/**
 * Arrow keys, Home and End between `menu`'s own items; returns whether the
 * key was one.
 */
function moveInMenu(menu: HTMLElement | null, key: string): boolean {
    const items = ownItems(menu);
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    switch (key) {
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
        default:
            return false;
    }
    next?.focus();
    return true;
}

/**
 * A menu of `role="menu"` under its button: arrow keys, Home and End move
 * between its items, Escape and Tab close it, and focus returns to the
 * button after Escape or a pick. A `SubMenu` inside it keeps its own keys.
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
        const items = ownItems(ref.current);
        (
            items.find(item => item.getAttribute('aria-checked') === 'true') ||
            items[0]
        )?.focus();
    }, [open]);
    if (!open) return null;
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose(true);
            return;
        }
        if (event.key === 'Tab') {
            onClose(false);
            return;
        }
        if (moveInMenu(ref.current, event.key)) {
            event.preventDefault();
            event.stopPropagation();
        }
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

/**
 * A menu item that opens a submenu beside it ("Move to layer ▸"): Enter,
 * Space, a click or → open it and focus its first item; inside it the
 * arrow keys, Home and End move, and ← or Escape close it, giving the
 * focus back to the item. Tab closes the whole menu. `open` and `onOpen`
 * let the parent menu keep one submenu open at a time.
 */
export function SubMenu({
    label,
    testId,
    open,
    onOpen,
    onItemFocus,
    disabled,
    title,
    note,
    children,
}: {
    label: React.ReactNode;
    testId: string;
    open: boolean;
    /** Opens (true) or closes (false) this submenu. */
    onOpen: (open: boolean) => void;
    /** The item itself took the focus (e.g. the arrow keys reached it). */
    onItemFocus?: () => void;
    disabled?: boolean;
    title?: string;
    /** A short note at the item's end, e.g. what undoes it. */
    note?: string;
    children: React.ReactNode;
}) {
    const item = React.useRef<HTMLButtonElement>(null);
    const menu = React.useRef<HTMLDivElement>(null);
    const [focusFirst, setFocusFirst] = React.useState(false);
    React.useEffect(() => {
        if (open && focusFirst) {
            ownItems(menu.current)[0]?.focus();
            setFocusFirst(false);
        }
    }, [open, focusFirst]);
    const show = () => {
        if (disabled) return;
        onOpen(true);
        setFocusFirst(true);
    };
    return (
        <div style={{ position: 'relative' }}>
            <button
                type="button"
                ref={item}
                role="menuitem"
                tabIndex={-1}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-disabled={disabled || undefined}
                data-testid={testId}
                title={title}
                onFocus={onItemFocus}
                onClick={() => (open ? onOpen(false) : show())}
                onKeyDown={event => {
                    if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        event.stopPropagation();
                        show();
                    }
                }}
                style={{
                    ...menuItemStyle(open),
                    opacity: disabled ? 0.55 : 1,
                    cursor: disabled ? 'default' : 'pointer',
                }}
            >
                <span style={{ flex: 1 }}>{label}</span>
                {note && <MenuNote>{note}</MenuNote>}
                <span aria-hidden="true">▸</span>
            </button>
            {open && !disabled && (
                <div
                    ref={menu}
                    role="menu"
                    aria-label={typeof label === 'string' ? label : undefined}
                    data-testid={`${testId}-menu`}
                    onKeyDown={event => {
                        if (
                            event.key === 'ArrowLeft' ||
                            event.key === 'Escape'
                        ) {
                            event.preventDefault();
                            event.stopPropagation();
                            onOpen(false);
                            item.current?.focus();
                            return;
                        }
                        if (moveInMenu(menu.current, event.key)) {
                            event.preventDefault();
                            event.stopPropagation();
                        }
                    }}
                    style={{
                        position: 'absolute',
                        top: -5,
                        left: 'calc(100% + 4px)',
                        minWidth: 170,
                        padding: 4,
                        background: '#fff',
                        border: `1px solid ${colors.border}`,
                        borderRadius: 4,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                        zIndex: 31,
                    }}
                >
                    {children}
                </div>
            )}
        </div>
    );
}

/** A muted note at a menu item's end, e.g. "Ctrl+Z undoes". */
export function MenuNote({ children }: { children: React.ReactNode }) {
    return (
        <span
            style={{
                marginLeft: 12,
                fontSize: 10,
                color: colors.muted,
                fontWeight: 400,
            }}
        >
            {children}
        </span>
    );
}
