import * as React from 'react';
import { observer } from 'mobx-react';
import {
    BRUSH_WIDTHS_PX,
    BRUSH_WIDTHS_UM,
    HPF_AREA_MAX_MM2,
    HPF_AREA_MIN_MM2,
    HPF_AREA_PRESETS,
    OUTLINE_TOOLS,
    SHAPE_TOOLS,
    WsiAnnotationController,
    WsiAnnotationTool,
} from './wsiAnnotationController';
import {
    AnnotationLabelField,
    readableTextColor,
    SoloIcon,
} from './wsiAnnotationControls';
import { WsiAnnotationBulkBar } from './wsiAnnotationBulkBar';

type DrawingTool = Exclude<WsiAnnotationTool, null>;

// Text and icons keep at least 4.5:1 contrast on the bar's near-white.
const colors = {
    active: '#1f6fbf',
    activeText: '#fff',
    bar: 'rgba(250,250,250,0.96)',
    border: '#cfcfcf',
    error: '#a00',
    hover: '#eef4fb',
    muted: '#595959',
    text: '#222',
} as const;

/** One drawing tool: its name, keyboard shortcut and how to draw with it. */
interface ToolInfo {
    label: string;
    shortcut: string;
    hint: string;
}

export const TOOL_INFO: Record<DrawingTool, ToolInfo> = {
    rectangle: {
        label: 'Rectangle',
        shortcut: 'R',
        hint: 'click and drag on the slide',
    },
    ellipse: {
        label: 'Ellipse',
        shortcut: 'R',
        hint: 'click and drag on the slide',
    },
    circle: {
        label: 'Circle',
        shortcut: 'R',
        hint: 'click and drag a box to fit it in',
    },
    hpf: {
        label: 'HPF field',
        shortcut: 'R',
        hint:
            'click to place a high-power field of the chosen area, labelled HPF 1, HPF 2, …',
    },
    line: {
        label: 'Line',
        shortcut: 'L',
        hint: 'click and drag to measure a length',
    },
    polygon: {
        label: 'Polygon',
        shortcut: 'P',
        hint:
            'click to add points; double-click or click the first point to close',
    },
    freehand: {
        label: 'Freehand',
        shortcut: 'F',
        hint: 'hold the mouse button and trace an outline',
    },
    brush: {
        label: 'Brush',
        shortcut: 'B',
        hint: 'hold the mouse button and paint over the region',
    },
    point: {
        label: 'Point',
        shortcut: '.',
        hint: 'click for each point (drag to pan)',
    },
    measure: {
        label: 'Measure',
        shortcut: 'M',
        hint:
            'drag to measure a length and angle; not saved, shown until the next one or Esc',
    },
};

/** A group of keyboard shortcuts in the help, and when they work. */
export interface ShortcutSection {
    title: string;
    when: string;
    keys: Array<[string[], string]>;
}

/** The keyboard shortcuts the help lists, by section, in order. */
export const SHORTCUT_HELP: ShortcutSection[] = [
    {
        title: 'Tools',
        when:
            'While Annotate is on; a drawing tool stays on, shape after shape, until Esc, V or another tool',
        keys: [
            [['V'], 'Select: pan, and select or edit shapes'],
            [['R'], 'Shape: the last of rectangle, ellipse, circle, HPF field'],
            [['L'], 'Line'],
            [['M'], 'Measure: a quick ruler, not saved'],
            [['P'], 'Polygon'],
            [['F'], 'Freehand'],
            [['B'], 'Brush'],
            [['.'], 'Point'],
            [
                ['Esc'],
                'Drop the shape being drawn, else clear the ruler, else back to Select',
            ],
            [
                ['Alt'],
                'Held as a shape ends: cut it out of the selected regions',
            ],
            [['Ctrl+Z'], 'Undo'],
            [['Ctrl+Shift+Z', 'Ctrl+Y'], 'Redo'],
        ],
    },
    {
        title: 'Viewing',
        when: 'Annotate on or off',
        keys: [
            [['H'], 'Hide or show all annotations on the slide'],
            [[']'], 'Next annotation in the list, fitted in the view'],
            [['['], 'Previous annotation in the list'],
            [['Esc'], 'Clear the selection, else stop highlighting'],
        ],
    },
    {
        title: 'Selecting',
        when: 'With Select (no drawing tool on), Annotate on or off',
        keys: [
            [['Shift+click'], 'Add or remove an annotation'],
            [['Shift+drag'], 'Add the annotations inside the box'],
            [['Ctrl+A'], 'Select all the list shows'],
            [['Esc'], 'Clear the selection'],
        ],
    },
    {
        title: 'Reviewing AI annotations',
        when:
            'While the review card is open; these keys come first, so R rejects instead of picking Shape',
        keys: [
            [['A'], 'Accept, then the next one'],
            [['R'], 'Reject, then the next one'],
            [['S', '→'], 'Skip'],
            [['←'], 'Previous'],
            [['Esc'], 'Exit review'],
        ],
    },
];

const kbdStyle: React.CSSProperties = {
    display: 'inline-block',
    padding: '0 4px',
    borderRadius: 3,
    border: `1px solid ${colors.border}`,
    background: '#f5f5f5',
    boxShadow: 'none',
    color: colors.text,
    fontFamily: 'inherit',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: '16px',
    whiteSpace: 'nowrap',
};

