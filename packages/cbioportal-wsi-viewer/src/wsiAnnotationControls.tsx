import * as React from 'react';
import { observer } from 'mobx-react';
import {
    annotationVisibility,
    DEFAULT_COLOR,
    DEFAULT_LAYER,
    formatRegionCount,
    WsiAnnotationAiFilter,
    WsiAnnotationController,
} from './wsiAnnotationController';
import { WsiAnnotation } from './wsiViewerTypes';
import { formatMeasurement, WsiPoint } from './wsiAnnotationGeometryUtils';
import {
    aiOriginDescription,
    annotationHistory,
    isAiProvenance,
    isEditedAi,
    isUnreviewedAi,
    transferSource,
} from './wsiAnnotationBody';
import { formatSlideId } from './wsiSlideId';
import { ReviewQueueButton } from './wsiAnnotationReview';
import { HPF_RATE_HELP, useHpfHelpId, WsiHpfInfo } from './wsiHpfHelp';
import { WsiRulerLine } from './wsiAnnotationOverlay';
import { AnnotationThread } from './wsiAnnotationThread';

// Text colors keep at least 4.5:1 contrast on the panel's white.
const colors = {
    ai: '#7c3aed',
    blue: '#1f6fbf',
    border: '#ddd',
    muted: '#737373',
    text: '#333',
} as const;

function relativeLuminance(hex: string): number | null {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
    if (!match) return null;
    const digits =
        match[1].length === 3
            ? match[1].replace(/./g, digit => digit + digit)
            : match[1];
    const [r, g, b] = [0, 2, 4].map(i => {
        const c = parseInt(digits.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Black or white, whichever reads better on `background`. */
export function readableTextColor(background: string): '#000' | '#fff' {
    const luminance = relativeLuminance(background);
    if (luminance === null) return '#000';
    // Contrast with black (L + 0.05) / 0.05 against white 1.05 / (L + 0.05).
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
        ? '#000'
        : '#fff';
}

/**
 * Moves focus after a row's action: to `target`'s focus button when it is
 * still on the page, else to the next or previous row, else to the list.
 */
function focusAfterRowAction(
    row: HTMLElement | null,
    list: HTMLElement | null,
    neighbours: Array<Element | null>
) {
    const focusable = (element: Element | null) =>
        element && element.isConnected
            ? element.querySelector<HTMLElement>('[data-row-focus]')
            : null;
    const target =
        focusable(row) ||
        neighbours.map(focusable).find(Boolean) ||
        (list && list.isConnected ? list : null);
    target?.focus();
}

let labelListCount = 0;

/** A page-unique id for a label suggestion list. */
function useLabelListId(): string {
    const ref = React.useRef('');
    if (!ref.current) ref.current = `wsi-annotation-labels-${++labelListCount}`;
    return ref.current;
}

/**
 * A label field: a select of the vocabulary when labels are strict, else a
 * text field suggesting the vocabulary and the labels already used.
 */
export const AnnotationLabelField = observer(
    ({
        controller,
        value,
        onChange,
        ariaLabel,
        testId,
        placeholder,
        allowEmpty,
        autoFocus,
        onKeyDown,
        style,
        toolbarItem,
    }: {
        controller: WsiAnnotationController;
        value: string;
        onChange: (value: string) => void;
        ariaLabel: string;
        testId: string;
        placeholder?: string;
        /** Strict labels only: offer an empty choice labelled `placeholder`. */
        allowEmpty?: boolean;
        autoFocus?: boolean;
        onKeyDown?: (event: React.KeyboardEvent) => void;
        style?: React.CSSProperties;
        /** Marks the field as one of a toolbar's controls. */
        toolbarItem?: boolean;
    }) => {
        const listId = useLabelListId();
        const itemProps = toolbarItem ? { 'data-toolbar-item': true } : {};
        if (controller.strictLabels) {
            return (
                <select
                    {...itemProps}
                    data-testid={testId}
                    aria-label={ariaLabel}
                    value={value}
                    autoFocus={autoFocus}
                    onChange={event => onChange(event.target.value)}
                    onKeyDown={onKeyDown}
                    style={style}
                >
                    {allowEmpty && (
                        <option value="">{placeholder || '—'}</option>
                    )}
                    {!allowEmpty &&
                        value &&
                        !controller.labelVocabulary.includes(value) && (
                            <option value={value} disabled>
                                {value}
                            </option>
                        )}
                    {controller.labelVocabulary.map(term => (
                        <option key={term} value={term}>
                            {term}
                        </option>
                    ))}
                </select>
            );
        }
        return (
            <>
                <input
                    {...itemProps}
                    data-testid={testId}
                    aria-label={ariaLabel}
                    list={listId}
                    value={value}
                    placeholder={placeholder}
                    maxLength={200}
                    autoFocus={autoFocus}
                    onChange={event => onChange(event.target.value)}
                    onKeyDown={onKeyDown}
                    style={style}
                />
                <datalist id={listId}>
                    {controller.labelSuggestions.map(term => (
                        <option key={term} value={term} />
                    ))}
                </datalist>
            </>
        );
    }
);

/** The solo button's icon: a ring, with a dot while the layer is solo. */
export function SoloIcon({ on = false }: { on?: boolean }) {
    return (
        <svg
            aria-hidden="true"
            focusable="false"
            width={12}
            height={12}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            style={{ display: 'inline-block', verticalAlign: '-1px' }}
        >
            <circle cx={8} cy={8} r={6} />
            {on && (
                <circle cx={8} cy={8} r={3} fill="currentColor" stroke="none" />
            )}
        </svg>
    );
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The confirmation for deleting a layer: it deletes only the user's own
 * annotations, and the layer stays while other users have annotations in
 * it. Null when there is nothing in the layer.
 */
export function layerDeleteMessage(
    layer: string,
    counts: { own: number; others: number }
): string | null {
    const { own, others } = counts;
    if (!own && !others) return null;
    const deletes = own
        ? `Delete layer "${layer}" and your ${plural(own, 'annotation')} in it?`
        : `Delete layer "${layer}"? None of its annotations are yours.`;
    return others
        ? `${deletes} The layer stays on the slide while ${plural(
              others,
              'annotation'
          )} by other users ${others === 1 ? 'is' : 'are'} in it.`
        : deletes;
}

export const WsiAnnotationLayersPanel = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const [showAddLayer, setShowAddLayer] = React.useState(false);
        const [newLayer, setNewLayer] = React.useState('');
        if (!controller || !controller.visible) return null;

        const reset = () => {
            setNewLayer('');
            setShowAddLayer(false);
        };
        const addLayer = () => {
            controller.addLayer(newLayer);
            reset();
        };

        return (
            <div data-testid="wsi-annotation-layers" style={{ marginTop: 6 }}>
                {controller.layerNames.map(layer => {
                    const hidden = controller.hiddenLayerNames.has(layer);
                    const active = controller.activeLayer === layer;
                    const count =
                        controller.annotationsByLayer.get(layer)?.length || 0;
                    return (
                        <div
                            key={layer}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '3px 0',
                            }}
                        >
                            <button
                                data-testid={`layer-toggle-${layer}`}
                                aria-label={`${
                                    hidden ? 'Show' : 'Hide'
                                } ${layer} layer`}
                                title={
                                    hidden
                                        ? `Show layer "${layer}"`
                                        : `Hide layer "${layer}"`
                                }
                                onClick={() =>
                                    controller.toggleLayerVisibility(layer)
                                }
                                style={{
                                    border: 'none',
                                    background: 'transparent',
                                    color: hidden ? colors.muted : colors.blue,
                                    cursor: 'pointer',
                                    padding: '0 2px',
                                    width: 18,
                                }}
                            >
                                <i
                                    aria-hidden="true"
                                    className={`fa ${
                                        hidden ? 'fa-eye-slash' : 'fa-eye'
                                    }`}
                                />
                            </button>
                            <button
                                data-testid={`layer-solo-${layer}`}
                                aria-pressed={controller.soloLayer === layer}
                                aria-label={
                                    controller.soloLayer === layer
                                        ? 'Show all layers again'
                                        : `Show only layer ${layer}`
                                }
                                title={
                                    controller.soloLayer === layer
                                        ? 'Show all layers again'
                                        : `Show only layer "${layer}"`
                                }
                                onClick={() =>
                                    controller.toggleSoloLayer(layer)
                                }
                                style={{
                                    border: 'none',
                                    background: 'transparent',
                                    color:
                                        controller.soloLayer === layer
                                            ? colors.blue
                                            : colors.muted,
                                    cursor: 'pointer',
                                    padding: '0 2px',
                                    width: 18,
                                }}
                            >
                                <SoloIcon on={controller.soloLayer === layer} />
                            </button>
                            <span
                                aria-hidden="true"
                                data-testid={`layer-color-${layer}`}
                                style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: '50%',
                                    flexShrink: 0,
                                    background: controller.layerColor(layer)
                                        .hex,
                                }}
                            />
                            <button
                                data-testid={`layer-select-${layer}`}
                                title={`Draw on layer "${layer}"`}
                                aria-pressed={active}
                                onClick={() => controller.setActiveLayer(layer)}
                                style={{
                                    flex: 1,
                                    textAlign: 'left',
                                    fontSize: 11,
                                    padding: '1px 6px',
                                    borderRadius: 3,
                                    cursor: 'pointer',
                                    border: `1.5px solid ${
                                        active ? colors.blue : colors.border
                                    }`,
                                    background: active
                                        ? colors.blue
                                        : 'transparent',
                                    color: active
                                        ? '#fff'
                                        : hidden
                                        ? colors.muted
                                        : colors.text,
                                    fontWeight: active ? 700 : 400,
                                    textDecoration: hidden
                                        ? 'line-through'
                                        : 'none',
                                    opacity: hidden ? 0.55 : 1,
                                }}
                            >
                                {layer}
                            </button>
                            <span
                                style={{
                                    minWidth: 14,
                                    textAlign: 'right',
                                    color: colors.muted,
                                    fontSize: 10,
                                }}
                            >
                                {count}
                            </span>
                            {layer !== DEFAULT_LAYER && controller.canEdit && (
                                <button
                                    data-testid={`delete-layer-${layer}`}
                                    title={`Delete layer "${layer}"`}
                                    aria-label={`Delete layer ${layer}`}
                                    onClick={() => {
                                        const message = layerDeleteMessage(
                                            layer,
                                            controller.layerDeleteCounts(layer)
                                        );
                                        if (
                                            message &&
                                            !window.confirm(message)
                                        ) {
                                            return;
                                        }
                                        void controller.deleteLayer(layer);
                                    }}
                                    style={{
                                        border: 'none',
                                        background: 'transparent',
                                        color: '#c0392b',
                                        cursor: 'pointer',
                                        padding: '0 2px',
                                    }}
                                >
                                    ✕
                                </button>
                            )}
                        </div>
                    );
                })}
                {!showAddLayer ? (
                    <button
                        data-testid="add-layer-btn"
                        title="Add new annotation layer"
                        onClick={() => setShowAddLayer(true)}
                        style={{
                            width: '100%',
                            marginTop: 4,
                            padding: '1px 8px',
                            border: `1px dashed ${colors.border}`,
                            borderRadius: 3,
                            background: 'transparent',
                            color: colors.muted,
                            fontSize: 11,
                        }}
                    >
                        + Add layer
                    </button>
                ) : (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 3,
                            marginTop: 4,
                        }}
                    >
                        <input
                            data-testid="add-layer-input"
                            value={newLayer}
                            placeholder="Layer name"
                            maxLength={30}
                            autoFocus
                            onChange={event => setNewLayer(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter') addLayer();
                                if (event.key === 'Escape') reset();
                            }}
                            style={{
                                flex: 1,
                                minWidth: 0,
                                fontSize: 11,
                                padding: '1px 5px',
                            }}
                        />
                        <button
                            data-testid="add-layer-confirm"
                            onClick={addLayer}
                            style={{
                                border: `1px solid ${colors.blue}`,
                                borderRadius: 3,
                                background: colors.blue,
                                color: '#fff',
                                fontSize: 11,
                            }}
                        >
                            Add
                        </button>
                        <button
                            title="Cancel"
                            aria-label="Cancel adding a layer"
                            onClick={reset}
                            style={{
                                border: 'none',
                                background: 'transparent',
                                color: colors.muted,
                            }}
                        >
                            ✕
                        </button>
                    </div>
                )}
            </div>
        );
    }
);

