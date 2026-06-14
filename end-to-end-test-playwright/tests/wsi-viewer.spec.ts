import { test, expect } from '../fixtures';

/**
 * End-to-end tests for the native WSI viewer (WSIViewer.tsx).
 *
 * These tests require a running tile server and a cBioPortal frontend
 * build that includes the WSI viewer feature (PR #5608).  They are
 * gated on the WSI_VIEWER_BASE_URL environment variable so that they
 * are skipped in CI runs against the public portal (which does not yet
 * have the feature).
 *
 * To run locally:
 *   WSI_VIEWER_BASE_URL=http://pllimsksparky3:3000 \
 *   TILE_SERVER_URL=http://pllimsksparky3:8081 \
 *   CBIO_URL=http://pllimsksparky3:8090 \
 *   npx playwright test end-to-end-test-playwright/tests/wsi-viewer.spec.ts
 *
 * The viewer URL pattern is:
 *   <baseUrl>/patient/wsiHESlides?studyId=<study>&caseId=<patient>
 *                                &resourceUrl=<tileServer>/?patient=<patient>&studyId=<study>&cbioUrl=<cbio>
 */

const BASE_URL = process.env.WSI_VIEWER_BASE_URL ?? '';
const TILE_SERVER = process.env.TILE_SERVER_URL ?? 'http://pllimsksparky3:8081';
const CBIO_URL = process.env.CBIO_URL ?? 'http://pllimsksparky3:8090';

// Patient that exists in both the local study and the tile server.
const STUDY_ID = 'coad_msk_2025';
const PATIENT_ID = 'P-0000678';

function viewerUrl(hash = ''): string {
    const resourceUrl = encodeURIComponent(
        `${TILE_SERVER}/?patient=${PATIENT_ID}&studyId=${STUDY_ID}&cbioUrl=${CBIO_URL}`
    );
    const base = `${BASE_URL}/patient/wsiHESlides?studyId=${STUDY_ID}&caseId=${PATIENT_ID}&resourceUrl=${resourceUrl}`;
    return hash ? `${base}${hash}` : base;
}

