import * as React from 'react';
import { observer } from 'mobx-react';
import { PatientHierarchy, Sample, Slide } from './wsiViewerTypes';
import {
    MIN_PANE_SHARE,
    otherSide,
    WsiCompareController,
    WsiPaneSide,
} from './wsiCompareController';
import {
    applyAffine,
    formatAlignmentError,
    MIN_ALIGNMENT_PAIRS,
    WsiTransformModel,
} from './wsiCompareTransform';
import {
    groupPairCandidates,
    pairingCandidates,
    slideSpecimenLabel,
    slideStainLabel,
    WsiPairLevel,
} from './wsiComparePairing';
import { formatSlideId } from './wsiSlideId';
import { getStainDotColor } from './wsiMetaUtils';
import { WSI_THEME as C } from './wsiTheme';

const colors = {
    active: '#1f6fbf',
    bar: '#f7f7f7',
    border: '#cfcfcf',
    muted: '#595959',
    text: '#222',
    marker: '#d9480f',
    markerSelected: '#1f6fbf',
} as const;

const SIDE_NAME: Record<WsiPaneSide, string> = {
    left: 'Left',
    right: 'Right',
};

const LEVEL_NAME: Record<WsiPairLevel, string> = {
    block: 'Block match',
    part: 'Part match',
    patient: 'Same patient',
};

function buttonStyle(active = false, disabled = false): React.CSSProperties {
    return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 24,
        padding: '0 8px',
        borderRadius: 3,
        border: `1px solid ${active ? colors.active : colors.border}`,
        background: active ? colors.active : '#fff',
        color: active ? '#fff' : colors.text,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 11,
        whiteSpace: 'nowrap',
    };
}

/** How the views follow each other now, for the bar. */
function syncSummary(compare: WsiCompareController): string {
    if (!compare.locked) return 'Views move separately';
    const fit = compare.fit;
    if (fit) {
        return `Aligned: ${fit.count} points${
            fit.exact
                ? ' (exact fit)'
                : `, error ${formatAlignmentError(fit.rms, fit.unit)}`
        }`;
    }
    if (compare.anchor) return 'Following from the anchor (µm)';
    return 'Following the same relative position';
}

/**
 * The side-by-side bar above the two slides: lock views, how they follow
 * each other, the anchor, the Align and copy panel, and closing.
 */
export const WsiCompareBar = observer(
    ({
        compare,
        onClose,
    }: {
        compare: WsiCompareController;
        onClose: () => void;
    }) => (
        <div
            role="toolbar"
            aria-label="Side by side"
            data-testid="wsi-compare-bar"
            style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 6,
                padding: '4px 8px',
                background: colors.bar,
                borderBottom: `1px solid ${C.border}`,
                fontSize: 11,
                color: colors.text,
            }}
        >
            <strong style={{ fontSize: 12 }}>Side by side</strong>
            <label
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    margin: 0,
                    fontWeight: 400,
                }}
                title="Pan, zoom and rotation of one slide move the other"
            >
                <input
                    type="checkbox"
                    data-testid="wsi-compare-lock"
                    checked={compare.locked}
                    onChange={event => compare.setLocked(event.target.checked)}
                    style={{ margin: 0 }}
                />
                Lock views
            </label>
            <span
                role="status"
                data-testid="wsi-compare-sync-status"
                style={{ color: colors.muted }}
            >
                {syncSummary(compare)}
            </span>
            <span style={{ flex: 1 }} />
            {!compare.fit &&
                (compare.anchor ? (
                    <button
                        type="button"
                        data-testid="wsi-compare-clear-anchor"
                        onClick={compare.clearAnchor}
                        style={buttonStyle()}
                        title="Follow the same relative position again"
                    >
                        Clear anchor
                    </button>
                ) : (
                    <button
                        type="button"
                        data-testid="wsi-compare-set-anchor"
                        onClick={compare.setAnchorHere}
                        style={buttonStyle()}
                        title="Centre both slides on the same tissue, then set the anchor: the views then follow each other by distance in µm from these two points"
                    >
                        Set anchor
                    </button>
                ))}
            <button
                type="button"
                data-testid="wsi-compare-align-toggle"
                aria-pressed={compare.panelOpen}
                aria-expanded={compare.panelOpen}
                aria-controls="wsi-compare-align-panel"
                onClick={() => compare.setPanelOpen(!compare.panelOpen)}
                style={buttonStyle(compare.panelOpen)}
            >
                Align and copy
            </button>
            <button
                type="button"
                data-testid="wsi-compare-close"
                aria-label="Close side by side"
                title="Close side by side"
                onClick={onClose}
                style={{ ...buttonStyle(), padding: '0 6px' }}
            >
                <i className="fa fa-times" aria-hidden="true" />
            </button>
        </div>
    )
);

