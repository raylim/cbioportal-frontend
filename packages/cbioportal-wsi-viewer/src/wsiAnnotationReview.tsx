import * as React from 'react';
import { observer } from 'mobx-react';
import {
    DEFAULT_LAYER,
    WSI_REVIEW_UNSUPPORTED_MESSAGE,
    WsiAnnotationController,
} from './wsiAnnotationController';
import { aiOriginDescription } from './wsiAnnotationBody';
import { formatMeasurement } from './wsiAnnotationGeometryUtils';

// Text keeps at least 4.5:1 contrast on the card's white.
const colors = {
    accept: '#2a7a2a',
    border: '#cfcfcf',
    error: '#a00',
    muted: '#595959',
    primary: '#1f6fbf',
    reject: '#c0392b',
    text: '#222',
} as const;

const kbdStyle: React.CSSProperties = {
    display: 'inline-block',
    marginLeft: 4,
    padding: '0 3px',
    borderRadius: 3,
    border: '1px solid currentColor',
    fontFamily: 'inherit',
    fontSize: 10,
    fontWeight: 600,
    lineHeight: '13px',
};

function buttonStyle(color: string, busy: boolean): React.CSSProperties {
    return {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 3,
        border: `1px solid ${color}`,
        background: '#fff',
        color,
        fontSize: 12,
        cursor: busy ? 'progress' : 'pointer',
    };
}

let reviewCardCount = 0;

/** What the finished queue says: all done, or why some are left. */
function doneMessage(controller: WsiAnnotationController): string {
    const { reviewed, total } = controller.reviewProgress;
    if (reviewed >= total) {
        return `All ${total} AI annotation${total === 1 ? '' : 's'} reviewed.`;
    }
    if (controller.accessMessage) return controller.accessMessage;
    const left = total - reviewed;
    const which = `${left} AI annotation${left === 1 ? '' : 's'}`;
    return controller.reviewRoute === false
        ? `${which} left: ${WSI_REVIEW_UNSUPPORTED_MESSAGE}`
        : `${which} left that you cannot review here.`;
}

/**
 * The AI review queue's card: the annotation under review (label, origin,
 * size, note and layer), Accept, Reject, Skip and Previous, and the
 * progress. It takes the focus when it opens and gives it back on closing.
 * While it is open its keys (A, X, S or →, ←, Esc) take priority over the
 * tool shortcuts; see `WSI_REVIEW_KEYS`. Reject asks first.
 */
