import { test, expect, Page } from '../fixtures';
import { pixel, tileMetadata, TileServerRequest } from './wsi-foundation-mocks';
import {
    ResourceTableTestServer,
    TestResourceRow,
} from '../../src/shared/api/resourceTableTestServer';
import {
    ResourceTableQuery,
    ResourceTabsRequest,
} from '../../src/shared/api/resourceTableClient';

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

/** The study-view chart filter the cohort test applies: patients 1, 3, 5, ... */
const ODD_PATIENTS_FILTER = {
    clinicalDataFilters: [
        { attributeId: 'PATIENT_PARITY', values: [{ value: 'Odd' }] },
    ],
};

function isOddPatient(patientId: string) {
    return patientIds.indexOf(patientId) % 2 === 0;
}

/** The first 30 patients' slides are biopsies, the rest resections. */
function partType(patientId: string) {
    return patientIds.indexOf(patientId) < 30 ? 'Biopsy' : 'Resection';
}

/** Every seventh patient's slides are matched by part, the others by block. */
function isPartMatched(patientId: string) {
    return patientIds.indexOf(patientId) % 7 === 0;
}

/** An opaque 12-hex slide key per patient slide, as the backend publishes them. */
function slideKeyFor(patientId: string, slide = 0) {
    return (patientIds.indexOf(patientId) + 1 + slide * 0x1000)
        .toString(16)
        .padStart(12, '0');
}

/**
 * A slide row of the WSI_SAMPLE resource. Every patient has an H&E slide, and
 * every fifth patient an IHC slide too: 66 slides.
 */
function slideRow(
    patientId: string,
    slide: number,
    stain: 'H&E' | 'IHC'
): TestResourceRow {
    const slideKey = slideKeyFor(patientId, slide);
    return {
        studyId: STUDY_ID,
        resourceId: 'WSI_SAMPLE',
        patientId,
        sampleId: `${patientId}-S`,
        metadata: {
            slide_key: slideKey,
            reference_sample_id: `${patientId}-S`,
            part_key: 'part:1',
            part_number: '1',
            part_description: 'Contract specimen',
            part_type: partType(patientId),
            block_key: 'block:A1',
            block_number: 'A1',
            block_label: 'A1',
            stain_name: stain === 'H&E' ? 'H&E initial' : 'Ki-67',
            stain_group: stain,
            is_hne: stain === 'H&E',
            is_ihc: stain === 'IHC',
            slide_type: stain,
            can_serve_tiles: true,
            match_level: isPartMatched(patientId) ? 'PART' : 'BLOCK',
            specimen_key: 'block::1::A1',
            serving: {
                key: slideKey,
                sealed_source: 'sealed',
                tile_metadata_json: tileMetadata,
                thumbnail_width: 128,
                thumbnail_height: 96,
                thumbnail_content_type: 'image/png',
            },
        },
    };
}

const slideRows: TestResourceRow[] = patientIds.flatMap((patientId, index) => [
    slideRow(patientId, 0, 'H&E'),
    ...(index % 5 === 0 ? [slideRow(patientId, 1, 'IHC')] : []),
]);

/** The resource-table API over the slide rows; the chart filter keeps odd patients. */
const resourceTable = new ResourceTableTestServer(() => slideRows, {
    inStudyViewCohort: (row, query) =>
        !(query.studyViewFilter as any)?.clinicalDataFilters ||
        isOddPatient(row.patientId!),
    // Identifiers and free text, which the slide contract declares unfilterable.
    unfilterableKeys: [
        'slide_key',
        'reference_sample_id',
        'part_key',
        'part_description',
        'block_key',
        'block_label',
        'specimen_key',
    ],
});

interface StudySlidesMocks {
    tabsRequests: ResourceTabsRequest[];
    /** Patient-grouped groups/fetch requests: the patient list. */
    listRequests: ResourceTableQuery[];
    /** Sample-grouped groups/fetch requests: the list's sample counts. */
    sampleCountRequests: ResourceTableQuery[];
    metadataRequests: ResourceTableQuery[];
    /** Rows requests, the viewer's and the slide table's. */
    rowsRequests: ResourceTableQuery[];
    /** Every tile and thumbnail request. */
    tileServerRequests: TileServerRequest[];
    /** Requests to the retired dedicated study-slides endpoint; there should be none. */
    retiredRequests: string[];
}

