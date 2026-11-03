// Browser check of a running demo (Playwright, Chromium):
//   patient page -> Pathology Slides tab, tiles load, annotation toolbar, draw a rectangle
//   (it is saved through the annotation service, then deleted again), no failed API calls.
//
//   npm i -D @playwright/test && npx playwright install chromium
//   node verify/browser_check.js [origin] [patientId]
// Screenshots are written next to this script.
const { chromium } = require('@playwright/test');

const ORIGIN = process.argv[2] || 'http://localhost:27800';
const PATIENT = process.argv[3] || 'TCGA-A7-A0CD';
const STUDY = 'brca_tcga_pan_can_atlas_2018';
const OUT = __dirname;

(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const failed = [];
    const otherFailed = [];
    const seen = { tiles: 0, thumbnails: 0, access: 0, annotationsGet: 0, annotationsPost: 0, agent: 0 };
    page.on('console', m => {
        if (m.type() === 'error') errors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', e => errors.push('pageerror ' + e.message.slice(0, 200)));
    page.on('response', r => {
        const u = r.url();
        const ok = r.status() < 400;
        if (u.includes('/wsi/tiles/') && ok) seen.tiles++;
        if (u.includes('/wsi/thumbnails') && ok) seen.thumbnails++;
        if (/\/api\/resources\/.*\/access/.test(u) && ok) seen.access++;
        if (u.includes('/wsi/annotations') && r.request().method() === 'GET' && ok) seen.annotationsGet++;
        if (u.includes('/wsi/annotations') && r.request().method() === 'POST' && ok) seen.annotationsPost++;
        if (u.includes('/wsi/agent')) seen.agent++;
        if ((u.startsWith(ORIGIN + '/api/') || u.startsWith(ORIGIN + '/wsi/')) && !ok) {
            failed.push(`${r.status()} ${r.request().method()} ${u.replace(ORIGIN, '').slice(0, 140)}`);
        } else if (!ok) {
            otherFailed.push(`${r.status()} ${u.slice(0, 140)}`);
        }
    });

    await page.goto(`${ORIGIN}/patient?studyId=${STUDY}&caseId=${PATIENT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=' + PATIENT, { timeout: 120000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${OUT}/01-patient-summary.png` });

    const tab = page.locator('a.tabAnchor', { hasText: /Pathology Slide/i }).first();
    await tab.waitFor({ timeout: 120000 });
    await tab.click();
    await page.waitForTimeout(15000);
    await page.screenshot({ path: `${OUT}/02-slides-tab.png` });

    const toolbar = await page.locator('[data-testid="wsi-annotation-toolbar"]').count();
    const layers = await page.locator('[data-testid="wsi-annotation-layers"]').count();
    const agentPanel = await page.locator('[data-testid="wsi-agent-panel"], [aria-label="Ask the research assistant"]').count();

    // Draw a rectangle in the middle of the slide.
    let drawn = false;
    const rect = page.locator('[data-testid="annotation-tool-rectangle"]').first();
    if (await rect.count()) {
        await rect.click();
        const canvas = page.locator('.openseadragon-canvas').first();
        const box = await canvas.boundingBox();
        if (box) {
            const x = box.x + box.width * 0.45;
            const y = box.y + box.height * 0.45;
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + 120, y + 80, { steps: 12 });
            await page.mouse.up();
            await page.waitForTimeout(4000);
            drawn = seen.annotationsPost > 0;
        }
    }
    const rows = page.locator('[data-testid^="annotation-row-"]');
    const annotationRows = await rows.count();
    await page.screenshot({ path: `${OUT}/03-annotation-drawn.png` });

    // Clean up the test annotation.
    let deleted = false;
    if (annotationRows) {
        const del = page.locator('[data-testid^="delete-annotation-"]').last();
        if (await del.count()) {
            page.once('dialog', d => d.accept());
            await del.click();
            await page.waitForTimeout(3000);
            deleted = (await rows.count()) === annotationRows - 1;
        }
    }

    const result = {
        origin: ORIGIN,
        patient: PATIENT,
        seen,
        annotationToolbar: toolbar,
        annotationLayers: layers,
        assistantPanel: agentPanel,
        rectangleSaved: drawn,
        annotationRows,
        testAnnotationDeleted: deleted,
        failedRequests: failed.slice(0, 20),
        otherFailedRequests: otherFailed.slice(0, 10),
        consoleErrors: errors.slice(0, 10),
    };
    console.log(JSON.stringify(result, null, 1));
    await browser.close();
    const pass = seen.tiles > 0 && toolbar > 0 && drawn && failed.length === 0;
    console.log(pass ? 'PASS' : 'FAIL');
    process.exit(pass ? 0 : 1);
})();
