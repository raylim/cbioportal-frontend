import * as React from 'react';
import { observer } from 'mobx-react';
import {
    COMMENT_MAX_LENGTH,
    WsiAnnotationController,
    WsiComment,
} from './wsiAnnotationController';
import { WsiAnnotation } from './wsiViewerTypes';

// Text colors keep at least 4.5:1 contrast on the panel's white.
const colors = {
    blue: '#1f6fbf',
    border: '#ddd',
    error: '#a00',
    muted: '#737373',
    text: '#333',
} as const;

/** A date and time as the user reads them, or the text as stored. */
export function formatCommentTime(value: string): string {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

const linkButtonStyle: React.CSSProperties = {
    border: 'none',
    background: 'transparent',
    color: colors.blue,
    fontSize: 10,
    padding: 0,
    cursor: 'pointer',
};

function smallButtonStyle(primary = false): React.CSSProperties {
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
 * A text area for a comment: Ctrl/Cmd+Enter saves, Escape cancels, and a
 * count shows near the 4,000-character limit.
 */
function CommentEditor({
    label,
    testId,
    initial,
    saveLabel,
    busy,
    autoFocus,
    onSave,
    onCancel,
    editorRef,
}: {
    label: string;
    testId: string;
    initial: string;
    saveLabel: string;
    busy: boolean;
    autoFocus?: boolean;
    onSave: (text: string) => Promise<boolean>;
    onCancel?: () => void;
    editorRef?: React.RefObject<HTMLTextAreaElement>;
}) {
    const [text, setText] = React.useState(initial);
    const own = React.useRef<HTMLTextAreaElement>(null);
    const ref = editorRef || own;
    const empty = !text.trim();
    const save = async () => {
        if (empty || busy) return;
        if (await onSave(text)) {
            setText('');
            ref.current?.focus();
        }
    };
    return (
        <div style={{ marginTop: 3 }}>
            <textarea
                ref={ref}
                data-testid={testId}
                aria-label={label}
                autoFocus={autoFocus}
                rows={2}
                value={text}
                maxLength={COMMENT_MAX_LENGTH}
                onChange={event => setText(event.target.value)}
                onKeyDown={event => {
                    if (
                        event.key === 'Enter' &&
                        (event.ctrlKey || event.metaKey)
                    ) {
                        event.preventDefault();
                        void save();
                    }
                    if (event.key === 'Escape' && onCancel) {
                        event.stopPropagation();
                        onCancel();
                    }
                }}
                style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    fontSize: 11,
                    resize: 'vertical',
                }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                    type="button"
                    data-testid={`${testId}-save`}
                    disabled={empty || busy}
                    aria-disabled={empty || busy}
                    onClick={() => void save()}
                    style={{
                        ...smallButtonStyle(true),
                        opacity: empty || busy ? 0.6 : 1,
                    }}
                >
                    {saveLabel}
                </button>
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        style={smallButtonStyle()}
                    >
                        Cancel
                    </button>
                )}
                {text.length > COMMENT_MAX_LENGTH - 500 && (
                    <span style={{ fontSize: 10, color: colors.muted }}>
                        {text.length.toLocaleString('en-US')} /{' '}
                        {COMMENT_MAX_LENGTH.toLocaleString('en-US')}
                    </span>
                )}
            </div>
        </div>
    );
}

/** One comment: its author, time and text, and edit and delete for its author. */
const CommentItem = observer(
    ({
        controller,
        annotationId,
        comment,
        busy,
        onDeleted,
    }: {
        controller: WsiAnnotationController;
        annotationId: string;
        comment: WsiComment;
        busy: boolean;
        onDeleted: () => void;
    }) => {
        const [editing, setEditing] = React.useState(false);
        const editButton = React.useRef<HTMLButtonElement>(null);
        const mine = controller.canChangeComment(comment);
        const edited = comment.updated && comment.updated !== comment.created;
        return (
            <li
                data-testid={`annotation-comment-${comment.id}`}
                style={{
                    listStyle: 'none',
                    padding: '3px 0',
                    borderTop: `1px solid ${colors.border}`,
                }}
            >
                <div style={{ fontSize: 10, color: colors.muted }}>
                    <strong style={{ color: colors.text }}>
                        {comment.author}
                    </strong>{' '}
                    {formatCommentTime(comment.created)}
                    {edited && ' (edited)'}
                </div>
                {editing ? (
                    <CommentEditor
                        label={`Edit your comment`}
                        testId={`annotation-comment-edit-input-${comment.id}`}
                        initial={comment.body}
                        saveLabel="Save"
                        busy={busy}
                        autoFocus
                        onSave={async text => {
                            const saved = await controller.editComment(
                                annotationId,
                                comment.id,
                                text
                            );
                            if (saved) {
                                setEditing(false);
                                // The button is back once the editor goes.
                                setTimeout(() => editButton.current?.focus());
                            }
                            return saved;
                        }}
                        onCancel={() => {
                            setEditing(false);
                            setTimeout(() => editButton.current?.focus());
                        }}
                    />
                ) : (
                    <div
                        data-testid={`annotation-comment-body-${comment.id}`}
                        style={{
                            fontSize: 11,
                            color: colors.text,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                        }}
                    >
                        {comment.body}
                    </div>
                )}
                {mine && !editing && (
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            type="button"
                            ref={editButton}
                            data-testid={`annotation-comment-edit-${comment.id}`}
                            aria-label={`Edit your comment from ${formatCommentTime(
                                comment.created
                            )}`}
                            onClick={() => setEditing(true)}
                            style={linkButtonStyle}
                        >
                            Edit
                        </button>
                        <button
                            type="button"
                            data-testid={`annotation-comment-delete-${comment.id}`}
                            aria-label={`Delete your comment from ${formatCommentTime(
                                comment.created
                            )}`}
                            disabled={busy}
                            onClick={async () => {
                                if (!window.confirm('Delete your comment?')) {
                                    return;
                                }
                                if (
                                    await controller.deleteComment(
                                        annotationId,
                                        comment.id
                                    )
                                ) {
                                    onDeleted();
                                }
                            }}
                            style={{ ...linkButtonStyle, color: '#b02a1e' }}
                        >
                            Delete
                        </button>
                    </div>
                )}
            </li>
        );
    }
);