async function installStudySlidesMocks(page: Page): Promise<StudySlidesMocks> {
    const mocks: StudySlidesMocks = {
        tabsRequests: [],
        listRequests: [],
        sampleCountRequests: [],
        metadataRequests: [],
        rowsRequests: [],
        tileServerRequests: [],
        retiredRequests: [],
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
    const json = (body: unknown) => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
    // Registered first, so the specific routes below take precedence.
    await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.startsWith('/api/wsi/')) {
            mocks.retiredRequests.push(pathname);
            return route.fulfill({ status: 404, body: '' });
        }
        if (pathname === '/api/studies') {
            return route.fulfill(json([study]));
        }
        if (pathname === '/api/filtered-samples/fetch') {
            const filter = route.request().postDataJSON();
            return route.fulfill(
                json(
                    filter?.studyViewFilter?.clinicalDataFilters ||
                        filter?.clinicalDataFilters
                        ? samples.filter(s => isOddPatient(s.patientId))
                        : samples
                )
            );
        }
        return route.fulfill(json([]));
    });
    await page.route('**/api/resource-table/tabs/fetch', route => {
        const request = route.request().postDataJSON() as ResourceTabsRequest;
        mocks.tabsRequests.push(request);
        return route.fulfill(json(resourceTable.tabs(request)));
    });
    await page.route('**/api/resource-table/groups/fetch', route => {
        const query = route.request().postDataJSON() as ResourceTableQuery;
        (query.groupBy === 'sample'
            ? mocks.sampleCountRequests
            : mocks.listRequests
        ).push(query);
        return route.fulfill(json(resourceTable.groups(query)));
    });
    await page.route('**/api/resource-table/metadata/fetch', route => {
        const query = route.request().postDataJSON() as ResourceTableQuery;
        mocks.metadataRequests.push(query);
        return route.fulfill(json(resourceTable.metadata(query)));
    });
    await page.route('**/api/resource-table/query/fetch', route => {
        const query = route.request().postDataJSON() as ResourceTableQuery;
        mocks.rowsRequests.push(query);
        return route.fulfill(json(resourceTable.rows(query)));
    });
    for (const pattern of ['**/wsi/tiles/**', '**/wsi/thumbnails**']) {
        await page.route(pattern, route => {
            const request = route.request();
            mocks.tileServerRequests.push({
                url: request.url(),
                headers: request.headers(),
            });
            return route.fulfill({
                status: 200,
                contentType: 'image/png',
                body: pixel,
            });
        });
    }
    return mocks;
}

function patientPosition(page: Page) {
    return page.getByTestId('study-slides-position');
}