const ReviewCard = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const ref = React.useRef<HTMLDivElement>(null);
        const idRef = React.useRef('');
        if (!idRef.current) {
            idRef.current = `wsi-review-card-${++reviewCardCount}`;
        }
        const titleId = `${idRef.current}-title`;
        const rejectHelpId = `${idRef.current}-reject-help`;
        const armed =
            !!controller.rejectArmed &&
            controller.rejectArmed === controller.reviewCurrent?.id;
        const rejectConsequence =
            controller.reviewRoute === false
                ? 'It is deleted'
                : 'It is hidden for everyone (the service keeps it as a review record); this cannot be undone';
        const queue = controller.reviewQueue!;
        const current = controller.reviewCurrent;
        const busy = queue.busy;
        const { reviewed, total } = controller.reviewProgress;

        React.useEffect(() => {
            const opener = document.activeElement as HTMLElement | null;
            // This viewer's list, not another viewer's on the page.
            const root = ref.current?.closest('[data-wsi-viewer-root]');
            ref.current
                ?.querySelector<HTMLElement>('[data-review-primary]')
                ?.focus();
            return () => {
                // Back to where the queue was opened from (else to the
                // annotation list), unless the user has moved on.
                const active = document.activeElement;
                if (active && active !== document.body) return;
                const target = opener?.isConnected
                    ? opener
                    : root?.querySelector<HTMLElement>(
                          '[data-testid="annotation-list"]'
                      );
                target?.focus();
            };
        }, []);
        // Focus stays in the card as it moves to the next annotation or to
        // the end.
        const done = !current;
        React.useEffect(() => {
            const card = ref.current;
            const active = document.activeElement;
            if (card && (!active || active === document.body)) {
                card.querySelector<HTMLElement>(
                    '[data-review-primary]'
                )?.focus();
            }
        }, [done, current?.id]);

        const label = current?.body?.[0]?.value || '(unlabeled)';
        const measurement = current && controller.measurementOf(current);
        const run = (task: () => unknown) => () => {
            if (!busy) void task();
        };
        return (
            <div
                ref={ref}
                role="dialog"
                aria-modal="false"
                aria-labelledby={titleId}
                data-testid="annotation-review-card"
                tabIndex={-1}
                style={{
                    position: 'absolute',
                    left: 8,
                    bottom: 40,
                    width: 300,
                    maxWidth: 'calc(100% - 16px)',
                    padding: 10,
                    background: '#fff',
                    border: `1px solid ${colors.border}`,
                    borderRadius: 4,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                    color: colors.text,
                    fontSize: 12,
                    zIndex: 21,
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 6,
                        marginBottom: 6,
                    }}
                >
                    <strong id={titleId} style={{ flex: 1 }}>
                        Review AI annotations
                    </strong>
                    <span
                        role="status"
                        data-testid="annotation-review-progress"
                        style={{ color: colors.muted, whiteSpace: 'nowrap' }}
                    >
                        {reviewed} of {total} reviewed
                    </span>
                    <button
                        type="button"
                        data-testid="annotation-review-exit"
                        aria-label="Exit review (Esc)"
                        title="Exit review (Esc)"
                        onClick={controller.exitReview}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: colors.muted,
                            fontSize: 16,
                            lineHeight: 1,
                            cursor: 'pointer',
                        }}
                    >
                        ×
                    </button>
                </div>
                {current ? (
                    <>
                        <div
                            data-testid="annotation-review-label"
                            style={{
                                fontSize: 13,
                                fontWeight: 600,
                                overflowWrap: 'anywhere',
                            }}
                        >
                            {label}
                        </div>
                        <div
                            data-testid="annotation-review-origin"
                            style={{ color: colors.muted }}
                        >
                            {aiOriginDescription(current.provenance)} · Layer{' '}
                            {current.layerName || DEFAULT_LAYER}
                        </div>
                        {measurement && (
                            <div data-testid="annotation-review-measurement">
                                {formatMeasurement(measurement)}
                            </div>
                        )}
                        {current.note && (
                            <div
                                data-testid="annotation-review-note"
                                style={{
                                    marginTop: 2,
                                    fontStyle: 'italic',
                                    whiteSpace: 'pre-wrap',
                                    overflowWrap: 'anywhere',
                                    maxHeight: 64,
                                    overflowY: 'auto',
                                }}
                            >
                                {current.note}
                            </div>
                        )}
                        <div
                            role="group"
                            aria-label="Review decision"
                            style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 4,
                                marginTop: 8,
                            }}
                        >
                            <button
                                type="button"
                                data-review-primary
                                data-testid="annotation-review-accept"
                                aria-keyshortcuts="A Enter"
                                aria-disabled={busy}
                                onClick={run(() =>
                                    controller.reviewDecide('accept')
                                )}
                                style={{
                                    ...buttonStyle(colors.accept, busy),
                                    background: colors.accept,
                                    color: '#fff',
                                }}
                            >
                                Accept<kbd style={kbdStyle}>A</kbd>
                            </button>
                            <button
                                type="button"
                                data-testid="annotation-review-reject"
                                aria-keyshortcuts={armed ? 'X Enter' : 'X'}
                                aria-disabled={busy}
                                aria-describedby={rejectHelpId}
                                onClick={run(() => controller.reviewReject())}
                                style={
                                    armed
                                        ? {
                                              ...buttonStyle(
                                                  colors.reject,
                                                  busy
                                              ),
                                              background: colors.reject,
                                              color: '#fff',
                                          }
                                        : buttonStyle(colors.reject, busy)
                                }
                            >
                                {armed ? 'Confirm reject' : 'Reject'}
                                <kbd style={kbdStyle}>X</kbd>
                            </button>
                            {armed && (
                                <button
                                    type="button"
                                    data-testid="annotation-review-reject-cancel"
                                    aria-keyshortcuts="Escape"
                                    onClick={controller.cancelReject}
                                    style={buttonStyle(colors.text, busy)}
                                >
                                    Cancel
                                </button>
                            )}
                            <button
                                type="button"
                                data-testid="annotation-review-skip"
                                aria-keyshortcuts="S ArrowRight"
                                aria-disabled={busy}
                                title="Skip: leave it unreviewed for now"
                                onClick={run(() => controller.reviewStep(1))}
                                style={buttonStyle(colors.text, busy)}
                            >
                                Skip<kbd style={kbdStyle}>S</kbd>
                            </button>
                            <button
                                type="button"
                                data-testid="annotation-review-previous"
                                aria-keyshortcuts="ArrowLeft"
                                aria-label="Previous (←)"
                                title="Previous annotation to review (←)"
                                aria-disabled={busy}
                                onClick={run(() => controller.reviewStep(-1))}
                                style={buttonStyle(colors.text, busy)}
                            >
                                ←
                            </button>
                        </div>
                        <div
                            id={rejectHelpId}
                            data-testid="annotation-review-reject-help"
                            role={armed ? 'alert' : undefined}
                            style={{
                                marginTop: 4,
                                fontSize: 12,
                                color: armed ? colors.reject : colors.muted,
                            }}
                        >
                            {armed
                                ? `Reject "${label}"? ${rejectConsequence}. Press X or Enter to confirm, Esc to cancel.`
                                : `Reject asks first: ${rejectConsequence.toLowerCase()}.`}
                        </div>
                    </>
                ) : (
                    <div data-testid="annotation-review-done">
                        <div style={{ marginBottom: 6 }}>
                            {doneMessage(controller)}
                        </div>
                        <button
                            type="button"
                            data-review-primary
                            data-testid="annotation-review-finish"
                            onClick={controller.exitReview}
                            style={{
                                ...buttonStyle(colors.primary, false),
                                background: colors.primary,
                                color: '#fff',
                            }}
                        >
                            Done
                        </button>
                    </div>
                )}
                <div
                    role="status"
                    data-testid="annotation-review-message"
                    style={{
                        marginTop: queue.message ? 6 : 0,
                        color: colors.text,
                    }}
                >
                    {queue.message}
                </div>
                <div
                    data-testid="annotation-review-keys"
                    style={{ marginTop: 6, color: colors.muted, fontSize: 11 }}
                >
                    Keys while reviewing: A or Enter accept, X reject (X or
                    Enter again to confirm, Esc to cancel), S or → skip, ←
                    previous, Esc exit. They come before the tool shortcuts
                    until you exit.
                </div>
            </div>
        );
    }
);

