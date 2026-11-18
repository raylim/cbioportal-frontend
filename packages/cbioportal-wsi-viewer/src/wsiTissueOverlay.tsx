import * as React from 'react';
import { observer } from 'mobx-react';
import { WsiAnnotationController } from './wsiAnnotationController';

const CUT_COLOR = '#d03030';

/**
 * The magic wand's or smart brush's outline over the slide: a dashed
 * even-odd path (red when it will be cut out of the selected regions), and
 * the wand's tolerance next to its last click. It ignores the pointer.
 * `data-ms` holds the time from the click to the first outline, and
 * `data-seed` the last click in level-0 image pixels.
 */
export const WsiTissueOverlay = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const outline = controller.tissueOutline;
        const view = controller.tissueView;
        if (!outline || !view) return null;
        const color = outline.cut ? CUT_COLOR : controller.activeColor;
        const anchor = outline.anchor;
        return (
            <svg
                data-testid="annotation-tissue-overlay"
                aria-hidden="true"
                style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    overflow: 'hidden',
                    zIndex: 19,
                }}
            >
                {outline.d && (
                    <g
                        data-testid="annotation-tissue-outline"
                        data-tool={view.tool}
                        data-source={view.source || ''}
                        data-ms={view.ms === null ? '' : Math.round(view.ms)}
                        data-busy={view.busy ? 'true' : 'false'}
                        data-seed={
                            view.seed
                                ? `${Math.round(view.seed.x)},${Math.round(
                                      view.seed.y
                                  )}`
                                : ''
                        }
                    >
                        <path
                            d={outline.d}
                            fillRule="evenodd"
                            fill={color}
                            fillOpacity={0.15}
                            stroke="rgba(0,0,0,0.75)"
                            strokeWidth={3}
                        />
                        <path
                            d={outline.d}
                            fillRule="evenodd"
                            fill="none"
                            stroke={outline.cut ? CUT_COLOR : '#fff'}
                            strokeWidth={1.5}
                            strokeDasharray="5 4"
                        />
                    </g>
                )}
                {anchor && view.tool === 'wand' && (
                    <text
                        data-testid="annotation-tissue-tolerance-chip"
                        x={anchor.x + 12}
                        y={anchor.y - 12}
                        fontSize={12}
                        fontWeight={600}
                        fill="#fff"
                        stroke="rgba(0,0,0,0.75)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        {`Tolerance ${view.tolerance}${view.busy ? ' …' : ''}`}
                    </text>
                )}
            </svg>
        );
    }
);

/**
 * What the magic wand or smart brush is doing, over the bottom of the
 * slide: how to use it, the pixel source, why an outline was cut short,
 * and messages. A `role="status"` region.
 */
export const WsiTissueBar = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const tool = controller.activeTool;
        if (tool !== 'wand' && tool !== 'smartBrush') return null;
        const view = controller.tissueView;
        const pending = tool === 'wand' && controller.tissuePending;
        const hint =
            tool === 'wand'
                ? pending
                    ? view?.cut
                        ? 'Enter cuts this outline out of the selected regions · Shift+click adds · Alt+click cuts out · drag or scroll: tolerance · Esc discards'
                        : 'Enter or double-click saves · Shift+click adds · Alt+click cuts out · drag up/down or scroll: tolerance · Esc discards'
                    : 'Click on tissue to outline the region of similar color.'
                : 'Paint over tissue: only color like the start of the stroke is painted.';
        const source =
            view?.source === 'screen'
                ? 'on-screen pixels'
                : view?.source === 'tiles'
                ? '10× tiles'
                : null;
        return (
            <div
                role="status"
                data-testid="annotation-tissue-bar"
                style={{
                    position: 'absolute',
                    left: '50%',
                    bottom: 40,
                    transform: 'translateX(-50%)',
                    maxWidth: 'calc(100% - 16px)',
                    padding: '4px 8px',
                    background: 'rgba(255,255,255,0.95)',
                    border: '1px solid #cfcfcf',
                    borderRadius: 4,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                    color: '#222',
                    fontSize: 12,
                    zIndex: 21,
                    pointerEvents: 'none',
                }}
            >
                <span data-testid="annotation-tissue-hint">{hint}</span>
                {view?.busy && (
                    <span
                        data-testid="annotation-tissue-busy"
                        style={{ marginLeft: 6 }}
                    >
                        <i
                            aria-hidden="true"
                            className="fa fa-spinner fa-spin"
                        />{' '}
                        {view.fetching ? 'Loading tiles…' : 'Outlining…'}
                    </span>
                )}
                {source && (
                    <span
                        data-testid="annotation-tissue-source"
                        style={{ marginLeft: 6, color: '#595959' }}
                    >
                        ({source}
                        {view?.ms !== null && view?.ms !== undefined
                            ? `, ${Math.round(view.ms)} ms`
                            : ''}
                        )
                    </span>
                )}
                {view?.note && (
                    <div
                        data-testid="annotation-tissue-note"
                        style={{ color: '#8a4b00' }}
                    >
                        {view.note}
                    </div>
                )}
                {controller.tissueMessage && (
                    <div
                        data-testid="annotation-tissue-message"
                        style={{ color: '#8a4b00' }}
                    >
                        {controller.tissueMessage}
                    </div>
                )}
            </div>
        );
    }
);
