import * as React from 'react';
import { observer } from 'mobx-react';
import { WsiAnnotationController } from './wsiAnnotationController';
import { WsiShapeOperation } from './wsiAnnotationBody';
import { AnnotationLabelField } from './wsiAnnotationControls';

// Text keeps at least 4.5:1 contrast on the bar's near-white.
const colors = {
    accept: '#2a7a2a',
    border: '#cfcfcf',
    muted: '#595959',
    primary: '#1f6fbf',
    reject: '#c0392b',
    text: '#222',
} as const;

function buttonStyle(color: string = colors.text): React.CSSProperties {
    return {
        fontSize: 11,
        height: 22,
        padding: '0 7px',
        borderRadius: 3,
        border: `1px solid ${color === colors.text ? colors.border : color}`,
        background: '#fff',
        color,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
    };
}

const fieldStyle: React.CSSProperties = {
    fontSize: 11,
    height: 22,
    maxWidth: 140,
};

/** "3 of 5" when only some of the selection apply, else the count. */
function applies(n: number, of: number) {
    return n === of ? `${n}` : `${n} of ${of}`;
}

/** The shape operations in the selection bar's menu, in order. */
const SHAPE_OPERATIONS: WsiShapeOperation[] = [
    'merge',
    'subtract',
    'intersect',
    'cut',
    'split',
    'separate',
];

/**
 * Bulk actions on the selected annotations, under the toolbar while any are
 * selected: relabel, move to a layer and sharing for the user's own
 * annotations, shape edits of the selected regions (merge, subtract,
 * intersect, cut a hole, split, separate parts), accept and reject for
 * unreviewed AI ones, and delete. Each names how many it applies to; what
 * was done and skipped is a status.
 */
