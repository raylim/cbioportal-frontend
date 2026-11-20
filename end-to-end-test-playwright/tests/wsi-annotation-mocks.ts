// The annotation service and PNG tiles the mocked WSI specs share.
import * as zlib from 'zlib';
import { Page, Route } from '@playwright/test';
import { expect } from '../fixtures';
import { STUDY_ID, SLIDE_KEY } from './wsi-foundation-mocks';

/** Microns per pixel of the mocked slide. */
export const MPP = 0.25;

/** The signed-in user; the portal's config names them. */
export const USER = 'e2e-user';
/** Provenance sources the service treats as machine-made. */
export const MACHINE_SOURCES = [
    'agent',
    'assistant',
    'ai',
    'model',
    'precomputed',
];

/**
 * The annotation service, kept in memory: creates (one, or a batch) get an
 * id and version 1; updates and deletes are creator-only and check the
 * version; a delete is soft (the row and its comments are kept, unlisted)
 * and its creator restores it under the same id with the version it had;
 * any user may review a machine-made annotation, a rejected one is kept but
 * not listed, and its reviewer may reset the review. A batch item labelled
 * "refuse" is refused with a 422 naming it. `batch-update`, `batch-delete`,
 * `batch-review` and `batch-restore` are all or none (403/404 name the
 * first failing item, 409 lists stale ones); comment threads and slide
 * notes follow the service's rules. While `hold` is set, writes wait for
 * `release()`. Returns the rows, the deleted rows, comments, notes and the
 * writes it received.
 */