// Skip all tests when the env var is not set (public CI / public portal).
test.describe('WSI viewer — share view and centering', () => {
    test.beforeEach(async () => {
        test.skip(!BASE_URL, 'WSI_VIEWER_BASE_URL not set — skipping WSI viewer e2e tests');
    });

    test('loads slide at home position, not at (1,1)', async ({ page }) => {
        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        // After open handler fires, hash is written with real slide coordinates.
        // The bug would produce x=1&y=1; the fix produces the actual image center.
        const hash = await page.evaluate(() => window.location.hash);
        expect(hash).toMatch(/^#wsi:slide=/);

        const params = new URLSearchParams(hash.replace(/^#wsi:/, ''));
        const x = Number(params.get('x'));
        const y = Number(params.get('y'));

        // Home position is the center of a ~65k×45k pixel slide.
        // It must be >> 1 to confirm the (1,1) regression is absent.
        expect(x).toBeGreaterThan(100);
        expect(y).toBeGreaterThan(100);
    });

    test('share view URL preserves position on reload', async ({ page }) => {
        // 1. Open the viewer fresh (no hash).
        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        // 2. Navigate to a known position via the coord bar.
        await page.locator('input[placeholder="px"]').nth(0).fill('15000');
        await page.locator('input[placeholder="px"]').nth(1).fill('10000');
        await page.locator('button:has-text("Go")').click();

        // Wait for hash to reflect the new position.
        await expect
            .poll(() => page.evaluate(() => window.location.hash), { timeout: 5_000 })
            .toMatch(/x=15000/);

        // 3. Capture share URL (intercept clipboard).
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText: async (t: string) => { (window as any)._copiedUrl = t; } },
                configurable: true,
                writable: true,
            });
        });
        await page.locator('button:has-text("Share view")').click();
        await expect(page.locator('button:has-text("✓ Copied")')).toBeVisible({
            timeout: 3_000,
        });

        const copiedUrl: string = await page.evaluate(() => (window as any)._copiedUrl);
        expect(copiedUrl).toContain('x=15000');
        expect(copiedUrl).toContain('y=10000');

        // 4. Open the share URL in a new tab and verify position is restored.
        const newPage = await page.context().newPage();
        await newPage.goto(copiedUrl);
        await expect(newPage.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        const restoredHash = await newPage.evaluate(() => window.location.hash);
        const restoredParams = new URLSearchParams(restoredHash.replace(/^#wsi:/, ''));

        // Position must be preserved — not reset to (1,1) or home.
        expect(Number(restoredParams.get('x'))).toBe(15000);
        expect(Number(restoredParams.get('y'))).toBe(10000);

        await newPage.close();
    });

    test('share view button shows "✓ Copied" feedback', async ({ page }) => {
        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        // Intercept clipboard so the button can complete without a secure context.
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText: async () => {} },
                configurable: true,
                writable: true,
            });
        });

        await page.locator('button:has-text("Share view")').click();
        await expect(page.locator('button:has-text("✓ Copied")')).toBeVisible();
        // Button reverts after 2 s.
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 4_000,
        });
    });

    test('coord nav jumps to entered pixel coordinates', async ({ page }) => {
        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        await page.locator('input[placeholder="px"]').nth(0).fill('5000');
        await page.locator('input[placeholder="px"]').nth(1).fill('3000');
        await page.locator('button:has-text("Go")').click();

        await expect
            .poll(() => page.evaluate(() => window.location.hash), { timeout: 5_000 })
            .toMatch(/x=5000/);

        const hash = await page.evaluate(() => window.location.hash);
        const params = new URLSearchParams(hash.replace(/^#wsi:/, ''));
        expect(Number(params.get('x'))).toBe(5000);
        expect(Number(params.get('y'))).toBe(3000);
    });

    test('download button triggers a JPEG download named by patient/slide/position', async ({
        page,
    }) => {
        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Download")')).toBeVisible({
            timeout: 30_000,
        });

        // Intercept document.createElement('a') to capture the download filename
        // without needing a real file-system download.
        await page.evaluate(() => {
            const origCreate = document.createElement.bind(document);
            (document as any).createElement = (tag: string) => {
                const el = origCreate(tag);
                if (tag === 'a') {
                    el.click = () => { (window as any)._downloadName = (el as HTMLAnchorElement).download; };
                }
                return el;
            };
        });

        await page.locator('button:has-text("Download")').click();
        await page.waitForTimeout(500); // toBlob is async

        const filename: string = await page.evaluate(() => (window as any)._downloadName ?? '');
        // Filename pattern: wsi-<patientId>-<slideId>-x<n>-y<n>.jpg
        expect(filename).toMatch(/^wsi-.+-\d+-x\d+-y\d+\.jpg$/);
        expect(filename).toContain('P-0000678');
        expect(filename).toContain('.jpg');
    });

    test('opening a share link with a different slide ID restores that slide', async ({
        page,
    }) => {
        // Navigate with a hash specifying the first slide.
        const hashWithSlide = '#wsi:slide=1492807&x=20000&y=15000&z=1.2';
        await page.goto(viewerUrl(hashWithSlide));
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        // Hash should be preserved (not overwritten with garbage from selectSlide).
        const hash = await page.evaluate(() => window.location.hash);
        const params = new URLSearchParams(hash.replace(/^#wsi:/, ''));
        expect(params.get('slide')).toBe('1492807');
        expect(Number(params.get('x'))).toBe(20000);
        expect(Number(params.get('y'))).toBe(15000);
    });
});

// ---- Annotation layer (Option C) ----
//
// These tests mock the annotation REST API via page.route() so they run
// without the annotation backend being deployed.  The API URL is injected
// into the page via window.setServerConfig() (exposed by config.ts).
//
// Run with the same env vars as the viewer tests:
//   WSI_VIEWER_BASE_URL=http://pllimsksparky3:3000 \
//   TILE_SERVER_URL=http://pllimsksparky3:8081 \
//   CBIO_URL=http://pllimsksparky3:8090 \
//   npx playwright test --grep "annotation" end-to-end-test-playwright/tests/wsi-viewer.spec.ts

const MOCK_ANNOTATION_URL = 'http://mock-annotation-api';

/** Stub W3C annotation returned by the mock GET /annotations endpoint. */
const MOCK_ANNOTATION = {
    id: 'ann-test-1',
    slide_id: '1492807',
    study_id: STUDY_ID,
    body: { label: 'Playwright test annotation', comment: '', type: 'region' },
    target: { selector: { type: 'FragmentSelector', value: 'xywh=100,100,50,50' } },
    created_by: 'playwright',
    created_at: '2025-01-01T00:00:00',
    version: 1,
};

/**
 * Navigate to the viewer and inject the mock annotation API URL into the
 * running page's serverConfig so WSIViewer picks it up.
 *
 * cBioPortal merges `localStorage.frontendConfig` into the server config at
 * bootstrap time (highest precedence), so we use an initScript to pre-populate
 * it before any page JavaScript runs.  This means the annotation URL is
 * already in `config.serverConfig` when ResourceTab first renders, so the
 * Annotations button is present from the start.
 */