/**
 * Dropped points the service refused to save: how many, with Retry (e.g.
 * after signing in again) while they are still on the slide.
 */
const UnsavedPointsNotice = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const message = controller.unsavedPointMessage;
        if (!message) return null;
        const here = controller.unsavedPointCount > 0;
        return (
            <div
                role="alert"
                data-testid="annotation-unsaved-points"
                style={{ color: '#a00', fontSize: 11, marginBottom: 4 }}
            >
                {message}{' '}
                {here ? (
                    <button
                        data-testid="annotation-unsaved-points-retry"
                        onClick={() => void controller.retryUnsavedPoints()}
                        style={transferButtonStyle()}
                    >
                        Retry
                    </button>
                ) : (
                    <button
                        onClick={controller.dismissPointsLeftUnsaved}
                        style={transferButtonStyle()}
                    >
                        Dismiss
                    </button>
                )}
            </div>
        );
    }
);

/** Says that sizes are in pixels, on a slide without a scale. */
const MeasurementScaleNote = observer(
    ({ controller }: { controller: WsiAnnotationController }) =>
        controller.mpp ? null : (
            <div
                data-testid="annotation-measurement-scale-note"
                style={{
                    color: colors.muted,
                    fontSize: 10,
                    marginBottom: 4,
                }}
            >
                Sizes are in pixels: this slide has no microns-per-pixel scale.
            </div>
        )
);

/** The panel's error, with Retry when the annotations failed to load. */
const AnnotationError = observer(
    ({ controller }: { controller: WsiAnnotationController }) =>
        controller.error ? (
            <div
                role="alert"
                data-testid="annotation-error"
                style={{ color: '#a00', fontSize: 11, marginBottom: 4 }}
            >
                {controller.error}
                {controller.loadFailed && (
                    <>
                        {' '}
                        <button
                            data-testid="annotation-load-retry"
                            onClick={() => void controller.retryLoad()}
                            style={transferButtonStyle()}
                        >
                            Retry
                        </button>
                    </>
                )}
            </div>
        ) : null
);

export const WsiAnnotationPanel = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        if (!controller || !controller.visible) return null;
        if (controller.loading) {
            return (
                <span style={{ color: colors.muted, fontSize: 11 }}>
                    Loading…
                </span>
            );
        }
        if (controller.error && !controller.annotations.length) {
            return <AnnotationError controller={controller} />;
        }
        if (!controller.annotations.length) {
            return (
                <>
                    <UnsavedPointsNotice controller={controller} />
                    {controller.canEdit && (
                        <MeasurementScaleNote controller={controller} />
                    )}
                    <span style={{ color: colors.muted, fontSize: 11 }}>
                        {controller.canEdit
                            ? 'No annotations yet. Turn on Annotate above the slide to draw one.'
                            : 'No annotations.'}
                    </span>
                </>
            );
        }
        const listed = controller.listedAnnotations;
        return (
            <div data-testid="wsi-annotation-panel" style={{ marginTop: 6 }}>
                <AnnotationError controller={controller} />
                {controller.notice && (
                    <div
                        role="status"
                        data-testid="annotation-notice"
                        style={{
                            color: colors.text,
                            fontSize: 11,
                            marginBottom: 4,
                        }}
                    >
                        {controller.notice}{' '}
                        <button
                            onClick={controller.dismissNotice}
                            style={transferButtonStyle()}
                        >
                            Dismiss
                        </button>
                    </div>
                )}
                <UnsavedPointsNotice controller={controller} />
                {(controller.unreviewedAiCount > 0 ||
                    controller.hideUnreviewedAi) && (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 6,
                            marginBottom: 4,
                        }}
                    >
                        <label
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 11,
                                color: colors.muted,
                                margin: 0,
                            }}
                        >
                            <input
                                type="checkbox"
                                data-testid="annotation-hide-unreviewed-ai"
                                checked={controller.hideUnreviewedAi}
                                onChange={controller.toggleHideUnreviewedAi}
                            />
                            Hide unreviewed AI annotations (
                            {controller.unreviewedAiCount})
                        </label>
                        {controller.unreviewedAiCount > 0 && (
                            <ReviewQueueButton controller={controller} />
                        )}
                    </div>
                )}
                <MeasurementScaleNote controller={controller} />
                <PointTally controller={controller} />
                <HpfSummary controller={controller} />
                <AnnotationListFilters controller={controller} />
                <AnnotationCounts controller={controller} />
                <AnnotationList controller={controller} listed={listed} />
            </div>
        );
    }
);

