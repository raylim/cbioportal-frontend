import * as React from 'react';
import { observer } from 'mobx-react';
import { WsiAnnotationController } from './wsiAnnotationController';
import { SLIDE_LABEL_FONT_SIZE, WsiScreenBox } from './wsiAnnotationSpatial';

/** Space between a shape and its highlight, in screen pixels. */
const HIGHLIGHT_PADDING = 6;
/** The smallest highlight, e.g. around a point. */
const HIGHLIGHT_MIN = 20;

function padded(box: WsiScreenBox, padding: number, min: number) {
    const width = Math.max(box.width + 2 * padding, min);
    const height = Math.max(box.height + 2 * padding, min);
    return {
        x: box.x + box.width / 2 - width / 2,
        y: box.y + box.height / 2 - height / 2,
        width,
        height,
    };
}

/**
 * Drawn over the slide, in screen pixels, following it as it moves: labels
 * on the slide, and the highlight of the focused annotation (under review,
 * stepped to, or opened by a link). It ignores the pointer, and is not part
 * of exports or of the downloaded view, which draw the slide's canvas only.
 */
export const WsiAnnotationOverlay = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const focused = controller.focusedBox;
        const labels = controller.slideLabels;
        if (!focused && !labels.length) return null;
        const box =
            focused && padded(focused, HIGHLIGHT_PADDING, HIGHLIGHT_MIN);
        return (
            <svg
                data-testid="annotation-overlay"
                aria-hidden="true"
                style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    overflow: 'hidden',
                    zIndex: 18,
                }}
            >
                {labels.length > 0 && (
                    <g data-testid="annotation-slide-label-layer">
                        {labels.map(label => (
                            <g
                                key={label.id}
                                data-testid={`annotation-slide-label-${label.id}`}
                            >
                                {/* White on at least 70% black: 7:1 or more
                                    on any tissue. */}
                                <rect
                                    x={label.x}
                                    y={label.y}
                                    width={label.width}
                                    height={label.height}
                                    rx={2}
                                    fill="rgba(0,0,0,0.7)"
                                />
                                <text
                                    x={label.x + 3}
                                    y={label.y + label.height - 4}
                                    fontSize={SLIDE_LABEL_FONT_SIZE}
                                    fill="#fff"
                                >
                                    {label.text}
                                </text>
                            </g>
                        ))}
                    </g>
                )}
                {box && (
                    <g data-testid="annotation-focus-highlight">
                        <rect
                            {...box}
                            rx={3}
                            fill="none"
                            stroke="rgba(0,0,0,0.7)"
                            strokeWidth={4}
                        />
                        <rect
                            {...box}
                            rx={3}
                            fill="none"
                            stroke="#ffd400"
                            strokeWidth={2}
                            strokeDasharray="6 4"
                        />
                    </g>
                )}
            </svg>
        );
    }
);

const barButtonStyle: React.CSSProperties = {
    border: '1px solid #cfcfcf',
    borderRadius: 3,
    background: '#fff',
    color: '#222',
    fontSize: 12,
    lineHeight: '18px',
    padding: '0 6px',
    cursor: 'pointer',
};

/**
 * The annotation the slide is pointed at by `]` / `[`, a list row or a
 * link: where it is among those listed, the previous and next ones, and
 * Copy link. Hidden while the review card is open.
 */
export const WsiAnnotationFocusBar = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const position = controller.navigationPosition;
        const id = controller.focusedAnnotationId;
        const annotation =
            id && controller.annotations.find(item => item.id === id);
        const message = controller.linkMessage;
        if (controller.reviewQueue || (!annotation && !message)) return null;
        const label = annotation
            ? annotation.body?.[0]?.value || '(unlabeled)'
            : '';
        return (
            <div
                role="group"
                aria-label="Annotation shown"
                data-testid="annotation-focus-bar"
                style={{
                    position: 'absolute',
                    left: '50%',
                    bottom: 40,
                    transform: 'translateX(-50%)',
                    maxWidth: 'calc(100% - 16px)',
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 6,
                    padding: '4px 8px',
                    background: '#fff',
                    border: '1px solid #cfcfcf',
                    borderRadius: 4,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                    color: '#222',
                    fontSize: 12,
                    zIndex: 21,
                }}
            >
                {annotation && (
                    <>
                        <button
                            type="button"
                            data-testid="annotation-focus-previous"
                            aria-label="Previous annotation ([)"
                            title="Previous annotation ([)"
                            onClick={() => controller.stepAnnotation(-1)}
                            style={barButtonStyle}
                        >
                            ‹
                        </button>
                        <span
                            role="status"
                            data-testid="annotation-focus-status"
                            style={{
                                maxWidth: 260,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {position && position.index >= 0
                                ? `${position.index + 1} of ${position.total}: `
                                : ''}
                            {label}
                        </span>
                        <button
                            type="button"
                            data-testid="annotation-focus-next"
                            aria-label="Next annotation (])"
                            title="Next annotation (])"
                            onClick={() => controller.stepAnnotation(1)}
                            style={barButtonStyle}
                        >
                            ›
                        </button>
                        {controller.canLinkAnnotations && (
                            <button
                                type="button"
                                data-testid="annotation-focus-copy-link"
                                title="Copy a link that opens the slide at this annotation"
                                onClick={() =>
                                    void controller.copyAnnotationLink(
                                        annotation.id
                                    )
                                }
                                style={barButtonStyle}
                            >
                                <i aria-hidden="true" className="fa fa-link" />{' '}
                                Copy link
                            </button>
                        )}
                    </>
                )}
                {message && (
                    <span
                        role="status"
                        data-testid="annotation-link-message"
                        style={{ overflowWrap: 'anywhere' }}
                    >
                        {message}
                    </span>
                )}
                <button
                    type="button"
                    data-testid="annotation-focus-close"
                    aria-label="Close (Esc)"
                    title="Close (Esc)"
                    onClick={() => {
                        controller.dismissLinkMessage();
                        controller.clearFocus();
                    }}
                    style={{
                        ...barButtonStyle,
                        border: 'none',
                        color: '#595959',
                        fontSize: 14,
                    }}
                >
                    ×
                </button>
            </div>
        );
    }
);