async function gotoViewerWithAnnotationApi(page: any, hash = '') {
    // Route all annotation API calls to mock handlers before navigating.
    await page.route(`${MOCK_ANNOTATION_URL}/annotations**`, async (route: any) => {
        const method = route.request().method();
        if (method === 'GET') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([MOCK_ANNOTATION]),
            });
        } else if (method === 'POST') {
            await route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ ...MOCK_ANNOTATION, id: 'ann-new-1' }),
            });
        } else if (method === 'PUT') {
            const url = route.request().url();
            const id = url.split('/annotations/')[1];
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ...MOCK_ANNOTATION, id, version: 2 }),
            });
        } else if (method === 'DELETE') {
            await route.fulfill({ status: 204, body: '' });
        } else {
            await route.continue();
        }
    });

    // Inject the annotation API URL via localStorage.frontendConfig, which
    // cBioPortal merges into the server config at bootstrap (highest precedence,
    // see config.ts initializeServerConfiguration).  The initScript runs before
    // any page scripts so the value is present when the React app first renders.
    await page.addInitScript((apiUrl: string) => {
        localStorage.setItem(
            'frontendConfig',
            JSON.stringify({ serverConfig: { msk_wsi_annotation_api_url: apiUrl } })
        );
    }, MOCK_ANNOTATION_URL);

    await page.goto(viewerUrl(hash));
}

test.describe('WSI viewer — annotation layer (Option C)', () => {
    test.beforeEach(async () => {
        test.skip(!BASE_URL, 'WSI_VIEWER_BASE_URL not set — skipping WSI annotation e2e tests');
    });

    test('Annotations button appears in CoordBar when API is configured', async ({ page }) => {
        await gotoViewerWithAnnotationApi(page);
        // Wait for the viewer to be ready (Share view button signals viewerReady).
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });
        // Force a slide select by re-clicking the first slide in the nav panel.
        // This triggers loadAnnotations and makes the CoordBar re-render with the new config.
        const firstSlide = page.locator('[data-testid="slide-nav-item"]').first();
        if (await firstSlide.isVisible()) {
            await firstSlide.click();
        }
        await expect(page.locator('button:has-text("Annotations")')).toBeVisible({
            timeout: 10_000,
        });
    });

    test('Annotations button toggles visibility label', async ({ page }) => {
        await gotoViewerWithAnnotationApi(page);
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        const annoBtn = page.locator('button').filter({ hasText: /Annotations/ });
        await annoBtn.waitFor({ state: 'visible', timeout: 15_000 });

        // Initially visible — label contains "Annotations".
        await expect(annoBtn).toContainText('Annotations');

        // Click to hide.
        await annoBtn.click();
        await expect(annoBtn).toContainText('Annotations'); // label always shows Annotations
        // The button style should change (border color) — verify it still exists.
        await expect(annoBtn).toBeVisible();
    });

    test('Annotations panel renders mocked annotations in MetaSidebar', async ({ page }) => {
        await gotoViewerWithAnnotationApi(page);
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        // The sidebar section heading should appear.
        await expect(
            page.locator('text=Annotations').filter({ hasNot: page.locator('button') }).first()
        ).toBeVisible({ timeout: 15_000 });

        // The mock annotation label should be in the panel.
        await expect(page.locator('text=Playwright test annotation')).toBeVisible({
            timeout: 10_000,
        });
    });

    test('DELETE request is sent when annotation ✕ button is clicked', async ({ page }) => {
        const deleteRequests: string[] = [];
        await page.route(`${MOCK_ANNOTATION_URL}/annotations**`, async (route: any) => {
            const method = route.request().method();
            if (method === 'DELETE') {
                deleteRequests.push(route.request().url());
                await route.fulfill({ status: 204, body: '' });
            } else if (method === 'GET') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify([MOCK_ANNOTATION]),
                });
            } else {
                await route.continue();
            }
        });

        // Inject the annotation URL at bootstrap time via localStorage.
        await page.addInitScript((apiUrl: string) => {
            localStorage.setItem(
                'frontendConfig',
                JSON.stringify({ serverConfig: { msk_wsi_annotation_api_url: apiUrl } })
            );
        }, MOCK_ANNOTATION_URL);

        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        // Click the ✕ delete button for the mock annotation.
        const deleteBtn = page.locator('button', { hasText: '✕' }).first();
        await deleteBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await deleteBtn.click();

        // Verify a DELETE request was made to the annotation endpoint.
        await page.waitForTimeout(500);
        expect(deleteRequests.length).toBeGreaterThan(0);
        expect(deleteRequests[0]).toContain(`/annotations/${MOCK_ANNOTATION.id}`);
    });

    test('Annotations button is absent when API URL is not configured', async ({
        page,
    }) => {
        // Navigate WITHOUT injecting the annotation API URL — plain viewer.
        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });
        // Annotations button must NOT appear.
        await expect(
            page.locator('button').filter({ hasText: /Annotations/ })
        ).toHaveCount(0);
    });

    test('Annotations panel shows empty-state message when API returns no annotations', async ({
        page,
    }) => {
        // Mock GET to return empty list.
        await page.route(`${MOCK_ANNOTATION_URL}/annotations**`, async (route: any) => {
            if (route.request().method() === 'GET') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify([]),
                });
            } else {
                await route.continue();
            }
        });
        await page.addInitScript((apiUrl: string) => {
            localStorage.setItem(
                'frontendConfig',
                JSON.stringify({ serverConfig: { msk_wsi_annotation_api_url: apiUrl } })
            );
        }, MOCK_ANNOTATION_URL);

        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.locator('button').filter({ hasText: /Annotations/ })
        ).toBeVisible({ timeout: 15_000 });

        await expect(
            page.locator('text=No annotations yet')
        ).toBeVisible({ timeout: 10_000 });
    });

    test('Annotations button cycles between filled and unfilled icon on toggle', async ({
        page,
    }) => {
        await gotoViewerWithAnnotationApi(page);
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        const annoBtn = page.locator('button').filter({ hasText: /Annotations/ });
        await annoBtn.waitFor({ state: 'visible', timeout: 15_000 });

        // Initially visible → filled blue circle emoji.
        await expect(annoBtn).toContainText('🔵 Annotations');

        // Toggle off.
        await annoBtn.click();
        await expect(annoBtn).toContainText('○ Annotations');

        // Toggle on again.
        await annoBtn.click();
        await expect(annoBtn).toContainText('🔵 Annotations');
    });
});

