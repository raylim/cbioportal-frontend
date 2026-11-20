import * as React from 'react';
import { observer } from 'mobx-react';
import { WsiAnnotationController } from './wsiAnnotationController';
import {
    addTag,
    normalizeTag,
    SLIDE_NOTE_MAX_LENGTH,
    SLIDE_NOTE_MAX_TAGS,
    WsiSlideNote,
    WsiSlideNoteDraft,
} from './wsiSlideNotes';

// Text colors keep at least 4.5:1 contrast on the panel's white.
const colors = {
    blue: '#1f6fbf',
    border: '#ddd',
    error: '#a00',
    muted: '#737373',
    text: '#333',
} as const;

function buttonStyle(primary = false): React.CSSProperties {
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

const linkStyle: React.CSSProperties = {
    border: 'none',
    background: 'transparent',
    color: colors.blue,
    fontSize: 10,
    padding: 0,
    cursor: 'pointer',
};

const chipStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: '0 5px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: '#f2f6fb',
    color: colors.text,
    fontSize: 10,
    lineHeight: '15px',
};

function formatTime(value: string): string {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

let fieldCount = 0;

function useFieldId(prefix: string): string {
    const ref = React.useRef('');
    if (!ref.current) ref.current = `${prefix}-${++fieldCount}`;
    return ref.current;
}

/**
 * Tags as chips with a field to add more: Enter or a comma adds what was
 * typed, Backspace in the empty field removes the last chip, and the
 * suggestions are the tags already used on the slide.
 */
function TagInput({
    tags,
    onChange,
    suggestions,
    testId,
}: {
    tags: string[];
    onChange: (tags: string[]) => void;
    suggestions: string[];
    testId: string;
}) {
    const [text, setText] = React.useState('');
    const [problem, setProblem] = React.useState<string | null>(null);
    const listId = useFieldId('wsi-slide-note-tags');
    const problemId = `${listId}-problem`;
    const add = (raw: string) => {
        if (!raw.trim()) return true;
        const tag = normalizeTag(raw);
        if (!tag) {
            setProblem(
                'A tag is 1–40 letters, digits, spaces or _-.:/+#, starting with a letter or digit.'
            );
            return false;
        }
        if (tags.length >= SLIDE_NOTE_MAX_TAGS) {
            setProblem(`A note has at most ${SLIDE_NOTE_MAX_TAGS} tags.`);
            return false;
        }
        setProblem(null);
        onChange(addTag(tags, tag));
        setText('');
        return true;
    };
    return (
        <div>
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 3,
                }}
            >
                {tags.map(tag => (
                    <span key={tag} style={chipStyle}>
                        {tag}
                        <button
                            type="button"
                            aria-label={`Remove tag ${tag}`}
                            onClick={() =>
                                onChange(tags.filter(item => item !== tag))
                            }
                            style={{
                                border: 'none',
                                background: 'transparent',
                                color: colors.muted,
                                padding: 0,
                                cursor: 'pointer',
                                fontSize: 11,
                                lineHeight: 1,
                            }}
                        >
                            ×
                        </button>
                    </span>
                ))}
                <input
                    data-testid={testId}
                    aria-label="Add a tag"
                    aria-describedby={problem ? problemId : undefined}
                    aria-invalid={!!problem}
                    list={listId}
                    value={text}
                    maxLength={60}
                    placeholder={tags.length ? 'Another tag' : 'Tags'}
                    onChange={event => {
                        const value = event.target.value;
                        if (value.endsWith(',')) add(value.slice(0, -1));
                        else setText(value);
                    }}
                    onKeyDown={event => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            add(text);
                        } else if (
                            event.key === 'Backspace' &&
                            !text &&
                            tags.length
                        ) {
                            onChange(tags.slice(0, -1));
                        }
                    }}
                    onBlur={() => {
                        if (text.trim()) add(text);
                    }}
                    style={{
                        flex: 1,
                        minWidth: 70,
                        fontSize: 11,
                        padding: '1px 4px',
                    }}
                />
                <datalist id={listId}>
                    {suggestions
                        .filter(tag => !tags.includes(tag))
                        .map(tag => (
                            <option key={tag} value={tag} />
                        ))}
                </datalist>
            </div>
            {problem && (
                <div
                    id={problemId}
                    role="alert"
                    style={{ color: colors.error, fontSize: 10 }}
                >
                    {problem}
                </div>
            )}
        </div>
    );
}

