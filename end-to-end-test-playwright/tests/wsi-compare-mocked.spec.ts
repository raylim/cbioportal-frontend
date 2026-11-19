import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import {
    encodePng,
    MPP,
    routeAnnotationService,
    USER,
} from './wsi-annotation-mocks';
import {
    installFoundationMocks,
    makeSlideRow,
    PATIENT_ID,
    SAMPLE_ID,
    SLIDE_KEY,
    STUDY_ID,
    tileMetadata,
} from './wsi-foundation-mocks';

/** The same block's IHC TTF-1: the H&E turned 90° clockwise. */
const IHC_KEY = 'abcdef012345';
/** The same block's H&E recut. */
const RECUT_KEY = 'abcdef000001';
/** Another block of the same part: IHC Ki-67. */
const KI67_KEY = 'abcdef000002';
/** Another part: an H&E. */
const PART2_KEY = 'abcdef000003';

const SIDE = 4096;
const META = {
    ...tileMetadata,
    dimensions: { width: SIDE, height: SIDE },
    max_zoom: 4,
    levels: 5,
    level_dimensions: [4096, 2048, 1024, 512, 256].map(side => ({
        width: side,
        height: side,
    })),
    level_downsamples: [1, 2, 4, 8, 16],
    objective_power: 40,
    mpp: { x: MPP, y: MPP },
};

type Rgb = [number, number, number];
/** Pink tissue with a purple, a brown and a light pink disk. */
const DISKS: Array<{ x: number; y: number; r: number; color: Rgb }> = [
    { x: 2048, y: 2048, r: 1300, color: [232, 160, 205] },
    { x: 1500, y: 2000, r: 300, color: [120, 70, 165] },
    { x: 2200, y: 2900, r: 150, color: [150, 95, 50] },
    { x: 2500, y: 1500, r: 160, color: [248, 205, 230] },
];

function heColor(x: number, y: number): Rgb {
    let color: Rgb = [243, 243, 243];
    DISKS.forEach(disk => {
        if ((x - disk.x) ** 2 + (y - disk.y) ** 2 <= disk.r * disk.r) {
            color = disk.color;
        }
    });
    return color;
}

/** Where the IHC slide shows H&E point (x, y): turned 90° clockwise. */
function toIhc(p: { x: number; y: number }) {
    return { x: SIDE - p.y, y: p.x };
}

/** The IHC slide: the H&E's tissue turned 90° clockwise, browner. */
function ihcColor(x: number, y: number): Rgb {
    const [r, g, b] = heColor(y, SIDE - x);
    return [r, Math.round(g * 0.85), Math.round(b * 0.6)];
}

function slideRow(
    key: string,
    stain: { name: string; group: string; ihc: boolean },
    part: string,
    block: string
) {
    const row = makeSlideRow(key, stain.name, stain.group);
    Object.assign(row.metadata, {
        is_hne: !stain.ihc,
        is_ihc: stain.ihc,
        slide_type: stain.ihc ? 'IHC' : 'H&E',
        part_key: `part:${part}`,
        part_number: part,
        part_description: `Part ${part}`,
        block_key: `block:${part}:${block}`,
        block_number: block,
        block_label: block,
    });
    row.metadata.serving.tile_metadata_json = META as typeof tileMetadata;
    return row;
}

const HE = { name: 'H&E', group: 'H&E (Initial)', ihc: false };
const ROWS = [
    slideRow(SLIDE_KEY, HE, '1', 'A1'),
    slideRow(IHC_KEY, { name: 'TTF-1', group: 'IHC', ihc: true }, '1', 'A1'),
    slideRow(
        RECUT_KEY,
        { name: 'H&E', group: 'H&E (Recut)', ihc: false },
        '1',
        'A1'
    ),
    slideRow(KI67_KEY, { name: 'Ki-67', group: 'IHC', ihc: true }, '1', 'A2'),
    slideRow(PART2_KEY, HE, '2', 'B1'),
];

/** A rectangle of the user's on the H&E around the purple disk, layer Tumor. */
const OWN_RECT = {
    id: 'own-rect',
    slide_id: SLIDE_KEY,
    study_id: STUDY_ID,
    body: {
        label: 'Tumor 1',
        comment: '',
        type: 'Tumor|#e03131',
        layer_name: 'Tumor',
        color: '#e03131',
        provenance: null,
    },
    target: {
        selector: {
            type: 'SvgSelector',
            value:
                '<svg><rect x="1400" y="1900" width="200" height="200" /></svg>',
        },
    },
    created_by: USER,
    visible_to: [],
    version: 1,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
};