/** The annotation list's height, in pixels; it scrolls beyond. */
export const ANNOTATION_LIST_HEIGHT = 260;
/** Lists longer than this render only the rows in and near the view. */
export const VIRTUALIZE_ABOVE = 100;
/** A row's height until it is measured, in pixels. */
const ROW_HEIGHT_ESTIMATE = 64;
/** Rows rendered above and below the view, in pixels. */
const OVERSCAN = 300;

/** The rendered row of annotation `id` in `list`, if any. */
function rowElement(list: HTMLElement, id: string): HTMLElement | null {
    return (
        Array.from(
            list.querySelectorAll<HTMLElement>('[data-annotation-row]')
        ).find(row => row.getAttribute('data-annotation-row') === id) || null
    );
}

/** The first index whose row ends below `y` (offsets are row tops). */
function rowAt(offsets: number[], y: number): number {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (offsets[middle + 1] <= y) low = middle + 1;
        else high = middle;
    }
    return low;
}

/**
 * The annotation rows. A long list (more than `VIRTUALIZE_ABOVE` rows)
 * renders only the rows in and near the view, placed at their measured
 * offsets, so thousands of annotations scroll smoothly; the row holding
 * the focus stays rendered while it is scrolled away. In either case:
 * ↑/↓ (and Home/End) move between rows' labels, rendering a row before
 * focusing it, and the list scrolls to the annotation the slide is
 * pointed at (`]`/`[`, review, a link).
 */
const AnnotationList = observer(
    ({
        controller,
        listed,
    }: {
        controller: WsiAnnotationController;
        listed: WsiAnnotation[];
    }) => {
        const container = React.useRef<HTMLDivElement>(null);
        const heights = React.useRef(new Map<string, number>());
        const [scrollTop, setScrollTop] = React.useState(0);
        const [, setMeasured] = React.useState(0);
        const [focusedRow, setFocusedRow] = React.useState<string | null>(null);
        const [pendingFocus, setPendingFocus] = React.useState<string | null>(
            null
        );
        const virtual = listed.length > VIRTUALIZE_ABOVE;
        const indexById = React.useMemo(() => {
            const map = new Map<string, number>();
            listed.forEach((annotation, index) =>
                map.set(annotation.id, index)
            );
            return map;
        }, [listed]);
        // Row tops, measured where rendered, estimated elsewhere.
        const offsets: number[] = [0];
        if (virtual) {
            listed.forEach(annotation =>
                offsets.push(
                    offsets[offsets.length - 1] +
                        (heights.current.get(annotation.id) ||
                            ROW_HEIGHT_ESTIMATE)
                )
            );
        }
        const total = offsets[offsets.length - 1];
        const viewHeight =
            container.current?.clientHeight || ANNOTATION_LIST_HEIGHT;
        let rendered: number[];
        if (virtual) {
            const first = rowAt(offsets, Math.max(0, scrollTop - OVERSCAN));
            const last = rowAt(offsets, scrollTop + viewHeight + OVERSCAN);
            const indices = new Set<number>();
            for (let i = first; i <= last && i < listed.length; i++) {
                indices.add(i);
            }
            [focusedRow, pendingFocus].forEach(id => {
                const index = id !== null ? indexById.get(id) : undefined;
                if (index !== undefined) indices.add(index);
            });
            rendered = Array.from(indices).sort((a, b) => a - b);
        } else {
            rendered = listed.map((_, index) => index);
        }

        // Measure the rendered rows; a changed height places them again. A
        // row that grows on its own (a note or thread opened) is measured
        // again through the ResizeObserver.
        const resizes = React.useRef<ResizeObserver | null>(null);
        const measure = React.useCallback(() => {
            if (!container.current) return;
            let changed = false;
            container.current
                .querySelectorAll<HTMLElement>('[data-annotation-row]')
                .forEach(row => {
                    const id = row.getAttribute('data-annotation-row')!;
                    const height = row.offsetHeight;
                    if (height > 0 && heights.current.get(id) !== height) {
                        heights.current.set(id, height);
                        changed = true;
                    }
                });
            if (changed) setMeasured(n => n + 1);
        }, []);
        React.useEffect(() => {
            if (!virtual || typeof ResizeObserver === 'undefined') return;
            resizes.current = new ResizeObserver(measure);
            return () => {
                resizes.current?.disconnect();
                resizes.current = null;
            };
        }, [virtual, measure]);
        React.useLayoutEffect(() => {
            if (!virtual || !container.current) return;
            container.current
                .querySelectorAll<HTMLElement>('[data-annotation-row]')
                .forEach(row => resizes.current?.observe(row));
            measure();
        });

        /** Scrolls the list so that row `index` shows. */
        const reveal = (index: number) => {
            const element = container.current;
            if (!element) return;
            let top: number;
            let height: number;
            if (virtual) {
                top = offsets[index];
                height = offsets[index + 1] - top;
            } else {
                const row = rowElement(element, listed[index].id);
                if (!row) return;
                // The list is position: relative, so it is the rows'
                // offsetParent and offsetTop is the row's place in it.
                top = row.offsetTop;
                height = row.offsetHeight;
            }
            const view = element.clientHeight || ANNOTATION_LIST_HEIGHT;
            if (top < element.scrollTop) {
                element.scrollTop = top;
            } else if (top + height > element.scrollTop + view) {
                element.scrollTop = top + height - view;
            } else {
                return;
            }
            setScrollTop(element.scrollTop);
        };

        // Follow the annotation the slide is pointed at.
        const focusedAnnotation = controller.focusedAnnotationId;
        React.useEffect(() => {
            const index =
                focusedAnnotation !== null
                    ? indexById.get(focusedAnnotation)
                    : undefined;
            if (index !== undefined) reveal(index);
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [focusedAnnotation]);

        // Focus a row once it is rendered (arrow keys, Home, End).
        React.useEffect(() => {
            if (pendingFocus === null) return;
            const row =
                container.current &&
                rowElement(container.current, pendingFocus);
            if (!row) return;
            row.querySelector<HTMLElement>('[data-row-focus]')?.focus();
            setPendingFocus(null);
        });

        const onKeyDown = (event: React.KeyboardEvent) => {
            const target = event.target as HTMLElement;
            if (
                !target.hasAttribute('data-row-focus') ||
                !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
            ) {
                return;
            }
            const id = target
                .closest('[data-annotation-row]')
                ?.getAttribute('data-annotation-row');
            const at = id ? indexById.get(id) : undefined;
            if (at === undefined || !listed.length) return;
            const next =
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                    ? listed.length - 1
                    : Math.min(
                          listed.length - 1,
                          Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1))
                      );
            event.preventDefault();
            reveal(next);
            setPendingFocus(listed[next].id);
        };

        return (
            <div
                ref={container}
                role="list"
                aria-label="Annotations"
                data-testid="annotation-list"
                data-virtual={virtual || undefined}
                tabIndex={-1}
                onScroll={event =>
                    setScrollTop((event.target as HTMLElement).scrollTop)
                }
                onKeyDown={onKeyDown}
                onFocus={event => {
                    const id = (event.target as HTMLElement)
                        .closest('[data-annotation-row]')
                        ?.getAttribute('data-annotation-row');
                    setFocusedRow(id || null);
                }}
                onBlur={event => {
                    if (
                        !container.current?.contains(
                            event.relatedTarget as Node | null
                        )
                    ) {
                        setFocusedRow(null);
                    }
                }}
                style={{
                    maxHeight: ANNOTATION_LIST_HEIGHT,
                    overflowY: 'auto',
                    position: 'relative',
                }}
            >
                <div
                    style={
                        virtual
                            ? { position: 'relative', height: total }
                            : undefined
                    }
                >
                    {rendered.map(index => {
                        const annotation = listed[index];
                        return (
                            <AnnotationRow
                                key={annotation.id}
                                controller={controller}
                                annotation={annotation}
                                position={
                                    virtual
                                        ? {
                                              top: offsets[index],
                                              index,
                                              size: listed.length,
                                          }
                                        : undefined
                                }
                            />
                        );
                    })}
                </div>
                {!listed.length && (
                    <div
                        role="status"
                        style={{
                            color: colors.muted,
                            fontSize: 11,
                            padding: 4,
                        }}
                    >
                        No annotations match the filters.
                    </div>
                )}
            </div>
        );
    }
);

