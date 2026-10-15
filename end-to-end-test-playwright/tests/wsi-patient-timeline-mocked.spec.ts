import { test, expect, Page } from '../fixtures';
import {
    installFoundationMocks,
    STUDY_ID,
    PATIENT_ID,
    SAMPLE_ID,
} from './wsi-foundation-mocks';

/** A second sequenced sample, with a later slide on a different part. */
const LATER_SAMPLE_ID = 'wsi-foundation-smoke-sample-2';

/** Opaque 32-hex slide keys, as the backend publishes them. */
const HNE_KEY = '11111111111111111111111111111111';
const IHC_KEY = '22222222222222222222222222222222';
const LATER_KEY = '44444444444444444444444444444444';
const ALL_KEYS = [HNE_KEY, IHC_KEY, LATER_KEY];

const BLOCK_SPECIMEN_KEY = 'block::1::A1';
const PART_SPECIMEN_KEY = 'part::2';

function slide(
    slideKey: string,
    stain: 'H&E' | 'IHC',
    sampleId: string,
    matchLevel: 'BLOCK' | 'PART',
    specimenKey: string
) {
    return {
        slideKey,
        stainName: stain === 'IHC' ? 'IHC PD-L1' : 'H&E initial',
        stainGroup: stain,
        isHne: stain === 'H&E',
        isIhc: stain === 'IHC',
        magnification: '',
        fileSizeBytes: null,
        canServeTiles: true,
        slideType: stain,
        sampleId,
        matchLevel,
        specimenKey,
    };
}

/**
 * Sample 1, block A1: an H&E and an IHC slide. Sample 2, part 2: an H&E
 * slide. The hierarchy carries no timing; the timeline file does.
 */