function lastOf<T>(requests: T[]): T {
    return requests[requests.length - 1];
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
            await expect(
                page.getByTestId('study-slides-patient').first()
            ).toContainText('1 sample · 2 slides');
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[0]} · 1 of ${PATIENT_COUNT}`
            );
            await expect(
                page.getByTestId(`wsi-slide-item-${slideKeyFor(patientIds[0])}`)
            ).toBeVisible({ timeout: 30000 });

            // The list is the slide resource grouped by patient, over the whole study.
            expect(mocks.tabsRequests[0].studyIds).toEqual([STUDY_ID]);
            expect(mocks.listRequests[0]).toMatchObject({
                studyIds: [STUDY_ID],
                resourceId: 'WSI_SAMPLE',
                groupBy: 'patient',
                groupCounts: ['metadata:stain_group'],
                pageNumber: 0,
                pageSize: PAGE_SIZE,
            });
            expect(mocks.listRequests[0].studyViewFilter).toBeUndefined();
            expect(mocks.sampleCountRequests[0]).toMatchObject({
                groupBy: 'sample',
                filters: [
                    expect.objectContaining({
                        columnId: 'patientId',
                        operator: 'in',
                    }),
                ],
            });
            expect(mocks.retiredRequests).toEqual([]);

            // Pixels are requested by study, opaque key and sealed source only.
            await expect
                .poll(() => mocks.tileServerRequests.length, { timeout: 30000 })
                .toBeGreaterThan(0);
            for (const { url, headers } of mocks.tileServerRequests) {
                const params = new URL(url).searchParams;
                expect(params.get('studyId')).toBe(STUDY_ID);
                expect(params.get('key')).toMatch(/^[0-9a-f]{12}$/);
                expect(params.get('enc')).toBe('sealed');
                expect(params.get('tw')).toBeNull();
                expect(params.get('th')).toBeNull();
                expect(headers.authorization).toBeUndefined();
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
            expect(mocks.listRequests.some(r => r.pageNumber === 1)).toBe(true);

            await expect(
                page.getByTestId('study-slides-open-patient')
            ).toHaveAttribute(
                'href',
                new RegExp(
                    `/patient/wsiHESlides\\?studyId=${STUDY_ID}&caseId=${patientIds[PAGE_SIZE]}#navCaseIds=`
                )
            );

            // A reload reopens the same patient on its list page, located by groups/fetch.
            await page.reload();
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[PAGE_SIZE]} · ${PAGE_SIZE +
                    1} of ${PATIENT_COUNT}`,
                { timeout: 30000 }
            );
            expect(
                mocks.listRequests.find(
                    r => r.locate?.patientId === patientIds[PAGE_SIZE]
                )?.locate
            ).toEqual({ studyId: STUDY_ID, patientId: patientIds[PAGE_SIZE] });
            await expect(page.getByTestId('study-slides-patient')).toHaveCount(
                PATIENT_COUNT - PAGE_SIZE
            );
        });

        test("lists only the study view's cohort", async ({ page }) => {
            const mocks = await installStudySlidesMocks(page);
            await page.goto(
                `/study/pathologySlides?id=${STUDY_ID}&filters=${encodeURIComponent(
                    JSON.stringify(ODD_PATIENTS_FILTER)
                )}`
            );

            const oddPatients = patientIds.filter(isOddPatient);
            await expect(
                page.getByTestId('study-slides-patient-count')
            ).toHaveText(String(oddPatients.length), { timeout: 30000 });
            await expect(patientPosition(page)).toHaveText(
                `${oddPatients[0]} · 1 of ${oddPatients.length}`
            );
            // The cohort travels as the study view's filter, which the backend resolves.
            expect(lastOf(mocks.listRequests).studyViewFilter).toMatchObject(
                ODD_PATIENTS_FILTER
            );
            expect(
                lastOf(mocks.listRequests).sampleIdentifiers
            ).toBeUndefined();
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
            // The stain chips count patients, from the grouped facets.
            await expect(
                page.getByTestId('study-slides-stain-IHC')
            ).toContainText('(11)');
            expect(mocks.metadataRequests[0]).toMatchObject({
                groupBy: 'patient',
                resourceId: 'WSI_SAMPLE',
            });

            await page.getByTestId('study-slides-stain-IHC').click();
            await expect(page.getByTestId('study-slides-patient')).toHaveCount(
                11
            );
            expect(lastOf(mocks.listRequests).filters).toEqual([
                {
                    columnId: 'metadata:stain_group',
                    operator: 'in',
                    values: ['IHC'],
                },
            ]);
            await expect(page.getByTestId('study-slides-summary')).toHaveText(
                '11 viewable slides'
            );
            await expect
                .poll(() => new URL(page.url()).searchParams.get('wsiStain'))
                .toBe('IHC');

            await page.getByTestId('study-slides-stain-IHC').click();
            await page.getByTestId('study-slides-search').fill('WSS-P-05');
            await expect(page.getByTestId('study-slides-patient')).toHaveCount(
                6
            );
            expect(lastOf(mocks.listRequests).search).toBe('WSS-P-05');

            // A pasted Slide ID finds its patient by the bare slide key.
            await page
                .getByTestId('study-slides-search')
                .fill('WSI-0000-0000-0007');
            await expect(page.getByTestId('study-slides-patient')).toHaveCount(
                1
            );
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[6]} · 1 of 1`
            );
            expect(lastOf(mocks.listRequests).search).toBe('000000000007');

            await page.getByTestId('study-slides-search').fill('none');
            await page.getByTestId('study-slides-search').press('Enter');
            await expect(page.getByTestId('study-slides-empty')).toHaveText(
                'No patients match these filters.'
            );
        });

        test('filters by slide column values from the search and by match level', async ({
            page,
        }) => {
            const mocks = await installStudySlidesMocks(page);
            await page.goto(`/study/pathologySlides?id=${STUDY_ID}`);
            await expect(
                page.getByTestId('study-slides-patient')
            ).toHaveCount(PAGE_SIZE, { timeout: 30000 });

            await page.getByTestId('study-slides-search').fill('biop');
            const suggestion = page
                .getByTestId('study-slides-suggestion')
                .filter({ hasText: /Biopsy\s*part_type/ });
            await expect(suggestion).toContainText('30 patients');
            await suggestion.click();

            await expect(
                page.getByTestId('study-slides-patient-count')
            ).toHaveText('30');
            await expect(
                page.getByTestId('study-slides-chip-metadata:part_type')
            ).toContainText('part_type: Biopsy');
            await expect(page.getByTestId('study-slides-search')).toHaveValue(
                ''
            );
            expect(lastOf(mocks.listRequests).filters).toEqual([
                {
                    columnId: 'metadata:part_type',
                    operator: 'in',
                    values: ['Biopsy'],
                },
            ]);
            await expect
                .poll(() => new URL(page.url()).searchParams.get('wsiFacets'))
                .toBe(JSON.stringify({ 'metadata:part_type': ['Biopsy'] }));

            // The filter survives a reload through the URL.
            await page.reload();
            await expect(
                page.getByTestId('study-slides-patient-count')
            ).toHaveText('30', { timeout: 30000 });

            await page
                .getByTestId('study-slides-chip-metadata:part_type')
                .getByLabel('Remove filter')
                .click();
            await expect(
                page.getByTestId('study-slides-patient-count')
            ).toHaveText(String(PATIENT_COUNT));

            await page.getByTestId('study-slides-filters-toggle').click();
            const partMatched = patientIds.filter(isPartMatched).length;
            await expect(
                page.getByTestId('study-slides-match-PART')
            ).toContainText(`(${partMatched})`);
            await page.getByTestId('study-slides-match-PART').click();
            await expect(
                page.getByTestId('study-slides-patient-count')
            ).toHaveText(String(partMatched));
            await expect(
                page.getByTestId('study-slides-chip-match-PART')
            ).toBeVisible();
            expect(mocks.retiredRequests).toEqual([]);
        });

        test('restores the slide table view and redirects the old slide table tabs', async ({
            page,
        }) => {
            const mocks = await installStudySlidesMocks(page);
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

            // The table reads the slide resources the study holds, without their serving block.
            const table = page.getByTestId('study-slides-table');
            await expect(table.getByText('WSI-0000-0000-0001')).toBeVisible({
                timeout: 30000,
            });
            expect(
                mocks.rowsRequests.some(
                    r =>
                        r.resourceId === 'WSI_SAMPLE' &&
                        (r.patientIdentifiers || []).length === 0
                )
            ).toBe(true);
            await expect(
                table.getByRole('columnheader', { name: 'stain_group' })
            ).toBeVisible();
            await expect(
                table.getByRole('columnheader', { name: 'serving' })
            ).toHaveCount(0);
            await expect(table.getByText('sealed')).toHaveCount(0);

            // Its View opens the slide's patient in the viewer.
            await table
                .getByTestId('resource-row-view')
                .first()
                .click();
            await expect(
                page.getByTestId('study-slides-view-viewer')
            ).toHaveAttribute('aria-pressed', 'true');
            await expect(
                page.getByTestId(`wsi-slide-item-${slideKeyFor(patientIds[0])}`)
            ).toBeVisible({ timeout: 30000 });

            await page.goto(
                `/study/resourceTable_PATHOLOGY_SLIDES?id=${STUDY_ID}`
            );
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
