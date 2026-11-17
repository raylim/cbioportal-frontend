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

/**
 * The annotation service, kept in memory: creates get an id and version 1,
 * updates check and bump the version. Returns the rows and the request
 * bodies it received.
 */
async function routeAnnotationService(page: Page) {
    const rows = new Map<string, any>();
    const writes: Array<{ method: string; body: any }> = [];
    let next = 0;
    await page.route('**/wsi/annotations**', async (route: Route) => {
        const request = route.request();
        const method = request.method();
        const url = new URL(request.url());
        expect(url.searchParams.getAll('studyId')).toEqual([STUDY_ID]);
        const id = decodeURIComponent(url.pathname.split('/')[3] || '');
        const body = request.postData()
            ? JSON.parse(request.postData()!)
            : null;
        if (method !== 'GET') writes.push({ method, body });
        const json = (status: number, value: unknown) =>
            route.fulfill({
                status,
                contentType: 'application/json',
                body: JSON.stringify(value),
            });
        if (method === 'GET') return json(200, Array.from(rows.values()));
        if (method === 'POST') {
            const row = {
                ...body,
                id: `annotation-${++next}`,
                created_by: 'e2e-user',
                version: 1,
                created_at: new Date().toISOString(),
            };
            rows.set(row.id, row);
            return json(201, row);
        }
        const row = rows.get(id);
        if (!row) return json(404, { detail: 'Annotation not found' });
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

// Mocked like wsi-foundation-mocked.spec.ts: runs in the WSI suite only.
if (process.env.PW_SUITE === 'wsi') {
    test.describe('WSI annotation tools', () => {
        test('measures a line, saves a note, counts points and exports GeoJSON', async ({
            page,
        }) => {
            await installFoundationMocks(page);
            // Annotations on, and a slide with a microns-per-pixel scale.
            await page.route('**/config_service', route =>
                route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        app_name: 'wsi-annotation-tools',
                        authenticationMethod: 'none',
                        wsi_tile_server_url: '/wsi',
                        wsi_annotation_api_url: '/wsi',
                    }),
                })
            );
            const row = makeSlideRow(SLIDE_KEY, 'H&E initial', 'H&E (Initial)');
            row.metadata.serving.tile_metadata_json = {
                ...tileMetadata,
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
            const service = await routeAnnotationService(page);
            const pageErrors: string[] = [];
            page.on('pageerror', error => pageErrors.push(error.message));

            await page.goto(
                `/wsi/patient/${PATIENT_ID}?studyId=${STUDY_ID}#wsi:slide=${SLIDE_KEY}&x=256&y=256&z=1`
            );
            await expect(
                page.getByRole('button', { name: 'Fit to view' })
            ).toBeVisible({ timeout: 30_000 });
            await expect(
                page.getByTestId('wsi-annotation-toolbar')
            ).toBeVisible({ timeout: 30_000 });
            const stage = page.locator('.openseadragon-container').first();
            const box = (await stage.boundingBox())!;
            const at = (fx: number, fy: number) => ({
                x: box.x + box.width * fx,
                y: box.y + box.height * fy,
            });

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
                'Default: 3'
            );
            await page.keyboard.press('Escape');
            await expect(
                page.getByTestId('annotation-point-tally-Default-Default')
            ).toContainText('3');
            await expect.poll(() => service.rows.size).toBe(4);
            const points = service.writes
                .filter(write => write.method === 'POST')
                .slice(1);
            for (const write of points) {
                expect(write.body.target.selector.value).toMatch(
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
    });
}