// ---- Live annotation API integration tests (Option C) ----
//
// These tests hit the REAL annotation API (no page.route() mocking).
// They are gated on TILE_SERVER_URL being set; skip if not available.
// Each test cleans up after itself via the DELETE endpoint.

const LIVE_ANNO_API = process.env.TILE_SERVER_URL ?? '';
const LIVE_SLIDE_ID = '1492807'; // first slide for P-0000678 in coad_msk_2025

/** Labels used by live e2e tests — used to clean up leftover annotations. */
const LIVE_TEST_LABELS = [
    'e2e-lifecycle-test',
    'e2e-viewer-load-test',
    'e2e-delete-via-ui',
];

/** Delete all annotations whose body.label is in `labels` — used for test cleanup. */
async function cleanupLiveAnnotations(
    request: any,
    apiUrl: string,
    slideId: string,
    studyId: string,
    labels: string[]
) {
    const resp = await request.get(
        `${apiUrl}/annotations?slide_id=${slideId}&study_id=${studyId}`
    );
    if (!resp.ok()) return;
    const all = await resp.json();
    for (const ann of all) {
        if (labels.includes(ann.body?.label)) {
            await request.delete(`${apiUrl}/annotations/${ann.id}`);
        }
    }
}

test.describe('WSI viewer — live annotation API (Option C)', () => {
    test.beforeEach(async ({ request }) => {
        test.skip(
            !BASE_URL || !LIVE_ANNO_API,
            'WSI_VIEWER_BASE_URL or TILE_SERVER_URL not set — skipping live annotation API tests'
        );
        // Clean up any leftover annotations from previous failed runs.
        await cleanupLiveAnnotations(
            request,
            LIVE_ANNO_API,
            LIVE_SLIDE_ID,
            STUDY_ID,
            LIVE_TEST_LABELS
        );
    });

    test('live API: GET /annotations returns 200 with array', async ({ page }) => {
        const resp = await page.request.get(
            `${LIVE_ANNO_API}/annotations?slide_id=${LIVE_SLIDE_ID}&study_id=${STUDY_ID}`
        );
        expect(resp.status()).toBe(200);
        const body = await resp.json();
        expect(Array.isArray(body)).toBe(true);
    });

    test('live API: CRUD lifecycle — create, read, delete', async ({ page }) => {
        // 1. Create annotation via POST.
        const postResp = await page.request.post(`${LIVE_ANNO_API}/annotations`, {
            data: {
                slide_id: LIVE_SLIDE_ID,
                study_id: STUDY_ID,
                body: { label: 'e2e-lifecycle-test', comment: '', type: 'region' },
                target: {
                    selector: { type: 'FragmentSelector', value: 'xywh=10,10,20,20' },
                },
            },
        });
        expect(postResp.status()).toBe(201);
        const created = await postResp.json();
        expect(created.id).toBeTruthy();
        expect(created.body.label).toBe('e2e-lifecycle-test');

        // 2. GET should include the created annotation.
        const getResp = await page.request.get(
            `${LIVE_ANNO_API}/annotations?slide_id=${LIVE_SLIDE_ID}&study_id=${STUDY_ID}`
        );
        const annotations = await getResp.json();
        expect(annotations.some((a: any) => a.id === created.id)).toBe(true);

        // 3. DELETE.
        const delResp = await page.request.delete(
            `${LIVE_ANNO_API}/annotations/${created.id}`
        );
        expect(delResp.status()).toBe(204);

        // 4. Confirm deleted.
        const afterDel = await page.request.get(
            `${LIVE_ANNO_API}/annotations?slide_id=${LIVE_SLIDE_ID}&study_id=${STUDY_ID}`
        );
        const remaining = await afterDel.json();
        expect(remaining.some((a: any) => a.id === created.id)).toBe(false);
    });

    test('live API: viewer loads existing annotation from live API into sidebar', async ({
        page,
    }) => {
        // 1. Pre-seed an annotation via the API.
        const postResp = await page.request.post(`${LIVE_ANNO_API}/annotations`, {
            data: {
                slide_id: LIVE_SLIDE_ID,
                study_id: STUDY_ID,
                body: { label: 'e2e-viewer-load-test', comment: '', type: 'region' },
                target: {
                    selector: { type: 'FragmentSelector', value: 'xywh=5,5,10,10' },
                },
            },
        });
        expect(postResp.status()).toBe(201);
        const created = await postResp.json();

        try {
            // 2. Navigate with live API URL injected.
            await page.addInitScript((apiUrl: string) => {
                localStorage.setItem(
                    'frontendConfig',
                    JSON.stringify({ serverConfig: { msk_wsi_annotation_api_url: apiUrl } })
                );
            }, LIVE_ANNO_API);

            await page.goto(viewerUrl());
            await expect(page.locator('button:has-text("Share view")')).toBeVisible({
                timeout: 30_000,
            });

            // 3. Annotation label should appear in MetaSidebar.
            await expect(
                page.locator('text=e2e-viewer-load-test')
            ).toBeVisible({ timeout: 15_000 });
        } finally {
            // 4. Cleanup — delete regardless of test outcome.
            await page.request.delete(`${LIVE_ANNO_API}/annotations/${created.id}`);
        }
    });

    test('live API: delete button in viewer removes annotation from sidebar and API', async ({
        page,
    }) => {
        // 1. Pre-seed.
        const postResp = await page.request.post(`${LIVE_ANNO_API}/annotations`, {
            data: {
                slide_id: LIVE_SLIDE_ID,
                study_id: STUDY_ID,
                body: { label: 'e2e-delete-via-ui', comment: '', type: 'region' },
                target: {
                    selector: { type: 'FragmentSelector', value: 'xywh=1,1,5,5' },
                },
            },
        });
        const created = await postResp.json();
        expect(postResp.status()).toBe(201);

        // 2. Navigate with live API URL.
        await page.addInitScript((apiUrl: string) => {
            localStorage.setItem(
                'frontendConfig',
                JSON.stringify({ serverConfig: { msk_wsi_annotation_api_url: apiUrl } })
            );
        }, LIVE_ANNO_API);

        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({
            timeout: 30_000,
        });

        // 3. Wait for the label to appear, then scope the ✕ button to that row.
        // MetaSidebar renders <div title={label}> for each annotation label, and
        // the delete <button title="Delete annotation"> is a sibling in the same row.
        await expect(page.locator(`[title="e2e-delete-via-ui"]`)).toBeVisible({
            timeout: 15_000,
        });
        // Navigate up two levels (label div → text container → row) to find the
        // sibling delete button for exactly this annotation.
        const annoRow = page
            .locator(`[title="e2e-delete-via-ui"]`)
            .locator('xpath=../..');
        await annoRow.locator('button[title="Delete annotation"]').click();

        // 4. Label must disappear from sidebar.
        await expect(page.locator(`[title="e2e-delete-via-ui"]`)).toHaveCount(0, {
            timeout: 10_000,
        });

        // 5. Confirm deleted from API.
        const afterDel = await page.request.get(
            `${LIVE_ANNO_API}/annotations?slide_id=${LIVE_SLIDE_ID}&study_id=${STUDY_ID}`
        );
        const remaining = await afterDel.json();
        expect(remaining.some((a: any) => a.id === created.id)).toBe(false);
    });
});