const iconPaths: Record<string, React.ReactNode> = {
    annotate: (
        <>
            <path d="M3 13l.6-2.8L10.8 3 13 5.2l-7.2 7.2z" />
            <path d="M9.4 4.4l2.2 2.2" />
        </>
    ),
    select: (
        <path
            d="M4 2.5v10l2.6-2.4 1.9 4 1.6-.8-1.9-3.9h3.6z"
            fill="currentColor"
        />
    ),
    rectangle: <rect x="2.5" y="3.5" width="11" height="9" rx="0.5" />,
    ellipse: <ellipse cx="8" cy="8" rx="6" ry="4" />,
    circle: <circle cx="8" cy="8" r="5.5" />,
    hpf: (
        <>
            <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 1.6" />
            <path d="M8 5.6v4.8M5.6 8h4.8" />
        </>
    ),
    line: (
        <>
            <path d="M2.5 13.5l11-11" />
            <path d="M1.5 11.5l3 3M11.5 1.5l3 3" />
        </>
    ),
    polygon: <path d="M8 2.2l5.8 4.2-2.2 6.9H4.4L2.2 6.4z" />,
    freehand: <path d="M2 11c2-6 5-6 6-3s4 5 6-3" />,
    brush: (
        <path
            d="M2.5 12c2.5-3.5 6-1 11-6"
            strokeWidth="3.4"
            strokeOpacity="0.75"
        />
    ),
    point: <circle cx="8" cy="8" r="2.6" fill="currentColor" />,
    measure: (
        <>
            <path d="M1.8 10.6l8.8-8.8 3.6 3.6-8.8 8.8z" />
            <path d="M4.4 9.8l1.2 1.2M6.2 8l1.8 1.8M8 6.2l1.2 1.2M9.8 4.4l1.8 1.8" />
        </>
    ),
    undo: <path d="M5.5 3.5l-3 3 3 3M2.5 6.5h7a3.5 3.5 0 010 7H6" />,
    saved: <path d="M3 8.5l3 3 7-7" />,
    saving: (
        <>
            <path d="M8 2.5a5.5 5.5 0 105.5 5.5" />
            <path d="M13.5 3v5h-5" />
        </>
    ),
    unsaved: (
        <>
            <path d="M8 2l6.5 11.5h-13z" />
            <path d="M8 6.5v3.2M8 11.6v.1" />
        </>
    ),
    redo: <path d="M10.5 3.5l3 3-3 3M13.5 6.5h-7a3.5 3.5 0 000 7H10" />,
    more: (
        <>
            <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
            <circle cx="8" cy="8" r="1.3" fill="currentColor" />
            <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
        </>
    ),
    caret: <path d="M4.5 6.5L8 10l3.5-3.5" />,
    display: (
        <>
            <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
            <circle cx="8" cy="8" r="2" />
        </>
    ),
    hidden: (
        <>
            <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
            <path d="M2.5 13.5l11-11" />
        </>
    ),
};

export function ToolIcon({ name, size = 16 }: { name: string; size?: number }) {
    return (
        <svg
            aria-hidden="true"
            focusable="false"
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ display: 'block', flexShrink: 0 }}
        >
            {iconPaths[name]}
        </svg>
    );
}

const barStyle: React.CSSProperties = {
    position: 'absolute',
    top: 4,
    left: 44,
    maxWidth: 'calc(100% - 52px)',
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 4,
    padding: 3,
    background: colors.bar,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
    fontSize: 11,
    color: colors.text,
    backdropFilter: 'blur(2px)',
    // Above the zoom buttons (100), so that the menus and popovers opened
    // from the toolbar cover them; below the viewer's error notice (110).
    zIndex: 105,
};

const groupStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    flexWrap: 'nowrap',
};

function iconButtonStyle(
    active: boolean,
    disabled = false
): React.CSSProperties {
    return {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        minWidth: 26,
        height: 26,
        padding: '0 5px',
        borderRadius: 3,
        border: `1px solid ${active ? colors.active : 'transparent'}`,
        background: active ? colors.active : 'transparent',
        color: active ? colors.activeText : colors.text,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontSize: 11,
        lineHeight: 1,
        whiteSpace: 'nowrap',
    };
}

function Divider() {
    return (
        <span
            aria-hidden="true"
            style={{
                width: 1,
                alignSelf: 'stretch',
                margin: '2px 2px',
                background: colors.border,
            }}
        />
    );
}