const AnnotationRow = observer(
    ({
        controller,
        annotation,
        position,
    }: {
        controller: WsiAnnotationController;
        annotation: WsiAnnotation;
        /** Where a virtualized list places the row (see `AnnotationList`). */
        position?: { top: number; index: number; size: number };
    }) => {
        const [editing, setEditing] = React.useState(false);
        const [label, setLabel] = React.useState(
            annotation.body?.[0]?.value || ''
        );
        const rawLabel = annotation.body?.[0]?.value || '';
        const layer = annotation.layerName || DEFAULT_LAYER;
        const dotColor = annotation.color || DEFAULT_COLOR;
        const creator = annotation.creator || '';
        const canReview = controller.canReview(annotation);
        const canModify = controller.canModify(annotation);
        const measurement = controller.measurementOf(annotation);
        const inside = controller.shownPointsInside(annotation);
        const created = annotation.created
            ? new Date(annotation.created).toLocaleDateString()
            : '';
        const rowRef = React.useRef<HTMLDivElement>(null);
        const name = rawLabel || '(unlabeled)';

        /**
         * Runs a row action, then moves focus: to this row when it is still
         * listed, else to the next (or previous) row, else to the list.
         */
        const thenFocus = (run: () => Promise<unknown>) => {
            const row = rowRef.current;
            const list = row?.closest<HTMLElement>('[role="list"]') || null;
            const neighbours = [
                row?.nextElementSibling || null,
                row?.previousElementSibling || null,
            ];
            void run().then(() => focusAfterRowAction(row, list, neighbours));
        };

        const save = () => {
            setEditing(false);
            thenFocus(() =>
                controller.renameAnnotation(annotation.id, label.trim())
            );
        };

        return (
            <div
                ref={rowRef}
                role="listitem"
                data-testid={`annotation-row-${annotation.id}`}
                data-annotation-row={annotation.id}
                aria-posinset={position ? position.index + 1 : undefined}
                aria-setsize={position ? position.size : undefined}
                style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 4,
                    padding: '4px 0',
                    borderBottom: `1px solid ${colors.border}`,
                    ...(position
                        ? {
                              position: 'absolute',
                              top: position.top,
                              left: 0,
                              right: 0,
                              boxSizing: 'border-box',
                          }
                        : {}),
                }}
            >
                <input
                    type="checkbox"
                    data-testid={`annotation-select-${annotation.id}`}
                    aria-label={`Select ${name}`}
                    checked={controller.isSelected(annotation.id)}
                    onChange={() => controller.toggleSelected(annotation.id)}
                    style={{ margin: '2px 0 0', flexShrink: 0 }}
                />
                <span
                    aria-hidden="true"
                    data-annotation-color={dotColor}
                    data-annotation-layer={layer}
                    style={{
                        width: 8,
                        height: 8,
                        marginTop: 4,
                        borderRadius: '50%',
                        background: dotColor,
                        flexShrink: 0,
                    }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                    {editing ? (
                        <div style={{ display: 'flex', gap: 3 }}>
                            <AnnotationLabelField
                                controller={controller}
                                testId={`annotation-label-input-${annotation.id}`}
                                ariaLabel={`Label for ${rawLabel ||
                                    'annotation'}`}
                                autoFocus
                                value={label}
                                onChange={setLabel}
                                onKeyDown={event => {
                                    if (event.key === 'Enter') save();
                                    if (event.key === 'Escape')
                                        setEditing(false);
                                }}
                                style={{ flex: 1, minWidth: 0, fontSize: 11 }}
                            />
                            <button
                                title="Save annotation label"
                                aria-label={`Save label of ${name}`}
                                disabled={!controller.isAllowedLabel(label)}
                                onClick={save}
                                style={{
                                    border: 'none',
                                    background: 'transparent',
                                    color: '#2a7a2a',
                                }}
                            >
                                ✓
                            </button>
                        </div>
                    ) : (
                        <>
                            <button
                                data-testid={`annotation-goto-${annotation.id}`}
                                data-row-focus
                                aria-label={`Go to annotation ${rawLabel ||
                                    '(unlabeled)'}`}
                                title={`${rawLabel ||
                                    '(unlabeled)'}: show on the slide`}
                                onClick={() =>
                                    controller.focusAnnotation(annotation.id)
                                }
                                style={{
                                    display: 'block',
                                    maxWidth: '100%',
                                    padding: 0,
                                    border: 'none',
                                    background: 'transparent',
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    color: colors.text,
                                    fontSize: 12,
                                    fontWeight: 500,
                                }}
                            >
                                {rawLabel || '(unlabeled)'}
                            </button>
                            <div
                                style={{
                                    display: 'flex',
                                    gap: 3,
                                    marginTop: 1,
                                    flexWrap: 'wrap',
                                }}
                            >
                                {annotation.unsaved && (
                                    <span
                                        data-testid={`annotation-unsaved-${annotation.id}`}
                                        style={{
                                            padding: '0 4px',
                                            borderRadius: 2,
                                            border: '1px solid #a00',
                                            color: '#a00',
                                            fontSize: 9,
                                            lineHeight: '12px',
                                        }}
                                    >
                                        Not saved
                                    </span>
                                )}
                                <AiBadge annotation={annotation} />
                                <TransferBadge annotation={annotation} />
                                <VisibilityBadge
                                    controller={controller}
                                    annotation={annotation}
                                />
                                <AnnotationBadge label={layer} />
                                {annotation.colorName &&
                                    // A layer's name is just its color.
                                    !controller.layerNames.includes(
                                        annotation.colorName
                                    ) && (
                                        <AnnotationBadge
                                            label={annotation.colorName}
                                            background={dotColor}
                                            color={readableTextColor(dotColor)}
                                        />
                                    )}
                            </div>
                            {measurement && (
                                <div
                                    data-testid={`annotation-measurement-${annotation.id}`}
                                    style={{
                                        color: colors.text,
                                        fontSize: 10,
                                        marginTop: 1,
                                    }}
                                >
                                    {formatMeasurement(measurement)}
                                </div>
                            )}
                            {inside && (
                                <div
                                    data-testid={`annotation-points-inside-${annotation.id}`}
                                    style={{
                                        color: colors.text,
                                        fontSize: 10,
                                    }}
                                >
                                    Points inside: {formatRegionCount(inside)}
                                </div>
                            )}
                            {controller.canVerifyTransfer(annotation) && (
                                <div style={{ marginTop: 2 }}>
                                    <button
                                        type="button"
                                        data-testid={`verify-transfer-${annotation.id}`}
                                        aria-label={`Mark ${rawLabel ||
                                            'annotation'} verified: its place on this slide is right`}
                                        title="Mark verified: you checked that the copy lies on the right tissue"
                                        onClick={() =>
                                            void controller.markTransferVerified(
                                                annotation.id
                                            )
                                        }
                                        style={reviewButtonStyle('#2a6a2a')}
                                    >
                                        ✓ Mark verified
                                    </button>
                                </div>
                            )}
                            <AnnotationNote
                                controller={controller}
                                annotation={annotation}
                            />
                            <AnnotationThread
                                controller={controller}
                                annotation={annotation}
                                name={name}
                            />
                            {canReview && (
                                <div
                                    style={{
                                        display: 'flex',
                                        gap: 4,
                                        marginTop: 2,
                                    }}
                                >
                                    <button
                                        data-testid={`accept-annotation-${annotation.id}`}
                                        aria-label={`Accept AI annotation ${rawLabel}`}
                                        onClick={() =>
                                            thenFocus(() =>
                                                controller.acceptAnnotation(
                                                    annotation.id
                                                )
                                            )
                                        }
                                        style={reviewButtonStyle('#2a7a2a')}
                                    >
                                        ✓ Accept
                                    </button>
                                    <button
                                        data-testid={`reject-annotation-${annotation.id}`}
                                        aria-label={`Reject AI annotation ${rawLabel}`}
                                        title={
                                            controller.reviewRoute === false
                                                ? 'Reject: deletes the annotation'
                                                : 'Reject: hides the annotation for everyone; the service keeps it as a review record'
                                        }
                                        onClick={() =>
                                            thenFocus(() =>
                                                controller.rejectAnnotation(
                                                    annotation.id
                                                )
                                            )
                                        }
                                        style={reviewButtonStyle('#c0392b')}
                                    >
                                        ✕ Reject
                                    </button>
                                </div>
                            )}
                            <AnnotationHistory
                                annotation={annotation}
                                name={name}
                                creator={creator}
                                created={created}
                            />
                        </>
                    )}
                </div>
                {!editing &&
                    controller.canLinkAnnotations &&
                    !annotation.unsaved &&
                    !annotation.id.startsWith('client-') && (
                        <button
                            data-testid={`copy-link-${annotation.id}`}
                            title="Copy a link that opens the slide at this annotation"
                            aria-label={`Copy link to annotation ${name}`}
                            onClick={() =>
                                void controller.copyAnnotationLink(
                                    annotation.id
                                )
                            }
                            style={{
                                border: 'none',
                                background: 'transparent',
                                color: colors.muted,
                                padding: '0 2px',
                            }}
                        >
                            <i aria-hidden="true" className="fa fa-link" />
                        </button>
                    )}
                {!editing && canModify && (
                    <button
                        data-testid={`edit-label-${annotation.id}`}
                        title="Edit label"
                        aria-label={`Edit label of ${name}`}
                        onClick={() => {
                            setLabel(rawLabel);
                            setEditing(true);
                        }}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: colors.muted,
                            padding: '0 2px',
                        }}
                    >
                        ✎
                    </button>
                )}
                {canModify && (
                    <button
                        data-testid={`delete-annotation-${annotation.id}`}
                        title="Delete annotation"
                        aria-label={`Delete annotation ${name}`}
                        onClick={() =>
                            thenFocus(() =>
                                controller.removeAnnotation(annotation.id)
                            )
                        }
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: '#c0392b',
                            padding: '0 2px',
                        }}
                    >
                        ✕
                    </button>
                )}
            </div>
        );
    }
);

