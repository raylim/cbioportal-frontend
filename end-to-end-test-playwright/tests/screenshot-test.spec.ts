import { test, expect } from '@playwright/test';

const BASE_URL = process.env.WSI_VIEWER_BASE_URL ?? '';
const MOCK_ANNOTATION_URL = 'http://mock-annotation-api';
const STUDY_ID = 'lgg_ucsf_2014';
const MOCK_ANNOTATION = {
    id: 'ann-test-1', slide_id: '1492807', study_id: STUDY_ID,
    body: { label: 'Test', comment: '', type: 'region' },
    target: { selector: { type: 'FragmentSelector', value: 'xywh=100,100,50,50' } },
    created_by: 'playwright', created_at: '2025-01-01T00:00:00', version: 1,
};

test('Screenshot after drawing ellipse', async ({ page }) => {
    await page.route(`${MOCK_ANNOTATION_URL}/annotations**`, async (route: any) => {
        const method = route.request().method();
        if (method === 'GET') await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([MOCK_ANNOTATION]) });
        else if (method === 'POST') await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...MOCK_ANNOTATION, id: 'ann-new-1' }) });
        else await route.continue();
    });
    await page.addInitScript((apiUrl: string) => {
        localStorage.setItem('frontendConfig', JSON.stringify({ serverConfig: { msk_wsi_annotation_api_url: apiUrl } }));
    }, MOCK_ANNOTATION_URL);

    const msgs: string[] = [];
    page.on('console', msg => msgs.push(`[${msg.type()}] ${msg.text().substring(0, 200)}`));

    await page.goto(`${BASE_URL}/patient?studyId=${STUDY_ID}&caseId=P04&activeTab=pathology`);
    await expect(page.locator('button:has-text("Share view")')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(4_000);

    await page.screenshot({ path: 'test-results/before-draw.png', fullPage: false });

    const osdCanvas = page.locator('.openseadragon-canvas').first();
    const box = await osdCanvas.boundingBox();
    console.log('OSD canvas box:', JSON.stringify(box));
    console.log('Relevant console msgs:', msgs.filter(m => m.includes('WSI') || m.includes('Failed') || m.includes('error')).join('\n'));

    await page.locator('button[title*="Draw an ellipse"]').click();
    await expect(page.locator('button', { hasText: '✕ Cancel draw' })).toBeVisible({ timeout: 5_000 });

    if (box) {
        const cx = box.x + box.width * 0.4;
        const cy = box.y + box.height * 0.4;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let i = 1; i <= 15; i++) await page.mouse.move(cx + i * 10, cy + i * 7);
        await page.mouse.up();
    }
    
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: 'test-results/after-draw.png', fullPage: false });

    const sidebarCount = await page.locator('[data-testid^="edit-label-"]').count();
    console.log('Sidebar annotation count after draw:', sidebarCount);
    console.log('More console msgs after draw:', msgs.slice(-5).join('\n'));
    
    expect(page.locator('[data-testid="edit-label-ann-new-1"]')).toBeTruthy();
});
