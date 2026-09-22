import { test, expect } from '../fixtures';
import {
    installFoundationMocks,
    STUDY_ID,
    PATIENT_ID,
    IMAGE_ID,
} from './wsi-foundation-mocks';

const SAMPLE_ID = 'wsi-foundation-smoke-sample';

const molecularHierarchy = {
    referenceSampleId: SAMPLE_ID,
    sampleGroups: [
        {
            sampleId: SAMPLE_ID,
            parts: [
                {
                    partNumber: '1',
                    partDesignator: '1',
                    partType: '',
                    partDescription: 'Molecular specimen',
                    subspecialty: '',
                    pathDxTitle: '',
                    blocks: [
                        {
                            blockNumber: 'A1',
                            blockLabel: 'A1',
                            slides: [
                                {
                                    imageId: IMAGE_ID,
                                    stainName: 'H&E initial',
                                    stainGroup: 'H&E (Initial)',
                                    isHne: true,
                                    isIhc: false,
                                    magnification: '',
                                    fileSizeBytes: null,
                                    canServeTiles: true,
                                    barcode: '',
                                    slideType: 'H&E',
                                    sampleId: SAMPLE_ID,
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

async function installMolecularMocks(page: import('@playwright/test').Page) {
    const enrichmentRequests = await installFoundationMocks(page);
    const portalRequests: string[] = [];
    page.on('request', request => {
        if (
            /molecular-profiles|mutations\/fetch|cna-genes|structural-variant|mutation-counts/.test(
                request.url()
            )
        ) {
            portalRequests.push(request.url());
        }
    });

    await page.route('**/config_service', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                app_name: 'wsi-molecular-smoke',
                authenticationMethod: 'none',
                msk_wsi_tile_server_url: '/wsi',
                msk_wsi_authentication_enabled: false,
                show_oncokb: false,
                show_civic: false,
            }),
        })
    );
    await page.route(
        `**/api/wsi/v2/hierarchy/${STUDY_ID}/${PATIENT_ID}`,
        route =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(molecularHierarchy),
            })
    );
    await page.route(`**/api/studies/${STUDY_ID}/samples**`, route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
                {
                    sampleId: SAMPLE_ID,
                    patientId: PATIENT_ID,
                    studyId: STUDY_ID,
                    sequenced: true,
                },
            ]),
        })
    );
    await page.route(`**/api/studies/${STUDY_ID}/molecular-profiles**`, route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
                {
                    molecularProfileId: 'wsi-mutations',
                    molecularAlterationType: 'MUTATION_EXTENDED',
                },
            ]),
        })
    );
    await page.route('**/api/mutations/fetch**', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
                {
                    sampleId: SAMPLE_ID,
                    entrezGeneId: 3845,
                    gene: { hugoGeneSymbol: 'KRAS', entrezGeneId: 3845 },
                    proteinChange: 'p.G12D',
                    mutationType: 'Missense_Mutation',
                    proteinPosStart: 12,
                    proteinPosEnd: 12,
                },
            ]),
        })
    );
    await page.route('**/api/mutation-counts-by-position/fetch', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
        })
    );
    return { enrichmentRequests, portalRequests };
}

test.describe('WSI molecular child contract', () => {
    test('loads molecular rows through portal APIs without changing tile routing', async ({
        page,
    }) => {
        const {
            enrichmentRequests,
            portalRequests,
        } = await installMolecularMocks(page);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));

        await page.goto(
            `/wsi/patient/${PATIENT_ID}?studyId=${STUDY_ID}#wsi:slide=${IMAGE_ID}`
        );

        await expect(page.getByTitle('Fit to view')).toBeVisible({
            timeout: 30000,
        });
        await expect(
            page.getByTestId('wsi-metadata-sidebar')
        ).toContainText('KRAS', { timeout: 30000 });
        expect(
            portalRequests.some(url => url.includes('/api/mutations/fetch'))
        ).toBe(true);
        expect(enrichmentRequests).toEqual([]);
        expect(errors).toEqual([]);
    });
});