export async function routeAnnotationService(page: Page, seed: any[] = []) {
    const rows = new Map<string, any>(seed.map(row => [row.id, row]));
    const deleted = new Map<string, any>();
    const comments = new Map<string, any[]>();
    const notes = new Map<string, any>();
    const writes: Array<{ method: string; path: string; body: any }> = [];
    let next = 0;
    let held: Array<() => void> = [];
    const control = { hold: false };
    const release = () => {
        control.hold = false;
        held.splice(0).forEach(resolve => resolve());
    };
    const now = () => new Date().toISOString();
    const create = (item: any) => {
        const row = {
            ...item,
            id: `annotation-${++next}`,
            created_by: USER,
            version: 1,
            created_at: now(),
            updated_at: now(),
        };
        rows.set(row.id, row);
        return row;
    };
    const listed = (row: any) => ({
        ...row,
        comment_count: (comments.get(row.id) || []).filter(c => !c.deleted)
            .length,
    });
    const isMachine = (row: any) =>
        MACHINE_SOURCES.includes(
            String(row.body?.provenance?.source || '').toLowerCase()
        );
    const reviewed = (row: any, decision: string) => {
        const { review_status, reviewed_by, reviewed_at, ...provenance } =
            row.body.provenance || {};
        return {
            ...row,
            body: {
                ...row.body,
                provenance:
                    decision === 'reset'
                        ? provenance
                        : {
                              ...provenance,
                              review_status:
                                  decision === 'accept'
                                      ? 'accepted'
                                      : 'rejected',
                              reviewed_by: USER,
                              reviewed_at: now(),
                          },
            },
            version: row.version + 1,
            updated_at: now(),
        };
    };
    /** Why a reset of `row` is refused (after the version check). */
    const resetRefusal = (row: any) => {
        const provenance = row.body?.provenance || {};
        if (!provenance.review_status) {
            return {
                status: 422,
                msg: 'The annotation has no review to reset',
            };
        }
        if (provenance.reviewed_by !== USER) {
            return {
                status: 403,
                msg: 'Only the reviewer may reset this review',
            };
        }
        return null;
    };
    const remove = (id: string) => {
        deleted.set(id, rows.get(id));
        rows.delete(id);
    };
    const restored = (id: string) => {
        const row = {
            ...deleted.get(id),
            version: deleted.get(id).version + 1,
            updated_at: now(),
        };
        deleted.delete(id);
        rows.set(id, row);
        return row;
    };
    const updated = (row: any, item: any) => ({
        ...row,
        body: item.body ?? row.body,
        target: item.target ?? row.target,
        visible_to: 'visible_to' in item ? item.visible_to : row.visible_to,
        version: row.version + 1,
        updated_at: now(),
    });
    const json = (route: Route, status: number, value: unknown) =>
        route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(value),
        });
    const receive = async (route: Route) => {
        const request = route.request();
        const method = request.method();
        const url = new URL(request.url());
        expect(url.searchParams.getAll('studyId')).toEqual([STUDY_ID]);
        const body = request.postData()
            ? JSON.parse(request.postData()!)
            : null;
        if (method !== 'GET') {
            expect(request.headers()['x-requested-with']).toBe(
                'XMLHttpRequest'
            );
            writes.push({ method, path: url.pathname, body });
            if (control.hold) {
                await new Promise<void>(resolve => held.push(resolve));
            }
        }
        return { method, url, body };
    };
    await page.route('**/wsi/annotations**', async (route: Route) => {
        const { method, url, body } = await receive(route);
        const parts = url.pathname.split('/');
        const id = decodeURIComponent(parts[3] || '');
        const sub = parts[4];
        const cid = parts[5] && decodeURIComponent(parts[5]);
        if (method === 'GET' && !id) {
            const slideId = url.searchParams.get('slide_id');
            return json(
                route,
                200,
                Array.from(rows.values())
                    .filter(
                        row =>
                            row.body?.provenance?.review_status !==
                                'rejected' &&
                            (!slideId ||
                                !row.slide_id ||
                                row.slide_id === slideId)
                    )
                    .map(listed)
            );
        }
        if (method === 'POST' && id === 'batch') {
            const refused = body.annotations
                .map((item: any, index: number) =>
                    item.body.label === 'refuse' || isMachine(item) ? index : -1
                )
                .filter((index: number) => index >= 0);
            if (refused.length) {
                return json(route, 422, {
                    detail: refused.map((index: number) => ({
                        loc: ['body', 'annotations', index, 'body', 'label'],
                        msg: 'label is not allowed',
                    })),
                });
            }
            return json(route, 201, body.annotations.map(create));
        }
        if (
            method === 'POST' &&
            /^batch-(update|delete|review|restore)$/.test(id)
        ) {
            const kind = id.slice('batch-'.length);
            const conflicts: any[] = [];
            for (let index = 0; index < body.items.length; index++) {
                const item = body.items[index];
                const row =
                    kind === 'restore'
                        ? deleted.get(item.id)
                        : rows.get(item.id);
                const refuse = (status: number, msg: string) =>
                    json(route, status, {
                        detail: {
                            msg,
                            index,
                            id: item.id,
                            loc: ['body', 'items', index],
                        },
                    });
                if (!row) return refuse(404, 'Annotation not found');
                if (kind === 'review' && !isMachine(row)) {
                    return refuse(
                        403,
                        'Only machine-made annotations can be reviewed'
                    );
                }
                if (kind !== 'review' && row.created_by !== USER) {
                    return refuse(
                        403,
                        'Only the creator may change this annotation'
                    );
                }
                if (row.version !== item.version) {
                    conflicts.push({
                        index,
                        id: item.id,
                        version: item.version,
                        current_version: row.version,
                    });
                    continue;
                }
                const refusal =
                    kind === 'review' && item.decision === 'reset'
                        ? resetRefusal(row)
                        : null;
                if (refusal) return refuse(refusal.status, refusal.msg);
            }
            if (conflicts.length) {
                return json(route, 409, {
                    detail: { msg: 'Version conflict', conflicts },
                });
            }
            return json(
                route,
                200,
                body.items.map((item: any) => {
                    if (kind === 'restore') return listed(restored(item.id));
                    const row = rows.get(item.id);
                    if (kind === 'delete') {
                        remove(item.id);
                        return listed(row);
                    }
                    const saved =
                        kind === 'review'
                            ? reviewed(row, item.decision)
                            : updated(row, item);
                    rows.set(item.id, saved);
                    return listed(saved);
                })
            );
        }
        if (method === 'POST' && !id) {
            // Only trusted writers may create machine-made annotations.
            if (isMachine(body)) {
                return json(route, 422, {
                    detail:
                        'Only a trusted writer may create a machine-made annotation',
                });
            }
            return json(route, 201, create(body));
        }
        if (method === 'POST' && sub === 'restore') {
            const gone = deleted.get(id);
            if (!gone) {
                return json(route, 404, {
                    detail: 'Deleted annotation not found',
                });
            }
            if (gone.created_by !== USER) {
                return json(route, 403, {
                    detail: 'Only the creator may restore this annotation',
                });
            }
            if (body.version !== gone.version) {
                return json(route, 409, { detail: 'Version conflict' });
            }
            return json(route, 200, listed(restored(id)));
        }
        const row = rows.get(id);
        if (!row) return json(route, 404, { detail: 'Annotation not found' });
        if (sub === 'comments') {
            const thread = comments.get(id) || [];
            comments.set(id, thread);
            if (method === 'GET') {
                return json(
                    route,
                    200,
                    thread.filter(c => !c.deleted)
                );
            }
            if (method === 'POST') {
                const comment = {
                    id: `comment-${++next}`,
                    annotation_id: id,
                    study_id: STUDY_ID,
                    author: USER,
                    body: String(body.body).trim(),
                    created_at: now(),
                    updated_at: now(),
                };
                thread.push(comment);
                return json(route, 201, comment);
            }
            const comment = thread.find(c => c.id === cid && !c.deleted);
            if (!comment)
                return json(route, 404, { detail: 'Comment not found' });
            if (method === 'PUT') {
                comment.body = String(body.body).trim();
                comment.updated_at = new Date(Date.now() + 1000).toISOString();
                return json(route, 200, comment);
            }
            comment.deleted = true;
            return route.fulfill({ status: 204, body: '' });
        }
        if (method === 'POST' && sub === 'review') {
            if (!isMachine(row)) {
                return json(route, 403, {
                    detail: 'Only machine-made annotations can be reviewed',
                });
            }
            if (body.version !== row.version) {
                return json(route, 409, { detail: 'Version conflict' });
            }
            const refusal =
                body.decision === 'reset' ? resetRefusal(row) : null;
            if (refusal) {
                return json(route, refusal.status, { detail: refusal.msg });
            }
            const saved = reviewed(row, body.decision);
            rows.set(id, saved);
            return json(route, 200, listed(saved));
        }
        if (row.created_by !== USER) {
            return json(route, 403, {
                detail: 'Only the creator may change this annotation',
            });
        }
        if (method === 'PUT') {
            if (body.version !== row.version) {
                return json(route, 409, { detail: 'Version conflict' });
            }
            const saved = updated(row, body);
            rows.set(id, saved);
            return json(route, 200, listed(saved));
        }
        remove(id);
        return route.fulfill({ status: 204, body: '' });
    });
    await page.route('**/wsi/slide-notes**', async (route: Route) => {
        const { method, url, body } = await receive(route);
        const id = decodeURIComponent(url.pathname.split('/')[3] || '');
        if (method === 'GET') {
            const listedNotes = Array.from(notes.values()).filter(
                note =>
                    note.slide_id === url.searchParams.get('slide_id') &&
                    (note.created_by === USER || Array.isArray(note.visible_to))
            );
            const counts = new Map<string, number>();
            listedNotes.forEach(note =>
                note.tags.forEach((tag: string) =>
                    counts.set(tag, (counts.get(tag) || 0) + 1)
                )
            );
            return json(route, 200, {
                slide_id: url.searchParams.get('slide_id'),
                notes: listedNotes,
                tags: Array.from(counts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([tag, count]) => ({ tag, count })),
            });
        }
        if (method === 'POST') {
            const note = {
                id: `note-${++next}`,
                slide_id: body.slide_id,
                study_id: body.study_id,
                text: String(body.text || '').trim(),
                tags: body.tags || [],
                created_by: USER,
                visible_to: body.visible_to ?? null,
                version: 1,
                created_at: now(),
                updated_at: now(),
            };
            notes.set(note.id, note);
            return json(route, 201, note);
        }
        const note = notes.get(id);
        if (!note) return json(route, 404, { detail: 'Slide note not found' });
        if (method === 'PUT') {
            const saved = {
                ...note,
                text: body.text ?? note.text,
                tags: body.tags ?? note.tags,
                visible_to:
                    'visible_to' in body ? body.visible_to : note.visible_to,
                version: note.version + 1,
                updated_at: now(),
            };
            notes.set(id, saved);
            return json(route, 200, saved);
        }
        notes.delete(id);
        return route.fulfill({ status: 204, body: '' });
    });
    return { rows, deleted, comments, notes, writes, control, release };
}

/** Another user's annotation, as the service stores it. */
export function seededAnnotation(
    id: string,
    label: string,
    points: string,
    provenance?: Record<string, unknown>
) {
    return {
        id,
        slide_id: SLIDE_KEY,
        study_id: STUDY_ID,
        body: {
            label,
            comment: '',
            type: `Model|#ef4444`,
            layer_name: 'Model',
            color: '#ef4444',
            provenance: provenance || null,
        },
        target: {
            selector: {
                type: 'SvgSelector',
                value: `<svg><polygon points="${points}" /></svg>`,
            },
        },
        created_by: 'model-loader',
        visible_to: [],
        version: 1,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
    };
}

/** CRC-32 of `data`, for PNG chunks. */
export function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let k = 0; k < 8; k++) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** An RGB PNG of `width`×`height` pixels colored by `color(x, y)`. */
export function encodePng(
    width: number,
    height: number,
    color: (x: number, y: number) => [number, number, number]
): Buffer {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 3 + 1);
        for (let x = 0; x < width; x++) {
            const [r, g, b] = color(x, y);
            raw[row + 1 + x * 3] = r;
            raw[row + 2 + x * 3] = g;
            raw[row + 3 + x * 3] = b;
        }
    }
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
