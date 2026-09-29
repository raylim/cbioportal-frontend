import {
    countUndatedViewableSlides,
    fetchUndatedViewableSlideCount,
} from './wsiUndatedSlides';
import { clearPatientHierarchyCache } from './wsiHierarchyFetchCache';
import { resetWsiViewerRuntime } from './wsiViewerConfig';
import { PatientHierarchy, Sample, Slide } from './wsiViewerTypes';

function makeSlide(imageId: string, overrides: Partial<Slide> = {}): Slide {
    return {
        image_id: imageId,
        stain_name: 'H&E',
        stain_group: 'Histology',
        is_hne: true,
        is_ihc: false,
        magnification: '20x',
        file_size_bytes: '100000000',
        can_serve_tiles: true,
        barcode: '',
        block_label: 'A1',
        block_number: '1',
        ...overrides,
    };
}

function makeSample(sampleId: string, slides: Slide[]): Sample {
    return {
        sample_id: sampleId,
        cancer_type: '',
        cancer_type_detailed: '',
        oncotree_code: '',
        primary_site: '',
        sample_type: 'Primary',
        parts: [
            {
                part_number: '1',
                part_designator: 'A',
                part_type: '',
                part_description: '',
                subspecialty: '',
                path_dx_title: '',
                blocks: [{ block_number: '1', block_label: 'A1', slides }],
            },
        ],
    };
}

function makeHierarchy(samples: Sample[]): PatientHierarchy {
    return { patient_id: 'P-1', samples };
}

describe('countUndatedViewableSlides', () => {
    it('counts viewable slides without a procedure day', () => {
        const hierarchy = makeHierarchy([
            makeSample('S-1', [
                makeSlide('dated', { slide_timepoint_days: -21 }),
                makeSlide('undated'),
                makeSlide('not-viewable', { can_serve_tiles: false }),
            ]),
            makeSample('UNMATCHED', [makeSlide('undated-unmatched')]),
        ]);

        expect(countUndatedViewableSlides(hierarchy)).toBe(2);
    });

    it('is zero when every viewable slide has a procedure day', () => {
        expect(
            countUndatedViewableSlides(
                makeHierarchy([
                    makeSample('S-1', [
                        makeSlide('a', { slide_timepoint_days: 0 }),
                    ]),
                ])
            )
        ).toBe(0);
    });

    it('is zero for an empty hierarchy', () => {
        expect(countUndatedViewableSlides(makeHierarchy([]))).toBe(0);
    });
});

describe('fetchUndatedViewableSlideCount', () => {
    afterEach(() => {
        clearPatientHierarchyCache();
        resetWsiViewerRuntime();
    });

    it('fetches the hierarchy with the host configuration', async () => {
        const fetchImpl = jest.fn(
            async () =>
                ({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        referenceSampleId: null,
                        sampleGroups: [],
                    }),
                } as Response)
        );

        const count = await fetchUndatedViewableSlideCount(
            {
                buildApiUrl: path => `http://portal.test/${path}`,
                authEnabled: false,
                authScope: 'user',
                showDownload: false,
                fetchImpl: fetchImpl as any,
            },
            'study',
            'P-1'
        );

        expect(count).toBe(0);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect((fetchImpl.mock.calls[0] as any)[0]).toContain(
            'api/wsi/v2/hierarchy/study/P-1'
        );
    });
});