/** The Align and copy panel's height, in pixels. */
export const ALIGN_PANEL_HEIGHT = 112;

const MODEL_LABELS: Record<WsiTransformModel, string> = {
    similarity: 'Similarity (rotate, scale, shift)',
    affine: 'Affine (also shear and stretch)',
};

/**
 * The Align and copy panel: point placing, the pairs with their errors,
 * the model, Reset and Clear; then copying annotations to the other slide.
 */
export const WsiAlignPanel = observer(
    ({ compare }: { compare: WsiCompareController }) => {
        if (!compare.panelOpen) return null;
        const fit = compare.fit;
        const complete = compare.pairs.filter(pair => pair.left && pair.right)
            .length;
        const pending = compare.pendingSide;
        const from = compare.activeSide;
        const to = otherSide(from);
        const choices = compare.transferChoices;
        const unavailable = compare.transferUnavailable;
        return (
            <div
                id="wsi-compare-align-panel"
                role="region"
                aria-label="Align and copy"
                data-testid="wsi-compare-align-panel"
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'flex-start',
                    gap: 16,
                    // A fixed height: the slides below do not move as points
                    // and messages come and go.
                    height: ALIGN_PANEL_HEIGHT,
                    overflowY: 'auto',
                    boxSizing: 'border-box',
                    padding: '6px 8px',
                    background: '#fff',
                    borderBottom: `1px solid ${C.border}`,
                    fontSize: 11,
                    color: colors.text,
                }}
            >
                <div
                    role="group"
                    aria-label="Alignment points"
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        minWidth: 280,
                        flex: '1 1 320px',
                    }}
                >
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 6,
                        }}
                    >
                        <button
                            type="button"
                            data-testid="wsi-compare-place-points"
                            aria-pressed={compare.placing}
                            onClick={() => compare.setPlacing(!compare.placing)}
                            style={buttonStyle(compare.placing)}
                            title="Click the same tissue feature on each slide; a drag still pans"
                        >
                            <i
                                className="fa fa-crosshairs"
                                aria-hidden="true"
                            />
                            Place points
                        </button>
                        <label
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                margin: 0,
                                fontWeight: 400,
                            }}
                        >
                            Fit
                            <select
                                data-testid="wsi-compare-model"
                                value={compare.model}
                                onChange={event =>
                                    compare.setModel(
                                        event.target.value as WsiTransformModel
                                    )
                                }
                                style={{ fontSize: 11, height: 22 }}
                            >
                                {(['similarity', 'affine'] as const).map(
                                    model => (
                                        <option key={model} value={model}>
                                            {MODEL_LABELS[model]}
                                        </option>
                                    )
                                )}
                            </select>
                        </label>
                        <button
                            type="button"
                            data-testid="wsi-compare-reset"
                            onClick={compare.resetPoints}
                            style={buttonStyle()}
                            title="Put the points back as they were when this panel opened"
                        >
                            Reset
                        </button>
                        <button
                            type="button"
                            data-testid="wsi-compare-clear"
                            onClick={compare.clearPoints}
                            disabled={!compare.pairs.length}
                            style={buttonStyle(false, !compare.pairs.length)}
                        >
                            Clear points
                        </button>
                    </div>
                    <div
                        role="status"
                        data-testid="wsi-compare-align-status"
                        style={{ color: colors.muted }}
                    >
                        {compare.placing
                            ? pending
                                ? `Now click the same feature on the ${pending} slide (point ${compare.pairNumber(
                                      compare.openPair!.id
                                  )}).`
                                : complete < MIN_ALIGNMENT_PAIRS
                                ? `Click a tissue feature on either slide, then the same feature on the other (${complete} of ${MIN_ALIGNMENT_PAIRS} pairs).`
                                : 'Click a feature on either slide to add a pair; drag a numbered point to move it.'
                            : complete < MIN_ALIGNMENT_PAIRS
                            ? `${complete} of ${MIN_ALIGNMENT_PAIRS} point pairs placed. Turn on Place points to add more.`
                            : 'Drag a numbered point to move it.'}
                    </div>
                    {fit && (
                        <div data-testid="wsi-compare-fit">
                            <strong>
                                Error (RMS){' '}
                                <span data-testid="wsi-compare-rms">
                                    {formatAlignmentError(fit.rms, fit.unit)}
                                </span>
                            </strong>
                            {` · largest ${formatAlignmentError(
                                fit.max,
                                fit.unit
                            )} · ${fit.count} pairs`}
                            {fit.exact &&
                                ' · 3 pairs fit an affine map exactly: add a fourth to measure the error'}
                            {fit.reflected &&
                                ' · mirrored: one section lies flipped, so the other slide shows it mirrored'}
                        </div>
                    )}
                    {compare.pairs.length > 0 && (
                        <ol
                            aria-label="Point pairs"
                            data-testid="wsi-compare-pairs"
                            style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 4,
                                listStyle: 'none',
                                margin: 0,
                                padding: 0,
                            }}
                        >
                            {compare.pairs.map((pair, index) => {
                                const residual = fit?.residuals[pair.id];
                                const selected =
                                    compare.selectedPairId === pair.id;
                                return (
                                    <li
                                        key={pair.id}
                                        data-testid={`wsi-compare-pair-${index +
                                            1}`}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 2,
                                            padding: '0 0 0 6px',
                                            border: `1px solid ${
                                                selected
                                                    ? colors.markerSelected
                                                    : colors.border
                                            }`,
                                            borderRadius: 10,
                                            background: '#fff',
                                        }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() =>
                                                compare.selectPair(pair.id)
                                            }
                                            aria-pressed={selected}
                                            style={{
                                                border: 0,
                                                background: 'none',
                                                padding: 0,
                                                fontSize: 11,
                                                color: colors.text,
                                            }}
                                        >
                                            <strong>{index + 1}</strong>{' '}
                                            {pair.left && pair.right
                                                ? residual !== undefined && fit
                                                    ? formatAlignmentError(
                                                          residual,
                                                          fit.unit
                                                      )
                                                    : 'placed'
                                                : `needs ${
                                                      pair.left
                                                          ? 'right'
                                                          : 'left'
                                                  }`}
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Delete point pair ${index +
                                                1}`}
                                            title={`Delete point pair ${index +
                                                1}`}
                                            onClick={() =>
                                                compare.deletePair(pair.id)
                                            }
                                            style={{
                                                border: 0,
                                                background: 'none',
                                                padding: '0 6px 0 2px',
                                                color: colors.muted,
                                            }}
                                        >
                                            <i
                                                className="fa fa-times"
                                                aria-hidden="true"
                                            />
                                        </button>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </div>
                <div
                    role="group"
                    aria-label="Copy annotations"
                    data-testid="wsi-compare-copy"
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        minWidth: 240,
                        flex: '1 1 260px',
                    }}
                >
                    <strong>
                        Copy annotations: {from} → {to} slide
                    </strong>
                    {unavailable ? (
                        <span style={{ color: colors.muted }}>
                            {unavailable}
                        </span>
                    ) : (
                        <div
                            style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 4,
                            }}
                        >
                            <button
                                type="button"
                                data-testid="wsi-compare-copy-selected"
                                disabled={
                                    !choices.selected || compare.transferBusy
                                }
                                onClick={() =>
                                    void compare.transfer({ kind: 'selected' })
                                }
                                style={buttonStyle(
                                    false,
                                    !choices.selected || compare.transferBusy
                                )}
                                title={
                                    choices.selected
                                        ? `Copy the ${choices.selected} selected on the ${from} slide`
                                        : `Select annotations on the ${from} slide first (Shift+click, or the list's checkboxes)`
                                }
                            >
                                Selected ({choices.selected})
                            </button>
                            {choices.layers.map(({ layer, count }) => (
                                <button
                                    key={layer}
                                    type="button"
                                    data-testid={`wsi-compare-copy-layer-${layer}`}
                                    disabled={compare.transferBusy}
                                    onClick={() =>
                                        void compare.transfer({
                                            kind: 'layer',
                                            layer,
                                        })
                                    }
                                    style={buttonStyle(
                                        false,
                                        compare.transferBusy
                                    )}
                                    title={`Copy layer ${layer} (${count}) of the ${from} slide`}
                                >
                                    Layer {layer} ({count})
                                </button>
                            ))}
                        </div>
                    )}
                    <span style={{ color: colors.muted }}>
                        Copies are new annotations of yours on the {to} slide,
                        marked "Transferred · unverified" until you check them.
                    </span>
                </div>
                {compare.message && (
                    <div
                        role="status"
                        data-testid="wsi-compare-message"
                        style={{ flexBasis: '100%', color: colors.text }}
                    >
                        {compare.message}
                    </div>
                )}
            </div>
        );
    }
);

