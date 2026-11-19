import { action, computed, makeObservable, observable } from 'mobx';

/** A note on a slide, with tags: attached to the slide, not to a shape. */
export interface WsiSlideNote {
    id: string;
    text: string;
    tags: string[];
    creator: string;
    /** null: private to its creator; []: shared with the study. */
    visibleTo: string[] | null;
    version: number;
    created: string;
    updated: string;
}

/** A tag and how many of the listed notes carry it. */
export interface WsiTagCount {
    tag: string;
    count: number;
}

/** What a slide note says, as the form edits it. */
export interface WsiSlideNoteDraft {
    text: string;
    tags: string[];
    shared: boolean;
}

/** The service's limits for a slide note. */
export const SLIDE_NOTE_MAX_LENGTH = 4000;
export const SLIDE_NOTE_MAX_TAGS = 20;
export const TAG_MAX_LENGTH = 40;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N}_ .:/+#-]*$/u;

/**
 * A tag as the service stores it: whitespace runs made one space, trimmed;
 * null when it is not a valid tag (1–40 letters, digits, spaces or
 * `_ - . : / + #`, starting with a letter or digit).
 */
export function normalizeTag(raw: string): string | null {
    const tag = raw
        .split(/\s+/)
        .filter(Boolean)
        .join(' ');
    return tag.length >= 1 && tag.length <= TAG_MAX_LENGTH && TAG_RE.test(tag)
        ? tag
        : null;
}

/** Adds `tag` to `tags` unless it is there in any letter case. */
export function addTag(tags: string[], tag: string): string[] {
    const key = tag.toLocaleLowerCase();
    return tags.some(item => item.toLocaleLowerCase() === key)
        ? tags
        : [...tags, tag];
}

/** Each tag on `notes` and how many carry it, most used first. */
export function tagSummary(notes: WsiSlideNote[]): WsiTagCount[] {
    const counts = new Map<string, number>();
    notes.forEach(note =>
        note.tags.forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1))
    );
    return Array.from(counts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort(
            (a, b) =>
                b.count - a.count ||
                a.tag
                    .toLocaleLowerCase()
                    .localeCompare(b.tag.toLocaleLowerCase())
        );
}

/** What the slide notes need from the annotation controller. */
export interface WsiSlideNotesHost {
    /** A service request, counted by the save status when it writes. */
    serviceRequest(
        path: string,
        init: RequestInit,
        signal: AbortSignal | undefined
    ): Promise<Response>;
    /** The open slide and what makes a request's answer still wanted. */
    requestContext(): {
        generation: number;
        slideKey: string | null;
        signal?: AbortSignal;
    };
    isCurrentContext(context: {
        generation: number;
        slideKey: string | null;
        signal?: AbortSignal;
    }): boolean;
    /** Records a 401/403 from the proxy; returns whether it was one. */
    refuseServiceAccess(response: Response): boolean;
    readonly serviceStudyId: string | undefined;
    readonly currentUser: string | null;
    readonly canEdit: boolean;
}

async function jsonDetail(response: Response): Promise<unknown> {
    try {
        return (await response.clone().json())?.detail;
    } catch (_) {
        return undefined;
    }
}

/**
 * The open slide's notes and tags (`/slide-notes`): loaded with the slide,
 * created, edited and deleted by their creator, private or shared with the
 * study. A service without the route (404 "Not Found" or 405) turns them
 * off for the session.
 */
export class WsiSlideNotes {
    /** Whether the service has slide notes; unknown until the first load. */
    @observable route: boolean | null = null;
    @observable loading = false;
    @observable.ref notes: WsiSlideNote[] = [];
    @observable error: string | null = null;
    /** A note is being saved. */
    @observable busy = false;
    /** Shows only the notes with this tag; null for all. */
    @observable tagFilter: string | null = null;
    /** The open slide, by its opaque key. */
    @observable slideKey: string | null = null;
    /** The slide whose notes were loaded, or are loading. */
    private loadedFor: string | null = null;
    /** Bumped when the notes are forgotten, so a shown section loads again. */
    @observable resets = 0;

