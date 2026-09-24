import {
    buildPathologyAssociationGroups,
    buildTimelineEventsSignature,
    buildPatientHierarchyUrl,
    buildPatientHierarchyApiUrl,
    hasServableDiagnosticSlides,
    getUndatedPathologySlideCount,
} from './pathologyTimelineUtils';
import { PatientHierarchy } from 'shared/components/wsiViewer/wsiViewerTypes';
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import { getLoadConfig } from 'config/config';

beforeAll(() => {
    getLoadConfig().apiRoot = '/';
});

function makeSlide(
    overrides: Partial<
        PatientHierarchy['samples'][number]['parts'][number]['blocks'][number]['slides'][number]
    > = {}
) {
    return {
        image_id: '1',
        stain_name: 'H&E',
        stain_group: 'H&E (Initial)',
        is_hne: true,
        is_ihc: false,
        slide_timepoint_days: -418,
        slide_timepoint_source: 'Sample acquisition',
        magnification: '',
        file_size_bytes: '',
        can_serve_tiles: true,
        barcode: '',
        block_label: 'A1',
        block_number: '1',
        ...overrides,
    };
}

function makeHierarchySample(
    sampleId: string,
    slides: Array<ReturnType<typeof makeSlide>>
) {
    return {
        sample_id: sampleId,
        cancer_type: '',
        cancer_type_detailed: '',
        oncotree_code: '',
        primary_site: '',
        sample_type: '',
        parts: [
            {
                part_number: '1',
                part_designator: '1',
                part_type: '',
                part_description: '',
                subspecialty: '',
                path_dx_title: '',
                blocks: [
                    {
                        block_number: '1',
                        block_label: 'A1',
                        slides,
                    },
                ],
            },
        ],
    };
}

function makeHierarchy(
    patientId: string,
    samples: Array<ReturnType<typeof makeHierarchySample>>
): PatientHierarchy {
    const slideAssociations = samples.flatMap(sample =>
        sample.parts.flatMap(part =>
            part.blocks.flatMap(block =>
                block.slides.map(slide => ({
                    image_id: slide.image_id,
                    sample_id: sample.sample_id,
                    match_level: 'BLOCK' as const,
                    specimen_key: `block::${part.part_number}::${block.block_number}`,
                    slide_type:
                        slide.slide_type ||
                        (slide.is_ihc ? ('IHC' as const) : ('H&E' as const)),
                    procedure_date_days: slide.slide_timepoint_days,
                    timepoint_source: slide.slide_timepoint_source,
                    stain_name: slide.stain_name,
                    part_description: part.part_description,
                    part_number: part.part_number,
                    block_label: block.block_label,
                    block_number: block.block_number,
                    can_serve_tiles: slide.can_serve_tiles,
                }))
            )
        )
    );
    return {
        patient_id: patientId,
        samples,
        slide_associations: slideAssociations,
    };
}

describe('buildPathologyAssociationGroups', () => {
    it('groups servable slides by date, sample, specimen and subtype', () => {
        const hierarchy = makeHierarchy('P-1', [
            makeHierarchySample('S-1', [
                makeSlide({ image_id: 'slide-1', slide_timepoint_days: -5 }),
                makeSlide({ image_id: 'slide-2', slide_timepoint_days: -5 }),
            ]),
        ]);

        const groups = buildPathologyAssociationGroups(hierarchy, []);

        expect(groups).toHaveLength(1);
        expect(groups[0]).toEqual(
            expect.objectContaining({
                date: -5,
                dated: true,
                imageCount: 2,
                sampleId: 'S-1',
                subtype: 'H&E',
            })
        );
        expect(groups[0].imageIds).toEqual(['slide-1', 'slide-2']);
    });
});

