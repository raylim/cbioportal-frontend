import { test, expect, Page } from '../fixtures';

const DEV_STUDY = {
    studyId: 'wsi-study-clinical-data-contract',
} as const;

function studyClinicalDataUrl() {
    return `/study/clinicalData?id=${DEV_STUDY.studyId}`;
}

const study = {
    studyId: DEV_STUDY.studyId,
    name: 'WSI study clinical-data contract',
    cancerTypeId: 'wsi-contract',
    publicStudy: true,
    groups: 'PUBLIC',
    status: 0,
    referenceGenome: 'hg19',
};

const samples = [
    {
        studyId: DEV_STUDY.studyId,
        patientId: 'WSP-1',
        sampleId: 'WSS-1',
        uniquePatientKey: `${DEV_STUDY.studyId}_WSP-1`,
        uniqueSampleKey: `${DEV_STUDY.studyId}_WSS-1`,
    },
    {
        studyId: DEV_STUDY.studyId,
        patientId: 'WSP-2',
        sampleId: 'WSS-2',
        uniquePatientKey: `${DEV_STUDY.studyId}_WSP-2`,
        uniqueSampleKey: `${DEV_STUDY.studyId}_WSS-2`,
    },
];

const clinicalAttributes = [
    'WSI_SAMPLE_SLIDE_COUNT',
    'WSI_PATIENT_SLIDE_COUNT',
    'WSI_SAMPLE_PART_MATCHED_SLIDE_COUNT',
    'WSI_SAMPLE_BLOCK_MATCHED_SLIDE_COUNT',
    'WSI_PATIENT_PART_MATCHED_SLIDE_COUNT',
    'WSI_PATIENT_BLOCK_MATCHED_SLIDE_COUNT',
].map(clinicalAttributeId => ({
    clinicalAttributeId,
    displayName: clinicalAttributeId,
    description: clinicalAttributeId,
    datatype: 'NUMBER',
    patientAttribute: true,
    priority: 0,
    studyId: DEV_STUDY.studyId,
}));

const sampleClinicalData = {
    [samples[0].uniqueSampleKey]: [
        { clinicalAttributeId: 'WSI_SAMPLE_SLIDE_COUNT', value: '7' },
        {
            clinicalAttributeId: 'WSI_SAMPLE_PART_MATCHED_SLIDE_COUNT',
            value: '5',
        },
        {
            clinicalAttributeId: 'WSI_SAMPLE_BLOCK_MATCHED_SLIDE_COUNT',
            value: '4',
        },
    ],
    [samples[1].uniqueSampleKey]: [
        { clinicalAttributeId: 'WSI_SAMPLE_SLIDE_COUNT', value: '2' },
        {
            clinicalAttributeId: 'WSI_SAMPLE_PART_MATCHED_SLIDE_COUNT',
            value: '1',
        },
        {
            clinicalAttributeId: 'WSI_SAMPLE_BLOCK_MATCHED_SLIDE_COUNT',
            value: '1',
        },
    ],
};

async function installStudyMocks(page: Page) {
    await page.route('**/api/**', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
        })
    );
    await page.addInitScript(() => {
        localStorage.setItem(
            'frontendConfig',
            JSON.stringify({
                serverConfig: {
                    authenticationMethod: 'none',
                    skin_hide_download_controls: 'HIDE_ALL',
                },
            })
        );
    });
    await page.route('**/config_service', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                app_name: 'wsi-study-clinical-data-contract',
                authenticationMethod: 'none',
            }),
        })
    );
    await page.route('**/api/studies**', route => {
        if (new URL(route.request().url()).pathname !== '/api/studies') {
            return route.fallback();
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([study]),
        });
    });
    await page.route('**/api/filtered-samples/fetch', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(samples),
        })
    );
    await page.route('**/api/clinical-attributes/fetch', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(clinicalAttributes),
        })
    );
    await page.route('**/api/clinical-data-table/fetch', async route => {
        const requestBody = route.request().postDataJSON() as {
            studyViewFilter?: { clinicalDataFilters?: unknown[] };
        };
        const filtered =
            (requestBody.studyViewFilter?.clinicalDataFilters?.length ?? 0) > 0;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'total-count': filtered ? '600' : '2' },
            body: JSON.stringify({
                byUniqueSampleKey: filtered
                    ? {
                          [samples[0].uniqueSampleKey]:
                              sampleClinicalData[samples[0].uniqueSampleKey],
                      }
                    : sampleClinicalData,
            }),
        });
    });
}

