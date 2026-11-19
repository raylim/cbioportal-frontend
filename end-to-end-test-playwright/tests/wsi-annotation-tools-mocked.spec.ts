import * as fs from 'fs';
import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import {
    encodePng,
    MPP,
    routeAnnotationService,
    seededAnnotation,
    USER,
} from './wsi-annotation-mocks';
import {
    installFoundationMocks,
    makeSlideRow,
    PATIENT_ID,
    SLIDE_KEY,
    STUDY_ID,
    tileMetadata,
} from './wsi-foundation-mocks';

/**
 * Opens the mocked slide (`size` pixels square, 512 by default, at `MPP` µm
 * per pixel) with annotations on, signed in as `USER`; `config` adds to the
 * portal's config.
 */
async function openAnnotatedSlide(
    page: Page,
    size = 512,
    config: Record<string, unknown> = {},
    meta: Record<string, unknown> = {}
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
        ...meta,
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

/** The synthetic slide for the tissue tools: 4096 pixels, 5 levels. */
const TISSUE_SLIDE = 4096;
const TISSUE_META = {
    max_zoom: 4,
    levels: 5,
    level_dimensions: [4096, 2048, 1024, 512, 256].map(side => ({
        width: side,
        height: side,
    })),
    level_downsamples: [1, 2, 4, 8, 16],
    objective_power: 40,
};
type Disk = {
    x: number;
    y: number;
    r: number;
    color: [number, number, number];
};
/**
 * Pink tissue (radius 1300) holding a purple disk (radius 300), a white
 * lumen (radius 150), a brown disk (radius 150) and a lighter pink disk
 * (radius 160) close to the tissue's color; later disks lie over earlier.
 */
const TISSUE_DISKS: Disk[] = [
    { x: 2048, y: 2048, r: 1300, color: [232, 160, 205] },
    { x: 1500, y: 2000, r: 300, color: [120, 70, 165] },
    { x: 2600, y: 2100, r: 150, color: [243, 243, 243] },
    { x: 2200, y: 2900, r: 150, color: [150, 95, 50] },
    { x: 2500, y: 1500, r: 160, color: [248, 205, 230] },
];

function tissueColor(x: number, y: number): [number, number, number] {
    let color: [number, number, number] = [243, 243, 243];
    TISSUE_DISKS.forEach(disk => {
        if ((x - disk.x) ** 2 + (y - disk.y) ** 2 <= disk.r * disk.r) {
            color = disk.color;
        }
    });
    return color;
}

/**
 * Serves the synthetic slide's tiles (`/wsi/tiles/zxy/{z}/{x}/{y}`, level
 * `max_zoom` at full resolution); collects the tile URLs requested.
 */
async function routeTissueTiles(page: Page, requested: string[] = []) {
    const cache = new Map<string, Buffer>();
    await page.route('**/wsi/tiles/**', route => {
        const url = new URL(route.request().url());
        requested.push(url.pathname);
        const [z, x, y] = url.pathname
            .split('/')
            .slice(-3)
            .map(Number);
        const key = `${z}/${x}/${y}`;
        if (!cache.has(key)) {
            const downsample = 2 ** (TISSUE_META.max_zoom - z);
            cache.set(
                key,
                encodePng(256, 256, (i, j) =>
                    tissueColor(
                        (x * 256 + i + 0.5) * downsample,
                        (y * 256 + j + 0.5) * downsample
                    )
                )
            );
        }
        return route.fulfill({
            status: 200,
            contentType: 'image/png',
            body: cache.get(key)!,
        });
    });
    return requested;
}

/**
 * Opens the synthetic slide centred on image point (cx, cy) at viewport
 * zoom `z` (1: the slide's width fills the view); returns a mapping from
 * image pixels to the page.
 */
async function gotoTissueView(page: Page, cx: number, cy: number, z: number) {
    await page.goto(
        `/wsi/patient/${PATIENT_ID}?studyId=${STUDY_ID}#wsi:slide=${SLIDE_KEY}&x=${cx}&y=${cy}&z=${z}`
    );
    await expect(page.getByTestId('wsi-annotation-toolbar')).toBeVisible({
        timeout: 30_000,
    });
    const stage = page.locator('.openseadragon-container').first();
    const box = (await stage.boundingBox())!;
    const perScreen = TISSUE_SLIDE / (box.width * z);
    return (x: number, y: number) => ({
        x: box.x + box.width / 2 + (x - cx) / perScreen,
        y: box.y + box.height / 2 + (y - cy) / perScreen,
    });
}

/** Runs an item of the selection bar's Actions menu. */
async function bulkAction(page: Page, item: string) {
    await page.getByTestId('annotation-bulk-actions').click();
    await page.getByTestId(item).click();
}

/** Picks a shape operation from Actions ▸ Edit shapes. */
async function pickShapeOp(page: Page, operation: string) {
    await page.getByTestId('annotation-bulk-actions').click();
    await page.getByTestId('annotation-bulk-shape').click();
    await page.getByTestId(`annotation-shape-op-${operation}`).click();
}

/** The wand's outline once it has settled; its data attributes. */
async function settledOutline(page: Page) {
    const outline = page.getByTestId('annotation-tissue-outline');
    await expect(outline).toHaveAttribute('data-busy', 'false', {
        timeout: 20_000,
    });
    await expect(outline).not.toHaveAttribute('data-ms', '');
    return outline;
}

/** The subpaths (rings) of the wand's outline path. */
async function outlineRings(page: Page): Promise<number> {
    const d = await page
        .getByTestId('annotation-tissue-outline')
        .locator('path')
        .first()
        .getAttribute('d');
    return (d || '').split('M').length - 1;
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

/** A square region of the user's, `size` image pixels from (x, y). */
function ownSquare(
    id: string,
    label: string,
    x: number,
    y: number,
    size: number
) {
    return {
        ...seededAnnotation(
            id,
            label,
            `${x},${y} ${x + size},${y} ${x + size},${y + size} ${x},${y +
                size}`
        ),
        created_by: USER,
    };
}

/**
 * Image pixels to the page, from the selection frame of a selected region
 * whose bounds are `bounds` (the frame is 3 pixels outside them).
 */
async function imageToPage(
    page: Page,
    id: string,
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
) {
    const frame = (await page
        .getByTestId(`annotation-selection-frame-${id}`)
        .locator('rect')
        .first()
        .boundingBox())!;
    const x0 = frame.x + 3;
    const y0 = frame.y + 3;
    const sx = (frame.width - 6) / (bounds.maxX - bounds.minX);
    const sy = (frame.height - 6) / (bounds.maxY - bounds.minY);
    return (x: number, y: number) => ({
        x: x0 + (x - bounds.minX) * sx,
        y: y0 + (y - bounds.minY) * sy,
    });
}

/** Drags from `from` to `to` on the page. */
async function dragOnSlide(
    page: Page,
    from: { x: number; y: number },
    to: { x: number; y: number }
) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
}

/** The rings of a saved region selector: `<polygon>` or evenodd paths. */
function selectorRings(selector: string): number[][][] {
    const polygon = /<polygon points="([^"]+)"/.exec(selector);
    const toPairs = (text: string) =>
        text
            .trim()
            .split(/\s+/)
            .map(pair => pair.split(',').map(Number));
    if (polygon) return [toPairs(polygon[1])];
    const rings: number[][][] = [];
    const re = /d="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(selector))) {
        match[1]
            .split('Z')
            .map(part => part.replace(/[ML]/g, ' ').trim())
            .filter(Boolean)
            .forEach(part => rings.push(toPairs(part)));
    }
    return rings;
}