const filterControlStyle: React.CSSProperties = {
    fontSize: 11,
    padding: '1px 4px',
    minWidth: 0,
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    background: '#fff',
    color: colors.text,
};

/** Filters for the annotation list: label text, layer, author and AI. */
const AnnotationListFilters = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const filter = controller.listFilter;
        const anyAi = controller.annotations.some(annotation =>
            isAiProvenance(annotation.provenance)
        );
        const filtered =
            filter.text ||
            filter.label ||
            filter.layer ||
            filter.author ||
            filter.ai !== 'all';
        return (
            <div
                data-testid="annotation-list-filters"
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 4,
                    marginBottom: 4,
                }}
            >
                <input
                    type="search"
                    aria-label="Filter annotations by label or note"
                    data-testid="annotation-filter-text"
                    placeholder="Filter by label or note"
                    value={filter.text}
                    onChange={event =>
                        controller.setListFilter({ text: event.target.value })
                    }
                    style={{ ...filterControlStyle, flex: '1 1 100%' }}
                />
                <select
                    aria-label="Filter annotations by layer"
                    data-testid="annotation-filter-layer"
                    value={filter.layer}
                    onChange={event =>
                        controller.setListFilter({ layer: event.target.value })
                    }
                    style={{ ...filterControlStyle, flex: 1 }}
                >
                    <option value="">All layers</option>
                    {controller.layerNames.map(layer => (
                        <option key={layer} value={layer}>
                            {layer}
                        </option>
                    ))}
                </select>
                {controller.authors.length > 1 && (
                    <select
                        aria-label="Filter annotations by author"
                        data-testid="annotation-filter-author"
                        value={filter.author}
                        onChange={event =>
                            controller.setListFilter({
                                author: event.target.value,
                            })
                        }
                        style={{ ...filterControlStyle, flex: 1 }}
                    >
                        <option value="">All authors</option>
                        {controller.authors.map(author => (
                            <option key={author} value={author}>
                                {author}
                            </option>
                        ))}
                    </select>
                )}
                {anyAi && (
                    <select
                        aria-label="Filter annotations by AI origin"
                        data-testid="annotation-filter-ai"
                        value={filter.ai}
                        onChange={event =>
                            controller.setListFilter({
                                ai: event.target.value as WsiAnnotationAiFilter,
                            })
                        }
                        style={{ ...filterControlStyle, flex: 1 }}
                    >
                        <option value="all">AI and manual</option>
                        <option value="ai">AI only</option>
                        <option value="unreviewed">Unreviewed AI</option>
                        <option value="human">Manual only</option>
                    </select>
                )}
                {filtered && (
                    <button
                        data-testid="annotation-filter-clear"
                        onClick={controller.clearListFilter}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: colors.blue,
                            fontSize: 10,
                            cursor: 'pointer',
                            padding: 0,
                        }}
                    >
                        Clear filters
                    </button>
                )}
            </div>
        );
    }
);

/** How many label groups "By label" shows before "+N more". */
export const LABEL_GROUPS_SHOWN = 8;

/**
 * How many listed annotations each layer and label group has. A label chip
 * filters the list to that group; the most common groups show first, and
 * the rest behind "+N more".
 */
const AnnotationCounts = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const [showAll, setShowAll] = React.useState(false);
        const layers = Array.from(controller.listedLayerCounts.entries());
        const labels = Array.from(controller.listedLabelCounts.entries()).sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
        );
        if (!layers.length) return null;
        const activeLabel = controller.listFilter.label;
        const shown = showAll ? labels : labels.slice(0, LABEL_GROUPS_SHOWN);
        const hidden = labels.length - shown.length;
        const row = (title: string, children: React.ReactNode) => (
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 3,
                    fontSize: 10,
                    color: colors.muted,
                    marginBottom: 3,
                }}
            >
                <span>{title}</span>
                {children}
            </div>
        );
        const moreButtonStyle: React.CSSProperties = {
            border: 'none',
            background: 'transparent',
            color: colors.blue,
            fontSize: 10,
            cursor: 'pointer',
            padding: '0 2px',
        };
        return (
            <div data-testid="annotation-counts">
                {row(
                    'By layer:',
                    layers.map(([layer, count]) => (
                        <span
                            key={layer}
                            data-testid={`annotation-count-layer-${layer}`}
                            style={countChipStyle}
                        >
                            {layer} {count}
                        </span>
                    ))
                )}
                {row(
                    'By label:',
                    <>
                        {shown.map(([label, count]) => {
                            const active = activeLabel === label;
                            return (
                                <button
                                    key={label}
                                    data-testid={`annotation-count-label-${label}`}
                                    aria-label={`Show only the ${count} ${label} annotation${
                                        count === 1 ? '' : 's'
                                    }`}
                                    aria-pressed={active}
                                    onClick={() =>
                                        controller.setListFilter({
                                            label: active ? '' : label,
                                        })
                                    }
                                    style={{
                                        ...countChipStyle,
                                        cursor: 'pointer',
                                        fontWeight: active ? 700 : 400,
                                        borderColor: active
                                            ? colors.text
                                            : colors.border,
                                    }}
                                >
                                    {label} {count}
                                </button>
                            );
                        })}
                        {hidden > 0 && (
                            <button
                                data-testid="annotation-count-label-more"
                                aria-expanded={false}
                                onClick={() => setShowAll(true)}
                                style={moreButtonStyle}
                            >
                                +{hidden} more
                            </button>
                        )}
                        {showAll && labels.length > LABEL_GROUPS_SHOWN && (
                            <button
                                data-testid="annotation-count-label-more"
                                aria-expanded={true}
                                onClick={() => setShowAll(false)}
                                style={moreButtonStyle}
                            >
                                Show fewer
                            </button>
                        )}
                    </>
                )}
            </div>
        );
    }
);

function transferButtonStyle(primary = false): React.CSSProperties {
    return {
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 3,
        border: `1px solid ${primary ? colors.blue : colors.border}`,
        background: primary ? colors.blue : '#fff',
        color: primary ? '#fff' : colors.text,
        cursor: 'pointer',
    };
}

/**
 * The high-power fields on the slide: how many, their area, and the points
 * inside them per label, per 10 fields.
 */
