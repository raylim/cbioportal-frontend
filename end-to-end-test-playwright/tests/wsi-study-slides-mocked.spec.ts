import { test, expect, Page } from '../fixtures';

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

interface StudySlidesRequestBody {
    studyViewFilter: {
        studyIds?: string[];
        clinicalDataFilters?: {
            attributeId: string;
            values: { value: string }[];
        }[];
    };
    stainGroups?: string[];
    matchLevels?: string[];
    search?: string;
    locateStudyId?: string;
    locatePatientId?: string;
    pageNumber?: number;
    pageSize?: number;
}

/** The first 30 patients have colorectal cancer, the rest breast cancer. */
function cancerType(patientId: string) {
    return patientIds.indexOf(patientId) < 30
        ? 'Colorectal Cancer'
        : 'Breast Cancer';
}

/** Every seventh patient has an unmatched slide. */
function isUnmatched(patientId: string) {
    return patientIds.indexOf(patientId) % 7 === 0;
}

function studySlidesPage(request: StudySlidesRequestBody) {
    const cancerTypes = request.studyViewFilter.clinicalDataFilters
        ?.find(f => f.attributeId === 'CANCER_TYPE')
        ?.values.map(v => v.value);
    const listed = patientIds.filter(
        patientId =>
            (!request.search ||
                patientId
                    .toLowerCase()
                    .includes(request.search.toLowerCase())) &&
            (!cancerTypes || cancerTypes.includes(cancerType(patientId))) &&
            (!request.matchLevels?.includes('UNMATCHED') ||
                isUnmatched(patientId)) &&
            (!request.stainGroups?.length ||
                request.stainGroups.some(
                    group =>
                        stainCounts(patientId)[
                            group as keyof ReturnType<typeof stainCounts>
                        ] > 0
                ))
    );
    const pageNumber = request.pageNumber ?? 0;
    const pageSize = request.pageSize ?? PAGE_SIZE;
    const located =
        request.locateStudyId === STUDY_ID
            ? listed.indexOf(request.locatePatientId || '')
            : -1;
    const patients = listed
        .slice(pageNumber * pageSize, (pageNumber + 1) * pageSize)
        .map(patientId => {
            const counts = stainCounts(patientId);
            const slideCount = counts['H&E'] + counts.IHC;
            return {
                studyId: STUDY_ID,
                patientId,
                slideCount,
                viewableSlideCount: slideCount,
                stainGroupCounts: counts,
            };
        });
    const slides = listed.reduce(
        (sum, patientId) =>
            sum + stainCounts(patientId)['H&E'] + stainCounts(patientId).IHC,
        0
    );
    return {
        totalPatients: listed.length,
        totalSlides: slides,
        totalViewableSlides: slides,
        stainGroupTotals: {
            'H&E': PATIENT_COUNT,
            IHC: patientIds.filter(p => stainCounts(p).IHC > 0).length,
            Other: 0,
            Unknown: 0,
        },
        locatedIndex: located >= 0 ? located : null,
        pageNumber,
        pageSize,
        patients,
    };
}

const tileMetadata = {
    dimensions: { width: 512, height: 512 },
    levels: 1,
    level_dimensions: [{ width: 512, height: 512 }],
    level_downsamples: [1],
    max_zoom: 0,
    tile_metadata_schema_version: 2,
    decode_policy_version:
        'geometry-v2;tile-max=16777216;thumbnail-max=16777216',
    max_decode_pixels: 16_777_216,
    thumbnail_max_decode_pixels: 16_777_216,
    safe_min_level: 0,
    tile_size: 256,
};

function slideImageId(patientId: string) {
    return `slide-${patientId}`;
}

