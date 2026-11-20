// Test helpers shared by the annotation specs: an in-memory annotation
// service with the tile server's routes, and a controller attached to a
// stand-in viewer. Not part of the package build (no entry imports it).
import { act } from '@testing-library/react';
import { createOSDAnnotator } from '@annotorious/openseadragon';
import { WsiAnnotationController } from './wsiAnnotationController';

export const TEST_SLIDE_KEY = '0123456789ab';
export const TEST_STUDY = 'study1';
export const TEST_USER = 'me';
export const TEST_API = 'https://tiles.example/wsi';

const MACHINE_SOURCES = ['agent', 'assistant', 'ai', 'model', 'precomputed'];

/** The service refuses a machine-made create from a user (not a trusted writer). */
const MACHINE_CREATE_REFUSED = {
    status: 422,
    body: {
        detail: 'Only a trusted writer may create a machine-made annotation',
    },
};

/** A stored annotation row, as the service answers it. */
export function serviceRow(
    id: string,
    selector: string,
    options: {
        label?: string;
        creator?: string;
        layer?: string;
        color?: string;
        provenance?: Record<string, unknown> | null;
        visibleTo?: string[] | null;
        version?: number;
        commentCount?: number;
    } = {}
): any {
    const layer = options.layer || 'Default';
    const color = options.color || '#ef4444';
    return {
        id,
        slide_id: TEST_SLIDE_KEY,
        study_id: TEST_STUDY,
        body: {
            label: options.label ?? `Label ${id}`,
            comment: '',
            layer_name: layer,
            color,
            type: `${layer}|${color}`,
            provenance: options.provenance ?? null,
        },
        target: {
            selector: selector.startsWith('<')
                ? { type: 'SvgSelector', value: selector }
                : { type: 'FragmentSelector', value: `xywh=pixel:${selector}` },
        },
        created_by: options.creator || TEST_USER,
        visible_to: options.visibleTo === undefined ? [] : options.visibleTo,
        version: options.version || 1,
        created_at: '2026-11-01T10:00:00Z',
        updated_at: '2026-11-01T10:00:00Z',
        ...(options.commentCount !== undefined
            ? { comment_count: options.commentCount }
            : {}),
    };
}

/** A point row at (`x`, `y`). */
export function pointRow(
    id: string,
    x: number,
    y: number,
    label = 'Mitosis',
    options: Parameters<typeof serviceRow>[2] = {}
) {
    return serviceRow(id, `<svg><circle cx="${x}" cy="${y}" r="0" /></svg>`, {
        label,
        ...options,
    });
}

export type TestRoute =
    | 'batch'
    | 'batchUpdate'
    | 'batchDelete'
    | 'batchReview'
    | 'batchRestore'
    | 'review'
    /** `decision: "reset"` on the review routes (refused as unknown). */
    | 'reset'
    /** `POST /annotations/{id}/restore` (and soft deletes). */
    | 'restore'
    | 'comments'
    | 'slideNotes';

export interface TestServiceOptions {
    user?: string;
    /**
     * Routes the service lacks, as an older service would (`restore`: no
     * soft deletes or restores; `reset`: no review reset).
     */
    missing?: TestRoute[];
    /** Whether list rows carry `comment_count` (a service with comments). */
    commentCounts?: boolean;
    /** Answers before the default handling, e.g. to fail one request. */
    override?: (request: TestRequest) => TestResponse | undefined;
    /**
     * Pages comment threads and slide notes as the current service does
     * (`{…, total, offset, limit, has_more, next_offset}`, this many a
     * page by default), and caps a thread and a slide's notes at `cap`.
     * Unset, they are answered whole, as an older service does.
     */
    page?: number;
    cap?: number;
}

