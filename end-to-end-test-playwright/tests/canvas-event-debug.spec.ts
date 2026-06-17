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

test.describe('Canvas event debug', () => {
    test.beforeEach(async () => {
        test.skip(!BASE_URL, 'WSI_VIEWER_BASE_URL not set');
    });

    test('Debug canvas mouse events', async ({ page }) => {
        // Listen to console logs
        page.on('console', msg => console.log('[Browser console]', msg.text()));
        
        await page.goto(viewerUrl());
        await expect(page.locator('button:has-text("Share view")')).toBeVisible({ timeout: 30_000 });
        
        // Log all element z-indexes and pointer-events
        const canvasInfo = await page.evaluate(() => {
            const canvas = document.querySelector('canvas');
            if (!canvas) return { error: 'No canvas found' };
            
            const rect = canvas.getBoundingClientRect();
            const canvasStyle = window.getComputedStyle(canvas);
            
            // Find all elements at canvas center position
            const elementsAtPoint = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            
            return {
                canvas: {
                    tagName: canvas.tagName,
                    zIndex: canvasStyle.zIndex,
                    pointerEvents: canvasStyle.pointerEvents,
                    position: canvasStyle.position,
                    display: canvasStyle.display,
                },
                elementsAtCenter: elementsAtPoint.slice(0, 8).map((el: any) => ({
                    tagName: el.tagName,
                    className: el.className || '',
                    id: el.id || '',
                    zIndex: window.getComputedStyle(el).zIndex,
                    pointerEvents: window.getComputedStyle(el).pointerEvents,
                })),
            };
        });
        
        console.log('Canvas info:', JSON.stringify(canvasInfo, null, 2));
    });
});