describe('hasServableDiagnosticSlides', () => {
    it('returns true when a servable H&E or IHC slide is present', () => {
        const hierarchy = makeHierarchy('P-1', [
            makeHierarchySample('S-1', [makeSlide()]),
        ]);

        expect(hasServableDiagnosticSlides(hierarchy)).toBe(true);
    });

    it('returns true when an unclassified viewable slide is present', () => {
        const hierarchy = makeHierarchy('P-2', [
            makeHierarchySample('S-2', [
                makeSlide({
                    image_id: '9',
                    stain_name: 'SLIDES SUBMITTED',
                    stain_group: 'SLIDES SUBMITTED',
                    is_hne: false,
                    is_ihc: false,
                }),
            ]),
        ]);

        expect(hasServableDiagnosticSlides(hierarchy)).toBe(true);
    });

    it('ignores servable slides from samples outside the allowed set', () => {
        const hierarchy = makeHierarchy('P-3', [
            makeHierarchySample('S-3', [makeSlide()]),
        ]);

        expect(hasServableDiagnosticSlides(hierarchy, new Set(['S-4']))).toBe(
            false
        );
    });

    it('uses explicit slide associations and filters by the allowed samples', () => {
        const hierarchy = makeHierarchy('P-4', [
            makeHierarchySample('S-4', [makeSlide()]),
            makeHierarchySample('S-5', [makeSlide({ image_id: '2' })]),
        ]);

        expect(hasServableDiagnosticSlides(hierarchy, new Set(['S-4']))).toBe(
            true
        );
        expect(hasServableDiagnosticSlides(hierarchy, new Set(['S-5']))).toBe(
            true
        );
        expect(hasServableDiagnosticSlides(hierarchy, new Set(['S-6']))).toBe(
            false
        );
    });
});

describe('getUndatedPathologySlideCount', () => {
    it('counts servable slides without a verified timepoint', () => {
        const hierarchy = makeHierarchy('P-1', [
            makeHierarchySample('S-1', [
                makeSlide({ slide_timepoint_days: undefined as any }),
            ]),
        ]);

        expect(getUndatedPathologySlideCount(hierarchy, [])).toBe(1);
    });
});

describe('buildPatientHierarchyUrl', () => {
    it('includes the studyId query parameter', () => {
        expect(
            buildPatientHierarchyUrl(
                '/api',
                'P-0074875',
                'msk_spectrum_tme_2022'
            )
        ).toBe('/api/patient/P-0074875?studyId=msk_spectrum_tme_2022');
    });
});

describe('buildPatientHierarchyApiUrl', () => {
    it('targets the backend hierarchy endpoint on the current frontend origin', () => {
        expect(buildPatientHierarchyApiUrl('P/007', 'study/one')).toBe(
            '/api/wsi/v2/hierarchy/study%2Fone/P%2F007'
        );
    });
});

describe('buildTimelineEventsSignature', () => {
    it('keeps ordinary timeline events in the shared timeline signature', () => {
        const pathologyEvent = {
            eventType: 'PATHOLOGY SLIDES',
            patientId: 'P-1',
            studyId: 'study',
            startNumberOfDaysSinceDiagnosis: 1,
            attributes: [{ key: 'SAMPLE_ID', value: 'S-1' }],
        } as ClinicalEvent;
        const ordinaryEvent = {
            eventType: 'TREATMENT',
            patientId: 'P-1',
            studyId: 'study',
            startNumberOfDaysSinceDiagnosis: 2,
            attributes: [{ key: 'DRUG', value: 'A' }],
        } as ClinicalEvent;

        const withOrdinaryEvent = buildTimelineEventsSignature([
            pathologyEvent,
            ordinaryEvent,
        ]);
        ordinaryEvent.attributes![0].value = 'B';

        expect(
            buildTimelineEventsSignature([pathologyEvent, ordinaryEvent])
        ).not.toBe(withOrdinaryEvent);
        pathologyEvent.attributes![0].value = 'S-2';
        expect(
            buildTimelineEventsSignature([pathologyEvent, ordinaryEvent])
        ).not.toBe(withOrdinaryEvent);
    });
});