/** Focusable items of a menu or the toolbar, in order. */
function focusables(root: HTMLElement | null, selector: string) {
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
function usePopupDismiss(
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
function Menu({
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

function menuItemStyle(checked = false): React.CSSProperties {
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

function MenuItem({
    testId,
    icon,
    shortcut,
    checked,
    disabled,
    title,
    onSelect,
    children,
}: {
    testId: string;
    icon?: string;
    shortcut?: string;
    /** Set for a `menuitemradio`. */
    checked?: boolean;
    disabled?: boolean;
    title?: string;
    onSelect: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            role={checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={checked}
            data-testid={testId}
            tabIndex={-1}
            disabled={disabled}
            title={title}
            onClick={onSelect}
            style={{
                ...menuItemStyle(!!checked),
                opacity: disabled ? 0.5 : 1,
            }}
        >
            {icon && <ToolIcon name={icon} />}
            <span style={{ flex: 1 }}>{children}</span>
            {shortcut && <kbd style={kbdStyle}>{shortcut}</kbd>}
        </button>
    );
}

function MenuSeparator() {
    return (
        <div
            role="separator"
            style={{ height: 1, margin: '4px 0', background: colors.border }}
        />
    );
}

/** A heading for a group of menu items; not focusable. */
function MenuHeading({ children }: { children: React.ReactNode }) {
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

function toolTitle(tool: DrawingTool, shortcut = TOOL_INFO[tool].shortcut) {
    const info = TOOL_INFO[tool];
    return `${info.label} (${shortcut}): ${info.hint}`;
}

/** A drawing tool's button: on, it goes back to Select. */
const ToolButton = observer(
    ({
        controller,
        tool,
        testId,
    }: {
        controller: WsiAnnotationController;
        tool: DrawingTool;
        testId: string;
    }) => {
        const active = controller.activeTool === tool;
        const info = TOOL_INFO[tool];
        return (
            <button
                type="button"
                data-toolbar-item
                data-testid={testId}
                aria-label={`${info.label} (${info.shortcut})`}
                title={
                    active
                        ? `${info.label} is on: click or press Esc for Select`
                        : toolTitle(tool)
                }
                aria-pressed={active}
                onClick={() => controller.setTool(active ? null : tool)}
                style={iconButtonStyle(active)}
            >
                <ToolIcon name={tool} />
            </button>
        );
    }
);

/**
 * A tool group with a menu: the button uses the group's last tool, so one
 * click draws with it again; the arrow next to it picks another.
 */
const ToolMenuButton = observer(
    ({
        controller,
        group,
        label,
        tools,
        current,
        groupShortcut,
        unavailable,
    }: {
        controller: WsiAnnotationController;
        group: 'shape' | 'outline';
        label: string;
        tools: readonly DrawingTool[];
        current: DrawingTool;
        /** The key for the whole group, when it has one (Shape: R). */
        groupShortcut?: string;
        /** Why a tool cannot be used now, or null when it can. */
        unavailable?: (tool: DrawingTool) => string | null;
    }) => {
        const [open, setOpen] = React.useState(false);
        const button = React.useRef<HTMLButtonElement>(null);
        const anchor = React.useRef<HTMLSpanElement>(null);
        const close = React.useCallback((returnFocus: boolean) => {
            setOpen(false);
            if (returnFocus) button.current?.focus();
        }, []);
        const active = tools.includes(controller.activeTool as DrawingTool);
        const shortcut = groupShortcut || TOOL_INFO[current].shortcut;
        return (
            <span
                ref={anchor}
                style={{ ...groupStyle, position: 'relative', gap: 0 }}
            >
                <button
                    type="button"
                    data-toolbar-item
                    data-testid={`annotation-tool-${group}`}
                    aria-label={`${label}: ${TOOL_INFO[current].label} (${shortcut})`}
                    title={
                        active
                            ? `${TOOL_INFO[current].label} is on: click or press Esc for Select`
                            : toolTitle(current, shortcut)
                    }
                    aria-pressed={active}
                    onClick={() =>
                        controller.setTool(
                            controller.activeTool === current ? null : current
                        )
                    }
                    style={{
                        ...iconButtonStyle(active),
                        borderTopRightRadius: 0,
                        borderBottomRightRadius: 0,
                    }}
                >
                    <ToolIcon name={current} />
                </button>
                <button
                    type="button"
                    ref={button}
                    data-toolbar-item
                    data-testid={`annotation-tool-${group}-menu`}
                    aria-label={`${label} tools`}
                    title={`${label} tools`}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                    onKeyDown={event => {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setOpen(true);
                        }
                    }}
                    style={{
                        ...iconButtonStyle(active),
                        minWidth: 14,
                        padding: 0,
                        borderTopLeftRadius: 0,
                        borderBottomLeftRadius: 0,
                    }}
                >
                    <ToolIcon name="caret" size={12} />
                </button>
                <Menu
                    open={open}
                    label={`${label} tools`}
                    testId={`annotation-tool-${group}-options`}
                    anchor={anchor}
                    onClose={close}
                >
                    {tools.map(tool => {
                        const why = unavailable?.(tool) || null;
                        return (
                            <MenuItem
                                key={tool}
                                testId={`annotation-tool-${tool}`}
                                icon={tool}
                                shortcut={
                                    groupShortcut
                                        ? undefined
                                        : TOOL_INFO[tool].shortcut
                                }
                                checked={controller.activeTool === tool}
                                disabled={!!why}
                                title={why || undefined}
                                onSelect={() => {
                                    controller.setTool(tool);
                                    close(true);
                                }}
                            >
                                {TOOL_INFO[tool].label}
                                {why && (
                                    <span
                                        style={{
                                            display: 'block',
                                            fontSize: 10,
                                            color: colors.muted,
                                        }}
                                    >
                                        {why}
                                    </span>
                                )}
                            </MenuItem>
                        );
                    })}
                </Menu>
            </span>
        );
    }
);

/**
 * The brush width: in µm of tissue on a slide with a scale, else in screen
 * pixels, with a note saying so.
 */
export const BrushWidthControl = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const microns = controller.brushInMicrons;
        const widths = microns ? BRUSH_WIDTHS_UM : BRUSH_WIDTHS_PX;
        return (
            <span style={groupStyle}>
                <select
                    data-toolbar-item
                    data-testid="annotation-brush-width"
                    aria-label={
                        microns
                            ? 'Brush width in micrometres'
                            : 'Brush width in screen pixels'
                    }
                    title={
                        microns
                            ? 'Brush width, in µm of tissue at every zoom'
                            : 'Brush width, in screen pixels at the current zoom: this slide has no scale'
                    }
                    value={controller.brushWidth}
                    onChange={event =>
                        controller.setBrushWidth(Number(event.target.value))
                    }
                    style={{ fontSize: 11, height: 24 }}
                >
                    {widths.map(width => (
                        <option key={width} value={width}>
                            {width} {microns ? 'µm' : 'px'}
                        </option>
                    ))}
                </select>
                {!microns && (
                    <span
                        data-testid="annotation-brush-unit-note"
                        style={{ fontSize: 10, color: colors.muted }}
                    >
                        No slide scale: screen px
                    </span>
                )}
            </span>
        );
    }
);

/**
 * The area of new high-power fields: the common field sizes, or a custom
 * area in mm².
 */
export const HpfAreaControl = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const area = controller.hpfAreaMm2;
        const preset = HPF_AREA_PRESETS.some(item => item.areaMm2 === area);
        const [custom, setCustom] = React.useState(!preset);
        const [draft, setDraft] = React.useState(String(area));
        const apply = () => {
            const value = Number(draft);
            if (value >= HPF_AREA_MIN_MM2 && value <= HPF_AREA_MAX_MM2) {
                controller.setHpfArea(value);
            } else {
                setDraft(String(controller.hpfAreaMm2));
            }
        };
        return (
            <span style={groupStyle}>
                <select
                    data-toolbar-item
                    data-testid="annotation-hpf-area"
                    aria-label="High-power field area"
                    title="Area of each high-power field placed, in mm² of tissue"
                    value={custom ? 'custom' : String(area)}
                    onChange={event => {
                        if (event.target.value === 'custom') {
                            setDraft(String(area));
                            setCustom(true);
                        } else {
                            setCustom(false);
                            controller.setHpfArea(Number(event.target.value));
                        }
                    }}
                    style={{ fontSize: 11, height: 24 }}
                >
                    {HPF_AREA_PRESETS.map(item => (
                        <option key={item.areaMm2} value={String(item.areaMm2)}>
                            {item.areaMm2} mm² ({item.diameterMm} mm field)
                        </option>
                    ))}
                    <option value="custom">Custom…</option>
                </select>
                {custom && (
                    <input
                        type="number"
                        data-toolbar-item
                        data-testid="annotation-hpf-area-custom"
                        aria-label="Custom high-power field area in mm²"
                        min={HPF_AREA_MIN_MM2}
                        max={HPF_AREA_MAX_MM2}
                        step={0.001}
                        value={draft}
                        onChange={event => setDraft(event.target.value)}
                        onBlur={apply}
                        onKeyDown={event => {
                            if (event.key === 'Enter') apply();
                        }}
                        style={{ width: 64, fontSize: 11, height: 24 }}
                    />
                )}
                {custom && (
                    <span style={{ fontSize: 10, color: colors.muted }}>
                        mm²
                    </span>
                )}
            </span>
        );
    }
);

/**
 * The layer color swatch and its palette: picking a named or custom color
 * gives the active layer that color for new annotations.
 */
const ColorSwatch = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const [open, setOpen] = React.useState(false);
        const [newColorName, setNewColorName] = React.useState('');
        const [newColorHex, setNewColorHex] = React.useState('#ff0000');
        const button = React.useRef<HTMLButtonElement>(null);
        const anchor = React.useRef<HTMLSpanElement>(null);
        const popup = React.useRef<HTMLDivElement>(null);
        const close = React.useCallback((returnFocus: boolean) => {
            setOpen(false);
            if (returnFocus) button.current?.focus();
        }, []);
        usePopupDismiss(open, close, popup, anchor);
        React.useEffect(() => {
            if (open) {
                popup.current
                    ?.querySelector<HTMLElement>('[aria-pressed="true"]')
                    ?.focus();
            }
        }, [open]);
        const colorName = controller.activeColorName || controller.activeColor;
        const saveColor = () => {
            controller.addNamedColor(
                newColorName.trim() || newColorHex,
                newColorHex
            );
            setNewColorName('');
            close(true);
        };
        return (
            <span ref={anchor} style={{ position: 'relative', ...groupStyle }}>
                <button
                    type="button"
                    ref={button}
                    data-toolbar-item
                    data-testid="annotation-color-swatch"
                    aria-label={`Color of layer ${controller.activeLayer}: ${colorName}`}
                    title={`Color of layer "${controller.activeLayer}": ${colorName}. Click to change it.`}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                    style={{ ...iconButtonStyle(false), padding: 0 }}
                >
                    <span
                        aria-hidden="true"
                        style={{
                            width: 14,
                            height: 14,
                            borderRadius: '50%',
                            background: controller.activeColor,
                            border: '1px solid rgba(0,0,0,0.45)',
                        }}
                    />
                </button>
                {open && (
                    <div
                        ref={popup}
                        role="dialog"
                        aria-label={`Color of layer ${controller.activeLayer}`}
                        data-testid="annotation-color-popover"
                        onKeyDown={event => {
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                close(true);
                            }
                        }}
                        style={{
                            position: 'absolute',
                            top: 'calc(100% + 4px)',
                            right: 0,
                            width: 240,
                            padding: 8,
                            background: '#fff',
                            border: `1px solid ${colors.border}`,
                            borderRadius: 4,
                            boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                            zIndex: 30,
                            fontSize: 11,
                        }}
                    >
                        <div style={{ color: colors.muted, marginBottom: 6 }}>
                            Color of new annotations in layer{' '}
                            <strong style={{ color: colors.text }}>
                                {controller.activeLayer}
                            </strong>
                        </div>
                        <div
                            style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 4,
                                marginBottom: 8,
                            }}
                        >
                            {controller.namedColors.map(color => {
                                const name = color.name || color.hex;
                                const active =
                                    controller.activeColor === color.hex &&
                                    controller.activeColorName === color.name;
                                return (
                                    <span
                                        key={`${color.name}|${color.hex}`}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                        }}
                                    >
                                        <button
                                            type="button"
                                            data-testid={`annotation-color-${name}`}
                                            title={`Color: ${name}`}
                                            aria-pressed={active}
                                            onClick={() => {
                                                controller.setActiveNamedColor(
                                                    color.name,
                                                    color.hex
                                                );
                                                close(true);
                                            }}
                                            style={{
                                                fontSize: 10,
                                                padding: '1px 7px',
                                                borderRadius: 10,
                                                cursor: 'pointer',
                                                background: active
                                                    ? color.hex
                                                    : '#fff',
                                                color: active
                                                    ? readableTextColor(
                                                          color.hex
                                                      )
                                                    : colors.text,
                                                border: `1.5px solid ${color.hex}`,
                                                fontWeight: active ? 700 : 400,
                                                maxWidth: 220,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            {name}
                                        </button>
                                        {controller.canRemoveNamedColor(
                                            color.name,
                                            color.hex
                                        ) && (
                                            <button
                                                type="button"
                                                title={`Remove "${name}" from the palette`}
                                                aria-label={`Remove color ${name} from the palette`}
                                                onClick={() =>
                                                    controller.removeNamedColor(
                                                        color.name,
                                                        color.hex
                                                    )
                                                }
                                                style={{
                                                    fontSize: 10,
                                                    padding: '0 3px',
                                                    border: 'none',
                                                    background: 'transparent',
                                                    cursor: 'pointer',
                                                    color: colors.muted,
                                                }}
                                            >
                                                ×
                                            </button>
                                        )}
                                    </span>
                                );
                            })}
                        </div>
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                            }}
                        >
                            <input
                                aria-label="Custom annotation color"
                                type="color"
                                value={newColorHex}
                                onChange={event =>
                                    setNewColorHex(event.target.value)
                                }
                                style={{
                                    width: 24,
                                    height: 20,
                                    border: 'none',
                                    padding: 0,
                                    cursor: 'pointer',
                                }}
                            />
                            <input
                                aria-label="Custom annotation color name"
                                value={newColorName}
                                placeholder="Custom color name"
                                maxLength={20}
                                onChange={event =>
                                    setNewColorName(event.target.value)
                                }
                                onKeyDown={event => {
                                    if (event.key === 'Enter') saveColor();
                                }}
                                style={{
                                    flex: 1,
                                    minWidth: 0,
                                    fontSize: 11,
                                    padding: '1px 4px',
                                }}
                            />
                            <button
                                type="button"
                                data-testid="save-annotation-color"
                                title="Add the color to the palette and use it"
                                onClick={saveColor}
                                style={{
                                    border: `1px solid ${colors.active}`,
                                    borderRadius: 3,
                                    background: colors.active,
                                    color: '#fff',
                                    fontSize: 11,
                                    padding: '1px 8px',
                                    cursor: 'pointer',
                                }}
                            >
                                Add
                            </button>
                        </div>
                    </div>
                )}
            </span>
        );
    }
);