/** A page of `items` as the service answers it, from the query. */
function paged<T>(items: T[], query: URLSearchParams, limit: number) {
    const offset = Number(query.get('offset') || 0);
    const size = Number(query.get('limit') || limit);
    const slice = items.slice(offset, offset + size);
    const more = offset + size < items.length;
    return {
        items: slice,
        total: items.length,
        offset,
        limit: size,
        has_more: more,
        next_offset: more ? offset + size : null,
    };
}

export interface TestRequest {
    method: string;
    path: string;
    query: URLSearchParams;
    body: any;
}

export interface TestResponse {
    status: number;
    body?: unknown;
}

/**
 * An in-memory annotation service following the tile server's rules:
 * creator-only updates and deletes with versions, reviews of machine-made
 * annotations by anyone and their reset by the reviewer only, soft deletes
 * that keep the row and its comments for a restore under the same id by
 * the creator, all-or-nothing batches (403/404 name the first failing
 * item, 409 lists every stale one), comment threads and slide notes.
 * Without the `restore` route, a delete removes the row and its comments
 * for good, as an older service does. Install it with `install()`, which
 * replaces `global.fetch`.
 */
export class TestAnnotationService {
    /** The live annotations. */
    rows = new Map<string, any>();
    /** Soft-deleted annotations, restorable, with their comments kept. */
    deleted = new Map<string, any>();
    comments = new Map<string, any[]>();
    notes = new Map<string, any>();
    calls: TestRequest[] = [];
    private next = 0;
    private readonly options: TestServiceOptions;
    /** Requests waiting for `release()` while `hold` is set. */
    hold = false;
    private held: Array<() => void> = [];

    constructor(seed: any[] = [], options: TestServiceOptions = {}) {
        this.options = options;
        seed.forEach(row => this.rows.set(row.id, row));
    }

    get user(): string {
        return this.options.user || TEST_USER;
    }

    /** The writes received, as [method, path]. */
    writes(): Array<[string, string]> {
        return this.calls
            .filter(call => call.method !== 'GET')
            .map(call => [call.method, call.path]);
    }

    install() {
        global.fetch = jest.fn(async (input: any, init?: RequestInit) => {
            const url = new URL(String(input));
            const request: TestRequest = {
                method: init?.method || 'GET',
                path: url.pathname,
                query: url.searchParams,
                body: init?.body ? JSON.parse(String(init.body)) : null,
            };
            this.calls.push(request);
            if (this.hold) {
                await new Promise<void>(resolve => this.held.push(resolve));
            } else {
                await Promise.resolve();
            }
            const answer = this.options.override?.(request) ||
                this.handle(request) || {
                    status: 404,
                    body: { detail: 'Not Found' },
                };
            return response(answer);
        }) as any;
        return this;
    }

    /** Lets the held requests go on. */
    release() {
        this.hold = false;
        const held = this.held.splice(0);
        held.forEach(resolve => resolve());
    }

    private missing(route: TestRoute) {
        const missing = this.options.missing || [];
        // A service without restores has no batch restore either.
        return (
            missing.includes(route) ||
            (route === 'batchRestore' && missing.includes('restore'))
        );
    }

    private create(item: any): any {
        const now = new Date().toISOString();
        const row = {
            ...item,
            id: `saved-${++this.next}`,
            created_by: this.user,
            visible_to: item.visible_to === undefined ? null : item.visible_to,
            version: 1,
            created_at: now,
            updated_at: now,
            comment_count: 0,
        };
        this.rows.set(row.id, row);
        return row;
    }

    private listed(row: any) {
        const out = { ...row };
        if (this.options.commentCounts === false) delete out.comment_count;
        else if (out.comment_count === undefined) {
            out.comment_count = (this.comments.get(row.id) || []).filter(
                comment => !comment.deleted
            ).length;
        }
        return out;
    }

    private isMachine(row: any) {
        return MACHINE_SOURCES.includes(
            String(row.body?.provenance?.source || '').toLowerCase()
        );
    }

