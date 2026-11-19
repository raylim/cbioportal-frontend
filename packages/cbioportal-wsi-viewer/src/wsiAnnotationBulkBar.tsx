import * as React from 'react';
import { observer } from 'mobx-react';
import {
    rejectConfirmation,
    WsiAnnotationController,
} from './wsiAnnotationController';
import { WsiShapeOperation } from './wsiAnnotationBody';
import { AnnotationLabelField } from './wsiAnnotationControls';
import {
    Menu,
    MenuNote,
    menuItemStyle,
    MenuSeparator,
    SubMenu,
} from './wsiMenu';

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
 * Asks before a merge would delete originals with comments; resolves to
 * whether to go on (at once when none has comments).
 */
async function confirmMerge(
    controller: WsiAnnotationController
): Promise<boolean> {
    const warning = await controller.threadLossWarning(
        controller.mergeDeletes,
        'Merging'
    );
    return (
        !warning ||
        window.confirm(
            `Merge the selected regions? Your originals are deleted: ${warning}`
        )
    );
}

/** What the Actions menu says of undo, item by item. */
const UNDOABLE = 'Ctrl+Z undoes';
const FINAL = "Can't be undone";

/** One item of the Actions menu or of one of its submenus. */
function ActionItem({
    testId,
    label,
    disabled,
    title,
    note,
    color,
    onPick,
    onFocus,
}: {
    testId: string;
    label: React.ReactNode;
    disabled?: boolean;
    title?: string;
    note?: string;
    color?: string;
    onPick: () => void;
    onFocus?: () => void;
}) {
    return (
        <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid={testId}
            disabled={disabled}
            aria-disabled={disabled || undefined}
            title={title}
            onFocus={onFocus}
            onClick={() => {
                if (!disabled) onPick();
            }}
            style={{
                ...menuItemStyle(),
                color: color || menuItemStyle().color,
                opacity: disabled ? 0.55 : 1,
                cursor: disabled ? 'default' : 'pointer',
            }}
        >
            <span style={{ flex: 1 }}>{label}</span>
            {note && <MenuNote>{note}</MenuNote>}
        </button>
    );
}

/**
 * Bulk actions on the selected annotations, under the toolbar while any are
 * selected: "N selected" and one **Actions ▾** menu, whose items name how
 * many they apply to and whether Ctrl+Z undoes them: Relabel… (a field
 * in the bar), Move to layer ▸, Sharing ▸ and Edit shapes ▸ (submenus),
 * Accept, Reject… and Delete… (both ask first), and Clear selection.
 * Relabel, move, sharing, shape edits, delete and a review undo as one
 * step (a review only where the service can reset reviews). What was done
 * and skipped is a status.
 */
