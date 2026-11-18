import * as fs from 'fs';
import { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures';
import {
    installFoundationMocks,
    makeSlideRow,
    PATIENT_ID,
    SLIDE_KEY,
    STUDY_ID,
    tileMetadata,
} from './wsi-foundation-mocks';

/** Microns per pixel of the mocked slide. */
const MPP = 0.25;

/** The signed-in user; the portal's config names them. */
const USER = 'e2e-user';
/** Provenance sources the service treats as machine-made. */
const MACHINE_SOURCES = ['agent', 'assistant', 'ai', 'model', 'precomputed'];

/**
 * The annotation service, kept in memory: creates (one, or a batch) get an
 * id and version 1; updates and deletes are creator-only and check the
 * version; any user may review a machine-made annotation, and a rejected one
 * is kept but not listed. A batch item labelled "refuse" is refused with a
 * 422 naming it. `batch-update`, `batch-delete` and `batch-review` are all or
 * none (403/404 name the first failing item, 409 lists stale ones); comment
 * threads and slide notes follow the service's rules. While `hold` is set,
 * writes wait for `release()`. Returns the rows, comments, notes and the
 * writes it received.
 */
async function routeAnnotationService(page: Page, seed: any[] = []) {
    const rows = new Map<string, any>(seed.map(row => [row.id, row]));
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
    const reviewed = (row: any, decision: string) => ({
        ...row,
        body: {
            ...row.body,
            provenance: {
                ...row.body.provenance,
                review_status: decision === 'accept' ? 'accepted' : 'rejected',
                reviewed_by: USER,
                reviewed_at: now(),
            },
        },
        version: row.version + 1,
        updated_at: now(),
    });
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
            return json(
                route,
                200,
                Array.from(rows.values())
                    .filter(
                        row =>
                            row.body?.provenance?.review_status !== 'rejected'
                    )
                    .map(listed)
            );
        }
        if (method === 'POST' && id === 'batch') {
            const refused = body.annotations
                .map((item: any, index: number) =>
                    item.body.label === 'refuse' ? index : -1
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
        if (method === 'POST' && /^batch-(update|delete|review)$/.test(id)) {
            const kind = id.slice('batch-'.length);
            const conflicts: any[] = [];
            for (let index = 0; index < body.items.length; index++) {
                const item = body.items[index];
                const row = rows.get(item.id);
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
                }
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
                    const row = rows.get(item.id);
                    if (kind === 'delete') {
                        rows.delete(item.id);
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
        if (method === 'POST' && !id) return json(route, 201, create(body));
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
        rows.delete(id);
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
    return { rows, comments, notes, writes, control, release };
}

/** Another user's annotation, as the service stores it. */
function seededAnnotation(
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

/**
 * Opens the mocked slide (`size` pixels square, 512 by default, at `MPP` µm
 * per pixel) with annotations on, signed in as `USER`; `config` adds to the
 * portal's config.
 */
async function openAnnotatedSlide(
    page: Page,
    size = 512,
    config: Record<string, unknown> = {}
) {
    await installFoundationMocks(page);
    await page.route('**/config_service', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                app_name: 'wsi-annotation-tools',
                authenticationMethod: 'none',
                user_display_name: USER,
                wsi_tile_server_url: '/wsi',
                wsi_annotation_api_url: '/wsi',
                ...config,
            }),
        })
    );
    const row = makeSlideRow(SLIDE_KEY, 'H&E initial', 'H&E (Initial)');
    row.metadata.serving.tile_metadata_json = {
        ...tileMetadata,
        dimensions: { width: size, height: size },
        level_dimensions: [{ width: size, height: size }],
        mpp: { x: MPP, y: MPP },
    } as typeof tileMetadata;
    await page.route('**/api/resource-table/query/fetch', route => {
        const query = route.request().postDataJSON();
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
                query?.resourceId === 'WSI_SAMPLE' ? [row] : []
            ),
        });
    });
}

async function gotoSlide(page: Page) {
    await page.goto(
        `/wsi/patient/${PATIENT_ID}?studyId=${STUDY_ID}#wsi:slide=${SLIDE_KEY}&x=256&y=256&z=1`
    );
    await expect(
        page.getByRole('button', { name: 'Fit to view' })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('wsi-annotation-toolbar')).toBeVisible({
        timeout: 30_000,
    });
    const stage = page.locator('.openseadragon-container').first();
    const box = (await stage.boundingBox())!;
    return (fx: number, fy: number) => ({
        x: box.x + box.width * fx,
        y: box.y + box.height * fy,
    });
}

/** Turns Annotate on once the slide's annotations have loaded. */
async function startAnnotating(page: Page) {
    const toggle = page.getByTestId('annotation-mode-toggle');
    await expect(toggle).toHaveAttribute('aria-disabled', 'false', {
        timeout: 15_000,
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('annotation-tools')).toBeVisible();
}

/** Picks a tool from the Shape or Outline menu. */
async function pickFromMenu(
    page: Page,
    group: 'shape' | 'outline',
    tool: string
) {
    await page.getByTestId(`annotation-tool-${group}-menu`).click();
    await page.getByTestId(`annotation-tool-${tool}`).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
}

/** Runs an item of the toolbar's ⋯ menu. */
async function moreMenu(page: Page, item: string) {
    await page.getByTestId('annotation-more-menu-button').click();
    await page.getByTestId(item).click();
}

/** The vertices of a saved polygon selector. */
function polygonPoints(selector: string): Array<{ x: number; y: number }> {
    const match = /points="([^"]+)"/.exec(selector);
    return (match ? match[1].trim().split(/\s+/) : []).map(pair => {
        const [x, y] = pair.split(',').map(Number);
        return { x, y };
    });
}