    private reviewed(row: any, decision: string) {
        if (decision === 'reset') {
            const { review_status, reviewed_by, reviewed_at, ...provenance } =
                row.body.provenance || {};
            return {
                ...row,
                body: { ...row.body, provenance },
                version: row.version + 1,
                updated_at: new Date().toISOString(),
            };
        }
        return {
            ...row,
            body: {
                ...row.body,
                provenance: {
                    ...row.body.provenance,
                    review_status:
                        decision === 'accept' ? 'accepted' : 'rejected',
                    reviewed_by: this.user,
                    reviewed_at: new Date().toISOString(),
                },
            },
            version: row.version + 1,
            updated_at: new Date().toISOString(),
        };
    }

    /**
     * Why the user may not review `row` with `decision` (after the version
     * check), as the service answers it; undefined when they may.
     */
    private reviewRefusal(
        row: any,
        decision: string
    ): { status: number; detail: string } | undefined {
        if (decision !== 'reset') return undefined;
        const provenance = row.body?.provenance || {};
        if (
            !('review_status' in provenance) &&
            !('reviewed_by' in provenance) &&
            !('reviewed_at' in provenance)
        ) {
            return {
                status: 422,
                detail: 'The annotation has no review to reset',
            };
        }
        if (provenance.reviewed_by !== this.user) {
            return {
                status: 403,
                detail: 'Only the reviewer may reset this review',
            };
        }
        return undefined;
    }

    /** Deletes a row: kept for a restore, or gone with an older service. */
    private remove(id: string) {
        const row = this.rows.get(id);
        this.rows.delete(id);
        if (this.missing('restore')) this.comments.delete(id);
        else this.deleted.set(id, row);
    }

    /** The restored row: live again under its id, `version` bumped. */
    private restored(id: string) {
        const row = {
            ...this.deleted.get(id),
            version: this.deleted.get(id).version + 1,
            updated_at: new Date().toISOString(),
        };
        this.deleted.delete(id);
        this.rows.set(id, row);
        return row;
    }

    private updated(row: any, item: any) {
        return {
            ...row,
            body: item.body ?? row.body,
            target: item.target ?? row.target,
            visible_to: 'visible_to' in item ? item.visible_to : row.visible_to,
            version: row.version + 1,
            updated_at: new Date().toISOString(),
        };
    }

    private handle(request: TestRequest): TestResponse | undefined {
        const parts = request.path.split('/').filter(Boolean);
        const at = parts.indexOf('annotations');
        if (at >= 0) return this.annotations(request, parts.slice(at + 1));
        const notes = parts.indexOf('slide-notes');
        if (notes >= 0) {
            if (this.missing('slideNotes')) {
                return { status: 404, body: { detail: 'Not Found' } };
            }
            return this.slideNotes(request, parts.slice(notes + 1));
        }
        return undefined;
    }