const hierarchy = {
    referenceSampleId: SAMPLE_ID,
    sampleGroups: [
        {
            sampleId: SAMPLE_ID,
            parts: [
                {
                    partNumber: '1',
                    partType: '',
                    partDescription: 'Primary specimen',
                    subspecialty: '',
                    blocks: [
                        {
                            blockNumber: 'A1',
                            blockLabel: 'A1',
                            slides: [
                                slide(
                                    HNE_KEY,
                                    'H&E',
                                    SAMPLE_ID,
                                    'BLOCK',
                                    BLOCK_SPECIMEN_KEY
                                ),
                                slide(
                                    IHC_KEY,
                                    'IHC',
                                    SAMPLE_ID,
                                    'BLOCK',
                                    BLOCK_SPECIMEN_KEY
                                ),
                            ],
                        },
                    ],
                },
            ],
        },
        {
            sampleId: LATER_SAMPLE_ID,
            parts: [
                {
                    partNumber: '2',
                    partType: '',
                    partDescription: 'Recurrence specimen',
                    subspecialty: '',
                    blocks: [
                        {
                            blockNumber: 'B1',
                            blockLabel: 'B1',
                            slides: [
                                slide(
                                    LATER_KEY,
                                    'H&E',
                                    LATER_SAMPLE_ID,
                                    'PART',
                                    PART_SPECIMEN_KEY
                                ),
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

/**
 * LINKOUT as pdm's generate_pathology_timeline_files.py writes it: the
 * Pathology Slides tab with top-level scope params.
 */
function pdmLinkout(
    stainFilter: string,
    matchLevel: string,
    specimenKey: string,
    sampleId: string
): string {
    const params = new URLSearchParams({
        studyId: STUDY_ID,
        caseId: PATIENT_ID,
        stainFilter,
        matchLevel,
        specimenKey,
        sampleId,
    });
    return `/patient/wsiHESlides?${params.toString()}`;
}

const HNE_LINKOUT = pdmLinkout('hne', 'BLOCK', BLOCK_SPECIMEN_KEY, SAMPLE_ID);

function clinicalEvent(
    eventType: string,
    days: number,
    attributes: Record<string, string>
) {
    return {
        uniquePatientKey: `${PATIENT_ID}:${STUDY_ID}`,
        studyId: STUDY_ID,
        patientId: PATIENT_ID,
        eventType,
        startNumberOfDaysSinceDiagnosis: days,
        attributes: Object.entries(attributes).map(([key, value]) => ({
            key,
            value,
        })),
    };
}

/** A row of the pdm pathology timeline file, as an imported event. */
function pathologySlidesEvent(
    days: number,
    sampleId: string,
    subtype: 'H&E' | 'IHC',
    matchLevel: 'BLOCK' | 'PART',
    specimen: string,
    linkout: string
) {
    return clinicalEvent('PATHOLOGY SLIDES', days, {
        SAMPLE_ID: sampleId,
        SUBTYPE: subtype,
        MATCH_LEVEL: matchLevel,
        SPECIMEN: specimen,
        IMAGE_COUNT: '1',
        NON_SERVABLE_IMAGE_COUNT: '0',
        TOTAL_IMAGE_COUNT: '1',
        TIMEPOINT_SOURCE: 'Procedure date relative to first ICD-O diagnosis',
        LINKOUT: linkout,
    });
}

const clinicalEvents = [
    clinicalEvent('SEQUENCING', 0, { SAMPLE_ID }),
    pathologySlidesEvent(
        -10,
        SAMPLE_ID,
        'H&E',
        'BLOCK',
        'Part 1 / Block A1',
        HNE_LINKOUT
    ),
    pathologySlidesEvent(
        -10,
        SAMPLE_ID,
        'IHC',
        'BLOCK',
        'Part 1 / Block A1',
        pdmLinkout('ihc', 'BLOCK', BLOCK_SPECIMEN_KEY, SAMPLE_ID)
    ),
    pathologySlidesEvent(
        200,
        LATER_SAMPLE_ID,
        'H&E',
        'PART',
        'Part 2',
        pdmLinkout('hne', 'PART', PART_SPECIMEN_KEY, LATER_SAMPLE_ID)
    ),
];

function json(body: unknown) {
    return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
    };
}

const study = {
    studyId: STUDY_ID,
    name: STUDY_ID,
    description: 'WSI patient timeline contract',
    cancerTypeId: 'mixed',
    cancerType: {
        cancerTypeId: 'mixed',
        name: 'Mixed',
        dedicatedColor: 'Black',
        shortName: 'MIXED',
        parent: 'tissue',
    },
    publicStudy: true,
    groups: 'PUBLIC',
    status: 0,
    referenceGenome: 'hg19',
    allSampleCount: 2,
};

const samples = [SAMPLE_ID, LATER_SAMPLE_ID].map(sampleId => ({
    studyId: STUDY_ID,
    patientId: PATIENT_ID,
    sampleId,
    sampleType: 'Primary Solid Tumor',
    uniquePatientKey: `${PATIENT_ID}:${STUDY_ID}`,
    uniqueSampleKey: `${sampleId}:${STUDY_ID}`,
    sequenced: true,
    copyNumberSegmentPresent: false,
}));

/**
 * The patient page around the foundation slide mocks: every other portal
 * API answers empty, the patient has two samples, and the clinical events
 * include the PATHOLOGY SLIDES events of the pdm pathology timeline file.
 */
async function installPatientPageMocks(page: Page, accessRequests: string[]) {
    // Registered first, so the specific routes below take precedence.
    await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/studies') {
            return route.fulfill(json([study]));
        }
        if (pathname === '/api/studies/fetch') {
            return route.fulfill(json([study]));
        }
        if (pathname === `/api/studies/${STUDY_ID}/patients/${PATIENT_ID}`) {
            return route.fulfill(
                json({
                    patientId: PATIENT_ID,
                    studyId: STUDY_ID,
                    uniquePatientKey: `${PATIENT_ID}:${STUDY_ID}`,
                })
            );
        }
        if (/\/samples(\/fetch)?$/.test(pathname)) {
            return route.fulfill(json(samples));
        }
        return route.fulfill(json([]));
    });
    await installFoundationMocks(page, { accessRequests, hierarchy });
    await page.route(
        new RegExp(
            `/api/studies/${STUDY_ID}/patients/${PATIENT_ID}/samples(\\?.*)?$`
        ),
        route => route.fulfill(json(samples))
    );
    await page.route(
        `**/api/studies/${STUDY_ID}/patients/${PATIENT_ID}/clinical-events**`,
        route => route.fulfill(json(clinicalEvents))
    );
}

/** The slide key of each slide access request. */
function accessedSlideKeys(accessRequests: string[]): string[] {
    return accessRequests.map(
        url => new URL(url).searchParams.get('slideKey') || ''
    );
}

/**
 * Slide access is requested only for the linked sample's slides: the opened
 * slide plus the viewer's metadata prefetch, which covers the selected
 * sample regardless of the stain filter. The other sample's slide is never
 * requested.
 */
function expectAccessWithinLinkedSample(accessRequests: string[]) {
    const keys = accessedSlideKeys(accessRequests);
    expect(keys).not.toContain(LATER_KEY);
    for (const key of keys) {
        expect([HNE_KEY, IHC_KEY]).toContain(key);
    }
}

/** Asserts the Pathology Slides tab lists exactly `slideKeys`. */
async function expectListedSlides(page: Page, slideKeys: string[]) {
    // The count shows only while a filter narrows the list.
    await expect(page.getByTestId('wsi-filtered-slide-count')).toHaveText(
        `Showing ${slideKeys.length} of ${ALL_KEYS.length} slides`,
        {
            timeout: 30000,
        }
    );
    for (const key of ALL_KEYS) {
        await expect(page.getByTestId(`wsi-slide-item-${key}`)).toHaveCount(
            slideKeys.includes(key) ? 1 : 0
        );
    }
}

/**
 * Hovers the timeline events in turn until one shows a pathology slide
 * tooltip titled `title`, and returns that tooltip.
 */
async function hoverPathologyEvent(page: Page, title: string) {
    const events = page.locator(
        '.tl-timeline-svg g.tl-track g[style*="cursor"]'
    );
    await expect(events.first()).toBeVisible({ timeout: 30000 });
    // Any event's tooltip; other tracks (Sequencing) have their own.
    const anyTooltip = page.locator('.tl-timeline-tooltip');
    const tooltip = page.locator('[data-test="pathology-slide-tooltip"]');
    const count = await events.count();
    for (let i = 0; i < count; i++) {
        const box = await events.nth(i).boundingBox();
        if (!box) {
            continue;
        }
        await page.mouse.move(0, 0);
        await expect(anyTooltip).toHaveCount(0);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.move(
            box.x + box.width / 2 + 1,
            box.y + box.height / 2
        );
        await expect(anyTooltip).toHaveCount(1);
        if ((await tooltip.count()) === 0) {
            continue;
        }
        const text = (await tooltip.locator('strong').textContent()) || '';
        if (text === title) {
            return tooltip;
        }
    }
    throw new Error(`No timeline event shows a "${title}" tooltip`);
}

if (process.env.PW_SUITE === 'wsi') {
    test.describe('WSI patient timeline pathology slide links', () => {
        test('a timeline tooltip link opens the Pathology Slides tab scoped to its event', async ({
            page,
        }) => {
            const accessRequests: string[] = [];
            await installPatientPageMocks(page, accessRequests);
            await page.goto(
                `/patient/summary?studyId=${STUDY_ID}&caseId=${PATIENT_ID}`
            );

            const tooltip = await hoverPathologyEvent(
                page,
                'Pathology slides · H&E · Block-matched'
            );
            await expect(tooltip).toContainText(SAMPLE_ID);
            await expect(tooltip).toContainText(
                'd-10 — 10 d before sequencing (d0)'
            );
            await expect(tooltip).toContainText('Part 1 / Block A1');
            await expect(tooltip).toContainText('1 of 1 viewable');
            const link = tooltip.getByRole('link', { name: /Open H&E slides/ });
            // The link is the event's LINKOUT, as the timeline file has it.
            expect(await link.getAttribute('href')).toBe(HNE_LINKOUT);
            // No slide is opened while the Summary tab is showing.
            expect(accessRequests).toEqual([]);

            // Enter the tooltip so it stays open, then follow the link.
            const linkBox = await link.boundingBox();
            await page.mouse.move(
                linkBox!.x + linkBox!.width / 2,
                linkBox!.y + linkBox!.height / 2
            );
            await link.click();

            await expect(page).toHaveURL(/\/patient\/wsiHESlides\?/);
            expect(new URL(page.url()).searchParams.get('sampleId')).toBe(
                SAMPLE_ID
            );
            await expectListedSlides(page, [HNE_KEY]);
            await expect(
                page.getByTestId(`wsi-slide-item-${HNE_KEY}`)
            ).toHaveAttribute('aria-current', 'true', { timeout: 30000 });
            await expect
                .poll(() => accessedSlideKeys(accessRequests), {
                    timeout: 30000,
                })
                .toContain(HNE_KEY);
            expectAccessWithinLinkedSample(accessRequests);
        });

        test('legacy flat params scope the Pathology Slides tab like the nested node', async ({
            page,
        }) => {
            const accessRequests: string[] = [];
            await installPatientPageMocks(page, accessRequests);
            const legacy = new URLSearchParams({
                studyId: STUDY_ID,
                caseId: PATIENT_ID,
                sampleId: SAMPLE_ID,
                stainFilter: 'hne',
                matchLevel: 'BLOCK',
                specimenKey: BLOCK_SPECIMEN_KEY,
            });
            await page.goto(`/patient/wsiHESlides?${legacy.toString()}`);
            await expectListedSlides(page, [HNE_KEY]);
            await expect
                .poll(() => accessedSlideKeys(accessRequests), {
                    timeout: 30000,
                })
                .toContain(HNE_KEY);
            expectAccessWithinLinkedSample(accessRequests);

            // A lone legacy stain filter, and the same scope as a node.
            await page.goto(
                `/patient/wsiHESlides?studyId=${STUDY_ID}&caseId=${PATIENT_ID}&stainFilter=ihc`
            );
            await expectListedSlides(page, [IHC_KEY]);
            const nested = new URLSearchParams({
                studyId: STUDY_ID,
                caseId: PATIENT_ID,
                pathologySlideSettings: JSON.stringify({ stainFilter: 'ihc' }),
            });
            await page.goto(`/patient/wsiHESlides?${nested.toString()}`);
            await expectListedSlides(page, [IHC_KEY]);
        });
    });
}