async function waitForClinicalDataTable(page: Page) {
    await expect(
        page.locator('[data-test="clinical-data-tab-content"] table')
    ).toBeVisible({ timeout: 30000 });
}

async function clickColumnsButton(page: Page) {
    await page
        .locator('[data-test="clinical-data-tab-content"] button', {
            hasText: 'Columns',
        })
        .click();
}

async function toggleColumn(page: Page, columnId: string) {
    await page.locator(`[data-id="${columnId}"]`).click();
}

async function getVisibleHeaderNames(page: Page): Promise<string[]> {
    return page
        .locator('[data-test="clinical-data-tab-content"] thead th')
        .evaluateAll(headers =>
            headers
                .map(header => (header.textContent || '').trim())
                .filter(Boolean)
        );
}

async function getColumnValuesByHeader(
    page: Page,
    headerName: string
): Promise<string[]> {
    return page.evaluate(targetHeader => {
        const table = document.querySelector(
            '[data-test="clinical-data-tab-content"] table'
        );
        if (!table) {
            return [];
        }

        const headers = Array.from(table.querySelectorAll('thead th')).map(th =>
            (th.textContent || '').trim()
        );
        const index = headers.findIndex(header => header === targetHeader);
        if (index < 0) {
            return [];
        }

        return Array.from(table.querySelectorAll('tbody tr'))
            .map(row => {
                const cell = row.querySelectorAll('td')[index];
                return (cell?.textContent || '').trim();
            })
            .filter(Boolean);
    }, headerName);
}

function parseLeadingIntegers(values: string[]): number[] {
    return values
        .map(value => {
            const match = value.match(/^-?\d+/);
            return match ? Number(match[0]) : NaN;
        })
        .filter(value => Number.isFinite(value));
}

function isNonIncreasing(values: number[]): boolean {
    for (let index = 1; index < values.length; index += 1) {
        if (values[index] > values[index - 1]) {
            return false;
        }
    }
    return true;
}

function isNonDecreasing(values: number[]): boolean {
    for (let index = 1; index < values.length; index += 1) {
        if (values[index] < values[index - 1]) {
            return false;
        }
    }
    return true;
}

async function sortColumnDescending(page: Page, headerName: string) {
    const header = page.locator(`[data-test="${headerName}"]`);

    for (let attempt = 0; attempt < 3; attempt += 1) {
        await header.click();
        try {
            await expect
                .poll(
                    async () => {
                        const values = parseLeadingIntegers(
                            await getColumnValuesByHeader(page, headerName)
                        );
                        return values.length > 0 && isNonIncreasing(values);
                    },
                    { timeout: 3000 }
                )
                .toBe(true);
            return;
        } catch (error) {
            if (attempt === 2) {
                throw error;
            }
        }
    }
}

