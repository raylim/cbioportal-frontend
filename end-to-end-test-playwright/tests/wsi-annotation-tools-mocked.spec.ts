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
 * 422 naming it. Returns the rows and the writes it received.
 */
async function routeAnnotationService(page: Page, seed: any[] = []) {
    const rows = new Map<string, any>(seed.map(row => [row.id, row]));
    const writes: Array<{ method: string; path: string; body: any }> = [];
    let next = 0;
    const create = (item: any) => {
        const row = {
            ...item,
            id: `annotation-${++next}`,
            created_by: USER,
            version: 1,
            created_at: new Date().toISOString(),
        };
        rows.set(row.id, row);
        return row;
    };
    await page.route('**/wsi/annotations**', async (route: Route) => {
        const request = route.request();
        const method = request.method();
        const url = new URL(request.url());
        expect(url.searchParams.getAll('studyId')).toEqual([STUDY_ID]);
        if (method !== 'GET') {
            expect(request.headers()['x-requested-with']).toBe(
                'XMLHttpRequest'
            );
        }
        const parts = url.pathname.split('/');
        const id = decodeURIComponent(parts[3] || '');
        const body = request.postData()
            ? JSON.parse(request.postData()!)
            : null;
        if (method !== 'GET') writes.push({ method, path: url.pathname, body });
        const json = (status: number, value: unknown) =>
            route.fulfill({
                status,
                contentType: 'application/json',
                body: JSON.stringify(value),
            });
        if (method === 'GET') {
            return json(
                200,
                Array.from(rows.values()).filter(
                    row => row.body?.provenance?.review_status !== 'rejected'
                )
            );
        }
        if (method === 'POST' && id === 'batch') {
            const refused = body.annotations
                .map((item: any, index: number) =>
                    item.body.label === 'refuse' ? index : -1
                )
                .filter((index: number) => index >= 0);
            if (refused.length) {
                return json(422, {
                    detail: refused.map((index: number) => ({
                        loc: ['body', 'annotations', index, 'body', 'label'],
                        msg: 'label is not allowed',
                    })),
                });
            }
            return json(201, body.annotations.map(create));
        }
        if (method === 'POST' && !id) return json(201, create(body));
        const row = rows.get(id);
        if (!row) return json(404, { detail: 'Annotation not found' });
        if (method === 'POST' && parts[4] === 'review') {
            const source = String(row.body?.provenance?.source || '');
            if (!MACHINE_SOURCES.includes(source.toLowerCase())) {
                return json(403, {
                    detail: 'Only machine-made annotations can be reviewed',
                });
            }
            if (body.version !== row.version) {
                return json(409, { detail: 'Version conflict' });
            }
            const reviewed = {
                ...row,
                body: {
                    ...row.body,
                    provenance: {
                        ...row.body.provenance,
                        review_status:
                            body.decision === 'accept'
                                ? 'accepted'
                                : 'rejected',
                        reviewed_by: USER,
                        reviewed_at: new Date().toISOString(),
                    },
                },
                version: row.version + 1,
            };
            rows.set(id, reviewed);
            return json(200, reviewed);
        }
        if (row.created_by !== USER) {
            return json(403, {
                detail: 'Only the creator may change this annotation',
            });
        }
        if (method === 'PUT') {
            if (body.version !== row.version) {
                return json(409, { detail: 'Version conflict' });
            }
            const updated = {
                ...row,
                body: body.body ?? row.body,
                target: body.target ?? row.target,
                visible_to:
                    'visible_to' in body ? body.visible_to : row.visible_to,
                version: row.version + 1,
            };
            rows.set(id, updated);
            return json(200, updated);
        }
        rows.delete(id);
        return route.fulfill({ status: 204, body: '' });
    });
    return { rows, writes };
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
 * per pixel) with annotations on, signed in as `USER`.
 */
async function openAnnotatedSlide(page: Page, size = 512) {
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

            // A line shows its length while it is drawn, then in the list.
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
            await page.getByTestId('annotation-tool-point').click();
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
                page.getByTestId('annotation-export-all').click(),
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
                classification: { name: 'Default' },
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

        test('paints a brush stroke of the chosen width in µm at any zoom', async ({
            page,
        }) => {
            // A slide large enough to zoom into.
            await openAnnotatedSlide(page, 2048);
            const service = await routeAnnotationService(page);
            const at = await gotoSlide(page);

            await page.getByTestId('annotation-tool-brush').click();
            const width = page.getByTestId('annotation-brush-width');
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
            await page.getByTestId('annotation-tool-brush').click();
            await expect
                .poll(cursorDiameter, { timeout: 10_000 })
                .toBeGreaterThan(before * 1.5);
            expect(await stroke()).toBeCloseTo(100, -1);
        });

        test('imports GeoJSON in one batch request and reports refused features', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page);
            await gotoSlide(page);

            const feature = (label: string, x: number) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [x, 100] },
                properties: { name: label },
            });
            await page.getByTestId('annotation-import-file').setInputFiles({
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
        });
    });
}