const HpfSummary = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const summary = controller.hpfSummary;
        const helpId = useHpfHelpId();
        if (!summary) return null;
        const per10 = (value: number) =>
            value.toLocaleString('en-US', { maximumFractionDigits: 1 });
        const perMm2 = (count: number) =>
            summary.areaMm2 > 0
                ? (count / summary.areaMm2).toLocaleString('en-US', {
                      maximumFractionDigits: 1,
                  })
                : '–';
        return (
            <table
                data-testid="annotation-hpf-summary"
                aria-describedby={helpId}
                style={{
                    width: '100%',
                    fontSize: 11,
                    borderCollapse: 'collapse',
                    marginBottom: 6,
                }}
            >
                <caption
                    style={{
                        textAlign: 'left',
                        fontSize: 10,
                        color: colors.muted,
                    }}
                >
                    {summary.fields} high-power field
                    {summary.fields === 1 ? '' : 's'}
                    {summary.areaMm2 > 0
                        ? ` (${summary.areaMm2.toLocaleString('en-US', {
                              maximumFractionDigits: 3,
                          })} mm²)`
                        : ''}{' '}
                    <WsiHpfInfo
                        testId="annotation-hpf-summary"
                        describedById={helpId}
                        rates
                        style={{ fontSize: 11 }}
                    />
                </caption>
                <thead>
                    <tr style={{ color: colors.muted, fontSize: 10 }}>
                        <th style={{ textAlign: 'left', fontWeight: 400 }}>
                            Points
                        </th>
                        <th style={{ textAlign: 'right', fontWeight: 400 }}>
                            In fields
                        </th>
                        <th
                            style={{ textAlign: 'right', fontWeight: 400 }}
                            title={HPF_RATE_HELP[0].text}
                        >
                            Per 10 HPF
                        </th>
                        <th
                            style={{ textAlign: 'right', fontWeight: 400 }}
                            title={HPF_RATE_HELP[1].text}
                        >
                            Per mm²
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {summary.byLabel.map(item => (
                        <tr
                            key={item.label}
                            data-testid={`annotation-hpf-rate-${item.label}`}
                        >
                            <td>{item.label}</td>
                            <td style={{ textAlign: 'right' }}>{item.count}</td>
                            <td
                                style={{
                                    textAlign: 'right',
                                    fontWeight: 600,
                                }}
                            >
                                {per10(item.per10)}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                                {perMm2(item.count)}
                            </td>
                        </tr>
                    ))}
                    {summary.byLabel.length !== 1 && (
                        <tr data-testid="annotation-hpf-rate-total">
                            <td>All points</td>
                            <td style={{ textAlign: 'right' }}>
                                {summary.total}
                            </td>
                            <td
                                style={{
                                    textAlign: 'right',
                                    fontWeight: 600,
                                }}
                            >
                                {per10(summary.per10)}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                                {perMm2(summary.total)}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        );
    }
);

/** Point counts per layer and label, e.g. mitoses. */
const PointTally = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const rows = controller.pointTally;
        if (!rows.length) return null;
        return (
            <table
                data-testid="annotation-point-tally"
                style={{
                    width: '100%',
                    fontSize: 11,
                    borderCollapse: 'collapse',
                    marginBottom: 6,
                }}
            >
                <caption
                    style={{
                        textAlign: 'left',
                        fontSize: 10,
                        color: colors.muted,
                    }}
                >
                    Point counts
                </caption>
                <thead>
                    <tr style={{ color: colors.muted, fontSize: 10 }}>
                        <th style={{ textAlign: 'left', fontWeight: 400 }}>
                            Label
                        </th>
                        <th style={{ textAlign: 'left', fontWeight: 400 }}>
                            Layer
                        </th>
                        <th style={{ textAlign: 'right', fontWeight: 400 }}>
                            Count
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => (
                        <tr
                            key={`${row.layer}|${row.label}`}
                            data-testid={`annotation-point-tally-${row.layer}-${row.label}`}
                        >
                            <td>
                                <span
                                    aria-hidden="true"
                                    style={{
                                        display: 'inline-block',
                                        width: 7,
                                        height: 7,
                                        borderRadius: '50%',
                                        background: row.color,
                                        marginRight: 4,
                                    }}
                                />
                                {row.label}
                            </td>
                            <td style={{ color: colors.muted }}>{row.layer}</td>
                            <td
                                style={{
                                    textAlign: 'right',
                                    fontWeight: 600,
                                }}
                            >
                                {row.count}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }
);

const countChipStyle: React.CSSProperties = {
    padding: '0 5px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: '#f7f7f7',
    color: colors.text,
    fontSize: 10,
    lineHeight: '14px',
};

export const MAX_NOTE_LENGTH = 2000;

/** An annotation's note, with an editor for users who can edit. */
const AnnotationNote = observer(
    ({
        controller,
        annotation,
    }: {
        controller: WsiAnnotationController;
        annotation: WsiAnnotation;
    }) => {
        const [editing, setEditing] = React.useState(false);
        const [draft, setDraft] = React.useState('');
        const note = annotation.note || '';
        const label = annotation.body?.[0]?.value || 'annotation';
        const save = () => {
            setEditing(false);
            void controller.setAnnotationNote(annotation.id, draft.trim());
        };
        if (editing) {
            return (
                <div style={{ marginTop: 2 }}>
                    <textarea
                        data-testid={`annotation-note-input-${annotation.id}`}
                        aria-label={`Note for ${label}`}
                        autoFocus
                        rows={3}
                        value={draft}
                        maxLength={MAX_NOTE_LENGTH}
                        onChange={event => setDraft(event.target.value)}
                        onKeyDown={event => {
                            if (
                                event.key === 'Enter' &&
                                (event.ctrlKey || event.metaKey)
                            ) {
                                event.preventDefault();
                                save();
                            }
                            if (event.key === 'Escape') setEditing(false);
                        }}
                        style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            fontSize: 11,
                            resize: 'vertical',
                        }}
                    />
                    <div style={{ display: 'flex', gap: 4 }}>
                        <button
                            data-testid={`annotation-note-save-${annotation.id}`}
                            onClick={save}
                            style={reviewButtonStyle('#2a7a2a')}
                        >
                            Save note
                        </button>
                        <button
                            onClick={() => setEditing(false)}
                            style={reviewButtonStyle(colors.muted)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            );
        }
        return (
            <>
                {note && (
                    <div
                        data-testid={`annotation-note-${annotation.id}`}
                        style={{
                            color: colors.text,
                            fontSize: 11,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            marginTop: 2,
                            fontStyle: 'italic',
                        }}
                    >
                        {note}
                    </div>
                )}
                {controller.canModify(annotation) && (
                    <button
                        data-testid={`annotation-note-edit-${annotation.id}`}
                        aria-label={`${
                            note ? 'Edit' : 'Add'
                        } note for ${label}`}
                        onClick={() => {
                            setDraft(note);
                            setEditing(true);
                        }}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: colors.blue,
                            fontSize: 10,
                            padding: 0,
                            cursor: 'pointer',
                        }}
                    >
                        {note ? 'Edit note' : '+ Note'}
                    </button>
                )}
            </>
        );
    }
);

/** A date and time as the user reads them, or the text as stored. */
function formatTime(value: string | undefined): string {
    if (!value) return '';
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

let historyCount = 0;

/**
 * Who made an annotation and when, and a History disclosure with what the
 * service stores: creation, the review, and the last change with its
 * version. The service keeps no change log, so earlier changes are not
 * listed.
 */
function AnnotationHistory({
    annotation,
    name,
    creator,
    created,
}: {
    annotation: WsiAnnotation;
    name: string;
    creator: string;
    created: string;
}) {
    const [open, setOpen] = React.useState(false);
    const id = React.useRef('');
    if (!id.current) id.current = `wsi-annotation-history-${++historyCount}`;
    if (!creator && !created && !annotation.version) return null;
    const entries = annotationHistory(annotation);
    return (
        <>
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 4,
                    color: colors.muted,
                    fontSize: 10,
                }}
            >
                <span>
                    {creator}
                    {creator && created ? ' · ' : ''}
                    {created}
                </span>
                {annotation.version !== undefined && (
                    <button
                        type="button"
                        data-testid={`annotation-history-toggle-${annotation.id}`}
                        aria-expanded={open}
                        aria-controls={id.current}
                        aria-label={`History of ${name}`}
                        onClick={() => setOpen(!open)}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: colors.blue,
                            fontSize: 10,
                            padding: 0,
                            cursor: 'pointer',
                        }}
                    >
                        History {open ? '▾' : '▸'}
                    </button>
                )}
            </div>
            {open && (
                <div
                    id={id.current}
                    data-testid={`annotation-history-${annotation.id}`}
                    style={{ fontSize: 10, color: colors.text, marginTop: 1 }}
                >
                    <ul style={{ margin: 0, paddingLeft: 14 }}>
                        {entries.map(entry => (
                            <li key={entry.what}>
                                {entry.what}
                                {entry.who ? ` by ${entry.who}` : ''}
                                {entry.when
                                    ? `, ${formatTime(entry.when)}`
                                    : ''}
                            </li>
                        ))}
                    </ul>
                    <div style={{ color: colors.muted }}>
                        The annotation service keeps only these fields; a full
                        change log would need one in the service.
                    </div>
                </div>
            )}
        </>
    );
}