test.describe('study clinical data pathology columns', () => {
    test.beforeEach(async ({ page }) => {
        await installStudyMocks(page);
    });

    test('exposes WSI slide columns through column visibility and sorts by WSI Slides per Patient', async ({
        page,
    }) => {
        await page.goto(studyClinicalDataUrl());
        await waitForClinicalDataTable(page);

        const initialHeaders = await getVisibleHeaderNames(page);
        expect(initialHeaders).toContain('WSI Slides per Patient');
        expect(initialHeaders).not.toContain(
            'WSI Slides per Patient, Part-matched'
        );
        expect(initialHeaders).not.toContain(
            'WSI Slides per Patient, Block-matched'
        );

        await clickColumnsButton(page);
        await toggleColumn(page, 'WSI Slides per Patient, Part-matched');
        await toggleColumn(page, 'WSI Slides per Patient, Block-matched');
        await clickColumnsButton(page);

        await expect(
            page.locator('[data-test="WSI Slides per Patient"]')
        ).toBeVisible();
        await expect(
            page.locator('[data-test="WSI Slides per Patient, Part-matched"]')
        ).toBeVisible();
        await expect(
            page.locator('[data-test="WSI Slides per Patient, Block-matched"]')
        ).toBeVisible();

        const beforeSort = parseLeadingIntegers(
            await getColumnValuesByHeader(page, 'WSI Slides per Patient')
        );
        expect(beforeSort.length).toBeGreaterThan(0);

        await sortColumnDescending(page, 'WSI Slides per Patient');
        await sortColumnDescending(
            page,
            'WSI Slides per Patient, Part-matched'
        );
        await sortColumnDescending(
            page,
            'WSI Slides per Patient, Block-matched'
        );
    });
});

test.describe('private MSK-IMPACT clinical data sorting', () => {
    test.beforeEach(async ({ page }) => {
        await installStudyMocks(page);
    });

    test('keeps the filtered cohort total when sorting WSI slides in either direction', async ({
        page,
    }) => {
        const filterJson = encodeURIComponent(
            JSON.stringify({
                clinicalDataFilters: [
                    {
                        attributeId: 'CANCER_TYPE',
                        values: [{ value: 'Colorectal Cancer' }],
                    },
                ],
            })
        );
        await page.goto(`${studyClinicalDataUrl()}#filterJson=${filterJson}`);
        await waitForClinicalDataTable(page);

        const resultCount = page
            .locator('[data-test="clinical-data-tab-content"] strong')
            .filter({ hasText: /^\d+ results$/ });
        await expect(resultCount).toBeVisible();
        const filteredResultText = (await resultCount.innerText()).trim();
        expect(Number.parseInt(filteredResultText, 10)).toBeGreaterThan(500);

        const headerCell = page
            .locator('[data-test="clinical-data-tab-content"] th')
            .filter({
                has: page.locator('[data-test="WSI Slides per Patient"]'),
            });
        const sortButton = headerCell.locator('span[role="button"]');
        const waitForSortedTable = () =>
            page.waitForResponse(
                response =>
                    response.ok() &&
                    response.request().method() === 'POST' &&
                    response.url().includes('/api/clinical-data-table/fetch')
            );

        const descendingResponse = waitForSortedTable();
        await sortButton.click();
        await descendingResponse;
        await expect(sortButton).toHaveClass(/sort-des/);
        await expect
            .poll(async () => {
                const values = parseLeadingIntegers(
                    await getColumnValuesByHeader(
                        page,
                        'WSI Slides per Patient'
                    )
                );
                return values.length > 0 && isNonIncreasing(values);
            })
            .toBe(true);
        await expect(resultCount).toHaveText(filteredResultText);
        await expect(
            page.getByRole('button', { name: 'View Next Page' })
        ).toBeEnabled();
        await expect(
            page.getByText("You've reached the maximum viewable records.")
        ).toHaveCount(0);

        const ascendingResponse = waitForSortedTable();
        await sortButton.click();
        await ascendingResponse;
        await expect(sortButton).toHaveClass(/sort-asc/);
        await expect
            .poll(async () => {
                const values = parseLeadingIntegers(
                    await getColumnValuesByHeader(
                        page,
                        'WSI Slides per Patient'
                    )
                );
                return values.length > 0 && isNonDecreasing(values);
            })
            .toBe(true);
        await expect(resultCount).toHaveText(filteredResultText);
        await expect(
            page.getByText("You've reached the maximum viewable records.")
        ).toHaveCount(0);
    });
});