/** The form for a new note or an edit: text, tags and who sees it. */
function NoteForm({
    initial,
    suggestions,
    busy,
    submitLabel,
    testId,
    autoFocus,
    textRef,
    onSubmit,
    onCancel,
}: {
    initial: WsiSlideNoteDraft;
    suggestions: string[];
    busy: boolean;
    submitLabel: string;
    testId: string;
    autoFocus?: boolean;
    textRef?: React.RefObject<HTMLTextAreaElement>;
    onSubmit: (draft: WsiSlideNoteDraft) => Promise<boolean>;
    onCancel?: () => void;
}) {
    const [text, setText] = React.useState(initial.text);
    const [tags, setTags] = React.useState(initial.tags);
    const [shared, setShared] = React.useState(initial.shared);
    const own = React.useRef<HTMLTextAreaElement>(null);
    const ref = textRef || own;
    const empty = !text.trim() && !tags.length;
    const submit = async () => {
        if (empty || busy) return;
        if (await onSubmit({ text, tags, shared })) {
            setText('');
            setTags([]);
            ref.current?.focus();
        }
    };
    return (
        <div
            role="group"
            aria-label={submitLabel}
            data-testid={testId}
            style={{ display: 'grid', gap: 3, marginTop: 4 }}
            onKeyDown={event => {
                if (event.key === 'Escape' && onCancel) {
                    event.stopPropagation();
                    onCancel();
                }
            }}
        >
            <textarea
                ref={ref}
                data-testid={`${testId}-text`}
                aria-label="Slide note"
                autoFocus={autoFocus}
                rows={2}
                value={text}
                maxLength={SLIDE_NOTE_MAX_LENGTH}
                placeholder="A note on this slide"
                onChange={event => setText(event.target.value)}
                onKeyDown={event => {
                    if (
                        event.key === 'Enter' &&
                        (event.ctrlKey || event.metaKey)
                    ) {
                        event.preventDefault();
                        void submit();
                    }
                }}
                style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    fontSize: 11,
                    resize: 'vertical',
                }}
            />
            <TagInput
                tags={tags}
                onChange={setTags}
                suggestions={suggestions}
                testId={`${testId}-tags`}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <select
                    data-testid={`${testId}-sharing`}
                    aria-label="Who sees this note"
                    value={shared ? 'shared' : 'private'}
                    onChange={event =>
                        setShared(event.target.value === 'shared')
                    }
                    style={{ fontSize: 10, flex: 1, minWidth: 0 }}
                >
                    <option value="shared">Shared with the study</option>
                    <option value="private">Private (only you)</option>
                </select>
                <button
                    type="button"
                    data-testid={`${testId}-submit`}
                    disabled={empty || busy}
                    onClick={() => void submit()}
                    style={{
                        ...buttonStyle(true),
                        opacity: empty || busy ? 0.6 : 1,
                    }}
                >
                    {submitLabel}
                </button>
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        style={buttonStyle()}
                    >
                        Cancel
                    </button>
                )}
            </div>
        </div>
    );
}