let threadCount = 0;

/**
 * An annotation's comment thread, separate from its note: a "Comments (N)"
 * disclosure that loads the thread, lists it oldest first, and lets users
 * who can edit in the study add a comment and edit or delete their own.
 * Shown only when the service has threads.
 */
export const AnnotationThread = observer(
    ({
        controller,
        annotation,
        name,
    }: {
        controller: WsiAnnotationController;
        annotation: WsiAnnotation;
        name: string;
    }) => {
        const [open, setOpen] = React.useState(false);
        const regionId = React.useRef('');
        if (!regionId.current) {
            regionId.current = `wsi-annotation-thread-${++threadCount}`;
        }
        const composer = React.useRef<HTMLTextAreaElement>(null);
        const region = React.useRef<HTMLDivElement>(null);
        if (
            !controller.commentsAvailable ||
            annotation.unsaved ||
            annotation.id.startsWith('client-')
        ) {
            return null;
        }
        const count = controller.commentCountOf(annotation);
        const thread = controller.threads.get(annotation.id);
        const toggle = () => {
            const next = !open;
            setOpen(next);
            if (next) {
                void controller.loadComments(annotation.id);
                setTimeout(() => (composer.current || region.current)?.focus());
            }
        };
        return (
            <div style={{ marginTop: 2 }}>
                <button
                    type="button"
                    data-testid={`annotation-comments-toggle-${annotation.id}`}
                    aria-expanded={open}
                    aria-controls={regionId.current}
                    aria-label={`Comments on ${name}: ${count}`}
                    onClick={toggle}
                    style={{
                        ...linkButtonStyle,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                    }}
                >
                    Comments
                    <span
                        data-testid={`annotation-comment-count-${annotation.id}`}
                        style={{
                            minWidth: 14,
                            padding: '0 4px',
                            borderRadius: 7,
                            background: count ? colors.blue : '#e8e8e8',
                            color: count ? '#fff' : '#444',
                            fontSize: 9,
                            lineHeight: '14px',
                            textAlign: 'center',
                        }}
                    >
                        {count}
                    </span>
                    {open ? '▾' : '▸'}
                </button>
                {open && (
                    <div
                        ref={region}
                        id={regionId.current}
                        role="region"
                        aria-label={`Comments on ${name}`}
                        tabIndex={-1}
                        data-testid={`annotation-thread-${annotation.id}`}
                        style={{ marginTop: 2 }}
                    >
                        {thread?.error && (
                            <div
                                role="alert"
                                data-testid={`annotation-thread-error-${annotation.id}`}
                                style={{ color: colors.error, fontSize: 10 }}
                            >
                                {thread.error}{' '}
                                <button
                                    type="button"
                                    onClick={() =>
                                        controller.dismissThreadError(
                                            annotation.id
                                        )
                                    }
                                    style={smallButtonStyle()}
                                >
                                    Dismiss
                                </button>
                            </div>
                        )}
                        {thread?.loading && !thread.comments.length ? (
                            <div
                                role="status"
                                style={{ fontSize: 10, color: colors.muted }}
                            >
                                Loading comments…
                            </div>
                        ) : (
                            <ul style={{ margin: 0, padding: 0 }}>
                                {(thread?.comments || []).map(comment => (
                                    <CommentItem
                                        key={comment.id}
                                        controller={controller}
                                        annotationId={annotation.id}
                                        comment={comment}
                                        busy={!!thread?.busy}
                                        onDeleted={() =>
                                            (
                                                composer.current ||
                                                region.current
                                            )?.focus()
                                        }
                                    />
                                ))}
                                {typeof thread?.nextOffset === 'number' && (
                                    <li style={{ listStyle: 'none' }}>
                                        <button
                                            type="button"
                                            data-testid={`annotation-comments-more-${annotation.id}`}
                                            disabled={thread.loading}
                                            onClick={() =>
                                                void controller.loadMoreComments(
                                                    annotation.id
                                                )
                                            }
                                            style={smallButtonStyle()}
                                        >
                                            {thread.loading
                                                ? 'Loading…'
                                                : `Show more comments${
                                                      thread.total !== undefined
                                                          ? ` (${thread.total -
                                                                thread.comments
                                                                    .length} more)`
                                                          : ''
                                                  }`}
                                        </button>
                                    </li>
                                )}
                                {thread &&
                                    !thread.loading &&
                                    !thread.comments.length && (
                                        <li
                                            style={{
                                                listStyle: 'none',
                                                fontSize: 10,
                                                color: colors.muted,
                                            }}
                                        >
                                            No comments yet.
                                        </li>
                                    )}
                            </ul>
                        )}
                        {controller.canEdit && (
                            <CommentEditor
                                label={`Add a comment on ${name}`}
                                testId={`annotation-comment-input-${annotation.id}`}
                                initial=""
                                saveLabel="Comment"
                                busy={!!thread?.busy}
                                editorRef={composer}
                                onSave={text =>
                                    controller.addComment(annotation.id, text)
                                }
                            />
                        )}
                    </div>
                )}
            </div>
        );
    }
);