/** "Drawing as": the layer, label and color of new annotations. */
const DrawingAs = observer(
    ({ controller }: { controller: WsiAnnotationController }) => (
        <span
            role="group"
            aria-label="Drawing as"
            data-testid="annotation-drawing-as"
            style={{ ...groupStyle, gap: 4, flexWrap: 'wrap' }}
        >
            <span style={{ color: colors.muted, whiteSpace: 'nowrap' }}>
                Drawing as:
            </span>
            <select
                data-toolbar-item
                data-testid="annotation-active-layer"
                aria-label="Layer for new annotations"
                title="Layer for new annotations; its color comes with it"
                value={controller.activeLayer}
                onChange={event =>
                    controller.setActiveLayer(event.target.value)
                }
                style={{ fontSize: 11, height: 24, maxWidth: 150 }}
            >
                {controller.layerNames.map(layer => (
                    <option key={layer} value={layer}>
                        {layer}
                    </option>
                ))}
            </select>
            <AnnotationLabelField
                controller={controller}
                value={controller.activeLabel}
                onChange={controller.setActiveLabel}
                ariaLabel="Label for new annotations"
                testId="annotation-active-label"
                placeholder={controller.strictLabels ? undefined : 'Auto label'}
                style={{
                    width: 120,
                    fontSize: 11,
                    height: 24,
                    padding: '0 4px',
                }}
                toolbarItem
            />
            <ColorSwatch controller={controller} />
        </span>
    )
);

const fieldRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    margin: '0 0 6px',
    fontWeight: 400,
    fontSize: 12,
    color: colors.text,
};