    constructor(private readonly host: WsiSlideNotesHost) {
        makeObservable(this);
    }

    /** Each tag on the slide's notes, most used first. */
    @computed get tags(): WsiTagCount[] {
        return tagSummary(this.notes);
    }

    /** The notes shown, under the tag filter. */
    @computed get shownNotes(): WsiSlideNote[] {
        const tag = this.tagFilter;
        return tag
            ? this.notes.filter(note => note.tags.includes(tag))
            : this.notes;
    }

    /** Whether the user may change `note`: its creator (the service checks). */
    canChange(note: WsiSlideNote): boolean {
        return (
            this.host.canEdit &&
            (!this.host.currentUser || note.creator === this.host.currentUser)
        );
    }

    /** Forgets the slide's notes, e.g. on another slide or study. */
    @action
    reset(slideKey: string | null, routeUnknown = false) {
        this.slideKey = slideKey;
        this.loadedFor = null;
        this.resets += 1;
        this.notes = [];
        this.error = null;
        this.busy = false;
        this.loading = false;
        this.tagFilter = null;
        if (routeUnknown) this.route = null;
    }

    @action.bound
    setTagFilter(tag: string | null) {
        this.tagFilter = tag;
    }

    @action.bound
    dismissError() {
        this.error = null;
    }

    private fromApi(item: any): WsiSlideNote {
        return {
            id: String(item?.id),
            text: String(item?.text || ''),
            tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
            creator: String(item?.created_by || ''),
            visibleTo: Array.isArray(item?.visible_to) ? item.visible_to : null,
            version: Number(item?.version) || 1,
            created: String(item?.created_at || ''),
            updated: String(item?.updated_at || ''),
        };
    }

    /**
     * Handles a refusal; returns whether `response` was one. A service
     * without the route turns notes off; a version conflict or a missing
     * note reloads them.
     */
    private async refused(
        response: Response,
        context: ReturnType<WsiSlideNotesHost['requestContext']>
    ): Promise<boolean> {
        if (response.ok) return false;
        const detail = await jsonDetail(response);
        // Another slide opened meanwhile: the refusal is not about its notes.
        if (!this.host.isCurrentContext(context)) return true;
        if (
            response.status === 405 ||
            (response.status === 404 && detail === 'Not Found')
        ) {
            action(() => {
                this.route = false;
                this.loading = false;
                this.busy = false;
            })();
            return true;
        }
        if (response.status === 409 || response.status === 404) {
            await this.load();
            if (!this.host.isCurrentContext(context)) return true;
            action(() => {
                this.error =
                    response.status === 409
                        ? 'The note was changed elsewhere; reloaded the notes.'
                        : 'The note was deleted elsewhere; reloaded the notes.';
            })();
            return true;
        }
        if (response.status === 403 && typeof detail === 'string') {
            action(() => {
                this.busy = false;
                this.error = /only the creator/i.test(detail)
                    ? 'Only its author can change this note.'
                    : detail;
            })();
            return true;
        }
        if (this.host.refuseServiceAccess(response)) {
            action(() => {
                this.loading = false;
                this.busy = false;
            })();
            return true;
        }
        action(() => {
            this.loading = false;
            this.busy = false;
            this.error =
                response.status === 422
                    ? 'A note needs text or tags: up to 4,000 characters and 20 tags of 1–40 letters, digits, spaces or _-.:/+#.'
                    : `The slide notes could not be saved or loaded (${response.status}).`;
        })();
        return true;
    }

    /**
     * Loads the open slide's notes unless they are loaded or loading: the
     * Slide notes section asks when it shows, so a slide opened with the
     * section hidden sends no request.
     */
    @action.bound
    ensureLoaded(): Promise<void> {
        if (!this.slideKey || this.loadedFor === this.slideKey) {
            return Promise.resolve();
        }
        return this.load();
    }