/** "IHC TTF-1 · Part 1 · Block A1 · WSI-0123-4567-89ab", for an option. */
function optionLabel(slide: Slide, level: WsiPairLevel): string {
    const where = slideSpecimenLabel(slide);
    return [
        slideStainLabel(slide),
        level === 'patient' ? where : null,
        formatSlideId(slide.slide_key),
    ]
        .filter(Boolean)
        .join(' · ');
}

/**
 * A pane's header: which side, the slide's stain and Slide ID, and the
 * slide picker, closest slides to the other pane's first.
 */
export const WsiPaneHeader = observer(
    ({
        side,
        active,
        hierarchy,
        slide,
        otherSlide,
        onSelect,
    }: {
        side: WsiPaneSide;
        active: boolean;
        hierarchy: PatientHierarchy;
        slide: Slide | null;
        otherSlide: Slide | null;
        onSelect: (slide: Slide, sample: Sample) => void;
    }) => {
        const candidates = React.useMemo(
            () => pairingCandidates(hierarchy, otherSlide),
            [hierarchy, otherSlide]
        );
        const groups = groupPairCandidates(candidates);
        const pickerId = `wsi-compare-picker-${side}`;
        return (
            <div
                data-testid={`wsi-pane-header-${side}`}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    minWidth: 0,
                    padding: '3px 8px',
                    background: active ? '#eef4fb' : colors.bar,
                    borderBottom: `2px solid ${
                        active ? colors.active : C.border
                    }`,
                    fontSize: 11,
                    color: colors.text,
                }}
            >
                <span style={{ fontWeight: 700 }}>{SIDE_NAME[side]}</span>
                {slide && (
                    <span
                        data-testid={`wsi-pane-stain-${side}`}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        <span
                            aria-hidden="true"
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: getStainDotColor(slide),
                            }}
                        />
                        {slideStainLabel(slide)}
                    </span>
                )}
                <label htmlFor={pickerId} className="sr-only">
                    {SIDE_NAME[side]} slide
                </label>
                <select
                    id={pickerId}
                    data-testid={`wsi-compare-picker-${side}`}
                    value={slide?.slide_key || ''}
                    onChange={event => {
                        const picked = candidates.find(
                            candidate =>
                                candidate.slide.slide_key === event.target.value
                        );
                        if (picked) onSelect(picked.slide, picked.sample);
                    }}
                    style={{
                        minWidth: 0,
                        flex: '1 1 auto',
                        maxWidth: 360,
                        height: 22,
                        fontSize: 11,
                    }}
                >
                    {!slide && <option value="">Pick a slide</option>}
                    {groups.map(({ group, candidates: entries }) => (
                        <optgroup key={group} label={group}>
                            {entries.map(candidate => (
                                <option
                                    key={candidate.slide.slide_key}
                                    value={candidate.slide.slide_key}
                                    title={LEVEL_NAME[candidate.level]}
                                >
                                    {optionLabel(
                                        candidate.slide,
                                        candidate.level
                                    )}
                                </option>
                            ))}
                        </optgroup>
                    ))}
                </select>
                {slide && (
                    <span
                        data-testid={`wsi-pane-slide-id-${side}`}
                        title="Slide ID"
                        style={{
                            color: colors.muted,
                            whiteSpace: 'nowrap',
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        {formatSlideId(slide.slide_key)}
                    </span>
                )}
            </div>
        );
    }
);