/**
 * How annotations show on the slide: fill opacity, outlines only, labels
 * on the slide and hiding them all (H), in a popover; showing one layer
 * alone is on the layer rows and can be ended here.
 */
const DisplayMenu = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const [open, setOpen] = React.useState(false);
        const button = React.useRef<HTMLButtonElement>(null);
        const anchor = React.useRef<HTMLSpanElement>(null);
        const popup = React.useRef<HTMLDivElement>(null);
        const close = React.useCallback((returnFocus: boolean) => {
            setOpen(false);
            if (returnFocus) button.current?.focus();
        }, []);
        usePopupDismiss(open, close, popup, anchor);
        React.useEffect(() => {
            if (open)
                popup.current?.querySelector<HTMLElement>('input')?.focus();
        }, [open]);
        const percent = Math.round(controller.fillOpacity * 100);
        const origins = controller.shownOrigins;
        const changed =
            controller.hideAll ||
            controller.outlineOnly ||
            controller.showSlideLabels ||
            controller.soloLayer !== null ||
            !origins.mine ||
            !origins.others ||
            !origins.ai;
        const counts = controller.originCounts;
        const userKnown = !!controller.currentUser;
        const title = controller.hideAll
            ? 'Display: all annotations are hidden (H shows them)'
            : 'Display: fill, outlines, labels on the slide, hide all (H), whose annotations show';
        return (
            <span ref={anchor} style={{ position: 'relative', ...groupStyle }}>
                <button
                    type="button"
                    ref={button}
                    data-toolbar-item
                    data-testid="annotation-display-button"
                    aria-label={
                        controller.hideAll
                            ? 'Display (annotations hidden)'
                            : 'Display'
                    }
                    title={title}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                    style={{
                        ...iconButtonStyle(open),
                        // A dot while something differs from the default.
                        position: 'relative',
                    }}
                >
                    <ToolIcon
                        name={controller.hideAll ? 'hidden' : 'display'}
                    />
                    {changed && !open && (
                        <span
                            aria-hidden="true"
                            style={{
                                position: 'absolute',
                                top: 3,
                                right: 3,
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                background: colors.active,
                            }}
                        />
                    )}
                </button>
                {open && (
                    <div
                        ref={popup}
                        role="dialog"
                        aria-label="Display"
                        data-testid="annotation-display-popover"
                        onKeyDown={event => {
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                close(true);
                            }
                        }}
                        style={{
                            position: 'absolute',
                            top: 'calc(100% + 4px)',
                            left: 0,
                            width: 250,
                            padding: 10,
                            background: '#fff',
                            border: `1px solid ${colors.border}`,
                            borderRadius: 4,
                            boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                            zIndex: 30,
                            fontSize: 12,
                        }}
                    >
                        <label style={fieldRowStyle}>
                            <span style={{ width: 28 }}>Fill</span>
                            <input
                                type="range"
                                data-testid="annotation-fill-opacity"
                                aria-label="Fill opacity"
                                aria-valuetext={`${percent}%`}
                                min={0}
                                max={100}
                                step={5}
                                value={percent}
                                disabled={controller.outlineOnly}
                                onChange={event =>
                                    controller.setFillOpacity(
                                        Number(event.target.value) / 100
                                    )
                                }
                                style={{ flex: 1, minWidth: 0 }}
                            />
                            <output
                                style={{
                                    width: 34,
                                    textAlign: 'right',
                                    color: controller.outlineOnly
                                        ? colors.muted
                                        : colors.text,
                                }}
                            >
                                {percent}%
                            </output>
                        </label>
                        <label style={fieldRowStyle}>
                            <input
                                type="checkbox"
                                data-testid="annotation-outline-only"
                                checked={controller.outlineOnly}
                                onChange={event =>
                                    controller.setOutlineOnly(
                                        event.target.checked
                                    )
                                }
                            />
                            Outlines only
                        </label>
                        <label style={fieldRowStyle}>
                            <input
                                type="checkbox"
                                data-testid="annotation-slide-labels"
                                checked={controller.showSlideLabels}
                                onChange={event =>
                                    controller.setShowSlideLabels(
                                        event.target.checked
                                    )
                                }
                            />
                            Labels on the slide
                        </label>
                        <label style={fieldRowStyle}>
                            <input
                                type="checkbox"
                                data-testid="annotation-hide-all"
                                aria-keyshortcuts="H"
                                checked={controller.hideAll}
                                onChange={controller.toggleHideAll}
                            />
                            Hide all annotations
                            <kbd style={{ ...kbdStyle, marginLeft: 'auto' }}>
                                H
                            </kbd>
                        </label>
                        <fieldset
                            data-testid="annotation-show-origins"
                            style={{
                                border: 'none',
                                margin: '0 0 6px',
                                padding: 0,
                            }}
                        >
                            <legend
                                style={{
                                    fontSize: 12,
                                    fontWeight: 600,
                                    color: colors.text,
                                    border: 'none',
                                    margin: '0 0 2px',
                                    padding: 0,
                                    width: 'auto',
                                }}
                            >
                                Show
                            </legend>
                            {(['mine', 'others', 'ai'] as const)
                                .filter(
                                    origin => userKnown || origin !== 'others'
                                )
                                .map(origin => (
                                    <label
                                        key={origin}
                                        style={{
                                            ...fieldRowStyle,
                                            margin: '0 0 2px',
                                        }}
                                    >
                                        <input
                                            type="checkbox"
                                            data-testid={`annotation-show-${origin}`}
                                            checked={origins[origin]}
                                            onChange={event =>
                                                controller.setOriginShown(
                                                    origin,
                                                    event.target.checked
                                                )
                                            }
                                        />
                                        {origin === 'ai'
                                            ? 'AI (assistant and models)'
                                            : origin === 'others'
                                            ? 'Other users’'
                                            : userKnown
                                            ? 'Mine'
                                            : 'Manual'}
                                        <span
                                            style={{
                                                marginLeft: 'auto',
                                                color: colors.muted,
                                            }}
                                        >
                                            {counts[origin]}
                                        </span>
                                    </label>
                                ))}
                        </fieldset>
                        {controller.soloLayer !== null ? (
                            <div
                                data-testid="annotation-solo-status"
                                style={{ color: colors.text }}
                            >
                                Showing only layer{' '}
                                <strong>{controller.soloLayer}</strong>.{' '}
                                <button
                                    type="button"
                                    data-testid="annotation-solo-end"
                                    onClick={() =>
                                        controller.toggleSoloLayer(
                                            controller.soloLayer!
                                        )
                                    }
                                    style={{
                                        border: 'none',
                                        background: 'transparent',
                                        color: colors.active,
                                        padding: 0,
                                        textDecoration: 'underline',
                                        cursor: 'pointer',
                                        fontSize: 12,
                                    }}
                                >
                                    Show all layers
                                </button>
                            </div>
                        ) : (
                            <div style={{ color: colors.muted, fontSize: 11 }}>
                                To show one layer alone, use <SoloIcon /> on its
                                row under Layers.
                            </div>
                        )}
                    </div>
                )}
            </span>
        );
    }
);

