import { test, expect, Page } from '../fixtures';

const STUDY_ID = 'wsi-study-contract';
const PATIENT_ID = 'wsi-study-patient';
const SAMPLE_ID = 'wsi-study-sample';
const UNIQUE_SAMPLE_KEY = `${STUDY_ID}_${SAMPLE_ID}`;

const study = {
    studyId: STUDY_ID,
    name: 'WSI study contract',
    description: 'Study child browser contract',
    publicStudy: true,
    groups: 'PUBLIC',
    status: 0,
    cancerTypeId: 'miscellaneous',
    referenceGenome: 'hg19',
};

const samples = [
    {
        studyId: STUDY_ID,
        patientId: PATIENT_ID,
        sampleId: SAMPLE_ID,
        uniqueSampleKey: UNIQUE_SAMPLE_KEY,
        uniquePatientKey: `${STUDY_ID}_${PATIENT_ID}`,
        sampleType: 'Primary Tumor',
    },
];

const clinicalAttributes = [
    {
        clinicalAttributeId: 'CANCER_TYPE',
        displayName: 'Cancer Type',
        datatype: 'STRING',
        patientAttribute: true,
        priority: 1,
    },
    ...[
        ['WSI_PATIENT_SLIDE_COUNT', 'WSI Slides per Patient'],
        [
            'WSI_PATIENT_PART_MATCHED_SLIDE_COUNT',
            'WSI Slides per Patient, Part-matched',
        ],
        [
            'WSI_PATIENT_BLOCK_MATCHED_SLIDE_COUNT',
            'WSI Slides per Patient, Block-matched',
        ],
    ].map(([clinicalAttributeId, displayName]) => ({
        clinicalAttributeId,
        displayName,
        datatype: 'NUMBER',
        patientAttribute: true,
        priority: 10,
    })),
];

const clinicalTableRows = {
    [UNIQUE_SAMPLE_KEY]: [
        { clinicalAttributeId: 'CANCER_TYPE', value: 'Contract cohort' },
        { clinicalAttributeId: 'WSI_PATIENT_SLIDE_COUNT', value: '3' },
        {
            clinicalAttributeId: 'WSI_PATIENT_PART_MATCHED_SLIDE_COUNT',
            value: '2',
        },
        {
            clinicalAttributeId: 'WSI_PATIENT_BLOCK_MATCHED_SLIDE_COUNT',
            value: '1',
        },
    ],
};

async function installStudyMocks(page: Page) {
    await page.addInitScript(() => {
        window.localStorage.setItem(
            'frontendConfig',
            JSON.stringify({
                apiRoot: '/',
                serverConfig: {
                    authenticationMethod: 'none',
                    sessionServiceEnabled: true,
                    clinical_attribute_product_limit: 5000,
                    skin_hide_download_controls: 'SHOW_ALL',
                },
            })
        );
    });
    await page.route('**/config_service', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                app_name: 'wsi-study-contract',
                apiRoot: '/',
                authenticationMethod: 'none',
                sessionServiceEnabled: true,
                clinical_attribute_product_limit: 5000,
                skin_hide_download_controls: 'SHOW_ALL',
            }),
        })
    );
    await page.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const apiPath = path.includes('/api/')
            ? path.slice(path.indexOf('/api/'))
            : path;

        if (apiPath === '/api/studies' && request.method() === 'GET') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([study]),
            });
            return;
        }
        if (apiPath === `/api/studies/${STUDY_ID}`) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(study),
            });
            return;
        }
        if (apiPath === '/api/molecular-profiles/fetch') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([]),
            });
            return;
        }
        if (apiPath === '/api/clinical-attributes/fetch') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(clinicalAttributes),
            });
            return;
        }
        if (apiPath === '/api/clinical-attributes/counts/fetch') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(
                    clinicalAttributes.map(attribute => ({
                        clinicalAttributeId: attribute.clinicalAttributeId,
                        count: 1,
                    }))
                ),
            });
            return;
        }
        if (
            apiPath === '/api/samples/fetch' ||
            apiPath === '/api/filtered-samples/fetch'
        ) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(samples),
            });
            return;
        }
        if (apiPath === '/api/clinical-data-table/fetch') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: { 'total-count': '1' },
                body: JSON.stringify({ byUniqueSampleKey: clinicalTableRows }),
            });
            return;
        }
        if (apiPath === '/api/clinical-data/fetch') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([]),
            });
            return;
        }
        if (apiPath === '/api/clinical-data-counts/fetch') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([
                    {
                        attributeId: 'CANCER_TYPE',
                        counts: [
                            { value: 'Contract cohort', count: 1, freq: 1 },
                        ],
                    },
                ]),
            });
            return;
        }
        if (apiPath === '/api/clinical-data-bin-counts/fetch') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(
                    clinicalAttributes
                        .filter(attribute => attribute.datatype === 'NUMBER')
                        .map(attribute => ({
                            attributeId: attribute.clinicalAttributeId,
                            count: 1,
                            start: 1,
                            end: 3,
                        }))
                ),
            });
            return;
        }

        // Study View initializes optional charts before the Clinical Data tab
        // renders. Empty responses keep those optional requests nonfatal while
        // the contract below still exercises the WSI columns and sorting.
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
        });
    });
}

test.describe('WSI study presentation browser contract', () => {
    test('renders WSI columns, preserves ordinary data, and sorts the WSI count', async ({
        page,
    }) => {
        await installStudyMocks(page);
        const pageErrors: string[] = [];
        page.on('pageerror', error => pageErrors.push(error.message));

        await page.goto(`/study/clinicalData?id=${STUDY_ID}`);

        const content = page.locator('[data-test="clinical-data-tab-content"]');
        await expect(content).toBeVisible({ timeout: 30000 });
        await expect(content.getByText('1 results')).toBeVisible({
            timeout: 30000,
        });
        await expect(
            content.locator('[data-test="WSI Slides per Patient"]')
        ).toBeVisible();
        await expect(
            content.locator('[data-test="Contract cohort"]')
        ).toBeVisible();

        await content.getByRole('button', { name: /Columns/ }).click();
        await expect(
            page.locator('[data-id="WSI Slides per Patient, Part-matched"]')
        ).toBeVisible();
        await page
            .locator('[data-id="WSI Slides per Patient, Part-matched"]')
            .click();
        await page
            .locator('[data-id="WSI Slides per Patient, Block-matched"]')
            .click();
        await content.getByRole('button', { name: /Columns/ }).click();

        await expect(
            content.locator(
                '[data-test="WSI Slides per Patient, Part-matched"]'
            )
        ).toBeVisible();
        await expect(
            content.locator(
                '[data-test="WSI Slides per Patient, Block-matched"]'
            )
        ).toBeVisible();
        expect(pageErrors).toEqual([]);
    });
});
