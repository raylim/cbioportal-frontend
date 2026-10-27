import { test, expect, Page } from '../fixtures';
import {
    routeSlideAccess,
    routeTilePixels,
    tileMetadata,
} from './wsi-foundation-mocks';
import { studySlidesPageFor } from '../../src/pages/studyView/tabs/pathologySlides/studySlidesTestServer';
import { StudySlidesRequest } from '../../src/pages/studyView/tabs/pathologySlides/studySlidesApi';

const STUDY_ID = 'wsi-study-slides-contract';
const PATIENT_COUNT = 55;
const PAGE_SIZE = 50;

const study = {
    studyId: STUDY_ID,
    name: 'WSI study slides contract',
    description:
        'A deterministic study fixture for the study Pathology Slides tab.',
    cancerTypeId: 'wsi-contract',
    publicStudy: true,
    groups: 'PUBLIC',
    status: 0,
    referenceGenome: 'hg19',
};

const patientIds = Array.from(
    { length: PATIENT_COUNT },
    (_, index) => `WSS-P-${String(index + 1).padStart(3, '0')}`
);

const samples = patientIds.map(patientId => ({
    studyId: STUDY_ID,
    patientId,
    sampleId: `${patientId}-S`,
    uniquePatientKey: `${STUDY_ID}_${patientId}`,
    uniqueSampleKey: `${STUDY_ID}_${patientId}-S`,
}));

function stainCounts(patientId: string) {
    const ihc = patientIds.indexOf(patientId) % 5 === 0 ? 1 : 0;
    return { 'H&E': 1, IHC: ihc, Other: 0, Unknown: 0 };
}

const patients = patientIds.map(patientId => {
    const counts = stainCounts(patientId);
    return {
        studyId: STUDY_ID,
        patientId,
        slideCount: counts['H&E'] + counts.IHC,
        stainGroupCounts: counts,
    };
});

/** An opaque 12-hex slide key per patient, as the backend publishes them. */
function slideKeyFor(patientId: string) {
    return (patientIds.indexOf(patientId) + 1).toString(16).padStart(12, '0');
}

/** A patient's one WSI_SAMPLE slide row, as the resource table API returns it. */
function slideRowsFor(patientId: string) {
    return [
        {
            studyId: STUDY_ID,
            resourceId: 'WSI_SAMPLE',
            patientId,
            sampleId: `${patientId}-S`,
            metadata: {
                slide_key: slideKeyFor(patientId),
                reference_sample_id: `${patientId}-S`,
                part_key: 'part:1',
                part_number: '1',
                part_description: 'Contract specimen',
                block_key: 'block:A1',
                block_number: 'A1',
                block_label: 'A1',
                stain_name: 'H&E initial',
                stain_group: 'H&E',
                is_hne: true,
                is_ihc: false,
                slide_type: 'H&E',
                can_serve_tiles: true,
                match_level: 'BLOCK',
                specimen_key: 'block::1::A1',
                wsi_serving: {
                    sealed_source: 'sealed',
                    tile_metadata_json: tileMetadata,
                    thumbnail_width: 128,
                    thumbnail_height: 96,
                    thumbnail_content_type: 'image/png',
                },
            },
        },
    ];
}

interface StudySlidesMocks {
    studySlidesRequests: StudySlidesRequest[];
    slideRowPatients: string[];
    /** Every slide access request URL. */
    accessRequests: string[];
}

async function installStudySlidesMocks(page: Page): Promise<StudySlidesMocks> {
    const mocks: StudySlidesMocks = {
        studySlidesRequests: [],
        slideRowPatients: [],
        accessRequests: [],
    };
    const serverConfig = {
        authenticationMethod: 'none',
        sessionServiceEnabled: true,
        user_display_name: 'wsi-study-slides-user',
        skin_hide_download_controls: 'HIDE_ALL',
        wsi_tile_server_url: '/wsi',
    };
    await page.addInitScript(config => {
        const win = window as any;
        let frontendConfig = win.frontendConfig || {};
        const localConfig = {
            apiRoot: '/',
            baseUrl: window.location.host,
            frontendUrl: `${window.location.origin}/`,
            configurationServiceUrl: '/config_service',
        };
        Object.defineProperty(win, 'frontendConfig', {
            configurable: true,
            get: () => frontendConfig,
            set: value => {
                frontendConfig = { ...value, ...localConfig };
            },
        });
        frontendConfig = { ...frontendConfig, ...localConfig };
        localStorage.setItem(
            'frontendConfig',
            JSON.stringify({ serverConfig: config })
        );
    }, serverConfig);
    await page.route('**/config_service', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                app_name: 'wsi-study-slides-contract',
                ...serverConfig,
            }),
        })
    );
    // Registered first, so the specific routes below take precedence.
    await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/studies') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([study]),
            });
        }
        if (pathname === '/api/filtered-samples/fetch') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(samples),
            });
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
        });
    });
    await page.route(
        '**/api/wsi/v2/study-slides/patients/fetch',
        async route => {
            const body = route.request().postDataJSON() as StudySlidesRequest;
            mocks.studySlidesRequests.push(body);
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(studySlidesPageFor(body, patients)),
            });
        }
    );
    // The viewer lists a patient's slides from the WSI_SAMPLE and WSI_PATIENT
    // resource rows; every patient here has one WSI_SAMPLE slide.
    await page.route('**/api/resource-table/query/fetch', route => {
        const query = route.request().postDataJSON();
        const patientId: string =
            query?.patientIdentifiers?.[0]?.patientId || '';
        if (query?.resourceId !== 'WSI_SAMPLE') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([]),
            });
        }
        mocks.slideRowPatients.push(patientId);
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(slideRowsFor(patientId)),
        });
    });
    await routeSlideAccess(
        page,
        STUDY_ID,
        (patientId, slideKey) => slideKey === slideKeyFor(patientId),
        mocks.accessRequests
    );
    await routeTilePixels(page);
    return mocks;
}