// Mocked like wsi-foundation-mocked.spec.ts: runs in the WSI suite only.
if (process.env.PW_SUITE === 'wsi') {
    test.describe('WSI annotation tools', () => {
        test('measures a line, saves a note, counts points and exports GeoJSON', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page);
            const pageErrors: string[] = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            const at = await gotoSlide(page);
            // Viewing shows only Annotate and the ⋯ menu.
            await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
            await startAnnotating(page);

            // A line shows its length while it is drawn, then in the list.
            await page
                .getByTestId('annotation-drawing-as')
                .getByLabel('Label for new annotations')
                .fill('Depth');
            await page.getByTestId('annotation-tool-line').click();
            const start = at(0.35, 0.5);
            const end = at(0.6, 0.5);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(end.x, end.y, { steps: 5 });
            await expect(
                page.getByTestId('annotation-draw-measurement')
            ).toHaveText(/^Length [\d.,]+ (µm|mm)$/);
            await page.mouse.up();
            await expect(
                page.getByTestId('annotation-measurement-annotation-1')
            ).toHaveText(/^Length [\d.,]+ (µm|mm)$/, { timeout: 15_000 });
            const line = service.writes[0].body;
            expect(line.target.selector.value).toMatch(/^<svg><line /);
            expect(line.body.layer_name).toBe('Default');
            expect(line.body.label).toBe('Depth');
            const label = page.getByLabel('Label for new annotations');
            await label.fill('');
            await label.blur();
            expect(line.visible_to).toEqual([]);

            // A note is saved in comment with the annotation's version.
            await page.getByTestId('annotation-note-edit-annotation-1').click();
            await page
                .getByLabel(/^Note for /)
                .fill('Depth of invasion, measured to the deepest cells.');
            await page.getByTestId('annotation-note-save-annotation-1').click();
            await expect(
                page.getByTestId('annotation-note-annotation-1')
            ).toHaveText('Depth of invasion, measured to the deepest cells.');
            const noteWrite = service.writes[1];
            expect(noteWrite.method).toBe('PUT');
            expect(noteWrite.body.version).toBe(1);
            expect(noteWrite.body.body.comment).toBe(
                'Depth of invasion, measured to the deepest cells.'
            );

            // Points count as they are dropped; the tool stays on.
            await page.keyboard.press('.');
            await expect(
                page.getByTestId('annotation-tool-point')
            ).toHaveAttribute('aria-pressed', 'true');
            for (const [fx, fy] of [
                [0.4, 0.3],
                [0.45, 0.35],
                [0.5, 0.3],
            ]) {
                const point = at(fx, fy);
                await page.mouse.click(point.x, point.y);
            }
            await expect(page.getByTestId('annotation-point-count')).toHaveText(
                'Point: 3'
            );
            await page.keyboard.press('Escape');
            await expect(
                page.getByTestId('annotation-tool-select')
            ).toHaveAttribute('aria-pressed', 'true');
            await expect(
                page.getByTestId('annotation-point-tally-Default-Point')
            ).toContainText('3');
            await expect.poll(() => service.rows.size).toBe(4);
            // The three points were saved together in one batch request.
            const batches = service.writes.filter(
                write => write.path === '/wsi/annotations/batch'
            );
            expect(batches).toHaveLength(1);
            expect(batches[0].body.annotations).toHaveLength(3);
            for (const point of batches[0].body.annotations) {
                expect(point.slide_id).toBe(SLIDE_KEY);
                expect(point.target.selector.value).toMatch(
                    /^<svg><circle cx="[\d.]+" cy="[\d.]+" r="0" \/><\/svg>$/
                );
            }

            // Export: a QuPath-style FeatureCollection named by the slide key.
            const [download] = await Promise.all([
                page.waitForEvent('download'),
                moreMenu(page, 'annotation-export-all'),
            ]);
            expect(download.suggestedFilename()).toBe(
                `slide-${SLIDE_KEY}.geojson`
            );
            const exported = JSON.parse(
                fs.readFileSync((await download.path())!, 'utf8')
            );
            expect(exported.type).toBe('FeatureCollection');
            expect(exported.wsi).toEqual({
                slide_key: SLIDE_KEY,
                coordinates: 'level-0 image pixels',
                mpp: { x: MPP, y: MPP },
            });
            expect(
                exported.features.map((f: any) => f.geometry.type).sort()
            ).toEqual(['LineString', 'Point', 'Point', 'Point']);
            const exportedLine = exported.features.find(
                (f: any) => f.geometry.type === 'LineString'
            );
            expect(exportedLine.properties).toMatchObject({
                objectType: 'annotation',
                note: 'Depth of invasion, measured to the deepest cells.',
                name: 'Depth',
                classification: { name: 'Depth' },
            });
            expect(
                exportedLine.properties.measurements['Length µm']
            ).toBeGreaterThan(0);
            expect(JSON.stringify(exported)).not.toMatch(
                /sealed|image_?id|serving/i
            );
            expect(pageErrors).toEqual([]);
        });

        test("reviews another user's AI annotations without editing them", async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page, [
                seededAnnotation('model-1', 'Tumor', '40,40 140,40 140,140', {
                    source: 'precomputed',
                    model: 'luad-patterns',
                }),
                seededAnnotation(
                    'agent-1',
                    'Stroma',
                    '300,300 400,300 400,400',
                    {
                        source: 'agent',
                    }
                ),
                seededAnnotation(
                    'human-1',
                    'Necrosis',
                    '200,40 260,40 260,100'
                ),
            ]);
            await gotoSlide(page);

            const modelBadge = page.getByTestId('annotation-ai-badge-model-1');
            await expect(modelBadge).toHaveText('AI · unreviewed', {
                timeout: 15_000,
            });
            await expect(modelBadge).toHaveAttribute(
                'title',
                'Made by a model (luad-patterns); not reviewed yet'
            );
            await expect(
                page.getByTestId('annotation-ai-badge-agent-1')
            ).toHaveAttribute(
                'title',
                'Made by the research assistant; not reviewed yet'
            );
            await expect(
                page.getByTestId('annotation-ai-badge-human-1')
            ).toHaveCount(0);
            await expect(
                page.getByTestId('annotation-hide-unreviewed-ai')
            ).toBeVisible();

            // Another user's annotations offer no edit or delete; the AI
            // ones offer review.
            for (const id of ['model-1', 'agent-1', 'human-1']) {
                await expect(page.getByTestId(`edit-label-${id}`)).toHaveCount(
                    0
                );
                await expect(
                    page.getByTestId(`delete-annotation-${id}`)
                ).toHaveCount(0);
            }
            await expect(
                page.getByTestId('accept-annotation-human-1')
            ).toHaveCount(0);

            await page.getByTestId('accept-annotation-model-1').click();
            await expect(modelBadge).toHaveText('AI · accepted');
            await expect(
                page.getByTestId('accept-annotation-model-1')
            ).toHaveCount(0);

            await page.getByTestId('reject-annotation-agent-1').click();
            await expect(
                page.getByTestId('annotation-row-agent-1')
            ).toHaveCount(0);

            expect(
                service.writes.map(write => [
                    write.method,
                    write.path,
                    write.body,
                ])
            ).toEqual([
                [
                    'POST',
                    '/wsi/annotations/model-1/review',
                    { decision: 'accept', version: 1 },
                ],
                [
                    'POST',
                    '/wsi/annotations/agent-1/review',
                    { decision: 'reject', version: 1 },
                ],
            ]);
            // The rejected annotation is kept by the service.
            expect(
                service.rows.get('agent-1').body.provenance.review_status
            ).toBe('rejected');
            expect(
                service.rows.get('model-1').body.provenance.reviewed_by
            ).toBe(USER);
        });

        test('reviews AI annotations one by one from the review card', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page, [
                seededAnnotation('model-a', 'Tumor', '40,40 140,40 140,140', {
                    source: 'precomputed',
                    model: 'luad-patterns',
                }),
                seededAnnotation('model-b', 'Stroma', '300,40 400,40 400,140', {
                    source: 'model',
                }),
                seededAnnotation(
                    'agent-c',
                    'Necrosis',
                    '300,300 400,300 400,400',
                    { source: 'agent' }
                ),
                seededAnnotation(
                    'human-d',
                    'Margin',
                    '200,200 260,200 260,260'
                ),
            ]);
            await gotoSlide(page);

            const start = page.getByTestId('annotation-review-start');
            await expect(start).toHaveText('Review AI (3)', {
                timeout: 15_000,
            });
            await start.click();
            const card = page.getByRole('dialog', {
                name: 'Review AI annotations',
            });
            await expect(card).toBeVisible();
            await expect(
                page.getByTestId('annotation-review-accept')
            ).toBeFocused();
            const progress = page.getByTestId('annotation-review-progress');
            const label = page.getByTestId('annotation-review-label');
            await expect(progress).toHaveText('0 of 3 reviewed');
            // Nearest next from the top left: Tumor, Stroma, Necrosis.
            await expect(label).toHaveText('Tumor');
            await expect(
                page.getByTestId('annotation-review-origin')
            ).toHaveText('Made by a model (luad-patterns) · Layer Model');
            await expect(
                page.getByTestId('annotation-focus-highlight')
            ).toBeVisible();

            // S skips; A and R decide and move on.
            await page.keyboard.press('s');
            await expect(label).toHaveText('Stroma');
            await page.keyboard.press('a');
            await expect(progress).toHaveText('1 of 3 reviewed');
            await expect(label).toHaveText('Necrosis');
            // R rejects here; it does not pick the Shape tool.
            await page.keyboard.press('r');
            await expect(progress).toHaveText('2 of 3 reviewed');
            await expect(
                page.getByTestId('annotation-row-agent-c')
            ).toHaveCount(0);
            // The skipped one comes back.
            await expect(label).toHaveText('Tumor');
            await page.getByTestId('annotation-review-accept').click();
            await expect(progress).toHaveText('3 of 3 reviewed');
            await expect(
                page.getByTestId('annotation-review-done')
            ).toContainText('All 3 AI annotations reviewed.');
            await page.keyboard.press('Escape');
            await expect(card).toHaveCount(0);

            expect(
                service.writes.map(write => [write.path, write.body.decision])
            ).toEqual([
                ['/wsi/annotations/model-b/review', 'accept'],
                ['/wsi/annotations/agent-c/review', 'reject'],
                ['/wsi/annotations/model-a/review', 'accept'],
            ]);
            await expect(
                page.getByTestId('annotation-ai-badge-model-a')
            ).toHaveText('AI · accepted');
        });

        test('labels annotations on the slide and hides them all with H', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            await routeAnnotationService(page, [
                seededAnnotation(
                    'human-1',
                    'Necrosis',
                    '100,100 400,100 400,400'
                ),
                seededAnnotation('human-2', 'Margin', '40,430 160,430 160,500'),
            ]);
            await gotoSlide(page);
            await expect(
                page.getByTestId('annotation-row-human-1')
            ).toBeVisible({ timeout: 15_000 });
            const display = page.getByTestId('annotation-display-button');
            await display.click();
            await page.getByTestId('annotation-slide-labels').check();
            const label = page.getByTestId('annotation-slide-label-human-1');
            await expect(label).toHaveText('Necrosis');
            await page.keyboard.press('Escape');
            await expect(
                page.getByTestId('annotation-display-popover')
            ).toHaveCount(0);
            await expect(display).toBeFocused();

            // H hides every annotation on the slide, with Annotate off.
            await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
            await page.keyboard.press('h');
            await expect(display).toHaveAttribute(
                'aria-label',
                'Display (annotations hidden)'
            );
            await expect(label).toHaveCount(0);
            // The list still lists them.
            await expect(
                page.getByTestId('annotation-row-human-1')
            ).toBeVisible();
            await page.keyboard.press('h');
            await expect(display).toHaveAttribute('aria-label', 'Display');
            await expect(label).toBeVisible();
        });

        test('steps with ] and copies a link that opens the slide at an annotation', async ({
            page,
            context,
        }) => {
            await context.grantPermissions([
                'clipboard-read',
                'clipboard-write',
            ]);
            await openAnnotatedSlide(page, 2048);
            await routeAnnotationService(page, [
                seededAnnotation(
                    'human-1',
                    'Necrosis',
                    '100,100 300,100 300,300'
                ),
                seededAnnotation(
                    'human-2',
                    'Margin',
                    '1500,1500 1600,1500 1600,1600'
                ),
            ]);
            await gotoSlide(page);
            await expect(
                page.getByTestId('annotation-row-human-2')
            ).toBeVisible({ timeout: 15_000 });
            const status = page.getByTestId('annotation-focus-status');
            await page.keyboard.press(']');
            await expect(status).toHaveText('1 of 2: Necrosis');
            await page.keyboard.press(']');
            await expect(status).toHaveText('2 of 2: Margin');
            await expect(
                page.getByTestId('annotation-focus-highlight')
            ).toBeVisible();
            await page.getByTestId('annotation-focus-copy-link').click();
            await expect(
                page.getByTestId('annotation-link-message')
            ).toHaveText('Link to the annotation copied.');
            const link = await page.evaluate(() =>
                navigator.clipboard.readText()
            );
            const url = new URL(link);
            expect(url.pathname).toBe(`/wsi/patient/${PATIENT_ID}`);
            expect(url.searchParams.get('slideKey')).toBe(SLIDE_KEY);
            expect(url.searchParams.get('annotationId')).toBe('human-2');
            expect(link).not.toMatch(/image_?id|sealed/i);

            // The link opens the slide fitted to the annotation.
            await page.goto(link);
            await expect(status).toHaveText('2 of 2: Margin', {
                timeout: 30_000,
            });
            const highlight = page
                .getByTestId('annotation-focus-highlight')
                .locator('rect')
                .first();
            await expect(highlight).toBeVisible();
            // Fitted: the 100-pixel square fills a good part of the view.
            await expect
                .poll(async () => Number(await highlight.getAttribute('width')))
                .toBeGreaterThan(150);

            // A link to an annotation that is gone says so.
            const gone = new URL(link);
            gone.searchParams.set('annotationId', 'rejected-or-deleted');
            await page.goto(gone.toString());
            await expect(
                page.getByTestId('annotation-link-message')
            ).toContainText('The linked annotation is not on this slide', {
                timeout: 30_000,
            });
        });

        test('selects with Shift+drag, relabels in bulk and undoes it in one step', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const mine = (id: string, points: string) => ({
                ...seededAnnotation(id, 'Unsure', points),
                created_by: USER,
            });
            const service = await routeAnnotationService(page, [
                mine('mine-1', '40,40 120,40 120,120'),
                mine('mine-2', '160,40 240,40 240,120'),
                seededAnnotation('theirs', 'Unsure', '280,40 360,40 360,120'),
                mine('far', '400,400 480,400 480,480'),
            ]);
            await gotoSlide(page);
            await expect(page.getByTestId('annotation-row-far')).toBeVisible({
                timeout: 15_000,
            });
            // The labels on the slide show where the shapes are on screen:
            // each sits 2 pixels inside its shape's top-left corner.
            await page.getByTestId('annotation-display-button').click();
            await page.getByTestId('annotation-slide-labels').check();
            await page.keyboard.press('Escape');
            const corner = async (id: string) =>
                (await page
                    .getByTestId(`annotation-slide-label-${id}`)
                    .locator('rect')
                    .boundingBox())!;
            const a = await corner('mine-1');
            const b = await corner('mine-2');
            const scale = (b.x - a.x) / 120;
            const screenAt = (x: number, y: number) => ({
                x: a.x - 2 + (x - 40) * scale,
                y: a.y - 2 + (y - 40) * scale,
            });

            // Shift+drag with Select adds what lies inside the box, drawn
            // up and to the left (the zoom buttons are at the top left).
            const from = screenAt(380, 140);
            const to = screenAt(20, 20);
            await page.keyboard.down('Shift');
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            await page.mouse.move(to.x, to.y, { steps: 5 });
            await expect(
                page.getByTestId('annotation-selection-box')
            ).toBeVisible();
            await page.mouse.up();
            await page.keyboard.up('Shift');
            const count = page.getByTestId('annotation-bulk-count');
            await expect(count).toHaveText('3 selected');
            await expect(
                page.getByTestId('annotation-select-far')
            ).not.toBeChecked();
            await expect(
                page.getByTestId('annotation-selection-frame-theirs')
            ).toBeVisible();

            await page
                .getByLabel('New label for the selected annotations')
                .fill('Tumor');
            const relabel = page.getByTestId('annotation-bulk-relabel');
            await expect(relabel).toHaveText('Relabel (2)');
            await relabel.click();
            await expect(
                page.getByTestId('annotation-bulk-message')
            ).toHaveText(
                'Relabelled 2 annotations; skipped 1 that is not yours.'
            );
            // One all-or-nothing batch with both, each with its version.
            expect(
                service.writes.map(write => [write.method, write.path])
            ).toEqual([['POST', '/wsi/annotations/batch-update']]);
            expect(
                service.writes[0].body.items.map((item: any) => [
                    item.id,
                    item.version,
                ])
            ).toEqual([
                ['mine-1', 1],
                ['mine-2', 1],
            ]);
            expect(service.rows.get('mine-2').body.label).toBe('Tumor');
            expect(service.rows.get('theirs').body.label).toBe('Unsure');

            // One undo puts both labels back.
            await startAnnotating(page);
            const undo = page.getByTestId('annotation-undo');
            await expect(undo).toHaveAttribute(
                'title',
                /Undo edit of 2 annotations/
            );
            await undo.click();
            await expect
                .poll(() => service.rows.get('mine-1').body.label)
                .toBe('Unsure');
            expect(service.rows.get('mine-2').body.label).toBe('Unsure');

            await page.getByTestId('annotation-bulk-clear').click();
            await expect(page.getByTestId('annotation-bulk-bar')).toHaveCount(
                0
            );
        });

        test('paints a brush stroke of the chosen width in µm at any zoom', async ({
            page,
        }) => {
            // A slide large enough to zoom into.
            await openAnnotatedSlide(page, 2048);
            const service = await routeAnnotationService(page);
            const at = await gotoSlide(page);
            await startAnnotating(page);

            const width = page.getByTestId('annotation-brush-width');
            await expect(width).toHaveCount(0);
            await pickFromMenu(page, 'outline', 'brush');
            await expect(width).toHaveAttribute(
                'aria-label',
                'Brush width in micrometres'
            );
            await expect(width).toHaveValue('50');
            await expect(
                page.getByTestId('annotation-brush-unit-note')
            ).toHaveCount(0);
            // 25 µm at 0.25 µm per pixel: 100 image pixels.
            await width.selectOption('25');

            const centre = at(0.5, 0.5);
            const cursorDiameter = async () => {
                await page.mouse.move(centre.x + 1, centre.y);
                await page.mouse.move(centre.x, centre.y);
                return Number(
                    await page
                        .getByTestId('annotation-brush-cursor')
                        .getAttribute('data-diameter')
                );
            };
            const before = await cursorDiameter();
            expect(before).toBeGreaterThan(0);

            const stroke = async () => {
                const saves = service.writes.length;
                const start = at(0.4, 0.5);
                const end = at(0.6, 0.5);
                await page.mouse.move(start.x, start.y);
                await page.mouse.down();
                await page.mouse.move(end.x, end.y, { steps: 10 });
                await page.mouse.up();
                await expect.poll(() => service.writes.length).toBe(saves + 1);
                const points = polygonPoints(
                    service.writes[saves].body.target.selector.value
                );
                const ys = points.map(point => point.y);
                return Math.max(...ys) - Math.min(...ys);
            };
            expect(await stroke()).toBeCloseTo(100, -1);

            // Zoomed in, the cursor grows and the band covers the same tissue.
            const zoomIn = page.getByTitle('Zoom in');
            await zoomIn.click();
            await zoomIn.click();
            // The brush stayed on after the first stroke.
            await expect(
                page.getByTestId('annotation-tool-outline')
            ).toHaveAttribute('aria-pressed', 'true');
            await expect
                .poll(cursorDiameter, { timeout: 10_000 })
                .toBeGreaterThan(before * 1.5);
            expect(await stroke()).toBeCloseTo(100, -1);
        });

        test('downloads the view with the annotations shown on it', async ({
            page,
        }) => {
            await openAnnotatedSlide(page, 512, {
                skin_hide_download_controls: 'show',
            });
            await routeAnnotationService(page, [
                seededAnnotation(
                    'square',
                    'Necrosis',
                    '100,100 400,100 400,400 100,400'
                ),
                seededAnnotation('small', 'Margin', '40,430 160,430 160,500'),
            ]);
            await gotoSlide(page);
            await expect(page.getByTestId('annotation-row-small')).toBeVisible({
                timeout: 15_000,
            });
            // The labels on the slide give the shapes' places on screen:
            // each sits 2 pixels inside its shape's top-left corner.
            await page.getByTestId('annotation-display-button').click();
            await page.getByTestId('annotation-slide-labels').check();
            await page.keyboard.press('Escape');
            const corner = async (id: string) =>
                (await page
                    .getByTestId(`annotation-slide-label-${id}`)
                    .locator('rect')
                    .boundingBox())!;
            const a = await corner('square');
            const b = await corner('small');
            const scale = (a.x - b.x) / 60;
            const screenAt = (x: number, y: number) => ({
                x: a.x - 2 + (x - 100) * scale,
                y: a.y - 2 + (y - 100) * scale,
            });
            const slide = (await page
                .locator('.openseadragon-canvas canvas')
                .first()
                .boundingBox())!;

            /** Downloads the view; returns how red it is at screen points. */
            const download = async () => {
                const [file] = await Promise.all([
                    page.waitForEvent('download'),
                    page.getByTestId('wsi-download-button').click(),
                ]);
                expect(file.suggestedFilename()).toMatch(
                    new RegExp(
                        `^wsi-${PATIENT_ID}-${SLIDE_KEY}-x\\d+-y\\d+\\.jpg$`
                    )
                );
                const data = fs
                    .readFileSync((await file.path())!)
                    .toString('base64');
                const probes = {
                    // On the square's right edge, its bottom edge, and inside.
                    right: screenAt(400, 250),
                    bottom: screenAt(250, 400),
                    inside: screenAt(250, 250),
                };
                return page.evaluate(
                    async ({ data, slide, probes }) => {
                        const image = new Image();
                        image.src = `data:image/jpeg;base64,${data}`;
                        await image.decode();
                        const canvas = document.createElement('canvas');
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const context = canvas.getContext('2d')!;
                        context.drawImage(image, 0, 0);
                        const ratio = image.width / slide.width;
                        const red = (r: number, g: number, b: number) =>
                            r > 170 && g < 130 && b < 130;
                        const near = (point: { x: number; y: number }) => {
                            const cx = Math.round((point.x - slide.x) * ratio);
                            const cy = Math.round((point.y - slide.y) * ratio);
                            const reach = Math.ceil(3 * ratio);
                            const { data: px } = context.getImageData(
                                cx - reach,
                                cy - reach,
                                2 * reach + 1,
                                2 * reach + 1
                            );
                            for (let i = 0; i < px.length; i += 4) {
                                if (red(px[i], px[i + 1], px[i + 2])) {
                                    return true;
                                }
                            }
                            return false;
                        };
                        const all = context.getImageData(
                            0,
                            0,
                            canvas.width,
                            canvas.height
                        ).data;
                        let redPixels = 0;
                        for (let i = 0; i < all.length; i += 4) {
                            if (red(all[i], all[i + 1], all[i + 2])) {
                                redPixels += 1;
                            }
                        }
                        return {
                            right: near(probes.right),
                            bottom: near(probes.bottom),
                            inside: near(probes.inside),
                            redPixels,
                        };
                    },
                    { data, slide, probes }
                );
            };

            // The outline lands on the square's edges; inside is the light
            // fill only.
            const shown = await download();
            expect(shown).toMatchObject({
                right: true,
                bottom: true,
                inside: false,
            });
            expect(shown.redPixels).toBeGreaterThan(200);

            // With H, the download has no annotations either.
            await page.keyboard.press('h');
            await expect(
                page.getByTestId('annotation-display-button')
            ).toHaveAttribute('aria-label', 'Display (annotations hidden)');
            const hidden = await download();
            expect(hidden.redPixels).toBe(0);
        });

        test('opens the toolbar menus over the zoom buttons', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            await routeAnnotationService(page);
            await gotoSlide(page);
            await page.getByTestId('annotation-more-menu-button').click();
            const menu = page.getByRole('menu');
            await expect(menu).toBeVisible();
            const box = (await menu.boundingBox())!;
            // The nav buttons the open menu lies over: each is hidden by it.
            const covered: string[] = [];
            for (const name of ['Zoom in', 'Zoom out', 'Fit to view']) {
                const button = (await page
                    .getByRole('button', { name, exact: true })
                    .boundingBox())!;
                const x = button.x + button.width / 2;
                const y = button.y + button.height / 2;
                if (
                    x < box.x ||
                    x > box.x + box.width ||
                    y < box.y ||
                    y > box.y + box.height
                ) {
                    continue;
                }
                covered.push(name);
                const hit = await page.evaluate(
                    ([px, py]) =>
                        !!document
                            .elementFromPoint(px, py)
                            ?.closest('[role="menu"]'),
                    [x, y]
                );
                expect(hit, `${name} is under the menu`).toBe(true);
            }
            expect(covered.length).toBeGreaterThan(0);
        });

        test('keeps the drawing tool on for shape after shape until Esc', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page);
            const at = await gotoSlide(page);
            await startAnnotating(page);
            const shape = page.getByTestId('annotation-tool-shape');
            await pickFromMenu(page, 'shape', 'rectangle');
            await expect(shape).toHaveAttribute('aria-pressed', 'true');

            // Two rectangles back to back, without picking the tool again.
            for (const [fx, fy] of [
                [0.3, 0.3],
                [0.55, 0.55],
            ]) {
                const from = at(fx, fy);
                const to = at(fx + 0.12, fy + 0.1);
                const saves = service.writes.length;
                await page.mouse.move(from.x, from.y);
                await page.mouse.down();
                await page.mouse.move(to.x, to.y, { steps: 5 });
                await page.mouse.up();
                await expect.poll(() => service.writes.length).toBe(saves + 1);
                await expect(shape).toHaveAttribute('aria-pressed', 'true');
            }
            expect(
                service.writes.map(write => write.body.target.selector.value)
            ).toEqual([
                expect.stringMatching(/^<svg><rect /),
                expect.stringMatching(/^<svg><rect /),
            ]);
            // Each takes the next auto label.
            expect(service.writes.map(write => write.body.body.label)).toEqual([
                'Default 1',
                'Default 2',
            ]);
            await expect(page.getByTestId('annotation-tooltip')).toHaveCount(0);

            // Esc with nothing being drawn goes back to Select.
            await page.keyboard.press('Escape');
            await expect(
                page.getByTestId('annotation-tool-select')
            ).toHaveAttribute('aria-pressed', 'true');
            await expect(shape).toHaveAttribute('aria-pressed', 'false');
        });

        test('keeps shapes on their tissue when the slide is zoomed mid-gesture', async ({
            page,
        }) => {
            await openAnnotatedSlide(page, 2048);
            const service = await routeAnnotationService(page);
            const at = await gotoSlide(page);
            await startAnnotating(page);
            const preview = page.getByTestId('annotation-draw-preview');
            const rectSelector = (index: number) =>
                /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/
                    .exec(service.writes[index].body.target.selector.value)!
                    .slice(1)
                    .map(Number);

            // A rectangle drawn without zooming, for reference.
            const from = at(0.4, 0.4);
            const to = at(0.55, 0.5);
            await pickFromMenu(page, 'shape', 'rectangle');
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            await page.mouse.move(to.x, to.y, { steps: 5 });
            await page.mouse.up();
            await expect.poll(() => service.writes.length).toBe(1);

            // The same drag, zoomed in with the wheel at its end: the
            // outline grows with the tissue, and the same tissue is saved.
            // The rectangle tool is still on.
            await expect(
                page.getByTestId('annotation-tool-shape')
            ).toHaveAttribute('aria-pressed', 'true');
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            await page.mouse.move(to.x, to.y, { steps: 5 });
            const outline = preview.locator('rect');
            const width = Number(await outline.getAttribute('width'));
            for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
            await expect
                .poll(async () => Number(await outline.getAttribute('width')))
                .toBeGreaterThan(width * 1.5);
            await page.mouse.up();
            await expect.poll(() => service.writes.length).toBe(2);
            const [ax, ay, aw, ah] = rectSelector(0);
            const [bx, by, bw, bh] = rectSelector(1);
            expect(Math.abs(bx - ax)).toBeLessThan(2);
            expect(Math.abs(by - ay)).toBeLessThan(2);
            expect(Math.abs(bw - aw)).toBeLessThan(2);
            expect(Math.abs(bh - ah)).toBeLessThan(2);

            // A polygon closes on its first vertex where the zoom put it.
            await page.keyboard.press('p');
            await expect(
                page.getByTestId('annotation-tool-outline')
            ).toHaveAttribute('aria-label', 'Outline: Polygon (P)');
            const centre = at(0.5, 0.5);
            for (const [dx, dy] of [
                [-50, -50],
                [50, -50],
                [50, 50],
            ]) {
                await page.mouse.click(centre.x + dx, centre.y + dy);
            }
            const vertices = async () =>
                (
                    (await preview
                        .locator('polyline')
                        .getAttribute('points')) || ''
                )
                    .trim()
                    .split(/\s+/)
                    .map(pair => pair.split(',').map(Number));
            const [[x0]] = await vertices();
            await page.mouse.move(centre.x, centre.y);
            for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
            // Zoomed in about the centre, the first vertex moves away from it.
            await expect
                .poll(async () => (await vertices())[0][0])
                .toBeLessThan(x0 - 10);
            let last = NaN;
            await expect
                .poll(async () => {
                    const x = (await vertices())[0][0];
                    const settled = x === last;
                    last = x;
                    return settled;
                })
                .toBe(true);
            const box = (await page
                .locator('.openseadragon-container')
                .first()
                .boundingBox())!;
            const first = (await vertices())[0];
            await page.mouse.click(box.x + first[0], box.y + first[1]);
            await expect.poll(() => service.writes.length).toBe(3);
            const triangle = polygonPoints(
                service.writes[2].body.target.selector.value
            );
            expect(triangle).toHaveLength(3);
            // A right angle with equal sides, as clicked.
            const [p, q, r] = triangle;
            expect(Math.abs(q.y - p.y)).toBeLessThan(2);
            expect(Math.abs(r.x - q.x)).toBeLessThan(2);
            expect(Math.abs(q.x - p.x - (r.y - q.y))).toBeLessThan(2);
        });

        test('measures with a quick ruler that is never saved', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page);
            const at = await gotoSlide(page);
            await startAnnotating(page);
            await page.keyboard.press('m');
            const measure = page.getByTestId('annotation-tool-measure');
            await expect(measure).toHaveAttribute('aria-pressed', 'true');
            const a = at(0.3, 0.6);
            const b = at(0.7, 0.6);
            await page.mouse.move(a.x, a.y);
            await page.mouse.down();
            await page.mouse.move(b.x, b.y, { steps: 5 });
            await expect(
                page.getByTestId('annotation-draw-measurement')
            ).toHaveText(/^[\d.,]+ (µm|mm) · 0°$/);
            await page.mouse.up();
            const reading = page.getByTestId('annotation-ruler-text');
            await expect(reading).toHaveText(/^[\d.,]+ (µm|mm) · 0°$/);
            // Never sent, and not an annotation.
            await expect(page.getByTestId('annotation-list')).toHaveCount(0);
            expect(service.writes).toEqual([]);
            // Esc clears it and keeps the tool; Esc again goes to Select.
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('annotation-ruler')).toHaveCount(0);
            await expect(measure).toHaveAttribute('aria-pressed', 'true');
            await page.keyboard.press('Escape');
            await expect(
                page.getByTestId('annotation-tool-select')
            ).toHaveAttribute('aria-pressed', 'true');
            expect(service.writes).toEqual([]);
        });

        test('places a high-power field and counts the points inside it', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const point = (id: string, x: number, y: number) => ({
                ...seededAnnotation(id, 'Mitosis', '0,0 1,0 1,1'),
                created_by: USER,
                target: {
                    selector: {
                        type: 'SvgSelector',
                        value: `<svg><circle cx="${x}" cy="${y}" r="0" /></svg>`,
                    },
                },
            });
            const service = await routeAnnotationService(page, [
                point('p1', 256, 256),
                point('p2', 290, 256),
                point('p3', 256, 300),
                point('far', 20, 20),
            ]);
            const at = await gotoSlide(page);
            await startAnnotating(page);
            await pickFromMenu(page, 'shape', 'hpf');
            // A custom field of 0.01 mm²: a radius of about 226 pixels.
            await page
                .getByTestId('annotation-hpf-area')
                .selectOption('custom');
            const custom = page.getByTestId('annotation-hpf-area-custom');
            await custom.fill('0.01');
            await custom.press('Enter');
            const centre = at(0.5, 0.5);
            await page.mouse.click(centre.x, centre.y);
            await expect.poll(() => service.rows.size).toBe(5);
            const field = service.writes.find(
                write => write.path === '/wsi/annotations'
            )!.body;
            expect(field.body.label).toBe('HPF 1');
            expect(field.target.selector.value).toMatch(/^<svg><ellipse /);
            await expect(
                page.getByTestId(`annotation-points-inside-annotation-1`)
            ).toHaveText(/^Points inside: 3 \(Mitosis 3\) · [\d,.]+ per mm²$/, {
                timeout: 15_000,
            });
            await expect(
                page.getByTestId('annotation-hpf-rate-Mitosis')
            ).toHaveText('Mitosis330');
        });

        test('says when changes are being saved and when they are saved', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page);
            const at = await gotoSlide(page);
            await startAnnotating(page);
            const status = page.getByTestId('annotation-save-status');
            await expect(status).toHaveAttribute('role', 'status');
            service.control.hold = true;
            await page.keyboard.press('r');
            const a = at(0.35, 0.35);
            const b = at(0.55, 0.55);
            await page.mouse.move(a.x, a.y);
            await page.mouse.down();
            await page.mouse.move(b.x, b.y, { steps: 4 });
            await page.mouse.up();
            await expect(status).toHaveText('Saving… 1');
            service.release();
            await expect(status).toHaveText('Saved');
            expect(service.rows.size).toBe(1);
        });

        test('adds and edits a comment in an annotation thread', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page, [
                {
                    ...seededAnnotation(
                        'mine-1',
                        'Tumor',
                        '40,40 140,40 140,140'
                    ),
                    created_by: USER,
                },
            ]);
            await gotoSlide(page);
            const toggle = page.getByTestId(
                'annotation-comments-toggle-mine-1'
            );
            await expect(toggle).toHaveAttribute(
                'aria-label',
                'Comments on Tumor: 0',
                { timeout: 15_000 }
            );
            await toggle.click();
            const input = page.getByTestId('annotation-comment-input-mine-1');
            await expect(input).toBeFocused();
            await input.fill('Is this the deep margin?');
            await input.press('Control+Enter');
            await expect(
                page.getByTestId('annotation-comment-count-mine-1')
            ).toHaveText('1');
            await expect(input).toHaveValue('');
            const comment = service.comments.get('mine-1')![0];
            await page
                .getByTestId(`annotation-comment-edit-${comment.id}`)
                .click();
            const edit = page.getByTestId(
                `annotation-comment-edit-input-${comment.id}`
            );
            await edit.fill('Deep margin, 1 mm.');
            await page
                .getByTestId(`annotation-comment-edit-input-${comment.id}-save`)
                .click();
            await expect(
                page.getByTestId(`annotation-comment-body-${comment.id}`)
            ).toHaveText('Deep margin, 1 mm.');
            await expect(
                page.getByTestId(`annotation-comment-${comment.id}`)
            ).toContainText('(edited)');
            expect(
                service.writes.map(write => [write.method, write.path])
            ).toEqual([
                ['POST', '/wsi/annotations/mine-1/comments'],
                ['PUT', `/wsi/annotations/mine-1/comments/${comment.id}`],
            ]);
            // The annotation's own note is untouched.
            expect(service.rows.get('mine-1').body.comment).toBe('');
        });

        test('adds a slide note with tags', async ({ page }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page);
            await gotoSlide(page);
            const notes = page.getByTestId('wsi-slide-notes');
            await expect(notes).toContainText('No notes on this slide yet.', {
                timeout: 15_000,
            });
            await page
                .getByTestId('slide-note-new-text')
                .fill('Recut ordered for block A2');
            const tags = page.getByTestId('slide-note-new-tags');
            await tags.fill('QC');
            await tags.press('Enter');
            await tags.type('margin,');
            await page
                .getByTestId('slide-note-new-sharing')
                .selectOption('private');
            await page.getByTestId('slide-note-new-submit').click();
            await expect(notes).toContainText('Recut ordered for block A2');
            await expect(page.getByTestId('slide-notes-tag-QC')).toHaveText(
                'QC 1'
            );
            await expect(page.getByTestId('slide-note-new-text')).toBeFocused();
            const post = service.writes.find(
                write => write.path === '/wsi/slide-notes'
            )!;
            expect(post.body).toEqual({
                slide_id: SLIDE_KEY,
                study_id: STUDY_ID,
                text: 'Recut ordered for block A2',
                tags: ['QC', 'margin'],
                visible_to: null,
            });
            await expect(
                page.getByTestId('wsi-sidebar-section-slideNotes-toggle')
            ).toContainText('Slide notes (1)');
        });

        test('accepts AI annotations in bulk with one batch review', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page, [
                seededAnnotation('ai-1', 'Tumor', '40,40 140,40 140,140', {
                    source: 'precomputed',
                }),
                seededAnnotation('ai-2', 'Tumor', '200,40 300,40 300,140', {
                    source: 'precomputed',
                }),
            ]);
            await gotoSlide(page);
            await page.getByTestId('annotation-select-ai-1').check({
                timeout: 15_000,
            });
            await page.getByTestId('annotation-select-ai-2').check();
            const accept = page.getByTestId('annotation-bulk-accept');
            await expect(accept).toHaveText(/\(2\)/);
            await accept.click();
            await expect(
                page.getByTestId('annotation-bulk-message')
            ).toHaveText('Accepted 2 annotations.');
            expect(
                service.writes.map(write => [write.method, write.path])
            ).toEqual([['POST', '/wsi/annotations/batch-review']]);
            expect(service.writes[0].body.items).toEqual([
                { id: 'ai-1', version: 1, decision: 'accept' },
                { id: 'ai-2', version: 1, decision: 'accept' },
            ]);
            await expect(
                page.getByTestId('annotation-ai-badge-ai-2')
            ).toHaveText('AI · accepted');
        });

        test('undoes points dropped one after another in one step', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page);
            const at = await gotoSlide(page);
            await startAnnotating(page);
            await page.keyboard.press('.');
            for (const [fx, fy] of [
                [0.4, 0.4],
                [0.45, 0.4],
                [0.5, 0.4],
            ]) {
                const point = at(fx, fy);
                await page.mouse.click(point.x, point.y);
            }
            await expect.poll(() => service.rows.size).toBe(3);
            const undo = page.getByTestId('annotation-undo');
            await expect(undo).toHaveAttribute(
                'title',
                /Undo create of 3 points/
            );
            await undo.click();
            await expect.poll(() => service.rows.size).toBe(0);
            const deletes = service.writes.filter(
                write => write.path === '/wsi/annotations/batch-delete'
            );
            expect(deletes).toHaveLength(1);
            expect(deletes[0].body.items).toHaveLength(3);
            await expect(page.getByTestId('annotation-redo')).toHaveAttribute(
                'title',
                /Redo create of 3 points/
            );
            await page.getByTestId('annotation-redo').click();
            await expect.poll(() => service.rows.size).toBe(3);
        });

        test('imports GeoJSON in one batch request and reports refused features', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page);
            await gotoSlide(page);
            await startAnnotating(page);

            const feature = (label: string, x: number) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [x, 100] },
                properties: { name: label },
            });
            const [chooser] = await Promise.all([
                page.waitForEvent('filechooser'),
                moreMenu(page, 'annotation-import'),
            ]);
            await chooser.setFiles({
                name: 'cells.geojson',
                mimeType: 'application/geo+json',
                buffer: Buffer.from(
                    JSON.stringify({
                        type: 'FeatureCollection',
                        features: [
                            feature('Mitosis', 50),
                            feature('refuse', 100),
                            feature('Mitosis', 150),
                            {
                                type: 'Feature',
                                geometry: {
                                    type: 'Polygon',
                                    coordinates: [
                                        [
                                            [200, 200],
                                            [260, 200],
                                            [260, 260],
                                            [200, 200],
                                        ],
                                    ],
                                },
                                properties: { name: 'Tumor' },
                            },
                        ],
                    })
                ),
            });
            await expect(
                page.getByTestId('annotation-import-preview')
            ).toBeVisible();
            await page.getByTestId('annotation-import-confirm').click();
            await expect(
                page.getByRole('alert').filter({ hasText: 'Imported' })
            ).toContainText(
                'Imported 3 of 4 annotations; 1 could not be saved (#2: body.label: label is not allowed).',
                { timeout: 15_000 }
            );
            await expect.poll(() => service.rows.size).toBe(3);

            // One batch with all four, then the three the service accepted.
            const batches = service.writes.filter(
                write => write.path === '/wsi/annotations/batch'
            );
            expect(
                batches.map(write =>
                    write.body.annotations.map((item: any) => item.body.label)
                )
            ).toEqual([
                ['Mitosis', 'refuse', 'Mitosis', 'Tumor'],
                ['Mitosis', 'Mitosis', 'Tumor'],
            ]);
            expect(
                service.writes.filter(
                    write => write.path === '/wsi/annotations'
                )
            ).toHaveLength(0);

            // The import undoes as one step.
            await expect(page.getByTestId('annotation-undo')).toHaveAttribute(
                'title',
                /Undo create of 3 annotations/
            );
            await page.getByTestId('annotation-undo').click();
            await expect.poll(() => service.rows.size).toBe(0);

            // Redo creates the three again, in one step.
            await expect(page.getByTestId('annotation-redo')).toHaveAttribute(
                'title',
                /Redo create of 3 annotations/
            );
            await page.keyboard.press('Control+Shift+Z');
            await expect.poll(() => service.rows.size).toBe(3);
            await expect(page.getByTestId('annotation-undo')).toHaveAttribute(
                'title',
                /Undo create of 3 annotations/
            );
        });
    });
}