function ringArea(ring: number[][]): number {
    let twice = 0;
    ring.forEach(([x, y], i) => {
        const [nx, ny] = ring[(i + 1) % ring.length];
        twice += x * ny - nx * y;
    });
    return Math.abs(twice) / 2;
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
            // Measure, with "Keep as annotation" on, saves the line.
            await page.getByTestId('annotation-tool-measure').click();
            const keep = page.getByTestId('annotation-measure-keep');
            await expect(keep).not.toBeChecked();
            await keep.check();
            await expect(
                page.getByTestId('annotation-tool-measure')
            ).toHaveAttribute('aria-label', /kept as a line annotation/);
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
            await page.keyboard.press('c');
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
            // The point table is under Counts, collapsed by default.
            await expect(
                page.getByTestId('annotation-counts-summary')
            ).toHaveText('· 3 points');
            await page.getByTestId('annotation-counts-toggle').click();
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
            // Show hides the unreviewed AI annotations on the slide and in
            // the list, and the hint says how many are hidden.
            const unreviewedChip = page.getByTestId(
                'annotation-show-chip-aiUnreviewed'
            );
            await expect(unreviewedChip).toHaveText('AI unreviewed 2');
            await unreviewedChip.click();
            await expect(unreviewedChip).toHaveAttribute(
                'aria-pressed',
                'false'
            );
            await expect(
                page.getByTestId('annotation-row-model-1')
            ).toHaveCount(0);
            await expect(
                page.getByTestId('annotation-hidden-count')
            ).toHaveText('2 hidden by filters');
            await expect(
                page.getByTestId('annotation-review-start')
            ).toHaveAttribute('aria-disabled', 'true');
            await page.getByTestId('annotation-show-everything').click();
            await expect(
                page.getByTestId('annotation-hidden-hint')
            ).toHaveCount(0);
            await expect(modelBadge).toBeVisible();

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

            // Reject asks first, saying what it does.
            const asked = new Promise<string>(resolve =>
                page.once('dialog', dialog => {
                    resolve(dialog.message());
                    void dialog.accept();
                })
            );
            await page.getByTestId('reject-annotation-agent-1').click();
            expect(await asked).toMatch(
                /^Reject ".*"\? It is hidden for everyone; the service keeps it as a review record\. Undo \(Ctrl\+Z\) can take the reject back\.$/
            );
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

            // S skips; A accepts and X, confirmed, rejects; each moves on.
            await page.keyboard.press('s');
            await expect(label).toHaveText('Stroma');
            await page.keyboard.press('a');
            await expect(progress).toHaveText('1 of 3 reviewed');
            await expect(label).toHaveText('Necrosis');
            // X asks first; R does nothing while reviewing.
            await page.keyboard.press('r');
            await page.keyboard.press('x');
            await expect(
                page.getByTestId('annotation-review-reject')
            ).toHaveText(/^Confirm reject/);
            await expect(progress).toHaveText('1 of 3 reviewed');
            await page.keyboard.press('x');
            await expect(progress).toHaveText('2 of 3 reviewed');
            await expect(
                page.getByTestId('annotation-row-agent-c')
            ).toHaveCount(0);
            // The skipped one comes back.
            await expect(label).toHaveText('Tumor');
            // Enter accepts as A does.
            await page.keyboard.press('Enter');
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

            // Actions ▾ › Relabel… opens a field in the bar.
            await bulkAction(page, 'annotation-bulk-relabel-start');
            const field = page.getByLabel(
                'New label for the selected annotations'
            );
            await expect(field).toBeFocused();
            await field.fill('Tumor');
            const relabel = page.getByTestId('annotation-bulk-relabel');
            await expect(relabel).toHaveText('Relabel 2');
            await relabel.click();
            await expect(
                page.getByTestId('annotation-bulk-message')
            ).toHaveText(
                'Relabelled 2 annotations; skipped 1 that is not yours.'
            );
            await expect(
                page.getByTestId('annotation-bulk-undo-note')
            ).toHaveText(/with Ctrl\+Z or the toolbar's Undo\.$/);
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

            await bulkAction(page, 'annotation-bulk-clear');
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
            // Settled: OpenSeadragon's animation has finished.
            await expect(
                page.locator('[data-wsi-animating]').first()
            ).toHaveAttribute('data-wsi-animating', 'false');
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
            await page.getByTestId('annotation-tool-hpf').click();
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
            // Count, per 10 HPF, then per mm² of the field, under Counts.
            await page.getByTestId('annotation-counts-toggle').click();
            await expect(
                page.getByTestId('annotation-hpf-rate-Mitosis')
            ).toHaveText(/^Mitosis330[\d,.]+$/);
        });

        test('says when changes are being saved and when they are saved', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page);
            const at = await gotoSlide(page);
            await startAnnotating(page);
            const status = page.getByTestId('annotation-save-status');
            await expect(
                page.getByTestId('annotation-save-status-live')
            ).toHaveAttribute('role', 'status');
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

        test('takes a reject back with Undo: the annotation is unreviewed again', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page, [
                seededAnnotation('ai-1', 'Tumor', '40,40 140,40 140,140', {
                    source: 'precomputed',
                }),
            ]);
            await gotoSlide(page);
            const badge = page.getByTestId('annotation-ai-badge-ai-1');
            await expect(badge).toHaveText('AI · unreviewed', {
                timeout: 15_000,
            });
            const asked = new Promise<string>(resolve =>
                page.once('dialog', dialog => {
                    resolve(dialog.message());
                    void dialog.accept();
                })
            );
            await page.getByTestId('reject-annotation-ai-1').click();
            expect(await asked).toBe(
                'Reject "Tumor"? It is hidden for everyone; the service keeps it as a review record. Undo (Ctrl+Z) can take the reject back.'
            );
            await expect(page.getByTestId('annotation-row-ai-1')).toHaveCount(
                0
            );
            await startAnnotating(page);
            const undo = page.getByTestId('annotation-undo');
            await expect(undo).toHaveAttribute('title', /^Undo reject/);
            await undo.click();
            await expect(badge).toHaveText('AI · unreviewed');
            await expect(
                page.getByTestId('accept-annotation-ai-1')
            ).toBeVisible();
            expect(
                service.writes.map(write => [write.path, write.body])
            ).toEqual([
                [
                    '/wsi/annotations/ai-1/review',
                    { decision: 'reject', version: 1 },
                ],
                [
                    '/wsi/annotations/ai-1/review',
                    { decision: 'reset', version: 2 },
                ],
            ]);
            expect(
                service.rows.get('ai-1').body.provenance.review_status
            ).toBeUndefined();
        });

        test('undoes the delete of an annotation with a comment: same annotation, comment kept', async ({
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
            service.comments.set('mine-1', [
                {
                    id: 'comment-a',
                    annotation_id: 'mine-1',
                    study_id: STUDY_ID,
                    author: 'colleague',
                    body: 'Is this the deep margin?',
                    created_at: '2026-11-18T10:00:00Z',
                    updated_at: '2026-11-18T10:00:00Z',
                },
            ]);
            await gotoSlide(page);
            const toggle = page.getByTestId(
                'annotation-comments-toggle-mine-1'
            );
            await expect(toggle).toHaveAttribute(
                'aria-label',
                'Comments on Tumor: 1',
                { timeout: 15_000 }
            );
            const asked = new Promise<string>(resolve =>
                page.once('dialog', dialog => {
                    resolve(dialog.message());
                    void dialog.accept();
                })
            );
            await page.getByTestId('delete-annotation-mine-1').click();
            expect(await asked).toBe(
                'Delete annotation "Tumor"? "Tumor" has 1 comment, all by other users. Undo (Ctrl+Z) brings it back with its comments; otherwise the service removes deleted annotations and their comments for good after 30 days (its default).'
            );
            await expect(page.getByTestId('annotation-row-mine-1')).toHaveCount(
                0
            );
            expect(service.deleted.has('mine-1')).toBe(true);
            await startAnnotating(page);
            const undo = page.getByTestId('annotation-undo');
            await expect(undo).toHaveAttribute('title', /^Undo delete/);
            await undo.click();
            // Back under the same id, with its thread.
            await expect(toggle).toHaveAttribute(
                'aria-label',
                'Comments on Tumor: 1'
            );
            await toggle.click();
            await expect(
                page.getByTestId('annotation-comment-body-comment-a')
            ).toHaveText('Is this the deep margin?');
            expect(
                service.writes.map(write => [
                    write.method,
                    write.path,
                    write.body,
                ])
            ).toEqual([
                ['DELETE', '/wsi/annotations/mine-1', null],
                ['POST', '/wsi/annotations/mine-1/restore', { version: 1 }],
            ]);
            expect(service.rows.get('mine-1').version).toBe(2);
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
            await page.getByTestId('annotation-bulk-actions').click();
            const accept = page.getByTestId('annotation-bulk-accept');
            await expect(accept).toHaveText('Accept 2Ctrl+Z undoes');
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
            await page.keyboard.press('c');
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

        test('cuts a hole in a region: the area drops and a click in the hole picks nothing', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page, [
                ownSquare('region', 'Tumor', 156, 156, 200),
            ]);
            await gotoSlide(page);
            await startAnnotating(page);
            await page.getByTestId('annotation-select-region').check();
            const at = await imageToPage(page, 'region', {
                minX: 156,
                minY: 156,
                maxX: 356,
                maxY: 356,
            });
            await expect(
                page.getByTestId('annotation-measurement-region')
            ).toHaveText('Area 2,500 µm² · Perimeter 200 µm');
            await pickShapeOp(page, 'cut');
            await expect(
                page.getByTestId('annotation-shape-edit-hint')
            ).toContainText('Cut a hole: draw a shape inside "Tumor"');
            await pickFromMenu(page, 'shape', 'rectangle');
            await dragOnSlide(page, at(216, 216), at(296, 296));
            await expect(
                page.getByTestId('annotation-bulk-message')
            ).toHaveText('Cut the shape out of "Tumor".');
            // One versioned PUT of the region with its hole; nothing created.
            expect(
                service.writes.map(write => [write.method, write.path])
            ).toEqual([['PUT', '/wsi/annotations/region']]);
            const selector = service.rows.get('region').target.selector.value;
            expect(selector).toMatch(
                /^<svg><g><path fill-rule="evenodd" d="M /
            );
            const [outer, hole] = selectorRings(selector);
            const holeArea = ringArea(hole);
            expect(holeArea).toBeGreaterThan(70 * 70);
            expect(holeArea).toBeLessThan(90 * 90);
            const area = (ringArea(outer) - holeArea) * MPP * MPP;
            await expect(
                page.getByTestId('annotation-measurement-region')
            ).toHaveText(
                new RegExp(
                    `^Area ${Math.round(area).toLocaleString(
                        'en-US'
                    )} µm² · Perimeter`
                )
            );
            if (process.env.WSI_SHOT_DIR) {
                await page.screenshot({
                    path: `${process.env.WSI_SHOT_DIR}/cut-hole.png`,
                });
            }
            // Back to Select: Shift+click in the hole selects nothing, on
            // the region it toggles it.
            await page.getByTestId('annotation-shape-edit-done').click();
            const [hx, hy] = [
                (hole[0][0] + hole[2][0]) / 2,
                (hole[0][1] + hole[2][1]) / 2,
            ];
            await page.keyboard.down('Shift');
            await page.mouse.click(at(hx, hy).x, at(hx, hy).y);
            await expect(page.getByTestId('annotation-bulk-count')).toHaveText(
                '1 selected'
            );
            await page.mouse.click(at(180, 180).x, at(180, 180).y);
            await page.keyboard.up('Shift');
            await expect(page.getByTestId('annotation-bulk-count')).toHaveCount(
                0
            );
            // Undo puts the square back.
            await page.getByTestId('annotation-undo').click();
            await expect
                .poll(() => service.rows.get('region').target.selector.value)
                .toMatch(/^<svg><polygon /);
        });

        test("merges two of the user's regions into one, and undoes it", async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page, [
                ownSquare('a', 'A', 156, 156, 120),
                ownSquare('b', 'B', 236, 156, 120),
            ]);
            await gotoSlide(page);
            await startAnnotating(page);
            await page.getByTestId('annotation-select-a').check();
            await page.getByTestId('annotation-select-b').check();
            await pickShapeOp(page, 'merge');
            await expect(
                page.getByTestId('annotation-bulk-message')
            ).toHaveText('Merged 2 regions into "A".');
            await expect.poll(() => service.rows.size).toBe(1);
            const merged = Array.from(service.rows.values())[0];
            expect(merged.body).toMatchObject({
                label: 'A',
                provenance: {
                    source: 'manual',
                    operation: 'merge',
                    derived_from: ['a', 'b'],
                },
            });
            // The union of two overlapping squares is one 200×120 polygon.
            const rings = selectorRings(merged.target.selector.value);
            expect(rings).toHaveLength(1);
            expect(ringArea(rings[0])).toBe(200 * 120);
            expect(
                service.writes.map(write => [write.method, write.path])
            ).toEqual([
                ['POST', '/wsi/annotations/batch'],
                ['POST', '/wsi/annotations/batch-delete'],
            ]);
            await expect(page.getByTestId('annotation-bulk-count')).toHaveText(
                '1 selected'
            );
            if (process.env.WSI_SHOT_DIR) {
                await page.screenshot({
                    path: `${process.env.WSI_SHOT_DIR}/merge.png`,
                });
            }

            const undo = page.getByTestId('annotation-undo');
            await expect(undo).toHaveAttribute('title', /Undo merge/);
            await undo.click();
            await expect.poll(() => service.rows.size).toBe(2);
            expect(
                Array.from(service.rows.values())
                    .map(row => row.body.label)
                    .sort()
            ).toEqual(['A', 'B']);
            await expect(page.getByTestId('annotation-redo')).toHaveAttribute(
                'title',
                /Redo merge/
            );
        });

        test("keeps another user's shared region in a merge and says so", async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page, [
                ownSquare('mine', 'Mine', 156, 156, 120),
                seededAnnotation(
                    'theirs',
                    'Theirs',
                    '236,156 356,156 356,276 236,276'
                ),
            ]);
            await gotoSlide(page);
            await startAnnotating(page);
            await page.getByTestId('annotation-select-mine').check();
            await page.getByTestId('annotation-select-theirs').check();
            await pickShapeOp(page, 'merge');
            await expect(
                page.getByTestId('annotation-bulk-message')
            ).toHaveText(
                'Merged 2 regions into "Mine". Kept "Theirs": it is not yours, so it stays as it is.'
            );
            await expect.poll(() => service.rows.size).toBe(2);
            expect(service.rows.has('theirs')).toBe(true);
            expect(service.rows.get('theirs').version).toBe(1);
            expect(service.rows.has('mine')).toBe(false);
            const merged = Array.from(service.rows.values()).find(
                row => row.id !== 'theirs'
            );
            expect(merged.created_by).toBe(USER);
            expect(merged.body.provenance.derived_from).toEqual([
                'mine',
                'theirs',
            ]);
            await expect(
                page.getByTestId('annotation-row-theirs')
            ).toBeVisible();
        });

        test('splits a region along a line drawn across it', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const service = await routeAnnotationService(page, [
                ownSquare('region', 'Tumor', 156, 156, 200),
            ]);
            await gotoSlide(page);
            await startAnnotating(page);
            await page.getByTestId('annotation-select-region').check();
            const at = await imageToPage(page, 'region', {
                minX: 156,
                minY: 156,
                maxX: 356,
                maxY: 356,
            });
            await pickShapeOp(page, 'split');
            // The split's line is Measure kept as an annotation.
            await expect(
                page.getByTestId('annotation-tool-measure')
            ).toHaveAttribute('aria-pressed', 'true');
            await expect(
                page.getByTestId('annotation-measure-keep')
            ).toBeChecked();
            // Across the lower part, away from the toolbar over the slide.
            await dragOnSlide(page, at(130, 300), at(380, 300));
            await expect(
                page.getByTestId('annotation-bulk-message')
            ).toHaveText('Split "Tumor" into 2 pieces.');
            await expect.poll(() => service.rows.size).toBe(2);
            // The region keeps the larger piece; the other is new, same label.
            const areas = Array.from(service.rows.values())
                .map(row =>
                    ringArea(selectorRings(row.target.selector.value)[0])
                )
                .sort((x, y) => y - x);
            expect(areas[0] + areas[1]).toBeGreaterThan(200 * 200 - 200);
            expect(areas[1]).toBeGreaterThan(45 * 200);
            expect(areas[1]).toBeLessThan(65 * 200);
            expect(
                Array.from(service.rows.values()).map(row => row.body.label)
            ).toEqual(['Tumor', 'Tumor']);
            await expect(page.getByTestId('annotation-bulk-count')).toHaveText(
                '2 selected'
            );
            if (process.env.WSI_SHOT_DIR) {
                await page.screenshot({
                    path: `${process.env.WSI_SHOT_DIR}/split.png`,
                });
            }
            await page.getByTestId('annotation-undo').click();
            await expect.poll(() => service.rows.size).toBe(1);
            await expect
                .poll(() => service.rows.get('region').target.selector.value)
                .toBe(
                    '<svg><polygon points="156,156 356,156 356,356 156,356" /></svg>'
                );
        });

        test('exports a region with a hole as a GeoJSON Polygon with an inner ring', async ({
            page,
        }) => {
            await openAnnotatedSlide(page);
            const holed = {
                ...ownSquare('holed', 'Tumor', 0, 0, 1),
                target: {
                    selector: {
                        type: 'SvgSelector',
                        value:
                            '<svg><g><path fill-rule="evenodd" d="M 100,100 L 400,100 L 400,400 L 100,400 Z M 200,200 L 300,200 L 300,300 L 200,300 Z" /></g></svg>',
                    },
                },
            };
            const parts = {
                ...ownSquare('parts', 'Parts', 0, 0, 1),
                target: {
                    selector: {
                        type: 'SvgSelector',
                        value:
                            '<svg><g><path fill-rule="evenodd" d="M 10,10 L 50,10 L 50,50 Z" /><path fill-rule="evenodd" d="M 450,450 L 500,450 L 500,500 Z" /></g></svg>',
                    },
                },
            };
            await routeAnnotationService(page, [holed, parts]);
            await gotoSlide(page);
            // Area: (300² - 100²) px at 0.25 µm per pixel = 5,000 µm².
            await expect(
                page.getByTestId('annotation-measurement-holed')
            ).toHaveText('Area 5,000 µm² · Perimeter 400 µm', {
                timeout: 15_000,
            });
            const [download] = await Promise.all([
                page.waitForEvent('download'),
                moreMenu(page, 'annotation-export-all'),
            ]);
            const exported = JSON.parse(
                fs.readFileSync((await download.path())!, 'utf8')
            );
            const byId = (id: string) =>
                exported.features.find((f: any) => f.id === id);
            expect(byId('holed').geometry).toEqual({
                type: 'Polygon',
                coordinates: [
                    [
                        [100, 100],
                        [400, 100],
                        [400, 400],
                        [100, 400],
                        [100, 100],
                    ],
                    [
                        [200, 200],
                        [300, 200],
                        [300, 300],
                        [200, 300],
                        [200, 200],
                    ],
                ],
            });
            expect(byId('holed').properties.measurements['Area µm^2']).toBe(
                5000
            );
            expect(byId('parts').geometry.type).toBe('MultiPolygon');
            expect(byId('parts').geometry.coordinates).toHaveLength(2);
        });
    });

    test.describe('WSI annotation toolbar layout', () => {
        // 1920: wide. 1600 with both sidebars open: a viewer of at most
        // about 1,100 pixels (944 on this page), still one row.
        for (const width of [1920, 1600]) {
            test(`keeps the tools on one row and in place whatever tool is on, ${width} px`, async ({
                page,
            }) => {
                await page.setViewportSize({ width, height: 900 });
                await openAnnotatedSlide(page, 2048);
                // A long layer name, as AI pattern maps have, widens the
                // layer choice to its limit.
                const long = seededAnnotation(
                    'pattern',
                    'Micropapillary region (3 tiles)',
                    '1800,1800 1900,1800 1900,1900',
                    { source: 'precomputed', model: 'keep-v0.2' }
                );
                long.body.layer_name = 'AI pattern map (LUAD): Micropapillary';
                long.body.type = `${long.body.layer_name}|#9333ea`;
                const service = await routeAnnotationService(page, [long]);
                const at = await gotoSlide(page);
                await startAnnotating(page);
                await expect(
                    page.getByTestId('wsi-metadata-sidebar')
                ).toBeVisible();
                await expect(page.getByTestId('wsi-nav-hide')).toBeVisible();
                const viewer = (await page
                    .locator('.openseadragon-container')
                    .first()
                    .boundingBox())!;
                if (width === 1600) {
                    expect(viewer.width).toBeLessThanOrEqual(1100);
                }
                const fixed = [
                    'annotation-mode-toggle',
                    'annotation-tool-select',
                    'annotation-tool-shape',
                    'annotation-tool-outline',
                    'annotation-tool-point',
                    'annotation-tool-hpf',
                    'annotation-tool-measure',
                    'annotation-drawing-as',
                    'annotation-undo',
                    'annotation-display-button',
                    'annotation-more-menu-button',
                ];
                const boxes = async () => {
                    const out: Record<string, string> = {};
                    for (const id of fixed) {
                        const box = (await page.getByTestId(id).boundingBox())!;
                        out[id] = [box.x, box.y, box.width, box.height]
                            .map(value => value.toFixed(1))
                            .join(',');
                    }
                    return out;
                };
                // One row: every control's middle at the same height.
                const middles = async () => {
                    const out = new Set<number>();
                    for (const id of fixed) {
                        const box = (await page.getByTestId(id).boundingBox())!;
                        out.add(Math.round(box.y + box.height / 2));
                    }
                    return out.size;
                };
                expect(await middles()).toBe(1);
                const before = await boxes();
                const shot = async (name: string) => {
                    if (process.env.WSI_SHOT_DIR) {
                        await page.screenshot({
                            path: `${process.env.WSI_SHOT_DIR}/${process.env
                                .WSI_SHOT_PREFIX ||
                                ''}toolbar-${width}-${name}.png`,
                            clip: {
                                x: viewer.x,
                                y: viewer.y - 4,
                                width: viewer.width,
                                height: 110,
                            },
                        });
                    }
                };
                await shot('select');
                const steps: Array<[string, () => Promise<void>]> = [
                    [
                        'rectangle',
                        () => pickFromMenu(page, 'shape', 'rectangle'),
                    ],
                    ['ellipse', () => pickFromMenu(page, 'shape', 'ellipse')],
                    ['circle', () => pickFromMenu(page, 'shape', 'circle')],
                    [
                        'hpf',
                        () => page.getByTestId('annotation-tool-hpf').click(),
                    ],
                    ['line', () => page.keyboard.press('l')],
                    ['measure', () => page.keyboard.press('m')],
                    [
                        'measure-keep',
                        () =>
                            page.getByTestId('annotation-measure-keep').check(),
                    ],
                    ['polygon', () => pickFromMenu(page, 'outline', 'polygon')],
                    [
                        'freehand',
                        () => pickFromMenu(page, 'outline', 'freehand'),
                    ],
                    ['brush', () => pickFromMenu(page, 'outline', 'brush')],
                    [
                        'smartBrush',
                        () => pickFromMenu(page, 'outline', 'smartBrush'),
                    ],
                    ['wand', () => pickFromMenu(page, 'outline', 'wand')],
                    ['point', () => page.keyboard.press('c')],
                ];
                for (const [name, pick] of steps) {
                    await pick();
                    await shot(name);
                    expect(await boxes(), name).toEqual(before);
                }
                // Points dropped: the count grows and "Saving…"/"Saved" show.
                await page.mouse.click(at(0.3, 0.6).x, at(0.3, 0.6).y);
                await page.mouse.click(at(0.35, 0.6).x, at(0.35, 0.6).y);
                await expect(
                    page.getByTestId('annotation-point-count')
                ).toContainText(': 2');
                await page.keyboard.press('Escape');
                await expect
                    .poll(() => service.writes.length)
                    .toBeGreaterThan(0);
                await expect(
                    page.getByTestId('annotation-save-status')
                ).toHaveText('Saved');
                await shot('saved');
                expect(await boxes(), 'saved').toEqual(before);
                expect(await middles()).toBe(1);
            });
        }
    });

    test.describe('WSI tissue tools', () => {
        test('outlines tissue with the magic wand: tolerance, Shift adds, Alt cuts, saves and undoes', async ({
            page,
        }) => {
            await openAnnotatedSlide(page, TISSUE_SLIDE, {}, TISSUE_META);
            const tiles = await routeTissueTiles(page);
            const service = await routeAnnotationService(page);
            // Zoomed out (about 7×): the wand fetches 10× tiles.
            const at = await gotoTissueView(page, 2048, 2048, 0.8);
            await startAnnotating(page);
            const magnification = await page
                .getByTestId('wsi-magnification')
                .textContent();
            await page.keyboard.press('w');
            await expect(
                page.getByTestId('annotation-tool-outline')
            ).toHaveAttribute('aria-pressed', 'true');
            const value = page.getByTestId('annotation-tissue-tolerance-value');
            await expect(value).toHaveText('15');
            const fetchedBefore = tiles.length;
            const purple = at(1500, 2000);
            await page.mouse.click(purple.x, purple.y);
            const outline = await settledOutline(page);
            await expect(outline).toHaveAttribute('data-source', 'tiles');
            // Level 2 (10×, downsample 4) tiles were fetched for it.
            expect(
                tiles.slice(fetchedBefore).some(path => /\/zxy\/2\//.test(path))
            ).toBe(true);
            await expect(
                page.getByTestId('annotation-tissue-source')
            ).toContainText('10× tiles');
            expect(await outlineRings(page)).toBe(1);
            // Dragging the press up 20 pixels raises the tolerance by 10; a
            // scroll down lowers it by 1 and does not zoom.
            await page.mouse.move(purple.x, purple.y);
            await page.mouse.down();
            await page.mouse.move(purple.x, purple.y - 10);
            await page.mouse.move(purple.x, purple.y - 20);
            await page.mouse.up();
            await expect(value).toHaveText('25');
            await expect(
                page.getByTestId('annotation-tissue-tolerance-chip')
            ).toHaveText('Tolerance 25');
            await page.mouse.wheel(0, 100);
            await expect(value).toHaveText('24');
            await expect(page.getByTestId('wsi-magnification')).toHaveText(
                magnification!
            );
            await settledOutline(page);
            // Shift+click adds the brown disk: two parts.
            const brown = at(2200, 2900);
            await page.keyboard.down('Shift');
            await page.mouse.click(brown.x, brown.y);
            await page.keyboard.up('Shift');
            await expect.poll(() => outlineRings(page)).toBe(2);
            await settledOutline(page);
            if (process.env.WSI_SHOT_DIR) {
                await page.screenshot({
                    path: `${process.env.WSI_SHOT_DIR}/wand-shift-add.png`,
                });
            }
            await page.keyboard.press('Enter');
            await expect.poll(() => service.writes.length).toBe(1);
            expect(service.writes[0].method).toBe('POST');
            const saved = service.writes[0].body.target.selector.value;
            expect(selectorRings(saved)).toHaveLength(2);
            const purpleArea =
                ringArea(selectorRings(saved)[0]) +
                ringArea(selectorRings(saved)[1]);
            const expected = Math.PI * (300 * 300 + 150 * 150);
            expect(purpleArea / expected).toBeGreaterThan(0.95);
            expect(purpleArea / expected).toBeLessThan(1.05);
            await expect(
                page.getByTestId('annotation-tissue-outline')
            ).toHaveCount(0);
            // Undo deletes it.
            await page.getByTestId('annotation-undo').click();
            await expect.poll(() => service.writes.length).toBe(2);
            expect(service.writes[1].method).toBe('DELETE');

            // The pink tissue at 24 takes in the lighter disk; Alt+click on
            // it, dragged down to 4, cuts it out as a hole.
            const pink = at(2048, 2500);
            await page.mouse.click(pink.x, pink.y);
            await settledOutline(page);
            const ringsBefore = await outlineRings(page);
            const light = at(2500, 1500);
            await page.keyboard.down('Alt');
            await page.mouse.move(light.x, light.y);
            await page.mouse.down();
            await page.mouse.move(light.x, light.y + 20);
            await page.mouse.move(light.x, light.y + 40);
            await page.mouse.up();
            await page.keyboard.up('Alt');
            await expect(value).toHaveText('4');
            await expect.poll(() => outlineRings(page)).toBe(ringsBefore + 1);
            await settledOutline(page);
            if (process.env.WSI_SHOT_DIR) {
                await page.screenshot({
                    path: `${process.env.WSI_SHOT_DIR}/wand-alt-cut.png`,
                });
            }
            // A double-click inside the outline saves it.
            await page.mouse.dblclick(pink.x, pink.y);
            await expect.poll(() => service.writes.length).toBe(3);
            const holed = service.writes[2].body.target.selector.value;
            expect(holed).toMatch(/^<svg><g><path fill-rule="evenodd" d="M /);
            // The outer ring with the purple, lumen, brown and cut holes.
            expect(selectorRings(holed)).toHaveLength(ringsBefore + 1);
            await page.getByTestId('annotation-undo').click();
            await expect.poll(() => service.writes.length).toBe(4);
            expect(service.writes[3].method).toBe('DELETE');
        });

        test('outlines the same tissue from 10× tiles and from on-screen pixels', async ({
            page,
        }) => {
            await openAnnotatedSlide(page, TISSUE_SLIDE, {}, TISSUE_META);
            await routeTissueTiles(page);
            const service = await routeAnnotationService(page);
            const areas: Record<string, number> = {};
            for (const [z, source] of [
                [0.8, 'tiles'],
                [3, 'screen'],
            ] as const) {
                const at = await gotoTissueView(page, 1500, 2000, z);
                if (source === 'tiles') {
                    await startAnnotating(page);
                } else {
                    // Same document: reload for the new view. Annotate stays
                    // on (remembered).
                    await page.reload();
                    await expect(
                        page.getByTestId('annotation-mode-toggle')
                    ).toHaveAttribute('aria-disabled', 'false', {
                        timeout: 15_000,
                    });
                    await expect(
                        page.getByTestId('annotation-tools')
                    ).toBeVisible();
                }
                await pickFromMenu(page, 'outline', 'wand');
                await expect(
                    page.getByTestId('annotation-tool-outline')
                ).toHaveAttribute('aria-pressed', 'true');
                const purple = at(1500, 2000);
                await page.mouse.click(purple.x, purple.y);
                const outline = await settledOutline(page);
                await expect(outline).toHaveAttribute('data-source', source);
                const writes = service.writes.length;
                await page.keyboard.press('Enter');
                await expect.poll(() => service.writes.length).toBe(writes + 1);
                const rings = selectorRings(
                    service.writes[writes].body.target.selector.value
                );
                expect(rings).toHaveLength(1);
                areas[source] = ringArea(rings[0]);
                if (process.env.WSI_SHOT_DIR && source === 'screen') {
                    await page.screenshot({
                        path: `${process.env.WSI_SHOT_DIR}/wand-screen-saved.png`,
                    });
                }
            }
            const disk = Math.PI * 300 * 300;
            expect(areas.tiles / disk).toBeGreaterThan(0.96);
            expect(areas.screen / disk).toBeGreaterThan(0.96);
            expect(Math.abs(areas.tiles - areas.screen) / disk).toBeLessThan(
                0.03
            );
        });

        test('paints along a tissue edge with the smart brush', async ({
            page,
        }) => {
            await openAnnotatedSlide(page, TISSUE_SLIDE, {}, TISSUE_META);
            await routeTissueTiles(page);
            const service = await routeAnnotationService(page);
            const at = await gotoTissueView(page, 1500, 2000, 2);
            await startAnnotating(page);
            await page.keyboard.press('Shift+B');
            await expect(
                page.getByTestId('annotation-brush-width')
            ).toBeVisible();
            await expect(
                page.getByTestId('annotation-tissue-tolerance')
            ).toBeVisible();
            // 50 µm: 200 image pixels wide.
            await page.getByTestId('annotation-brush-width').selectOption('50');
            // Just inside the purple disk's left edge (x = 1200 at y = 2000).
            const start = at(1240, 1850);
            const end = at(1240, 2150);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(end.x, end.y, { steps: 12 });
            await expect(
                page.getByTestId('annotation-tissue-outline')
            ).toHaveAttribute('data-tool', 'smartBrush');
            if (process.env.WSI_SHOT_DIR) {
                await page.screenshot({
                    path: `${process.env.WSI_SHOT_DIR}/smart-brush-stroke.png`,
                });
            }
            await page.mouse.up();
            await expect.poll(() => service.writes.length).toBe(1);
            const rings = selectorRings(
                service.writes[0].body.target.selector.value
            );
            const xs = rings[0].map(([x]) => x);
            // It stops at the disk's edge (x ≥ 1200 near y = 2000) and
            // reaches at most 100 pixels right of the stroke.
            expect(Math.min(...xs)).toBeGreaterThan(1190);
            expect(Math.max(...xs)).toBeLessThan(1345);
            rings[0].forEach(([x, y]) =>
                expect(Math.hypot(x - 1500, y - 2000)).toBeLessThan(310)
            );
        });
    });
}