function patientPosition(page: Page) {
    return page.getByTestId('study-slides-position');
}

if (process.env.PW_SUITE === 'wsi') {
    test.describe('study Pathology Slides tab', () => {
        test('steps through the cohort and keeps the patient in the URL', async ({
            page,
        }) => {
            const mocks = await installStudySlidesMocks(page);
            await page.goto(`/study/pathologySlides?id=${STUDY_ID}`);

            await expect(
                page.getByTestId('study-slides-summary')
            ).toHaveText('66 viewable slides', { timeout: 30000 });
            await expect(page.getByTestId('study-slides-patient')).toHaveCount(
                PAGE_SIZE
            );
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[0]} · 1 of ${PATIENT_COUNT}`
            );
            await expect(
                page.getByTestId(`wsi-slide-item-${slideKeyFor(patientIds[0])}`)
            ).toBeVisible({ timeout: 30000 });
            expect(
                mocks.studySlidesRequests[0].studyViewFilter.studyIds
            ).toEqual([STUDY_ID]);
            // Slides are addressed only by their opaque key.
            expect(mocks.accessRequests.length).toBeGreaterThan(0);
            for (const accessUrl of mocks.accessRequests) {
                const params = new URL(accessUrl).searchParams;
                expect(params.get('slideKey')).toMatch(/^[0-9a-f]{12}$/);
                expect([...params.keys()]).toEqual(['slideKey']);
            }

            await page.getByTestId('study-slides-next').click();
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[1]} · 2 of ${PATIENT_COUNT}`
            );
            await expect(
                page.getByTestId(`wsi-slide-item-${slideKeyFor(patientIds[1])}`)
            ).toBeVisible({ timeout: 30000 });
            await expect
                .poll(() =>
                    new URL(page.url()).searchParams.get('wsiPatientId')
                )
                .toBe(patientIds[1]);

            // Next from the last listed patient loads the following page.
            await page
                .getByTestId('study-slides-patients')
                .getByText(patientIds[PAGE_SIZE - 1], { exact: true })
                .click();
            await page.keyboard.press(']');
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[PAGE_SIZE]} · ${PAGE_SIZE +
                    1} of ${PATIENT_COUNT}`
            );
            await expect(page.getByTestId('study-slides-patient')).toHaveCount(
                PATIENT_COUNT - PAGE_SIZE
            );
            expect(
                mocks.studySlidesRequests.some(r => r.pageNumber === 1)
            ).toBe(true);

            await expect(
                page.getByTestId('study-slides-open-patient')
            ).toHaveAttribute(
                'href',
                new RegExp(
                    `/patient/wsiHESlides\\?studyId=${STUDY_ID}&caseId=${patientIds[PAGE_SIZE]}#navCaseIds=`
                )
            );

            // A reload reopens the same patient on its list page.
            await page.reload();
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[PAGE_SIZE]} · ${PAGE_SIZE +
                    1} of ${PATIENT_COUNT}`,
                { timeout: 30000 }
            );
            const restore = mocks.studySlidesRequests.find(
                r => r.locatePatientId === patientIds[PAGE_SIZE]
            );
            expect(restore).toBeTruthy();
        });

        test('filters the list by stain group and patient ID', async ({
            page,
        }) => {
            const mocks = await installStudySlidesMocks(page);
            await page.goto(`/study/pathologySlides?id=${STUDY_ID}`);
            await expect(
                page.getByTestId('study-slides-patient')
            ).toHaveCount(PAGE_SIZE, { timeout: 30000 });

            await page.getByTestId('study-slides-filters-toggle').click();
            await page.getByTestId('study-slides-stain-IHC').click();
            await expect(page.getByTestId('study-slides-patient')).toHaveCount(
                11
            );
            expect(
                mocks.studySlidesRequests[mocks.studySlidesRequests.length - 1]
                    .stainGroups
            ).toEqual(['IHC']);

            await page.getByTestId('study-slides-stain-IHC').click();
            await page.getByTestId('study-slides-search').fill('WSS-P-05');
            await expect(page.getByTestId('study-slides-patient')).toHaveCount(
                6
            );
            await page.getByTestId('study-slides-search').fill('none');
            await page.getByTestId('study-slides-search').press('Enter');
            await expect(page.getByTestId('study-slides-empty')).toHaveText(
                'No patients match these filters.'
            );
        });

        test('restores the slide table view and redirects the old slide table tab', async ({
            page,
        }) => {
            await installStudySlidesMocks(page);
            await page.goto(`/study/resourceTable_WSI_SAMPLE?id=${STUDY_ID}`);
            await expect(
                page.getByTestId('study-slides-view-table')
            ).toHaveAttribute('aria-pressed', 'true', { timeout: 30000 });
            await expect(page.getByTestId('study-slides-table')).toBeVisible();
            await expect
                .poll(() => {
                    const url = new URL(page.url());
                    return `${url.pathname} ${url.searchParams.get('wsiView')}`;
                })
                .toBe('/study/pathologySlides table');

            await page.reload();
            await expect(
                page.getByTestId('study-slides-view-table')
            ).toHaveAttribute('aria-pressed', 'true', { timeout: 30000 });

            await page.getByTestId('study-slides-view-viewer').click();
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[0]} · 1 of ${PATIENT_COUNT}`,
                {
                    timeout: 30000,
                }
            );
            await expect
                .poll(() => new URL(page.url()).searchParams.get('wsiView'))
                .toBeNull();
        });
    });
}