/** The keyboard shortcuts, in a dialog opened from the ⋯ menu. */
function ShortcutHelp({ onClose }: { onClose: () => void }) {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        ref.current?.querySelector<HTMLElement>('button')?.focus();
    }, []);
    return (
        <div
            ref={ref}
            role="dialog"
            aria-label="Keyboard shortcuts"
            data-testid="annotation-shortcut-help"
            onKeyDown={event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose();
                }
            }}
            style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                right: 0,
                width: 340,
                maxWidth: 'calc(100vw - 32px)',
                padding: 10,
                background: '#fff',
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                zIndex: 30,
                fontSize: 12,
            }}
        >
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 6,
                }}
            >
                <strong>Keyboard shortcuts</strong>
                <button
                    type="button"
                    aria-label="Close keyboard shortcuts"
                    onClick={onClose}
                    style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: colors.muted,
                        fontSize: 14,
                    }}
                >
                    ×
                </button>
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {SHORTCUT_HELP.map(section => (
                    <table
                        key={section.title}
                        style={{
                            width: '100%',
                            borderCollapse: 'collapse',
                            marginBottom: 6,
                        }}
                    >
                        <caption
                            style={{
                                textAlign: 'left',
                                fontWeight: 600,
                                color: colors.text,
                                padding: '2px 0 0',
                            }}
                        >
                            {section.title}
                            <div
                                style={{
                                    fontWeight: 400,
                                    fontSize: 11,
                                    color: colors.muted,
                                }}
                            >
                                {section.when}
                            </div>
                        </caption>
                        <tbody>
                            {section.keys.map(([keys, what]) => (
                                <tr key={what}>
                                    <td
                                        style={{
                                            padding: '2px 8px 2px 0',
                                            width: '40%',
                                            verticalAlign: 'top',
                                        }}
                                    >
                                        {keys.map((key, index) => (
                                            <React.Fragment key={key}>
                                                {index > 0 && ' or '}
                                                <kbd style={kbdStyle}>
                                                    {key}
                                                </kbd>
                                            </React.Fragment>
                                        ))}
                                    </td>
                                    <td style={{ padding: '2px 0' }}>{what}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ))}
            </div>
            <div style={{ color: colors.muted, fontSize: 11 }}>
                Single keys do nothing while typing in a field. On a Mac, use ⌘
                for Ctrl.
            </div>
        </div>
    );
}

/**
 * The ⋯ menu: the sharing of new annotations, GeoJSON export and import,
 * and the keyboard shortcuts.
 */
const MoreMenu = observer(
    ({
        controller,
        onImport,
    }: {
        controller: WsiAnnotationController;
        onImport: () => void;
    }) => {
        const [open, setOpen] = React.useState(false);
        const [help, setHelp] = React.useState(false);
        const button = React.useRef<HTMLButtonElement>(null);
        const anchor = React.useRef<HTMLSpanElement>(null);
        const helpRef = React.useRef<HTMLSpanElement>(null);
        const close = React.useCallback((returnFocus: boolean) => {
            setOpen(false);
            if (returnFocus) button.current?.focus();
        }, []);
        const closeHelp = React.useCallback(() => {
            setHelp(false);
            button.current?.focus();
        }, []);
        usePopupDismiss(help, closeHelp, helpRef, anchor);
        const total = controller.annotations.length;
        const shown = controller.shownAnnotations.length;
        const pick = (run: () => void) => () => {
            close(true);
            run();
        };
        return (
            <span ref={anchor} style={{ position: 'relative', ...groupStyle }}>
                <button
                    type="button"
                    ref={button}
                    data-toolbar-item
                    data-testid="annotation-more-menu-button"
                    aria-label="More annotation actions"
                    title="AI review, sharing, export, import and keyboard shortcuts"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={() => {
                        setHelp(false);
                        setOpen(!open);
                    }}
                    onKeyDown={event => {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setOpen(true);
                        }
                    }}
                    style={iconButtonStyle(open)}
                >
                    <ToolIcon name="more" />
                </button>
                <Menu
                    open={open}
                    label="More annotation actions"
                    testId="annotation-more-menu"
                    anchor={anchor}
                    onClose={close}
                    align="right"
                >
                    {controller.canEdit && (
                        <>
                            <MenuHeading>New annotations are</MenuHeading>
                            <MenuItem
                                testId="annotation-default-sharing-shared"
                                checked={controller.defaultShared}
                                onSelect={pick(() =>
                                    controller.setDefaultShared(true)
                                )}
                            >
                                Shared with everyone who can see this study
                            </MenuItem>
                            <MenuItem
                                testId="annotation-default-sharing-private"
                                checked={!controller.defaultShared}
                                onSelect={pick(() =>
                                    controller.setDefaultShared(false)
                                )}
                            >
                                Private (only you)
                            </MenuItem>
                            <MenuSeparator />
                        </>
                    )}
                    {controller.unreviewedAiCount > 0 && (
                        <>
                            <MenuItem
                                testId="annotation-review-start-menu"
                                disabled={!!controller.reviewUnavailable}
                                onSelect={pick(controller.startReview)}
                            >
                                Review AI annotations (
                                {controller.reviewUnavailable
                                    ? controller.unreviewedAiCount
                                    : controller.reviewableAi.length}
                                )…
                            </MenuItem>
                            <MenuSeparator />
                        </>
                    )}
                    <MenuItem
                        testId="annotation-export-all"
                        disabled={!total}
                        onSelect={pick(() => controller.downloadGeoJson('all'))}
                    >
                        Export all ({total}) as GeoJSON
                    </MenuItem>
                    {shown !== total && (
                        <MenuItem
                            testId="annotation-export-visible"
                            disabled={!shown}
                            onSelect={pick(() =>
                                controller.downloadGeoJson('visible')
                            )}
                        >
                            Export visible layers ({shown}) as GeoJSON
                        </MenuItem>
                    )}
                    {controller.canEdit && (
                        <MenuItem
                            testId="annotation-import"
                            disabled={!!controller.importProgress}
                            onSelect={pick(onImport)}
                        >
                            Import GeoJSON…
                        </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem
                        testId="annotation-shortcuts"
                        onSelect={() => {
                            setOpen(false);
                            setHelp(true);
                        }}
                    >
                        Keyboard shortcuts
                    </MenuItem>
                </Menu>
                {help && (
                    <span ref={helpRef}>
                        <ShortcutHelp onClose={closeHelp} />
                    </span>
                )}
            </span>
        );
    }
);

function smallButtonStyle(primary = false): React.CSSProperties {
    return {
        fontSize: 11,
        padding: '1px 8px',
        borderRadius: 3,
        border: `1px solid ${primary ? colors.active : colors.border}`,
        background: primary ? colors.active : '#fff',
        color: primary ? '#fff' : colors.text,
        cursor: 'pointer',
    };
}

/** A GeoJSON import: its error, its preview to confirm, or its progress. */
const ImportStatus = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const preview = controller.importPreview;
        const progress = controller.importProgress;
        if (!preview && !progress && !controller.importError) return null;
        const kinds = preview
            ? (['polygon', 'line', 'point'] as const)
                  .filter(kind => preview.counts[kind])
                  .map(
                      kind =>
                          `${preview.counts[kind]} ${kind}${
                              preview.counts[kind] === 1 ? '' : 's'
                          }`
                  )
                  .join(', ')
            : '';
        return (
            <div
                data-testid="annotation-import-status"
                style={{
                    flexBasis: '100%',
                    padding: '4px 6px',
                    borderTop: `1px solid ${colors.border}`,
                    fontSize: 11,
                }}
            >
                {controller.importError && (
                    <div
                        role="alert"
                        data-testid="annotation-import-error"
                        style={{ color: colors.error }}
                    >
                        Import failed: {controller.importError}{' '}
                        <button
                            type="button"
                            onClick={controller.cancelImport}
                            style={smallButtonStyle()}
                        >
                            Dismiss
                        </button>
                    </div>
                )}
                {preview && (
                    <div
                        role="group"
                        aria-label="Import preview"
                        data-testid="annotation-import-preview"
                    >
                        <span>
                            <strong>{preview.fileName}</strong>:{' '}
                            {preview.drafts.length
                                ? `${preview.drafts.length} annotation${
                                      preview.drafts.length === 1 ? '' : 's'
                                  } (${kinds})`
                                : 'no annotations to import'}
                        </span>
                        {preview.skipped.length > 0 && (
                            <span
                                data-testid="annotation-import-skipped"
                                style={{ color: colors.muted, marginLeft: 6 }}
                            >
                                {preview.skipped.length} skipped:{' '}
                                {Array.from(
                                    new Set(
                                        preview.skipped.map(item => item.reason)
                                    )
                                ).join('; ')}
                            </span>
                        )}{' '}
                        <button
                            type="button"
                            data-testid="annotation-import-confirm"
                            disabled={!preview.drafts.length}
                            onClick={() => void controller.confirmImport()}
                            style={smallButtonStyle(true)}
                        >
                            Create {preview.drafts.length} annotation
                            {preview.drafts.length === 1 ? '' : 's'}
                        </button>{' '}
                        <button
                            type="button"
                            data-testid="annotation-import-cancel"
                            onClick={controller.cancelImport}
                            style={smallButtonStyle()}
                        >
                            Cancel
                        </button>
                    </div>
                )}
                {progress && (
                    <div
                        role="status"
                        data-testid="annotation-import-progress"
                        style={{ color: colors.muted }}
                    >
                        Importing {progress.done} of {progress.total}…
                    </div>
                )}
            </div>
        );
    }
);