function reviewButtonStyle(color: string): React.CSSProperties {
    return {
        fontSize: 10,
        padding: '0 6px',
        borderRadius: 3,
        border: `1px solid ${color}`,
        background: '#fff',
        color,
        cursor: 'pointer',
        lineHeight: '16px',
    };
}

/**
 * "AI" on an annotation the research assistant or a model made; the tooltip
 * says which.
 */
function AiBadge({ annotation }: { annotation: WsiAnnotation }) {
    const provenance = annotation.provenance;
    const machine = aiOriginDescription(provenance);
    const edited = isEditedAi(provenance);
    if (!machine && !edited) return null;
    // Machine-made and still to review, or accepted; else made by a person
    // from AI annotations.
    const unreviewed = !!machine && isUnreviewedAi(provenance);
    const origin =
        machine ||
        `Made by ${annotation.creator || 'a person'} from AI annotations${
            typeof provenance?.operation === 'string'
                ? ` (${provenance.operation})`
                : ''
        }`;
    const description = `${origin}${edited && machine ? ', then edited' : ''}${
        machine ? `; ${unreviewed ? 'not reviewed yet' : 'accepted'}` : ''
    }`;
    const text = edited
        ? `AI, edited${unreviewed ? ' · unreviewed' : ''}`
        : unreviewed
        ? 'AI · unreviewed'
        : 'AI · accepted';
    return (
        <span
            data-testid={`annotation-ai-badge-${annotation.id}`}
            aria-label={description}
            title={description}
            style={{
                padding: '0 4px',
                borderRadius: 2,
                border: `1px ${unreviewed ? 'dashed' : 'solid'} ${colors.ai}`,
                background: unreviewed ? '#fff' : colors.ai,
                color: unreviewed ? colors.ai : '#fff',
                fontSize: 9,
                fontWeight: 700,
                lineHeight: '12px',
            }}
        >
            {text}
        </span>
    );
}

/** A transferred annotation's state, with the residual of its alignment. */
function transferDescription(annotation: WsiAnnotation): string | null {
    const provenance = annotation.provenance;
    const from = transferSource(provenance);
    if (!from) return null;
    const um = provenance!.transform_residual_um;
    const px = provenance!.transform_residual_px;
    const error =
        typeof um === 'number'
            ? ` (alignment error ${um} µm)`
            : typeof px === 'number'
            ? ` (alignment error ${px} px)`
            : '';
    return `Copied from slide ${formatSlideId(
        from.slide_key
    )} through an alignment${error}; ${
        provenance!.verified === true
            ? 'its place was verified'
            : 'its place is not verified yet'
    }`;
}

/**
 * "Transferred · unverified" (dashed) or "Transferred · verified", on an
 * annotation copied from another slide side by side.
 */
export function TransferBadge({ annotation }: { annotation: WsiAnnotation }) {
    const description = transferDescription(annotation);
    if (!description) return null;
    const verified = annotation.provenance?.verified === true;
    const color = verified ? '#2a6a2a' : '#8a5300';
    return (
        <span
            data-testid={`annotation-transfer-badge-${annotation.id}`}
            aria-label={description}
            title={description}
            style={{
                padding: '0 4px',
                borderRadius: 2,
                border: `1px ${verified ? 'solid' : 'dashed'} ${color}`,
                background: verified ? color : '#fff',
                color: verified ? '#fff' : color,
                fontSize: 9,
                fontWeight: 700,
                lineHeight: '12px',
            }}
        >
            {verified ? 'Transferred · verified' : 'Transferred · unverified'}
        </span>
    );
}

/**
 * Whether an annotation is private or shared with the study; a button that
 * switches it for a user who can edit.
 */
const VisibilityBadge = observer(
    ({
        controller,
        annotation,
    }: {
        controller: WsiAnnotationController;
        annotation: WsiAnnotation;
    }) => {
        const visibility = annotationVisibility(annotation.visibleTo);
        if (!visibility) return null;
        const label = annotation.body?.[0]?.value || 'annotation';
        const text =
            visibility === 'private'
                ? 'Private'
                : visibility === 'shared'
                ? 'Shared'
                : 'Groups';
        const description =
            visibility === 'private'
                ? 'Private: only you can see it'
                : visibility === 'shared'
                ? 'Shared with everyone who can see this study'
                : 'Shared with groups';
        const style: React.CSSProperties = {
            padding: '0 4px',
            borderRadius: 2,
            border: `1px solid ${colors.border}`,
            background: visibility === 'private' ? '#fff7e6' : '#eef6ff',
            color: colors.muted,
            fontSize: 9,
            lineHeight: '12px',
        };
        const content = (
            <>
                <i
                    aria-hidden="true"
                    className={`fa ${
                        visibility === 'private' ? 'fa-lock' : 'fa-users'
                    }`}
                />{' '}
                {text}
            </>
        );
        if (!controller.canModify(annotation)) {
            return (
                <span
                    data-testid={`annotation-visibility-${annotation.id}`}
                    title={description}
                    style={style}
                >
                    {content}
                </span>
            );
        }
        const share = visibility === 'private';
        return (
            <button
                data-testid={`annotation-visibility-${annotation.id}`}
                aria-label={`${description}. ${
                    share ? 'Share' : 'Make private'
                }: ${label}`}
                title={`${description}. Click to ${
                    share ? 'share it with the study' : 'make it private'
                }.`}
                onClick={() =>
                    void controller.setAnnotationShared(annotation.id, share)
                }
                style={{ ...style, cursor: 'pointer' }}
            >
                {content}
            </button>
        );
    }
);

function AnnotationBadge({
    label,
    background = '#e8e8e8',
    color = '#555',
}: {
    label: string;
    background?: string;
    color?: string;
}) {
    return (
        <span
            style={{
                padding: '0 4px',
                borderRadius: 2,
                background,
                color,
                fontSize: 9,
                lineHeight: '14px',
            }}
        >
            {label}
        </span>
    );
}

export const WsiAnnotationTooltip = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const tooltip = controller.annotationTooltip;
        if (!tooltip) return null;
        const stored = tooltip.id
            ? controller.annotations.find(item => item.id === tooltip.id)
            : undefined;
        const transferred =
            stored && transferSource(stored.provenance) ? stored : null;
        return (
            <div
                data-testid="annotation-tooltip"
                onClick={controller.dismissAnnotationTooltip}
                style={{
                    position: 'fixed',
                    left: tooltip.x + 12,
                    top: tooltip.y - 8,
                    maxWidth: 260,
                    padding: '4px 10px',
                    borderRadius: 4,
                    background: 'rgba(30,30,30,0.9)',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 12,
                    pointerEvents: 'auto',
                    zIndex: 9999,
                }}
            >
                {tooltip.text}
                {tooltip.measurement && (
                    <div
                        data-testid="annotation-tooltip-measurement"
                        style={{ marginTop: 2, fontSize: 11 }}
                    >
                        {tooltip.measurement}
                    </div>
                )}
                {tooltip.pointsInside && (
                    <div
                        data-testid="annotation-tooltip-points-inside"
                        style={{ marginTop: 2, fontSize: 11 }}
                    >
                        {tooltip.pointsInside}
                    </div>
                )}
                {tooltip.note && (
                    <div
                        data-testid="annotation-tooltip-note"
                        style={{
                            marginTop: 2,
                            fontSize: 11,
                            whiteSpace: 'pre-wrap',
                            fontStyle: 'italic',
                        }}
                    >
                        {tooltip.note}
                    </div>
                )}
                {(tooltip.ai || tooltip.aiEdited) && (
                    <div style={{ marginTop: 2, fontSize: 10 }}>
                        {tooltip.aiEdited
                            ? `AI, edited${
                                  tooltip.ai === 'unreviewed'
                                      ? ' · not reviewed yet'
                                      : ''
                              }`
                            : tooltip.ai === 'unreviewed'
                            ? 'AI · not reviewed yet'
                            : 'AI · accepted'}
                        {tooltip.aiOrigin && (
                            <div data-testid="annotation-tooltip-ai-origin">
                                {tooltip.aiOrigin}
                            </div>
                        )}
                    </div>
                )}
                {transferred && (
                    <div
                        data-testid="annotation-tooltip-transfer"
                        style={{ marginTop: 2, fontSize: 10 }}
                    >
                        {transferred.provenance?.verified === true
                            ? 'Transferred · verified'
                            : 'Transferred · unverified'}
                        {controller.canVerifyTransfer(transferred) && (
                            <button
                                type="button"
                                data-testid="annotation-tooltip-verify"
                                onClick={event => {
                                    event.stopPropagation();
                                    void controller.markTransferVerified(
                                        transferred.id
                                    );
                                }}
                                style={{
                                    marginLeft: 6,
                                    padding: '0 4px',
                                    border: '1px solid #fff',
                                    borderRadius: 2,
                                    background: 'transparent',
                                    color: '#fff',
                                    fontSize: 10,
                                }}
                            >
                                Mark verified
                            </button>
                        )}
                    </div>
                )}
                {tooltip.layerName && (
                    <div style={{ marginTop: 2, fontSize: 10, opacity: 0.7 }}>
                        Layer: {tooltip.layerName}
                    </div>
                )}
                {tooltip.comments && (
                    <div
                        data-testid="annotation-tooltip-comments"
                        style={{ marginTop: 2, fontSize: 10 }}
                    >
                        {tooltip.comments} (in the Annotations list)
                    </div>
                )}
                {tooltip.history && (
                    <div
                        data-testid="annotation-tooltip-history"
                        style={{ marginTop: 2, fontSize: 10, opacity: 0.85 }}
                    >
                        {tooltip.history}
                    </div>
                )}
            </div>
        );
    }
);