const MARKER_SIZE = 20;

/**
 * The numbered alignment points on one pane's slide, while the Align and
 * copy panel is open. Drag one to move it; with the focus on one, the
 * arrow keys nudge it (Shift: 10 pixels) and Delete removes its pair. A
 * complete pair's ring shows where the alignment puts the other slide's
 * point, so the error shows on the tissue.
 */
export const WsiAlignMarkers = observer(
    ({
        compare,
        side,
        containerRef,
    }: {
        compare: WsiCompareController;
        side: WsiPaneSide;
        containerRef: React.RefObject<HTMLDivElement>;
    }) => {
        const [drag, setDrag] = React.useState<{
            id: string;
            x: number;
            y: number;
        } | null>(null);
        if (!compare.open || !compare.panelOpen) return null;
        const fit = compare.fit;
        const toPane = (event: React.PointerEvent) => {
            const rect = containerRef.current?.getBoundingClientRect();
            return rect
                ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
                : null;
        };
        const commit = (id: string, x: number, y: number) => {
            const point = compare.imagePointAt(side, x, y);
            if (point) compare.movePoint(id, side, point);
        };
        const markers = compare.pairs
            .map((pair, index) => {
                const point = pair[side];
                const screen = point && compare.screenPoint(side, point);
                const other = pair[otherSide(side)];
                const predicted =
                    fit && point && other
                        ? compare.screenPoint(
                              side,
                              applyAffine(
                                  side === 'right'
                                      ? fit.transform
                                      : fit.inverse,
                                  other
                              )
                          )
                        : null;
                return { pair, index, screen, predicted };
            })
            .filter(entry => entry.screen);
        return (
            <div
                data-testid={`wsi-align-markers-${side}`}
                style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    zIndex: 60,
                    overflow: 'hidden',
                }}
            >
                <svg
                    aria-hidden="true"
                    width="100%"
                    height="100%"
                    style={{ position: 'absolute', inset: 0 }}
                >
                    {markers.map(({ pair, screen, predicted }) =>
                        predicted ? (
                            <g key={pair.id}>
                                <line
                                    x1={screen!.x}
                                    y1={screen!.y}
                                    x2={predicted.x}
                                    y2={predicted.y}
                                    stroke="#fff"
                                    strokeWidth={3}
                                />
                                <line
                                    x1={screen!.x}
                                    y1={screen!.y}
                                    x2={predicted.x}
                                    y2={predicted.y}
                                    stroke={colors.marker}
                                    strokeWidth={1}
                                />
                                <circle
                                    data-testid={`wsi-align-predicted-${side}`}
                                    cx={predicted.x}
                                    cy={predicted.y}
                                    r={5}
                                    fill="none"
                                    stroke={colors.marker}
                                    strokeWidth={1.5}
                                    strokeDasharray="2 2"
                                />
                            </g>
                        ) : null
                    )}
                </svg>
                {markers.map(({ pair, index, screen }) => {
                    const dragging = drag?.id === pair.id;
                    const x = dragging ? drag!.x : screen!.x;
                    const y = dragging ? drag!.y : screen!.y;
                    const selected = compare.selectedPairId === pair.id;
                    const waiting = !pair.left || !pair.right;
                    const number = index + 1;
                    return (
                        <button
                            key={pair.id}
                            type="button"
                            data-testid={`wsi-align-marker-${side}-${number}`}
                            aria-label={`Alignment point ${number} on the ${side} slide${
                                waiting ? ', waiting for its pair' : ''
                            }. Arrow keys move it; Delete removes the pair.`}
                            onFocus={() => compare.selectPair(pair.id)}
                            onPointerDown={event => {
                                event.stopPropagation();
                                event.preventDefault();
                                (event.currentTarget as HTMLElement).setPointerCapture?.(
                                    event.pointerId
                                );
                                compare.selectPair(pair.id);
                                const at = toPane(event);
                                if (at) setDrag({ id: pair.id, ...at });
                            }}
                            onPointerMove={event => {
                                if (!dragging) return;
                                const at = toPane(event);
                                if (at) setDrag({ id: pair.id, ...at });
                            }}
                            onPointerUp={event => {
                                if (!dragging) return;
                                const at = toPane(event);
                                setDrag(null);
                                if (at) commit(pair.id, at.x, at.y);
                            }}
                            onPointerCancel={() => setDrag(null)}
                            onKeyDown={event => {
                                if (
                                    event.key === 'Delete' ||
                                    event.key === 'Backspace'
                                ) {
                                    event.preventDefault();
                                    compare.deletePair(pair.id);
                                    return;
                                }
                                const step = event.shiftKey ? 10 : 1;
                                const delta: Record<
                                    string,
                                    [number, number]
                                > = {
                                    ArrowLeft: [-step, 0],
                                    ArrowRight: [step, 0],
                                    ArrowUp: [0, -step],
                                    ArrowDown: [0, step],
                                };
                                const move = delta[event.key];
                                if (!move) return;
                                event.preventDefault();
                                event.stopPropagation();
                                commit(
                                    pair.id,
                                    screen!.x + move[0],
                                    screen!.y + move[1]
                                );
                            }}
                            style={{
                                position: 'absolute',
                                left: x - MARKER_SIZE / 2,
                                top: y - MARKER_SIZE / 2,
                                width: MARKER_SIZE,
                                height: MARKER_SIZE,
                                padding: 0,
                                borderRadius: '50%',
                                border: `2px ${
                                    waiting ? 'dashed' : 'solid'
                                } #fff`,
                                boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
                                background: selected
                                    ? colors.markerSelected
                                    : colors.marker,
                                color: '#fff',
                                fontSize: 10,
                                fontWeight: 700,
                                lineHeight: `${MARKER_SIZE - 4}px`,
                                textAlign: 'center',
                                cursor: dragging ? 'grabbing' : 'grab',
                                pointerEvents: 'auto',
                                touchAction: 'none',
                            }}
                        >
                            {number}
                        </button>
                    );
                })}
            </div>
        );
    }
);