export const WsiAnnotationBulkBar = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const [label, setLabel] = React.useState('');
        const selected = controller.selectedAnnotations;
        const message = controller.bulkMessage;
        if (!selected.length && !message) return null;
        const n = selected.length;
        const { modifiable, reviewable, ai } = controller.bulkCounts;
        const shapeOps = controller.shapeOps;
        const regions = controller.selectedRegions.length;
        const hint = controller.shapeEditHint;
        const busy = controller.bulkBusy || !controller.canEdit;
        const notYours =
            modifiable < n
                ? ` (${n - modifiable} not yours ${
                      n - modifiable === 1 ? 'is' : 'are'
                  } skipped)`
                : '';
        const editTitle = (what: string) =>
            modifiable
                ? `${what} ${applies(modifiable, n)} selected${notYours}`
                : 'None of the selected annotations are yours';
        const relabel = () => {
            void controller.bulkRelabel(label).then(result => {
                if (result) setLabel('');
            });
        };
        return (
            <div
                role="group"
                aria-label="Selected annotations"
                data-testid="annotation-bulk-bar"
                style={{
                    flexBasis: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 6,
                    padding: '4px 6px',
                    borderTop: `1px solid ${colors.border}`,
                    fontSize: 11,
                }}
            >
                {n > 0 && (
                    <>
                        <strong
                            role="status"
                            data-testid="annotation-bulk-count"
                            style={{ whiteSpace: 'nowrap' }}
                        >
                            {n} selected
                        </strong>
                        <span
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 3,
                            }}
                        >
                            <AnnotationLabelField
                                controller={controller}
                                value={label}
                                onChange={setLabel}
                                ariaLabel="New label for the selected annotations"
                                testId="annotation-bulk-label"
                                placeholder="New label"
                                allowEmpty
                                onKeyDown={event => {
                                    if (event.key === 'Enter') relabel();
                                }}
                                style={fieldStyle}
                            />
                            <button
                                type="button"
                                data-testid="annotation-bulk-relabel"
                                disabled={busy || !modifiable || !label.trim()}
                                title={editTitle('Relabel')}
                                onClick={relabel}
                                style={buttonStyle()}
                            >
                                Relabel ({modifiable})
                            </button>
                        </span>
                        <select
                            data-testid="annotation-bulk-layer"
                            aria-label="Move the selected annotations to a layer"
                            title={editTitle('Move')}
                            disabled={busy || !modifiable}
                            value=""
                            onChange={event => {
                                if (event.target.value) {
                                    void controller.bulkMoveToLayer(
                                        event.target.value
                                    );
                                }
                            }}
                            style={fieldStyle}
                        >
                            <option value="">Move to layer…</option>
                            {controller.layerNames.map(layer => (
                                <option key={layer} value={layer}>
                                    {layer}
                                </option>
                            ))}
                        </select>
                        <select
                            data-testid="annotation-bulk-sharing"
                            aria-label="Share the selected annotations or make them private"
                            title={editTitle('Set the sharing of')}
                            disabled={busy || !modifiable}
                            value=""
                            onChange={event => {
                                if (event.target.value) {
                                    void controller.bulkSetShared(
                                        event.target.value === 'shared'
                                    );
                                }
                            }}
                            style={fieldStyle}
                        >
                            <option value="">Sharing…</option>
                            <option value="shared">
                                Shared with the study
                            </option>
                            <option value="private">Private</option>
                        </select>
                        {regions > 0 && (
                            <select
                                data-testid="annotation-bulk-shape"
                                aria-label="Edit the shapes of the selected regions"
                                title="Merge, subtract, intersect, cut a hole, split or separate the selected regions; the results are yours"
                                disabled={busy}
                                value=""
                                onChange={event => {
                                    const operation = event.target
                                        .value as WsiShapeOperation;
                                    if (operation) {
                                        void controller.runShapeOp(operation);
                                    }
                                }}
                                style={fieldStyle}
                            >
                                <option value="">Edit shapes…</option>
                                {SHAPE_OPERATIONS.map(operation => (
                                    <option
                                        key={operation}
                                        value={operation}
                                        disabled={!shapeOps[operation].enabled}
                                        title={shapeOps[operation].title}
                                        data-testid={`annotation-shape-op-${operation}`}
                                    >
                                        {shapeOps[operation].text}
                                    </option>
                                ))}
                            </select>
                        )}
                        {ai > 0 && (
                            <>
                                <button
                                    type="button"
                                    data-testid="annotation-bulk-accept"
                                    disabled={busy || !reviewable}
                                    title={
                                        reviewable
                                            ? `Accept ${applies(
                                                  reviewable,
                                                  n
                                              )} selected unreviewed AI annotations`
                                            : 'None of the selected are unreviewed AI annotations you can review'
                                    }
                                    onClick={() =>
                                        void controller.bulkReview('accept')
                                    }
                                    style={buttonStyle(colors.accept)}
                                >
                                    Accept ({reviewable})
                                </button>
                                <button
                                    type="button"
                                    data-testid="annotation-bulk-reject"
                                    disabled={busy || !reviewable}
                                    title={
                                        reviewable
                                            ? `Reject ${applies(
                                                  reviewable,
                                                  n
                                              )} selected unreviewed AI annotations`
                                            : 'None of the selected are unreviewed AI annotations you can review'
                                    }
                                    onClick={() =>
                                        void controller.bulkReview('reject')
                                    }
                                    style={buttonStyle(colors.reject)}
                                >
                                    Reject ({reviewable})
                                </button>
                            </>
                        )}
                        <button
                            type="button"
                            data-testid="annotation-bulk-delete"
                            disabled={busy || !modifiable}
                            title={editTitle('Delete')}
                            onClick={() => {
                                if (
                                    window.confirm(
                                        `Delete ${modifiable} annotation${
                                            modifiable === 1 ? '' : 's'
                                        }?${notYours} Undo can bring ${
                                            modifiable === 1 ? 'it' : 'them'
                                        } back.`
                                    )
                                ) {
                                    void controller.bulkDelete();
                                }
                            }}
                            style={buttonStyle(colors.reject)}
                        >
                            Delete ({modifiable})
                        </button>
                        <button
                            type="button"
                            data-testid="annotation-bulk-clear"
                            aria-label="Clear the selection (Esc)"
                            title="Clear the selection (Esc)"
                            onClick={controller.clearSelection}
                            style={{
                                ...buttonStyle(colors.muted),
                                border: 'none',
                                fontSize: 14,
                            }}
                        >
                            ×
                        </button>
                    </>
                )}
                {hint && (
                    <span
                        data-testid="annotation-shape-edit-hint"
                        style={{
                            flexBasis: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            color: colors.primary,
                            fontWeight: 600,
                        }}
                    >
                        <span role="status">{hint}</span>
                        <button
                            type="button"
                            data-testid="annotation-shape-edit-done"
                            onClick={controller.stopShapeEdit}
                            style={buttonStyle(colors.primary)}
                        >
                            Done
                        </button>
                    </span>
                )}
                {n === 0 && (
                    <button
                        type="button"
                        data-testid="annotation-bulk-dismiss"
                        onClick={controller.dismissBulkMessage}
                        style={buttonStyle()}
                    >
                        Dismiss
                    </button>
                )}
                <span
                    role="status"
                    data-testid="annotation-bulk-message"
                    style={{ color: colors.text, flexBasis: '100%' }}
                >
                    {controller.bulkBusy ? 'Saving…' : message}
                </span>
            </div>
        );
    }
);