/**
 * The freehand or brush stroke being drawn. Its points are added to the
 * polyline as they come (`SVGPointList.appendItem`, one per new point), and
 * placed again only when the slide moves or a new stroke starts, so a long
 * stroke stays as fast as a short one. Without `SVGPointList` (e.g. in
 * jsdom) it sets the `points` attribute.
 */
const StrokePolyline = observer(
    ({
        controller,
        ...props
    }: { controller: WsiAnnotationController } & React.SVGProps<
        SVGPolylineElement
    >) => {
        const ref = React.useRef<SVGPolylineElement>(null);
        const drawn = React.useRef<{
            points: readonly WsiPoint[] | null;
            count: number;
            revision: number;
            text: string;
        }>({ points: null, count: 0, revision: -1, text: '' });
        const points = controller.strokePoints();
        const revision = controller.viewRevision;
        // Re-rendered as the pointer moves, to add the new points.
        void controller.customDrawPreview;
        React.useLayoutEffect(() => {
            const element = ref.current;
            const place = controller.strokeScreenMapper();
            if (!element || !points || !place) return;
            const state = drawn.current;
            const list = (element as any).points as SVGPointList | undefined;
            const owner = element.ownerSVGElement;
            const native =
                !!list &&
                typeof list.appendItem === 'function' &&
                typeof owner?.createSVGPoint === 'function';
            const restart =
                state.points !== points ||
                state.revision !== revision ||
                state.count > points.length;
            if (restart) {
                state.text = '';
                if (native) list!.clear();
            }
            for (let i = restart ? 0 : state.count; i < points.length; i++) {
                const at = place(points[i]);
                if (native) {
                    const point = owner!.createSVGPoint();
                    point.x = at.x;
                    point.y = at.y;
                    list!.appendItem(point);
                } else {
                    state.text += `${state.text ? ' ' : ''}${at.x},${at.y}`;
                }
            }
            if (!native) element.setAttribute('points', state.text);
            state.points = points;
            state.count = points.length;
            state.revision = revision;
        });
        return (
            <polyline
                ref={ref}
                data-testid="annotation-stroke-preview"
                {...props}
            />
        );
    }
);

/** The brush's size under the pointer while the brush tool is on. */
const BrushCursor = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const cursor = controller.brushCursor;
        const tool = controller.activeTool;
        if (!cursor || (tool !== 'brush' && tool !== 'smartBrush')) {
            return null;
        }
        return (
            <circle
                data-testid="annotation-brush-cursor"
                data-diameter={Math.round(cursor.diameter * 10) / 10}
                cx={cursor.x}
                cy={cursor.y}
                r={Math.max(cursor.diameter / 2, 1)}
                stroke={controller.activeColor}
                strokeWidth={1}
                fill={controller.activeColor}
                fillOpacity={0.15}
            />
        );
    }
);

export const WsiAnnotationDrawPreview = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const preview = controller.customDrawPreview;
        const field = controller.hpfCursor;
        if (!preview && field) {
            return (
                <svg
                    data-testid="annotation-hpf-cursor-layer"
                    style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        pointerEvents: 'none',
                        zIndex: 19,
                    }}
                >
                    <ellipse
                        data-testid="annotation-hpf-cursor"
                        cx={field.x}
                        cy={field.y}
                        rx={field.rx}
                        ry={field.ry}
                        stroke={controller.activeColor}
                        strokeWidth={1.5}
                        strokeDasharray="5 4"
                        fill={controller.activeColor}
                        fillOpacity={0.08}
                    />
                </svg>
            );
        }
        if (!preview) {
            return controller.brushCursor ? (
                <svg
                    data-testid="annotation-brush-cursor-layer"
                    style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        pointerEvents: 'none',
                        zIndex: 19,
                    }}
                >
                    <BrushCursor controller={controller} />
                </svg>
            ) : null;
        }

        const x1 = preview.start.x;
        const y1 = preview.start.y;
        const x2 = preview.current.x;
        const y2 = preview.current.y;
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const rawRx = Math.abs(x2 - x1) / 2;
        const rawRy = Math.abs(y2 - y1) / 2;
        const radius = Math.min(rawRx, rawRy);
        const rx = preview.tool === 'circle' ? radius : rawRx;
        const ry = preview.tool === 'circle' ? radius : rawRy;
        const stroke =
            preview.tool === 'freehand' ||
            preview.tool === 'brush' ||
            preview.tool === 'smartBrush';
        // A stroke's points are placed by StrokePolyline as they come.
        const polygonPoints = stroke
            ? undefined
            : preview.points?.map(point => `${point.x},${point.y}`).join(' ');
        const polygonPreviewPoints = [
            ...(polygonPoints ? [polygonPoints] : []),
            `${x2},${y2}`,
        ].join(' ');

        const measurement = controller.drawPreviewMeasurement;
        return (
            <svg
                data-testid="annotation-draw-preview"
                style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    zIndex: 19,
                }}
            >
                {stroke ? (
                    // The smart brush shows its path thinly: what it paints
                    // is its live outline (WsiTissueOverlay).
                    <StrokePolyline
                        controller={controller}
                        stroke={controller.activeColor}
                        strokeOpacity={preview.tool === 'brush' ? 0.45 : 1}
                        strokeDasharray={
                            preview.tool === 'smartBrush' ? '4 3' : undefined
                        }
                        strokeWidth={
                            preview.tool === 'brush'
                                ? preview.strokeWidth || 1
                                : preview.tool === 'smartBrush'
                                ? 1.5
                                : 2
                        }
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill={
                            preview.tool === 'freehand'
                                ? controller.activeColor
                                : 'none'
                        }
                        fillOpacity={0.15}
                    />
                ) : preview.tool === 'polygon' ? (
                    <polyline
                        points={polygonPreviewPoints}
                        stroke={controller.activeColor}
                        strokeWidth={2}
                        fill={controller.activeColor}
                        fillOpacity={0.15}
                    />
                ) : preview.tool === 'rectangle' ? (
                    <rect
                        x={Math.min(x1, x2)}
                        y={Math.min(y1, y2)}
                        width={Math.abs(x2 - x1)}
                        height={Math.abs(y2 - y1)}
                        stroke={controller.activeColor}
                        strokeWidth={2}
                        fill={controller.activeColor}
                        fillOpacity={0.2}
                    />
                ) : preview.tool === 'measure' ? (
                    <WsiRulerLine
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        text={null}
                        testId="annotation-ruler-preview"
                    />
                ) : preview.tool === 'line' ? (
                    <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke={controller.activeColor}
                        strokeWidth={2}
                    />
                ) : (
                    <ellipse
                        cx={cx}
                        cy={cy}
                        rx={rx}
                        ry={ry}
                        stroke={controller.activeColor}
                        strokeWidth={2}
                        fill={controller.activeColor}
                        fillOpacity={0.2}
                    />
                )}
                <BrushCursor controller={controller} />
                {measurement && (
                    <text
                        data-testid="annotation-draw-measurement"
                        x={x2 + 12}
                        y={y2 - 10}
                        fontSize={12}
                        fontWeight={600}
                        fill="#fff"
                        stroke="rgba(0,0,0,0.75)"
                        strokeWidth={3}
                        paintOrder="stroke"
                    >
                        {measurement}
                    </text>
                )}
            </svg>
        );
    }
);