/**
 * The draggable divider between the panes; the arrow keys move it by 5%
 * of the width (Home and End to the limits).
 */
export const WsiCompareDivider = observer(
    ({
        compare,
        rowRef,
    }: {
        compare: WsiCompareController;
        rowRef: React.RefObject<HTMLDivElement>;
    }) => {
        const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            const handle = event.currentTarget;
            handle.setPointerCapture?.(event.pointerId);
            const move = (moveEvent: PointerEvent) => {
                const rect = rowRef.current?.getBoundingClientRect();
                if (rect && rect.width > 0) {
                    compare.setSplit(
                        (moveEvent.clientX - rect.left) / rect.width
                    );
                }
            };
            const end = () => {
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', end);
                handle.removeEventListener('pointercancel', end);
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', end);
            handle.addEventListener('pointercancel', end);
        };
        const percent = Math.round(compare.split * 100);
        return (
            <div
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="Resize the two slides"
                aria-valuemin={Math.round(MIN_PANE_SHARE * 100)}
                aria-valuemax={Math.round((1 - MIN_PANE_SHARE) * 100)}
                aria-valuenow={percent}
                aria-valuetext={`Left slide ${percent}% of the width`}
                data-testid="wsi-compare-divider"
                onPointerDown={onPointerDown}
                onKeyDown={event => {
                    const step: Record<string, number> = {
                        ArrowLeft: -0.05,
                        ArrowRight: 0.05,
                    };
                    if (event.key === 'Home') compare.setSplit(0);
                    else if (event.key === 'End') compare.setSplit(1);
                    else if (step[event.key] !== undefined) {
                        compare.setSplit(compare.split + step[event.key]);
                    } else return;
                    event.preventDefault();
                }}
                style={{
                    width: 8,
                    flexShrink: 0,
                    cursor: 'col-resize',
                    background: '#f0f0f0',
                    borderLeft: `1px solid ${C.border}`,
                    borderRight: `1px solid ${C.border}`,
                    position: 'relative',
                    touchAction: 'none',
                }}
            >
                <div
                    style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        width: 2,
                        height: 36,
                        borderRadius: 2,
                        background: '#c3c3c3',
                    }}
                />
            </div>
        );
    }
);