/** The review card while the AI review queue is open. */
export const WsiAnnotationReviewCard = observer(
    ({ controller }: { controller: WsiAnnotationController }) =>
        controller.reviewQueue ? <ReviewCard controller={controller} /> : null
);

/** "Review AI (N)": opens the AI review queue, or says why it cannot. */
export const ReviewQueueButton = observer(
    ({
        controller,
        style,
    }: {
        controller: WsiAnnotationController;
        style?: React.CSSProperties;
    }) => {
        const unavailable = controller.reviewUnavailable;
        const count = unavailable
            ? controller.unreviewedAiCount
            : controller.reviewableAi.length;
        const open = !!controller.reviewQueue;
        return (
            <button
                type="button"
                data-testid="annotation-review-start"
                aria-disabled={!!unavailable}
                aria-pressed={open}
                title={
                    unavailable ||
                    'Step through the unreviewed AI annotations: A accepts, X rejects (asks first), S skips'
                }
                onClick={() => {
                    if (!unavailable && !open) controller.startReview();
                }}
                style={{
                    fontSize: 11,
                    padding: '1px 8px',
                    borderRadius: 3,
                    border: `1px ${unavailable ? 'dashed' : 'solid'} ${
                        colors.primary
                    }`,
                    background: open ? colors.primary : '#fff',
                    color: open
                        ? '#fff'
                        : unavailable
                        ? colors.muted
                        : colors.primary,
                    cursor: unavailable ? 'default' : 'pointer',
                    whiteSpace: 'nowrap',
                    ...style,
                }}
            >
                Review AI ({count})
            </button>
        );
    }
);