    private annotations(
        request: TestRequest,
        rest: string[]
    ): TestResponse | undefined {
        const { method, body } = request;
        const [id, sub, cid] = rest.map(decodeURIComponent);
        if (!id) {
            if (method === 'GET') {
                return {
                    status: 200,
                    body: Array.from(this.rows.values())
                        .filter(
                            row =>
                                row.body?.provenance?.review_status !==
                                'rejected'
                        )
                        .map(row => this.listed(row)),
                };
            }
            if (method === 'POST') {
                if (this.isMachine(body)) return MACHINE_CREATE_REFUSED;
                return { status: 201, body: this.create(body) };
            }
        }
        if (id === 'batch' && method === 'POST') {
            if (this.missing('batch')) {
                return { status: 405, body: { detail: 'Method Not Allowed' } };
            }
            const machine = body.annotations.findIndex((item: any) =>
                this.isMachine(item)
            );
            if (machine >= 0) {
                return {
                    status: 422,
                    body: {
                        detail: [
                            {
                                loc: ['body', 'annotations', machine],
                                msg:
                                    'Only a trusted writer may create a machine-made annotation',
                            },
                        ],
                    },
                };
            }
            return {
                status: 201,
                body: body.annotations.map((item: any) => this.create(item)),
            };
        }
        const batchKind = ({
            'batch-update': 'batchUpdate',
            'batch-delete': 'batchDelete',
            'batch-review': 'batchReview',
            'batch-restore': 'batchRestore',
        } as Record<string, TestRoute>)[id];
        if (batchKind && method === 'POST') {
            if (this.missing(batchKind)) {
                return { status: 405, body: { detail: 'Method Not Allowed' } };
            }
            return this.batch(batchKind, body.items);
        }
        if (sub === 'comments') {
            if (this.missing('comments')) {
                return { status: 404, body: { detail: 'Not Found' } };
            }
            return this.thread(request, id, cid);
        }
        if (method === 'POST' && sub === 'restore') {
            if (this.missing('restore')) {
                return { status: 404, body: { detail: 'Not Found' } };
            }
            const gone = this.deleted.get(id);
            if (!gone) {
                return {
                    status: 404,
                    body: { detail: 'Deleted annotation not found' },
                };
            }
            if (gone.created_by !== this.user) {
                return {
                    status: 403,
                    body: {
                        detail: 'Only the creator may restore this annotation',
                    },
                };
            }
            if (body?.version === undefined) {
                return {
                    status: 422,
                    body: {
                        detail: [
                            { loc: ['body', 'version'], msg: 'Field required' },
                        ],
                    },
                };
            }
            if (body.version !== gone.version) {
                return { status: 409, body: { detail: 'Version conflict' } };
            }
            return { status: 200, body: this.listed(this.restored(id)) };
        }
        const row = this.rows.get(id);
        if (!row)
            return { status: 404, body: { detail: 'Annotation not found' } };
        if (method === 'POST' && sub === 'review') {
            if (this.missing('review')) {
                return { status: 404, body: { detail: 'Not Found' } };
            }
            if (body.decision === 'reset' && this.missing('reset')) {
                return {
                    status: 422,
                    body: {
                        detail: [
                            {
                                loc: ['body', 'decision'],
                                msg: "Input should be 'accept' or 'reject'",
                                type: 'literal_error',
                            },
                        ],
                    },
                };
            }
            if (!this.isMachine(row)) {
                return {
                    status: 403,
                    body: {
                        detail: 'Only machine-made annotations can be reviewed',
                    },
                };
            }
            if (body.version !== row.version) {
                return { status: 409, body: { detail: 'Version conflict' } };
            }
            const refusal = this.reviewRefusal(row, body.decision);
            if (refusal) {
                return {
                    status: refusal.status,
                    body: { detail: refusal.detail },
                };
            }
            const reviewed = this.reviewed(row, body.decision);
            this.rows.set(id, reviewed);
            return { status: 200, body: this.listed(reviewed) };
        }
        if (row.created_by !== this.user) {
            return {
                status: 403,
                body: { detail: 'Only the creator may change this annotation' },
            };
        }
        if (method === 'PUT') {
            if (body.version !== row.version) {
                return { status: 409, body: { detail: 'Version conflict' } };
            }
            // A user may keep an annotation's machine source, not set one.
            const source = (item: any) =>
                this.isMachine(item)
                    ? String(item.body.provenance.source).toLowerCase()
                    : null;
            if (body.body && source(body) && source(body) !== source(row)) {
                return {
                    status: 422,
                    body: {
                        detail:
                            'Only a trusted writer may mark an annotation machine-made',
                    },
                };
            }
            const updated = this.updated(row, body);
            this.rows.set(id, updated);
            return { status: 200, body: this.listed(updated) };
        }
        if (method === 'DELETE') {
            this.remove(id);
            return { status: 204 };
        }
        return undefined;
    }