/**
 * Whether the user's changes are saved: "Saved", "Saving… N" while
 * annotations, comments or notes are being sent, or "N not saved" with
 * Retry for dropped points the service refused. Shown while Annotate is
 * on, and whenever something is saving or not saved. The `role="status"`
 * region stays on the page so that changes are announced.
 */
export const SaveStatus = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const status = controller.saveStatus;
        const show =
            status.state === 'saving' ||
            status.state === 'unsaved' ||
            (status.state === 'saved' && controller.annotating);
        const unsaved =
            status.state === 'unsaved'
                ? status.count
                : status.state === 'saving'
                ? status.unsaved
                : 0;
        const text = !show
            ? ''
            : status.state === 'saving'
            ? `Saving… ${status.count}`
            : status.state === 'unsaved'
            ? `${status.count} not saved`
            : 'Saved';
        const title =
            status.state === 'saving'
                ? `${status.count} change${
                      status.count === 1 ? ' is' : 's are'
                  } being saved`
                : status.state === 'unsaved'
                ? `${status.count} point${
                      status.count === 1 ? ' was' : 's were'
                  } not saved: the service refused them. Retry sends them again.`
                : 'All changes are saved';
        return (
            <span
                style={{ ...groupStyle, gap: 4 }}
                data-testid="annotation-save-status-group"
            >
                <span
                    role="status"
                    aria-live="polite"
                    data-testid="annotation-save-status"
                    data-state={show ? status.state : 'idle'}
                    title={show ? title : undefined}
                    style={{
                        display: show ? 'inline-flex' : 'none',
                        alignItems: 'center',
                        gap: 3,
                        padding: '0 3px',
                        whiteSpace: 'nowrap',
                        color:
                            status.state === 'unsaved'
                                ? colors.error
                                : colors.muted,
                    }}
                >
                    {show && (
                        <ToolIcon
                            name={
                                status.state === 'saving'
                                    ? 'saving'
                                    : status.state === 'unsaved'
                                    ? 'unsaved'
                                    : 'saved'
                            }
                            size={12}
                        />
                    )}
                    {text}
                </span>
                {unsaved > 0 && status.state === 'unsaved' && (
                    <button
                        type="button"
                        data-toolbar-item
                        data-testid="annotation-save-status-retry"
                        aria-label={`Retry saving ${unsaved} point${
                            unsaved === 1 ? '' : 's'
                        }`}
                        onClick={() => void controller.retryUnsavedPoints()}
                        style={smallButtonStyle()}
                    >
                        Retry
                    </button>
                )}
            </span>
        );
    }
);

/** Why Annotate is off limits now, or null when the user may annotate. */
function annotateUnavailable(controller: WsiAnnotationController) {
    if (controller.canEdit) return null;
    if (controller.loading) return 'Loading annotations…';
    if (controller.accessMessage) return controller.accessMessage;
    if (controller.loadFailed) {
        return 'Annotations could not be loaded; retry from the Annotations panel.';
    }
    return 'Annotating is not available for this slide.';
}

/**
 * Moves focus between the toolbar's controls with the arrow keys, Home and
 * End; fields keep their own arrow keys.
 */
function onToolbarKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        return;
    }
    const target = event.target as HTMLElement;
    if (
        !target.hasAttribute('data-toolbar-item') ||
        /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)
    ) {
        return;
    }
    const items = focusables(event.currentTarget, '[data-toolbar-item]');
    const index = items.indexOf(target);
    if (index < 0) return;
    const next =
        event.key === 'Home'
            ? items[0]
            : event.key === 'End'
            ? items[items.length - 1]
            : items[
                  (index +
                      (event.key === 'ArrowRight' ? 1 : -1) +
                      items.length) %
                      items.length
              ];
    event.preventDefault();
    next.focus();
}

/**
 * The annotation toolbar: the Annotate toggle, and while it is on the
 * drawing tools, what new annotations are drawn as, undo and redo; the ⋯
 * menu holds sharing, export, import and the shortcuts.
 */
export const WsiAnnotationToolbar = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const fileInput = React.useRef<HTMLInputElement>(null);
        if (!controller || !controller.visible) return null;
        const unavailable = annotateUnavailable(controller);
        const on = controller.annotating && !unavailable;
        const tool = controller.activeTool;
        return (
            <div
                role="toolbar"
                aria-label="Annotation tools"
                data-testid="wsi-annotation-toolbar"
                onKeyDown={onToolbarKeyDown}
                style={barStyle}
            >
                <span style={groupStyle}>
                    <button
                        type="button"
                        data-toolbar-item
                        data-testid="annotation-mode-toggle"
                        aria-pressed={on}
                        aria-disabled={!!unavailable}
                        title={
                            unavailable ||
                            (on
                                ? 'Stop annotating: hide the drawing tools'
                                : 'Annotate: show the drawing tools')
                        }
                        onClick={() => {
                            if (!unavailable) {
                                controller.setAnnotating(
                                    !controller.annotating
                                );
                            }
                        }}
                        style={{
                            ...iconButtonStyle(on, !!unavailable),
                            padding: '0 8px',
                            fontWeight: 600,
                            border: `1px ${unavailable ? 'dashed' : 'solid'} ${
                                on ? colors.active : colors.border
                            }`,
                            background: on ? colors.active : '#fff',
                            // Disabled, it stays readable: the status says why.
                            color: on
                                ? colors.activeText
                                : unavailable
                                ? colors.muted
                                : colors.text,
                            opacity: 1,
                        }}
                    >
                        <ToolIcon name="annotate" size={14} />
                        Annotate
                    </button>
                </span>
                {unavailable && (
                    <span
                        role="status"
                        data-testid="wsi-annotation-access-notice"
                        style={{ color: colors.muted, padding: '0 4px' }}
                    >
                        {unavailable}
                    </span>
                )}
                {on && (
                    <>
                        <Divider />
                        <span
                            role="group"
                            aria-label="Drawing tools"
                            data-testid="annotation-tools"
                            style={groupStyle}
                        >
                            <button
                                type="button"
                                data-toolbar-item
                                data-testid="annotation-tool-select"
                                aria-label="Select (V)"
                                title="Select (V): pan, and click a shape to select or edit it"
                                aria-pressed={tool === null}
                                onClick={() => controller.cancelDrawing()}
                                style={iconButtonStyle(tool === null)}
                            >
                                <ToolIcon name="select" />
                            </button>
                            <ToolMenuButton
                                controller={controller}
                                group="shape"
                                label="Shape"
                                tools={SHAPE_TOOLS}
                                current={controller.shapeToolNow}
                                groupShortcut="R"
                                unavailable={tool =>
                                    tool === 'hpf' && !controller.mpp
                                        ? 'Needs the slide scale (µm per pixel)'
                                        : null
                                }
                            />
                            <ToolButton
                                controller={controller}
                                tool="line"
                                testId="annotation-tool-line"
                            />
                            <ToolButton
                                controller={controller}
                                tool="measure"
                                testId="annotation-tool-measure"
                            />
                            <ToolMenuButton
                                controller={controller}
                                group="outline"
                                label="Outline"
                                tools={OUTLINE_TOOLS}
                                current={controller.outlineTool}
                            />
                            <ToolButton
                                controller={controller}
                                tool="point"
                                testId="annotation-tool-point"
                            />
                        </span>
                        {tool === 'brush' && (
                            <BrushWidthControl controller={controller} />
                        )}
                        {tool === 'hpf' && (
                            <HpfAreaControl controller={controller} />
                        )}
                        {tool === 'point' && (
                            <span
                                role="status"
                                data-testid="annotation-point-count"
                                aria-live="polite"
                                style={{
                                    fontWeight: 600,
                                    whiteSpace: 'nowrap',
                                    padding: '0 2px',
                                }}
                            >
                                {controller.activePointLabel}:{' '}
                                {controller.activePointCount}
                            </span>
                        )}
                        <Divider />
                        <DrawingAs controller={controller} />
                        <Divider />
                        <span style={groupStyle}>
                            <button
                                type="button"
                                data-toolbar-item
                                data-testid="annotation-undo"
                                aria-label={`${controller.undoLabel ||
                                    'Nothing to undo'} (Ctrl+Z)`}
                                title={`${controller.undoLabel ||
                                    'Nothing to undo'} (Ctrl+Z)`}
                                disabled={!controller.canUndo}
                                onClick={() => void controller.undo()}
                                style={iconButtonStyle(
                                    false,
                                    !controller.canUndo
                                )}
                            >
                                <ToolIcon name="undo" />
                            </button>
                            <button
                                type="button"
                                data-toolbar-item
                                data-testid="annotation-redo"
                                aria-label={`${controller.redoLabel ||
                                    'Nothing to redo'} (Ctrl+Shift+Z)`}
                                title={`${controller.redoLabel ||
                                    'Nothing to redo'} (Ctrl+Shift+Z or Ctrl+Y)`}
                                disabled={!controller.canRedo}
                                onClick={() => void controller.redo()}
                                style={iconButtonStyle(
                                    false,
                                    !controller.canRedo
                                )}
                            >
                                <ToolIcon name="redo" />
                            </button>
                        </span>
                    </>
                )}
                <SaveStatus controller={controller} />
                <DisplayMenu controller={controller} />
                <MoreMenu
                    controller={controller}
                    onImport={() => fileInput.current?.click()}
                />
                {controller.canEdit && (
                    <input
                        ref={fileInput}
                        type="file"
                        data-testid="annotation-import-file"
                        aria-label="GeoJSON file to import"
                        accept=".geojson,.json,application/geo+json,application/json"
                        style={{ display: 'none' }}
                        onChange={event => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file) void controller.previewImport(file);
                        }}
                    />
                )}
                <ImportStatus controller={controller} />
                <WsiAnnotationBulkBar controller={controller} />
            </div>
        );
    }
);