    /** Loads the open slide's notes. */
    @action.bound
    async load(): Promise<void> {
        const slideKey = this.slideKey;
        if (!slideKey || this.route === false) return;
        this.loadedFor = slideKey;
        const context = this.host.requestContext();
        this.loading = true;
        try {
            const response = await this.host.serviceRequest(
                `/slide-notes?slide_id=${encodeURIComponent(slideKey)}`,
                {},
                context.signal
            );
            if (!this.host.isCurrentContext(context)) return;
            if (await this.refused(response, context)) return;
            const raw = await response.json();
            if (!this.host.isCurrentContext(context)) return;
            action(() => {
                this.route = true;
                this.loading = false;
                this.notes = Array.isArray(raw?.notes)
                    ? raw.notes.map((item: any) => this.fromApi(item))
                    : [];
                if (
                    this.tagFilter &&
                    !this.tags.some(t => t.tag === this.tagFilter)
                ) {
                    this.tagFilter = null;
                }
            })();
        } catch (error) {
            if (
                !this.host.isCurrentContext(context) ||
                (error as Error)?.name === 'AbortError'
            ) {
                return;
            }
            action(() => {
                this.loading = false;
                this.error = 'The slide notes could not be loaded.';
            })();
        }
    }

    /** Sends a write; resolves to the answer's JSON, null for none, or undefined. */
    private async write(path: string, init: RequestInit): Promise<any> {
        const context = this.host.requestContext();
        action(() => {
            this.busy = true;
            this.error = null;
        })();
        try {
            const response = await this.host.serviceRequest(
                path,
                init,
                context.signal
            );
            if (!this.host.isCurrentContext(context)) return undefined;
            if (await this.refused(response, context)) return undefined;
            const value =
                response.status === 204 ? null : await response.json();
            // The answer came for a slide that is no longer open: it must
            // not land in the open slide's notes.
            if (!this.host.isCurrentContext(context)) return undefined;
            action(() => {
                this.busy = false;
            })();
            return value;
        } catch (_) {
            if (!this.host.isCurrentContext(context)) return undefined;
            action(() => {
                this.busy = false;
                this.error = 'The note could not be saved.';
            })();
            return undefined;
        }
    }

    /** Adds a note to the open slide; resolves to whether it was saved. */
    @action.bound
    async create(draft: WsiSlideNoteDraft): Promise<boolean> {
        const text = draft.text.trim();
        if (!this.slideKey || (!text && !draft.tags.length)) return false;
        const saved = await this.write('/slide-notes', {
            method: 'POST',
            body: JSON.stringify({
                slide_id: this.slideKey,
                study_id: this.host.serviceStudyId || '',
                text,
                tags: draft.tags,
                visible_to: draft.shared ? [] : null,
            }),
        });
        if (!saved) return false;
        action(() => {
            this.notes = [...this.notes, this.fromApi(saved)];
        })();
        return true;
    }

    /** Saves an edit of the user's note; resolves to whether it was saved. */
    @action.bound
    async update(
        note: WsiSlideNote,
        draft: WsiSlideNoteDraft
    ): Promise<boolean> {
        const text = draft.text.trim();
        if (!text && !draft.tags.length) return false;
        const saved = await this.write(
            `/slide-notes/${encodeURIComponent(note.id)}`,
            {
                method: 'PUT',
                body: JSON.stringify({
                    version: note.version,
                    text,
                    tags: draft.tags,
                    visible_to: draft.shared ? [] : null,
                }),
            }
        );
        if (!saved) return false;
        const updated = this.fromApi(saved);
        action(() => {
            this.notes = this.notes.map(item =>
                item.id === note.id ? updated : item
            );
        })();
        return true;
    }

    /** Deletes the user's note; resolves to whether it is gone. */
    @action.bound
    async remove(note: WsiSlideNote): Promise<boolean> {
        const done = await this.write(
            `/slide-notes/${encodeURIComponent(note.id)}?version=${
                note.version
            }`,
            { method: 'DELETE' }
        );
        if (done === undefined) return false;
        action(() => {
            this.notes = this.notes.filter(item => item.id !== note.id);
            if (
                this.tagFilter &&
                !this.tags.some(t => t.tag === this.tagFilter)
            ) {
                this.tagFilter = null;
            }
        })();
        return true;
    }
}