    private batch(kind: TestRoute, items: any[]): TestResponse {
        if (!Array.isArray(items) || !items.length || items.length > 100) {
            return {
                status: 422,
                body: { detail: [{ loc: ['body', 'items'], msg: 'size' }] },
            };
        }
        const conflicts: any[] = [];
        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            const row =
                kind === 'batchRestore'
                    ? this.deleted.get(item.id)
                    : this.rows.get(item.id);
            const fail = (status: number, msg: string): TestResponse => ({
                status,
                body: {
                    detail: {
                        msg,
                        index,
                        id: item.id,
                        loc: ['body', 'items', index],
                    },
                },
            });
            if (kind === 'batchReview' && item.decision === 'reset') {
                if (this.missing('reset')) {
                    return {
                        status: 422,
                        body: {
                            detail: [
                                {
                                    loc: ['body', 'items', index, 'decision'],
                                    msg: "Input should be 'accept' or 'reject'",
                                    type: 'literal_error',
                                },
                            ],
                        },
                    };
                }
            }
            if (!row) {
                return fail(
                    404,
                    kind === 'batchRestore'
                        ? 'Deleted annotation not found'
                        : 'Annotation not found'
                );
            }
            if (kind === 'batchReview') {
                if (!this.isMachine(row)) {
                    return fail(
                        403,
                        'Only machine-made annotations can be reviewed'
                    );
                }
            } else if (row.created_by !== this.user) {
                return fail(403, 'Only the creator may change this annotation');
            }
            if (row.version !== item.version) {
                conflicts.push({
                    index,
                    id: item.id,
                    loc: ['body', 'items', index, 'version'],
                    version: item.version,
                    current_version: row.version,
                });
                continue;
            }
            const refusal =
                kind === 'batchReview'
                    ? this.reviewRefusal(row, item.decision)
                    : undefined;
            if (refusal?.status === 422) {
                return {
                    status: 422,
                    body: {
                        detail: [
                            {
                                loc: ['body', 'items', index],
                                msg: refusal.detail,
                                type: 'value_error',
                                id: item.id,
                            },
                        ],
                    },
                };
            }
            if (refusal) return fail(refusal.status, refusal.detail);
        }
        if (conflicts.length) {
            return {
                status: 409,
                body: { detail: { msg: 'Version conflict', conflicts } },
            };
        }
        const out = items.map(item => {
            if (kind === 'batchRestore') {
                return this.listed(this.restored(item.id));
            }
            const row = this.rows.get(item.id);
            if (kind === 'batchDelete') {
                this.remove(item.id);
                return this.listed(row);
            }
            const next =
                kind === 'batchReview'
                    ? this.reviewed(row, item.decision)
                    : this.updated(row, item);
            this.rows.set(item.id, next);
            return this.listed(next);
        });
        return { status: 200, body: out };
    }

    private thread(
        request: TestRequest,
        id: string,
        cid: string | undefined
    ): TestResponse {
        const row = this.rows.get(id);
        if (!row)
            return { status: 404, body: { detail: 'Annotation not found' } };
        const thread = this.comments.get(id) || [];
        this.comments.set(id, thread);
        const { method, body } = request;
        if (!cid) {
            if (method === 'GET') {
                const live = thread.filter(c => !c.deleted);
                if (!this.options.page) return { status: 200, body: live };
                const { items, ...page } = paged(
                    live,
                    request.query,
                    this.options.page
                );
                return {
                    status: 200,
                    body: { annotation_id: id, comments: items, ...page },
                };
            }
            if (this.options.cap && thread.length >= this.options.cap) {
                return {
                    status: 422,
                    body: {
                        detail: `An annotation holds at most ${this.options.cap} comments.`,
                    },
                };
            }
            const text = String(body?.body || '').trim();
            if (!text || text.length > 4000) {
                return {
                    status: 422,
                    body: {
                        detail: [
                            {
                                loc: ['body', 'body'],
                                msg: 'A comment needs some text',
                            },
                        ],
                    },
                };
            }
            const now = new Date().toISOString();
            const comment = {
                id: `comment-${++this.next}`,
                annotation_id: id,
                study_id: TEST_STUDY,
                author: this.user,
                body: text,
                created_at: now,
                updated_at: now,
            };
            thread.push(comment);
            return { status: 201, body: comment };
        }
        const comment = thread.find(c => c.id === cid && !c.deleted);
        if (!comment)
            return { status: 404, body: { detail: 'Comment not found' } };
        if (comment.author !== this.user) {
            return {
                status: 403,
                body: { detail: 'Only the author may change this comment' },
            };
        }
        if (method === 'PUT') {
            comment.body = String(body.body).trim();
            comment.updated_at = new Date(Date.now() + 1000).toISOString();
            return { status: 200, body: { ...comment } };
        }
        comment.deleted = true;
        return { status: 204 };
    }

    private slideNotes(request: TestRequest, rest: string[]): TestResponse {
        const { method, body, query } = request;
        const [id] = rest.map(decodeURIComponent);
        const visible = (note: any) =>
            note.created_by === this.user || Array.isArray(note.visible_to);
        if (!id && method === 'GET') {
            const slide = query.get('slide_id');
            const notes = Array.from(this.notes.values()).filter(
                note => note.slide_id === slide && visible(note)
            );
            const counts = new Map<string, number>();
            notes.forEach(note =>
                note.tags.forEach((tag: string) =>
                    counts.set(tag, (counts.get(tag) || 0) + 1)
                )
            );
            const tags = Array.from(counts.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([tag, count]) => ({ tag, count }));
            if (this.options.page) {
                const { items, ...page } = paged(
                    notes,
                    query,
                    this.options.page
                );
                return {
                    status: 200,
                    body: { slide_id: slide, notes: items, tags, ...page },
                };
            }
            return {
                status: 200,
                body: { slide_id: slide, notes, tags },
            };
        }
        if (
            !id &&
            method === 'POST' &&
            this.options.cap &&
            Array.from(this.notes.values()).filter(
                note => note.slide_id === body.slide_id
            ).length >= this.options.cap
        ) {
            return {
                status: 422,
                body: {
                    detail: `A slide holds at most ${this.options.cap} notes.`,
                },
            };
        }
        if (!id && method === 'POST') {
            if (!String(body.text || '').trim() && !(body.tags || []).length) {
                return {
                    status: 422,
                    body: {
                        detail: [
                            { loc: ['body'], msg: 'A note needs text or tags' },
                        ],
                    },
                };
            }
            const now = new Date().toISOString();
            const note = {
                id: `note-${++this.next}`,
                slide_id: body.slide_id,
                study_id: body.study_id,
                text: String(body.text || '').trim(),
                tags: body.tags || [],
                created_by: this.user,
                visible_to:
                    body.visible_to === undefined ? null : body.visible_to,
                version: 1,
                created_at: now,
                updated_at: now,
            };
            this.notes.set(note.id, note);
            return { status: 201, body: note };
        }
        const note = this.notes.get(id);
        if (!note || !visible(note)) {
            return { status: 404, body: { detail: 'Slide note not found' } };
        }
        if (note.created_by !== this.user) {
            return {
                status: 403,
                body: { detail: 'Only the creator may update this note' },
            };
        }
        if (method === 'PUT') {
            if (body.version !== note.version) {
                return {
                    status: 409,
                    body: { detail: 'Slide note was modified concurrently' },
                };
            }
            const next = {
                ...note,
                text: body.text ?? note.text,
                tags: body.tags ?? note.tags,
                visible_to:
                    'visible_to' in body ? body.visible_to : note.visible_to,
                version: note.version + 1,
                updated_at: new Date().toISOString(),
            };
            this.notes.set(id, next);
            return { status: 200, body: next };
        }
        const version = query.get('version');
        if (version && Number(version) !== note.version) {
            return {
                status: 409,
                body: { detail: 'Slide note was modified concurrently' },
            };
        }
        this.notes.delete(id);
        return { status: 204 };
    }
}