export const WsiAnnotationBulkBar = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const [label, setLabel] = React.useState('');
        const [relabeling, setRelabeling] = React.useState(false);
        const [open, setOpen] = React.useState(false);
        const [sub, setSub] = React.useState<string | null>(null);
        const button = React.useRef<HTMLButtonElement>(null);
        const anchor = React.useRef<HTMLSpanElement>(null);
        const close = React.useCallback((returnFocus: boolean) => {
            setOpen(false);
            setSub(null);
            if (returnFocus) button.current?.focus();
        }, []);
        const selected = controller.selectedAnnotations;
        const message = controller.bulkMessage;
        React.useEffect(() => {
            if (!selected.length) setRelabeling(false);
        }, [selected.length]);
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
        const reviewTitle = (what: string) =>
            reviewable
                ? `${what} ${applies(
                      reviewable,
                      n
                  )} selected unreviewed AI annotations`
                : 'None of the selected are unreviewed AI annotations you can review';
        const relabel = () => {
            void controller.bulkRelabel(label).then(result => {
                if (result) {
                    setLabel('');
                    setRelabeling(false);
                }
            });
        };
        /** Runs a pick: the menu closes first, focus back on Actions. */
        const pick = (run: () => void) => () => {
            close(true);
            run();
        };
        const subProps = (key: string) => ({
            open: sub === key,
            onOpen: (show: boolean) => setSub(show ? key : null),
            onItemFocus: () => {
                if (sub !== key) setSub(null);
            },
        });
        // Moving to another item of the top menu closes an open submenu.
        const closeSub = () => setSub(null);
        const reject = () => {
            if (
                window.confirm(
                    rejectConfirmation(
                        `${reviewable} AI annotation${
                            reviewable === 1 ? '' : 's'
                        }`,
                        reviewable,
                        controller.reviewRoute === false,
                        controller.reviewsUndoable
                    )
                )
            ) {
                void controller.bulkReview('reject');
            }
        };
        const remove = async () => {
            const warning = await controller.threadLossWarning(
                selected.filter(item => controller.canModify(item)),
                'Deleting'
            );
            if (
                window.confirm(
                    `Delete ${modifiable} annotation${
                        modifiable === 1 ? '' : 's'
                    }?${notYours} ${warning ||
                        `Undo (Ctrl+Z) can bring ${
                            modifiable === 1 ? 'it' : 'them'
                        } back.`}`
                )
            ) {
                await controller.bulkDelete();
            }
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
                        <span ref={anchor} style={{ position: 'relative' }}>
                            <button
                                type="button"
                                ref={button}
                                data-testid="annotation-bulk-actions"
                                aria-haspopup="menu"
                                aria-expanded={open}
                                title="Relabel, move, share, edit the shapes of, review or delete the selected annotations"
                                disabled={busy}
                                onClick={() => {
                                    setSub(null);
                                    setOpen(!open);
                                }}
                                onKeyDown={event => {
                                    if (event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        setOpen(true);
                                    }
                                }}
                                style={buttonStyle(colors.primary)}
                            >
                                Actions <span aria-hidden="true">▾</span>
                            </button>
                            <Menu
                                open={open && !busy}
                                label="Actions on the selected annotations"
                                testId="annotation-bulk-actions-menu"
                                anchor={anchor}
                                onClose={close}
                            >
                                <ActionItem
                                    testId="annotation-bulk-relabel-start"
                                    onFocus={closeSub}
                                    label={`Relabel ${modifiable}…`}
                                    disabled={!modifiable}
                                    title={editTitle('Relabel')}
                                    note={UNDOABLE}
                                    onPick={pick(() => setRelabeling(true))}
                                />
                                <SubMenu
                                    testId="annotation-bulk-layer"
                                    label={`Move ${modifiable} to layer`}
                                    disabled={!modifiable}
                                    title={editTitle('Move')}
                                    note={UNDOABLE}
                                    {...subProps('layer')}
                                >
                                    {controller.layerNames.map(layer => (
                                        <ActionItem
                                            key={layer}
                                            testId={`annotation-bulk-layer-${layer}`}
                                            label={layer}
                                            onPick={pick(
                                                () =>
                                                    void controller.bulkMoveToLayer(
                                                        layer
                                                    )
                                            )}
                                        />
                                    ))}
                                </SubMenu>
                                <SubMenu
                                    testId="annotation-bulk-sharing"
                                    label={`Sharing of ${modifiable}`}
                                    disabled={!modifiable}
                                    title={editTitle('Set the sharing of')}
                                    note={UNDOABLE}
                                    {...subProps('sharing')}
                                >
                                    <ActionItem
                                        testId="annotation-bulk-sharing-shared"
                                        label="Shared with the study"
                                        onPick={pick(
                                            () =>
                                                void controller.bulkSetShared(
                                                    true
                                                )
                                        )}
                                    />
                                    <ActionItem
                                        testId="annotation-bulk-sharing-private"
                                        label="Private"
                                        onPick={pick(
                                            () =>
                                                void controller.bulkSetShared(
                                                    false
                                                )
                                        )}
                                    />
                                </SubMenu>
                                <SubMenu
                                    testId="annotation-bulk-shape"
                                    label="Edit shapes"
                                    disabled={!regions}
                                    title={
                                        regions
                                            ? 'Merge, subtract, intersect, cut a hole, split or separate the selected regions; the results are yours'
                                            : 'Select regions (rectangles, ellipses, circles or polygons) to edit their shapes'
                                    }
                                    note={UNDOABLE}
                                    {...subProps('shape')}
                                >
                                    {SHAPE_OPERATIONS.map(operation => (
                                        <ActionItem
                                            key={operation}
                                            testId={`annotation-shape-op-${operation}`}
                                            label={shapeOps[operation].text}
                                            disabled={
                                                !shapeOps[operation].enabled
                                            }
                                            title={shapeOps[operation].title}
                                            onPick={pick(
                                                () =>
                                                    void (async () => {
                                                        if (
                                                            operation ===
                                                                'merge' &&
                                                            !(await confirmMerge(
                                                                controller
                                                            ))
                                                        ) {
                                                            return;
                                                        }
                                                        await controller.runShapeOp(
                                                            operation
                                                        );
                                                    })()
                                            )}
                                        />
                                    ))}
                                </SubMenu>
                                {ai > 0 && <MenuSeparator />}
                                {ai > 0 && (
                                    <ActionItem
                                        testId="annotation-bulk-accept"
                                        onFocus={closeSub}
                                        label={`Accept ${reviewable}`}
                                        color={colors.accept}
                                        disabled={!reviewable}
                                        title={reviewTitle('Accept')}
                                        note={
                                            controller.reviewsUndoable
                                                ? UNDOABLE
                                                : FINAL
                                        }
                                        onPick={pick(
                                            () =>
                                                void controller.bulkReview(
                                                    'accept'
                                                )
                                        )}
                                    />
                                )}
                                {ai > 0 && (
                                    <ActionItem
                                        testId="annotation-bulk-reject"
                                        onFocus={closeSub}
                                        label={`Reject ${reviewable}…`}
                                        color={colors.reject}
                                        disabled={!reviewable}
                                        title={`${reviewTitle(
                                            'Reject'
                                        )} (asks first)`}
                                        note={
                                            controller.reviewsUndoable
                                                ? UNDOABLE
                                                : FINAL
                                        }
                                        onPick={pick(reject)}
                                    />
                                )}
                                <MenuSeparator />
                                <ActionItem
                                    testId="annotation-bulk-delete"
                                    onFocus={closeSub}
                                    label={`Delete ${modifiable}…`}
                                    color={colors.reject}
                                    disabled={!modifiable}
                                    title={`${editTitle(
                                        'Delete'
                                    )} (asks first)`}
                                    note={UNDOABLE}
                                    onPick={pick(() => void remove())}
                                />
                                <ActionItem
                                    testId="annotation-bulk-clear"
                                    onFocus={closeSub}
                                    label="Clear selection"
                                    note="Esc"
                                    onPick={pick(controller.clearSelection)}
                                />
                            </Menu>
                        </span>
                        {relabeling && (
                            <span
                                role="group"
                                aria-label="Relabel the selected annotations"
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
                                    autoFocus
                                    onKeyDown={event => {
                                        if (event.key === 'Enter') relabel();
                                        if (event.key === 'Escape') {
                                            event.preventDefault();
                                            setRelabeling(false);
                                            button.current?.focus();
                                        }
                                    }}
                                    style={fieldStyle}
                                />
                                <button
                                    type="button"
                                    data-testid="annotation-bulk-relabel"
                                    disabled={
                                        busy || !modifiable || !label.trim()
                                    }
                                    title={editTitle('Relabel')}
                                    onClick={relabel}
                                    style={buttonStyle()}
                                >
                                    Relabel {modifiable}
                                </button>
                                <button
                                    type="button"
                                    data-testid="annotation-bulk-relabel-cancel"
                                    onClick={() => setRelabeling(false)}
                                    style={{
                                        ...buttonStyle(colors.muted),
                                        border: 'none',
                                    }}
                                >
                                    Cancel
                                </button>
                            </span>
                        )}
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
                {!controller.bulkBusy && message && controller.bulkUndo && (
                    <span
                        data-testid="annotation-bulk-undo-note"
                        style={{ color: colors.muted, flexBasis: '100%' }}
                    >
                        {controller.bulkUndo === 'undoable'
                            ? `${controller.undoLabel ||
                                  'Undo'} with Ctrl+Z or the toolbar's Undo.`
                            : "Reviews can't be undone."}
                    </span>
                )}
            </div>
        );
    }
);
