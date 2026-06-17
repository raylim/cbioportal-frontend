import { test, expect } from '../fixtures';

const BASE_URL = process.env.WSI_VIEWER_BASE_URL ?? '';
const TILE_SERVER = process.env.TILE_SERVER_URL ?? 'http://pllimsksparky3:8081';
const CBIO_URL = process.env.CBIO_URL ?? 'http://pllimsksparky3:8090';
const STUDY_ID = 'coad_msk_2025';
const PATIENT_ID = 'P-0000678';

function viewerUrl(hash = ''): string {
    const resourceUrl = encodeURIComponent(
        `${TILE_SERVER}/?patient=${PATIENT_ID}&studyId=${STUDY_ID}&cbioUrl=${CBIO_URL}`
    );
    const base = `${BASE_URL}/patient/wsiHESlides?studyId=${STUDY_ID}&caseId=${PATIENT_ID}&resourceUrl=${resourceUrl}`;
    return hash ? `${base}${hash}` : base;
}

test.describe('Event debug', () => {
    test.beforeEach(async () => {
        test.skip(!BASE_URL, 'WSI_VIEWER_BASE_URL not set');
    });

    test('Test if click events fire on container', async ({ page }) => {
        page.on('console', msg => console.log('[Browser console]', msg.text()));
        
        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(2000);
        
        // Click the ellipse button
        await page.click('button[title="Draw ellipse"]');
        await page.waitForTimeout(500);
        
        // Try to click on the viewer area
        const viewer = page.locator('.openseadragon-container');
        await viewer.click({ position: { x: 200, y: 200 } });
        
        await page.waitForTimeout(1000);
    });
});