function response({ status, body }: TestResponse): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        clone() {
            return response({ status, body });
        },
        json: async () => {
            if (body === undefined) throw new SyntaxError('No content');
            return JSON.parse(JSON.stringify(body));
        },
    } as any;
}

/** Waits for the promise jobs and timers queued now to run. */
export async function flush(times = 3) {
    for (let i = 0; i < times; i++) {
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
        });
    }
}

/**
 * A controller signed in as the service's user, on `TEST_SLIDE_KEY` with
 * the service's rows loaded, attached to a stand-in viewer with one screen
 * pixel per `imagePerScreen` image pixels (image (0, 0) at the top left).
 * `pointer` and `press` send events as the browser would.
 */
export async function attachTestController(
    service: TestAnnotationService,
    options: {
        imagePerScreen?: () => number;
        mpp?: { x: number; y: number };
    } = {}
) {
    const annotator = {
        on: jest.fn(),
        setVisible: jest.fn(),
        setAnnotations: jest.fn(),
        setStyle: jest.fn(),
        setUserSelectAction: jest.fn(),
        cancelDrawing: jest.fn(),
        setDrawingEnabled: jest.fn(),
        cancelSelected: jest.fn(),
        destroy: jest.fn(),
    };
    (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
    const controller = new WsiAnnotationController(TEST_API, TEST_STUDY);
    controller.setCurrentUser(service.user);
    if (options.mpp) {
        const mpp = options.mpp;
        controller.setMppProvider(() => mpp);
    }
    controller.beginSlide(TEST_SLIDE_KEY);
    await flush();
    const element = document.createElement('div');
    (element as any).setPointerCapture = jest.fn();
    document.body.appendChild(element);
    const handlers = new Map<string, Array<(event: any) => void>>();
    const viewer = {
        element,
        addHandler: jest.fn((name: string, handler: any) =>
            handlers.set(name, [...(handlers.get(name) || []), handler])
        ),
        removeHandler: jest.fn(),
    };
    controller.attachViewer(viewer, {}, TEST_SLIDE_KEY);
    const scale = options.imagePerScreen || (() => 1);
    jest.spyOn(controller as any, 'imagePoint').mockImplementation(
        (x: any, y: any) => ({
            x: x * scale(),
            y: y * scale(),
        })
    );
    jest.spyOn(controller as any, 'screenPoint').mockImplementation(
        (point: any) => ({
            x: point.x / scale(),
            y: point.y / scale(),
        })
    );
    const pointer = (
        type: string,
        x: number,
        y: number,
        init: MouseEventInit = {}
    ) => {
        const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: x,
            clientY: y,
            ...init,
        });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        act(() => {
            element.dispatchEvent(event);
        });
        return event;
    };
    /** A press, a drag through `steps` moves and a release. */
    const drag = (from: [number, number], to: [number, number], steps = 4) => {
        pointer('pointerdown', ...from);
        for (let i = 1; i <= steps; i++) {
            pointer(
                'pointermove',
                from[0] + ((to[0] - from[0]) * i) / steps,
                from[1] + ((to[1] - from[1]) * i) / steps
            );
        }
        pointer('pointerup', ...to);
    };
    const press = (
        key: string,
        init: KeyboardEventInit = {},
        target: EventTarget = document
    ) =>
        act(() => {
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                    ...init,
                })
            );
        });
    /** Tells the controller that the slide moved on screen. */
    const viewportChanged = () =>
        act(() => {
            (handlers.get('animation') || []).forEach(handler => handler({}));
        });
    return {
        controller,
        annotator,
        element,
        pointer,
        drag,
        press,
        viewportChanged,
        cleanup: () => {
            controller.detachViewer();
            element.remove();
        },
    };
}