/** One slide note: text, tags, author, time, sharing, and its controls. */
const NoteItem = observer(
    ({
        controller,
        note,
        onDeleted,
    }: {
        controller: WsiAnnotationController;
        note: WsiSlideNote;
        onDeleted: () => void;
    }) => {
        const notes = controller.slideNotes;
        const [editing, setEditing] = React.useState(false);
        const editButton = React.useRef<HTMLButtonElement>(null);
        const mine = notes.canChange(note);
        const edited = note.version > 1;
        return (
            <li
                data-testid={`slide-note-${note.id}`}
                style={{
                    listStyle: 'none',
                    padding: '4px 0',
                    borderBottom: `1px solid ${colors.border}`,
                }}
            >
                {editing ? (
                    <NoteForm
                        initial={{
                            text: note.text,
                            tags: note.tags,
                            shared: note.visibleTo !== null,
                        }}
                        suggestions={notes.tags.map(item => item.tag)}
                        busy={notes.busy}
                        submitLabel="Save note"
                        testId={`slide-note-edit-${note.id}`}
                        autoFocus
                        onSubmit={async draft => {
                            const saved = await notes.update(note, draft);
                            if (saved) {
                                setEditing(false);
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
                    <>
                        {note.text && (
                            <div
                                data-testid={`slide-note-text-${note.id}`}
                                style={{
                                    fontSize: 11,
                                    color: colors.text,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                }}
                            >
                                {note.text}
                            </div>
                        )}
                        {note.tags.length > 0 && (
                            <ul
                                aria-label="Tags"
                                data-testid={`slide-note-tags-${note.id}`}
                                style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: 3,
                                    margin: '2px 0',
                                    padding: 0,
                                }}
                            >
                                {note.tags.map(tag => (
                                    <li
                                        key={tag}
                                        style={{
                                            ...chipStyle,
                                            listStyle: 'none',
                                        }}
                                    >
                                        {tag}
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div
                            style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 6,
                                alignItems: 'center',
                                fontSize: 10,
                                color: colors.muted,
                            }}
                        >
                            <span>
                                {note.creator} · {formatTime(note.created)}
                                {edited ? ' (edited)' : ''}
                            </span>
                            <span data-testid={`slide-note-sharing-${note.id}`}>
                                <i
                                    aria-hidden="true"
                                    className={`fa ${
                                        note.visibleTo === null
                                            ? 'fa-lock'
                                            : 'fa-users'
                                    }`}
                                />{' '}
                                {note.visibleTo === null ? 'Private' : 'Shared'}
                            </span>
                            {mine && (
                                <>
                                    <button
                                        type="button"
                                        ref={editButton}
                                        data-testid={`slide-note-edit-button-${note.id}`}
                                        aria-label="Edit your slide note"
                                        onClick={() => setEditing(true)}
                                        style={linkStyle}
                                    >
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        data-testid={`slide-note-delete-${note.id}`}
                                        aria-label="Delete your slide note"
                                        disabled={notes.busy}
                                        onClick={async () => {
                                            if (
                                                !window.confirm(
                                                    'Delete your note on this slide?'
                                                )
                                            ) {
                                                return;
                                            }
                                            if (await notes.remove(note)) {
                                                onDeleted();
                                            }
                                        }}
                                        style={{
                                            ...linkStyle,
                                            color: '#b02a1e',
                                        }}
                                    >
                                        Delete
                                    </button>
                                </>
                            )}
                        </div>
                    </>
                )}
            </li>
        );
    }
);

/**
 * The sidebar's Slide notes: notes on the open slide with tags, the slide's
 * tags with how many notes carry each (a tag filters the notes), and a form
 * to add one, private or shared with the study. Users edit and delete only
 * their own. The notes load when the section first shows.
 */
export const WsiSlideNotesPanel = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const notes = controller.slideNotes;
        const addText = React.useRef<HTMLTextAreaElement>(null);
        const list = React.useRef<HTMLUListElement>(null);
        const slideKey = notes.slideKey;
        const resets = notes.resets;
        React.useEffect(() => {
            void notes.ensureLoaded();
        }, [notes, slideKey, resets]);
        if (notes.route === false) return null;
        const suggestions = notes.tags.map(item => item.tag);
        const shown = notes.shownNotes;
        return (
            <div data-testid="wsi-slide-notes" style={{ marginTop: 4 }}>
                {notes.error && (
                    <div
                        role="alert"
                        data-testid="slide-notes-error"
                        style={{ color: colors.error, fontSize: 11 }}
                    >
                        {notes.error}{' '}
                        <button
                            type="button"
                            onClick={notes.dismissError}
                            style={buttonStyle()}
                        >
                            Dismiss
                        </button>
                    </div>
                )}
                {notes.tags.length > 0 && (
                    <div
                        role="group"
                        aria-label="Tags on this slide"
                        data-testid="slide-notes-tag-summary"
                        style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 3,
                            margin: '2px 0 4px',
                        }}
                    >
                        {notes.tags.map(({ tag, count }) => {
                            const active = notes.tagFilter === tag;
                            return (
                                <button
                                    type="button"
                                    key={tag}
                                    data-testid={`slide-notes-tag-${tag}`}
                                    aria-pressed={active}
                                    aria-label={`Show only the ${count} note${
                                        count === 1 ? '' : 's'
                                    } tagged ${tag}`}
                                    onClick={() =>
                                        notes.setTagFilter(active ? null : tag)
                                    }
                                    style={{
                                        ...chipStyle,
                                        cursor: 'pointer',
                                        fontWeight: active ? 700 : 400,
                                        borderColor: active
                                            ? colors.text
                                            : colors.border,
                                    }}
                                >
                                    {tag} {count}
                                </button>
                            );
                        })}
                    </div>
                )}
                {notes.loading && !notes.notes.length ? (
                    <div
                        role="status"
                        style={{ color: colors.muted, fontSize: 11 }}
                    >
                        Loading…
                    </div>
                ) : (
                    <ul
                        ref={list}
                        aria-label="Slide notes"
                        data-testid="slide-notes-list"
                        tabIndex={-1}
                        style={{ margin: 0, padding: 0 }}
                    >
                        {shown.map(note => (
                            <NoteItem
                                key={note.id}
                                controller={controller}
                                note={note}
                                onDeleted={() =>
                                    (addText.current || list.current)?.focus()
                                }
                            />
                        ))}
                        {!shown.length && notes.nextOffset === null && (
                            <li
                                style={{
                                    listStyle: 'none',
                                    color: colors.muted,
                                    fontSize: 11,
                                }}
                            >
                                No notes on this slide yet.
                            </li>
                        )}
                    </ul>
                )}
                {notes.nextOffset !== null && (
                    <button
                        type="button"
                        data-testid="slide-notes-more"
                        disabled={notes.loading}
                        onClick={() => void notes.loadMore()}
                        style={{ ...buttonStyle(), marginTop: 2 }}
                    >
                        {notes.loading
                            ? 'Loading…'
                            : `Show more notes (${notes.count -
                                  notes.notes.length} more${
                                  notes.tagFilter
                                      ? '; the tag filter shows loaded notes only'
                                      : ''
                              })`}
                    </button>
                )}
                {controller.canEdit && (
                    <NoteForm
                        initial={{
                            text: '',
                            tags: notes.tagFilter ? [notes.tagFilter] : [],
                            shared: controller.defaultShared,
                        }}
                        suggestions={suggestions}
                        busy={notes.busy}
                        submitLabel="Add note"
                        testId="slide-note-new"
                        textRef={addText}
                        onSubmit={notes.create}
                    />
                )}
            </div>
        );
    }
);