function hierarchyFor(patientId: string) {
    return {
        referenceSampleId: `${patientId}-S`,
        sampleGroups: [
            {
                sampleId: `${patientId}-S`,
                parts: [
                    {
                        partNumber: '1',
                        partDesignator: '1',
                        partType: '',
                        partDescription: 'Contract specimen',
                        subspecialty: '',
                        pathDxTitle: '',
                        blocks: [
                            {
                                blockNumber: 'A1',
                                blockLabel: 'A1',
                                slides: [
                                    {
                                        imageId: slideImageId(patientId),
                                        resourceId: 'WSI_SAMPLE',
                                        resourceDataId: '1',
                                        stainName: 'H&E initial',
                                        stainGroup: 'H&E',
                                        isHne: true,
                                        isIhc: false,
                                        magnification: '',
                                        fileSizeBytes: null,
                                        canServeTiles: true,
                                        barcode: '',
                                        slideType: 'H&E',
                                        sampleId: `${patientId}-S`,
                                        matchLevel: 'BLOCK',
                                        specimenKey: 'block::1::A1',
                                        procedureDateDays: -10,
                                        timepointSource: 'Procedure date',
                                        procedureDateKind: 'RECORDED',
                                        procedureDateSource:
                                            'Recorded procedure date',
                                        procedureDateReason: null,
                                        procedureDateStatus: 'AVAILABLE',
                                        procedureCoordinateSystem:
                                            'patient_first_tumor_sequencing_day_zero',
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);

interface StudySlidesMocks {
    studySlidesRequests: StudySlidesRequestBody[];
    facetRequests: StudySlidesRequestBody[];
    hierarchyPatients: string[];
    /** Delay for list pages after the first, to observe the pending state. */
    pageDelayMs: number;
}

async function installStudySlidesMocks(page: Page): Promise<StudySlidesMocks> {
    const mocks: StudySlidesMocks = {
        studySlidesRequests: [],
        facetRequests: [],
        hierarchyPatients: [],
        pageDelayMs: 0,
    };
    const serverConfig = {
        authenticationMethod: 'none',
        sessionServiceEnabled: true,
        user_display_name: 'wsi-study-slides-user',
        skin_hide_download_controls: 'HIDE_ALL',
        msk_wsi_tile_server_url: '/wsi',
        msk_wsi_authentication_enabled: false,
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
        if (pathname === '/api/clinical-attributes/fetch') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([
                    {
                        clinicalAttributeId: 'CANCER_TYPE',
                        displayName: 'Cancer Type',
                        description: 'Cancer Type',
                        datatype: 'STRING',
                        patientAttribute: false,
                        priority: '3000',
                        studyId: STUDY_ID,
                    },
                ]),
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
            const body = route
                .request()
                .postDataJSON() as StudySlidesRequestBody;
            mocks.studySlidesRequests.push(body);
            if (body.pageNumber && mocks.pageDelayMs) {
                await new Promise(resolve =>
                    setTimeout(resolve, mocks.pageDelayMs)
                );
            }
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(studySlidesPage(body)),
            });
        }
    );
    await page.route('**/api/wsi/v2/study-slides/facets/fetch', route => {
        const body = route
            .request()
            .postDataJSON() as StudySlidesRequestBody & {
            attributeIds: string[];
        };
        mocks.facetRequests.push(body);
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                attributes: body.attributeIds.includes('CANCER_TYPE')
                    ? [
                          {
                              attributeId: 'CANCER_TYPE',
                              values: [
                                  {
                                      value: 'Colorectal Cancer',
                                      patientCount: 30,
                                  },
                                  {
                                      value: 'Breast Cancer',
                                      patientCount: PATIENT_COUNT - 30,
                                  },
                              ],
                              truncated: false,
                          },
                      ]
                    : [],
                matchLevels: {
                    PART: PATIENT_COUNT,
                    BLOCK: 0,
                    UNMATCHED: patientIds.filter(isUnmatched).length,
                },
            }),
        });
    });
    await page.route(`**/api/wsi/v2/hierarchy/${STUDY_ID}/*`, route => {
        const patientId = decodeURIComponent(
            new URL(route.request().url()).pathname.split('/').pop() || ''
        );
        mocks.hierarchyPatients.push(patientId);
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(hierarchyFor(patientId)),
        });
    });
    await page.route(
        `**/api/wsi/v2/resources/${STUDY_ID}/*/access?*`,
        route => {
            const imageId =
                new URL(route.request().url()).searchParams.get('imageId') ||
                '';
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    imageId,
                    sourceUrl: `s3://wsi-study-slides/${imageId}.svs`,
                    accessToken: 'wsi-study-slides-token',
                    tokenType: 'Bearer',
                    expiresIn: 300,
                    tileMetadata,
                    thumbnail: {
                        sourceUrl: `s3://wsi-study-slides/${imageId}.png`,
                        width: 1,
                        height: 1,
                        contentType: 'image/png',
                    },
                }),
            });
        }
    );
    await page.route('**/wsi/tiles/**', route =>
        route.fulfill({ status: 200, contentType: 'image/png', body: pixel })
    );
    await page.route('**/wsi/thumbnails**', route =>
        route.fulfill({ status: 200, contentType: 'image/png', body: pixel })
    );
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
                page.getByTestId(
                    `wsi-slide-item-${slideImageId(patientIds[0])}`
                )
            ).toBeVisible({ timeout: 30000 });
            expect(
                mocks.studySlidesRequests[0].studyViewFilter.studyIds
            ).toEqual([STUDY_ID]);

            await page.getByTestId('study-slides-next').click();
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[1]} · 2 of ${PATIENT_COUNT}`
            );
            await expect(
                page.getByTestId(
                    `wsi-slide-item-${slideImageId(patientIds[1])}`
                )
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
            // Text that is not ID-like waits for Enter (or the ID option).
            await page.getByTestId('study-slides-search').press('Enter');
            await expect(page.getByTestId('study-slides-empty')).toHaveText(
                'No patients match these filters.'
            );
        });

        test('pages the patient list with immediate feedback', async ({
            page,
        }) => {
            const mocks = await installStudySlidesMocks(page);
            mocks.pageDelayMs = 1500;
            await page.goto(`/study/pathologySlides?id=${STUDY_ID}`);
            const range = page.getByTestId('study-slides-range');
            await expect(range).toHaveText(`1–50 of ${PATIENT_COUNT}`, {
                timeout: 30000,
            });

            await page.getByLabel('Next page of patients').click();
            // The range and the busy list answer before the page arrives.
            await expect(range).toContainText(`51–55 of ${PATIENT_COUNT}`, {
                timeout: 1000,
            });
            await expect(page.getByLabel('Loading patients')).toBeVisible();
            await expect(
                page.getByTestId('study-slides-patients')
            ).toHaveAttribute('aria-busy', 'true');
            await expect(
                page.getByTestId('study-slides-patient').first()
            ).toContainText(patientIds[PAGE_SIZE], { timeout: 10000 });
            await expect(page.getByLabel('Loading patients')).toHaveCount(0);

            await page.getByTestId('study-slides-go-selected').click();
            await expect(
                page.getByTestId('study-slides-patient').first()
            ).toContainText(patientIds[0], { timeout: 10000 });
        });

        test('hides the patient list and the viewer panels, and remembers it', async ({
            page,
        }) => {
            await installStudySlidesMocks(page);
            await page.goto(`/study/pathologySlides?id=${STUDY_ID}`);
            await expect(
                page.getByTestId(
                    `wsi-slide-item-${slideImageId(patientIds[0])}`
                )
            ).toBeVisible({ timeout: 30000 });

            await page.getByTestId('study-slides-hide').click();
            await page.getByTestId('wsi-nav-hide').click();
            await page.getByTestId('wsi-metadata-hide').click();
            await expect(page.getByTestId('study-slides-rail')).toBeVisible();
            await expect(page.getByTestId('wsi-nav-rail')).toBeVisible();
            await expect(page.getByTestId('wsi-metadata-rail')).toBeVisible();

            // Stepping still works from the rail.
            await page.getByTestId('study-slides-rail-next').click();
            await expect(patientPosition(page)).toHaveText(
                `${patientIds[1]} · 2 of ${PATIENT_COUNT}`
            );

            await page.reload();
            await expect(page.getByTestId('study-slides-rail')).toBeVisible({
                timeout: 30000,
            });
            await expect(page.getByTestId('wsi-nav-rail')).toBeVisible({
                timeout: 30000,
            });
            await expect(page.getByTestId('wsi-metadata-rail')).toBeVisible();

            await page.getByTestId('study-slides-rail-expand').click();
            await page.getByTestId('wsi-nav-rail-expand').click();
            await page.getByTestId('wsi-metadata-rail-expand').click();
            await expect(
                page.getByTestId('study-slides-patient-panel')
            ).toBeVisible();
            await expect(
                page.getByTestId('wsi-metadata-sidebar')
            ).toBeVisible();
        });

        test('filters by clinical values from the search and by specimen match', async ({
            page,
        }) => {
            const mocks = await installStudySlidesMocks(page);
            await page.goto(`/study/pathologySlides?id=${STUDY_ID}`);
            await expect(
                page.getByTestId('study-slides-patient')
            ).toHaveCount(PAGE_SIZE, { timeout: 30000 });

            await page.getByTestId('study-slides-search').fill('colo');
            const suggestion = page
                .getByTestId('study-slides-suggestion')
                .filter({ hasText: /Colorectal Cancer\s*Cancer Type/ });
            await expect(suggestion).toContainText('30 patients');
            await suggestion.click();

            await expect(
                page.getByTestId('study-slides-patient-count')
            ).toHaveText('30');
            await expect(
                page.getByTestId('study-slides-chip-CANCER_TYPE')
            ).toContainText('Cancer Type: Colorectal Cancer');
            await expect(page.getByTestId('study-slides-search')).toHaveValue(
                ''
            );
            expect(
                mocks.studySlidesRequests[mocks.studySlidesRequests.length - 1]
                    .studyViewFilter.clinicalDataFilters
            ).toEqual([
                {
                    attributeId: 'CANCER_TYPE',
                    values: [{ value: 'Colorectal Cancer' }],
                },
            ]);

            await page
                .getByTestId('study-slides-chip-CANCER_TYPE')
                .getByLabel('Remove filter')
                .click();
            await expect(
                page.getByTestId('study-slides-patient-count')
            ).toHaveText(String(PATIENT_COUNT));

            await page.getByTestId('study-slides-filters-toggle').click();
            await page.getByTestId('study-slides-match-UNMATCHED').click();
            await expect(
                page.getByTestId('study-slides-patient-count')
            ).toHaveText(String(patientIds.filter(isUnmatched).length));
            await expect(
                page.getByTestId('study-slides-chip-match-UNMATCHED')
            ).toBeVisible();
        });
    });
}