/** Screenshots go to `WSI_SCREENSHOT_DIR` when it is set. */
function shot(name: string): string | undefined {
    const dir = process.env.WSI_SCREENSHOT_DIR;
    return dir ? `${dir}/${name}.png` : undefined;
}

async function routeSlides(page: Page) {
    await page.route('**/config_service', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                app_name: 'wsi-compare',
                authenticationMethod: 'none',
                user_display_name: USER,
                wsi_tile_server_url: '/wsi',
                wsi_annotation_api_url: '/wsi',
            }),
        })
    );
    await page.route('**/api/resource-table/query/fetch', route => {
        const query = route.request().postDataJSON();
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
                query?.resourceId === 'WSI_SAMPLE' ? ROWS : []
            ),
        });
    });
    const cache = new Map<string, Buffer>();
    await page.route('**/wsi/tiles/**', route => {
        const url = new URL(route.request().url());
        const slide = url.searchParams.get('key') || '';
        const [z, x, y] = url.pathname
            .split('/')
            .slice(-3)
            .map(Number);
        const key = `${slide}/${z}/${x}/${y}`;
        if (!cache.has(key)) {
            const color = slide === IHC_KEY ? ihcColor : heColor;
            const downsample = 2 ** (META.max_zoom - z);
            cache.set(
                key,
                encodePng(256, 256, (i, j) =>
                    color(
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
}

/** Opens the H&E fitted to its pane's width and opens Compare. */
async function openCompare(page: Page, seed: any[] = []) {
    await installFoundationMocks(page);
    await routeSlides(page);
    const service = await routeAnnotationService(page, seed);
    await page.goto(
        `/wsi/patient/${PATIENT_ID}?studyId=${STUDY_ID}#wsi:slide=${SLIDE_KEY}&x=2048&y=2048&z=1`
    );
    await expect(page.getByTestId('wsi-annotation-toolbar')).toBeVisible({
        timeout: 30_000,
    });
    const button = page.getByTestId('wsi-compare-button');
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
    await expect(page.getByTestId('wsi-compare-bar')).toBeVisible();
    await expect(
        page
            .getByTestId('wsi-pane-right')
            .locator('.openseadragon-container')
            .first()
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('wsi-pane-stain-right')).toHaveText(
        'IHC TTF-1'
    );
    return service;
}

/** Where the left view is put before points are placed: centre x, y, zoom. */
const VIEW = { x: 2050, y: 2048, z: 1 };

/**
 * Moves the left view by its `#wsi:` hash (`VIEW`; the right follows at
 * once, by relative position) and returns the image-to-page mapping of each
 * pane: both then show their slide's whole width at the left pane's scale.
 */
async function fitBothViews(page: Page) {
    await page.evaluate(
        hash =>
            new Promise<void>(resolve => {
                window.addEventListener(
                    'hashchange',
                    () => requestAnimationFrame(() => resolve()),
                    { once: true }
                );
                window.location.hash = hash;
            }),
        `#wsi:slide=${SLIDE_KEY}&x=${VIEW.x}&y=${VIEW.y}&z=${VIEW.z}`
    );
    const box = async (side: string) =>
        (await page
            .getByTestId(`wsi-pane-${side}`)
            .locator('.openseadragon-container')
            .first()
            .boundingBox())!;
    const left = await box('left');
    const right = await box('right');
    const scale = (left.width * VIEW.z) / SIDE;
    const at = (frame: typeof left) => (p: { x: number; y: number }) => ({
        x: frame.x + frame.width / 2 + (p.x - VIEW.x) * scale,
        y: frame.y + frame.height / 2 + (p.y - VIEW.y) * scale,
    });
    return { left: at(left), right: at(right) };
}

/** The left pane's view centre, from the `#wsi:` hash it keeps. */
function hashCenter(page: Page): { x: number; y: number } {
    const hash = new URL(page.url()).hash.replace(/^#wsi:/, '');
    const params = new URLSearchParams(hash);
    return { x: Number(params.get('x')), y: Number(params.get('y')) };
}

/** The option groups of a pane's slide picker, with their slide keys. */
function pickerGroups(page: Page, side: string) {
    return page
        .getByTestId(`wsi-compare-picker-${side}`)
        .locator('optgroup')
        .evaluateAll(nodes =>
            nodes.map(node => ({
                group: node.getAttribute('label'),
                options: Array.from(node.querySelectorAll('option')).map(
                    option => (option as HTMLOptionElement).value
                ),
            }))
        );
}

// Mocked like wsi-foundation-mocked.spec.ts: runs in the WSI suite only.
if (process.env.PW_SUITE === 'wsi') {
    test.describe('WSI side by side (mocked)', () => {
        test.use({ viewport: { width: 1600, height: 900 } });

        test('Compare opens the same block’s IHC, the picker ordered by match level', async ({
            page,
        }) => {
            await openCompare(page);
            await expect(
                page.getByTestId('wsi-pane-slide-id-right')
            ).toHaveText('WSI-abcd-ef01-2345');
            await expect(page.getByTestId('wsi-pane-stain-left')).toHaveText(
                'H&E'
            );
            expect(await pickerGroups(page, 'right')).toEqual([
                { group: 'Same block', options: [IHC_KEY, RECUT_KEY] },
                { group: 'Same part', options: [KI67_KEY] },
                { group: `${SAMPLE_ID} · Part 2`, options: [PART2_KEY] },
            ]);
            // The left picker lists the slides closest to the right one's.
            expect((await pickerGroups(page, 'left'))[0]).toEqual({
                group: 'Same block',
                options: [SLIDE_KEY, RECUT_KEY],
            });
            await expect(page.getByTestId('wsi-pane-left')).toHaveAttribute(
                'aria-label',
                'Left slide: H&E · WSI-0123-4567-89ab'
            );
            await page.screenshot({ path: shot('compare-open') });
            // Only the active pane has the annotation toolbar.
            await expect(
                page.getByTestId('wsi-annotation-toolbar')
            ).toHaveCount(1);
            await page
                .getByTestId('wsi-pane-right')
                .locator('.openseadragon-canvas')
                .first()
                .focus();
            await expect(page.getByTestId('wsi-pane-right')).toHaveAttribute(
                'data-active',
                'true'
            );
            await expect(
                page
                    .getByTestId('wsi-pane-right')
                    .getByTestId('wsi-annotation-toolbar')
            ).toBeVisible();
            // Keys go to the active slide only: H hides the right's.
            const display = page.getByTestId('annotation-display-button');
            await page.keyboard.press('h');
            await expect(display).toHaveAttribute(
                'aria-label',
                'Display (annotations hidden)'
            );
            // F6 moves the focus to the other slide, whose annotations
            // still show; H there leaves the right's hidden.
            await page.keyboard.press('F6');
            await expect(page.getByTestId('wsi-pane-left')).toHaveAttribute(
                'data-active',
                'true'
            );
            await expect(display).toHaveAttribute('aria-label', 'Display');
            await page.keyboard.press('h');
            await expect(display).toHaveAttribute(
                'aria-label',
                'Display (annotations hidden)'
            );
            await page.keyboard.press('h');
            await expect(display).toHaveAttribute('aria-label', 'Display');
            await page.keyboard.press('F6');
            await expect(display).toHaveAttribute(
                'aria-label',
                'Display (annotations hidden)'
            );
            await page.keyboard.press('h');
            await page.keyboard.press('F6');
            await expect(page.getByTestId('wsi-pane-left')).toHaveAttribute(
                'data-active',
                'true'
            );
            await page
                .getByTestId('wsi-compare-picker-right')
                .selectOption(KI67_KEY);
            await expect(page.getByTestId('wsi-pane-stain-right')).toHaveText(
                'IHC Ki-67'
            );
            await page.getByTestId('wsi-compare-close').click();
            await expect(page.getByTestId('wsi-pane-right')).toHaveCount(0);
            await expect(
                page.getByTestId('wsi-annotation-toolbar')
            ).toBeVisible();
        });

        test('locked views follow each other: panning the right moves the left', async ({
            page,
        }) => {
            await openCompare(page);
            await expect.poll(() => Math.round(hashCenter(page).x)).toBe(2048);
            const right = (await page
                .getByTestId('wsi-pane-right')
                .locator('.openseadragon-container')
                .first()
                .boundingBox())!;
            const from = {
                x: right.x + right.width / 2,
                y: right.y + right.height / 2,
            };
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            await page.mouse.move(from.x - 120, from.y, { steps: 8 });
            await page.mouse.up();
            // The right view moved right on its slide; the left followed.
            await expect
                .poll(() => hashCenter(page).x, { timeout: 15_000 })
                .toBeGreaterThan(2048 + 500);
            await expect(
                page.getByTestId('wsi-compare-sync-status')
            ).toHaveText('Following the same relative position');
            await page.getByTestId('wsi-compare-lock').uncheck();
            await expect(
                page.getByTestId('wsi-compare-sync-status')
            ).toHaveText('Views move separately');
        });

        test('three point pairs align the slides; a copied rectangle lands on the same tissue, is verified and undone', async ({
            page,
        }) => {
            const service = await openCompare(page, [OWN_RECT]);
            await page.getByTestId('wsi-compare-align-toggle').click();
            await expect(
                page.getByTestId('wsi-compare-place-points')
            ).toHaveAttribute('aria-pressed', 'true');
            const map = await fitBothViews(page);
            // The purple, brown and light pink disks' centres on each slide.
            const features = [
                { x: 1500, y: 2000 },
                { x: 2200, y: 2900 },
                { x: 2500, y: 1500 },
            ];
            for (const [index, feature] of features.entries()) {
                const onLeft = map.left(feature);
                await page.mouse.click(onLeft.x, onLeft.y);
                await expect(
                    page.getByTestId(`wsi-align-marker-left-${index + 1}`)
                ).toBeVisible();
                const onRight = map.right(toIhc(feature));
                await page.mouse.click(onRight.x, onRight.y);
                await expect(
                    page.getByTestId(`wsi-align-marker-right-${index + 1}`)
                ).toBeVisible();
            }
            await expect(page.getByTestId('wsi-compare-fit')).toBeVisible();
            const rms = Number(
                (
                    (await page.getByTestId('wsi-compare-rms').textContent()) ||
                    ''
                ).replace(/[^\d.]/g, '')
            );
            // Each click lands within a screen pixel (about 2 µm here).
            expect(rms).toBeLessThan(8);
            await expect(
                page.getByTestId('wsi-compare-sync-status')
            ).toContainText('Aligned: 3 points');
            await page.screenshot({ path: shot('compare-aligned') });

            // Copy the left slide's Tumor layer onto the IHC.
            await page
                .getByTestId('wsi-pane-left')
                .locator('.openseadragon-canvas')
                .first()
                .focus();
            await page.getByTestId('wsi-compare-copy-layer-Tumor').click();
            await expect(page.getByTestId('wsi-compare-message')).toContainText(
                'Copied 1 annotation to the right slide'
            );
            const batch = service.writes.find(write =>
                write.path.endsWith('/annotations/batch')
            )!;
            const copy = batch.body.annotations[0];
            expect(copy.slide_id).toBe(IHC_KEY);
            expect(copy.body.layer_name).toBe('Tumor');
            expect(copy.body.provenance).toMatchObject({
                source: 'manual',
                transferred_from: {
                    slide_key: SLIDE_KEY,
                    annotation_id: 'own-rect',
                },
                transform_model: 'similarity',
                verified: false,
            });
            expect(copy.body.provenance.transform_residual_um).toBeLessThan(8);
            // The rectangle turned with the tissue: x 1996–2196, y 1400–1600.
            const points = String(copy.target.selector.value)
                .match(/points="([^"]+)"/)![1]
                .split(' ')
                .map(pair => pair.split(',').map(Number));
            const xs = points.map(p => p[0]);
            const ys = points.map(p => p[1]);
            expect(Math.abs(Math.min(...xs) - 1996)).toBeLessThan(25);
            expect(Math.abs(Math.max(...xs) - 2196)).toBeLessThan(25);
            expect(Math.abs(Math.min(...ys) - 1400)).toBeLessThan(25);
            expect(Math.abs(Math.max(...ys) - 1600)).toBeLessThan(25);

            // The right slide is active now, and its list shows the copy.
            await expect(page.getByTestId('wsi-pane-right')).toHaveAttribute(
                'data-active',
                'true'
            );
            const id = 'annotation-1';
            const badge = page.getByTestId(`annotation-transfer-badge-${id}`);
            await expect(badge).toHaveText('Transferred · unverified');
            await page.getByTestId('wsi-compare-align-toggle').click();
            await page.screenshot({ path: shot('compare-transferred') });
            await page.getByTestId(`verify-transfer-${id}`).click();
            await expect(badge).toHaveText('Transferred · verified');
            const put = service.writes.find(
                write => write.method === 'PUT' && write.path.endsWith(id)
            )!;
            expect(put.body.body.provenance).toMatchObject({
                verified: true,
                verified_by: USER,
            });
            await expect(page.getByTestId(`verify-transfer-${id}`)).toHaveCount(
                0
            );

            // Undo takes the copy back in one step; the source is untouched.
            await page
                .getByTestId('wsi-pane-right')
                .getByTestId('annotation-mode-toggle')
                .click();
            const undo = page
                .getByTestId('wsi-pane-right')
                .getByTestId('annotation-undo');
            await expect(undo).toHaveAttribute(
                'aria-label',
                'Undo transfer of 1 annotation (Ctrl+Z)'
            );
            await undo.click();
            await expect(badge).toHaveCount(0);
            expect(service.rows.has(id)).toBe(false);
            expect(service.rows.get('own-rect').version).toBe(1);
        });
    });
}
