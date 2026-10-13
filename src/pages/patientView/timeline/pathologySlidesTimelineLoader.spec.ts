import { ClinicalEvent } from 'cbioportal-ts-api-client';
import { PatientHierarchy } from 'cbioportal-wsi-viewer';
import {
    hasServableSlide,
    loadPathologySlidesTimeline,
    PathologySlidesTimelineModule,
    PathologySlidesTimelineRequest,
    withPathologySlideEvents,
} from './pathologySlidesTimelineLoader';

const SLIDE_EVENT = {
    eventType: 'PATHOLOGY SLIDES',
    startNumberOfDaysSinceDiagnosis: -136,
    attributes: [],
} as any;

function hierarchyWith(canServeTiles: boolean[]): PatientHierarchy {
    return {
        patient_id: 'P-0000024',
        samples: [
            {
                sample_id: 'S-1',
                parts: [
                    {
                        part_number: '1',
                        part_type: '',
                        part_description: '',
                        subspecialty: '',
                        blocks: [
                            {
                                block_number: '1',
                                block_label: 'A1',
                                slides: canServeTiles.map((serves, i) => ({
                                    slide_key: `slide-${i}`,
                                    stain_name: 'H&E',
                                    stain_group: 'H&E',
                                    is_hne: true,
                                    is_ihc: false,
                                    magnification: '',
                                    file_size_bytes: '',
                                    can_serve_tiles: serves,
                                    block_label: 'A1',
                                    block_number: '1',
                                })),
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

function request(
    overrides: Partial<PathologySlidesTimelineRequest> = {}
): PathologySlidesTimelineRequest {
    return {
        tileServerUrl: '/wsi',
        studyId: 'mskimpact',
        patientId: 'P-0000024',
        authScope: 'user-1',
        ...overrides,
    };
}

function mockModule(
    loadPathologySlideTimelineData: PathologySlidesTimelineModule['loadPathologySlideTimelineData']
) {
    const module: PathologySlidesTimelineModule = {
        loadPathologySlideTimelineData: jest.fn(loadPathologySlideTimelineData),
        pathologySlidesTrackConfig: jest.fn(),
    };
    const importModule = jest.fn(() => Promise.resolve(module));
    return { module, importModule };
}

const loadedTimeline = () =>
    mockModule(() =>
        Promise.resolve({
            events: [SLIDE_EVENT],
            undatedViewableSlideCount: 2,
        })
    );

describe('hasServableSlide', () => {
    it('needs a slide the viewer can open', () => {
        expect(hasServableSlide(hierarchyWith([false, true]))).toBe(true);
        expect(hasServableSlide(hierarchyWith([false]))).toBe(false);
        expect(hasServableSlide({ patient_id: 'P', samples: [] })).toBe(false);
    });
});

describe('loadPathologySlidesTimeline', () => {
    it('loads the slide events and track for a patient with servable slides', async () => {
        const { module, importModule } = loadedTimeline();
        const fetchHierarchy = jest.fn(() =>
            Promise.resolve(hierarchyWith([true]))
        );

        const timeline = await loadPathologySlidesTimeline(
            request(),
            importModule,
            fetchHierarchy
        );

        expect(fetchHierarchy).toHaveBeenCalledWith(
            'mskimpact',
            'P-0000024',
            'user-1'
        );
        expect(importModule).toHaveBeenCalledTimes(1);
        expect(module.loadPathologySlideTimelineData).toHaveBeenCalledWith(
            'mskimpact',
            'P-0000024',
            'user-1'
        );
        expect(timeline).toEqual({
            events: [SLIDE_EVENT],
            undatedViewableSlideCount: 2,
            trackConfig: module.pathologySlidesTrackConfig,
        });
    });

    it.each([
        ['the patient has no slides', { patient_id: 'P', samples: [] }],
        ['no slide is servable', hierarchyWith([false, false])],
    ])('loads no track module when %s', async (_reason, hierarchy) => {
        const { module, importModule } = loadedTimeline();

        expect(
            await loadPathologySlidesTimeline(request(), importModule, () =>
                Promise.resolve(hierarchy as PatientHierarchy)
            )
        ).toBeUndefined();
        expect(importModule).not.toHaveBeenCalled();
        expect(module.loadPathologySlideTimelineData).not.toHaveBeenCalled();
    });

    it('requests nothing when no tile server is configured', async () => {
        const { importModule } = loadedTimeline();
        const fetchHierarchy = jest.fn();

        expect(
            await loadPathologySlidesTimeline(
                request({ tileServerUrl: null }),
                importModule,
                fetchHierarchy
            )
        ).toBeUndefined();
        expect(fetchHierarchy).not.toHaveBeenCalled();
        expect(importModule).not.toHaveBeenCalled();
    });

    it('resolves undefined when the hierarchy fails to load', async () => {
        const { importModule } = loadedTimeline();

        expect(
            await loadPathologySlidesTimeline(request(), importModule, () =>
                Promise.reject(new Error('Server returned 503'))
            )
        ).toBeUndefined();
        expect(importModule).not.toHaveBeenCalled();
    });

    it('resolves undefined when the module fails to load', async () => {
        expect(
            await loadPathologySlidesTimeline(
                request(),
                () => Promise.reject(new Error('ChunkLoadError')),
                () => Promise.resolve(hierarchyWith([true]))
            )
        ).toBeUndefined();
    });
});

describe('withPathologySlideEvents', () => {
    const clinicalEvents = ([
        { eventType: 'SEQUENCING', attributes: [] },
    ] as any[]) as ClinicalEvent[];

    it('appends the slide events', () => {
        expect(
            withPathologySlideEvents(clinicalEvents, {
                events: [SLIDE_EVENT],
                undatedViewableSlideCount: 0,
                trackConfig: jest.fn(),
            })
        ).toEqual([...clinicalEvents, SLIDE_EVENT]);
    });

    it('returns the clinical events without a track or slide events', () => {
        expect(withPathologySlideEvents(clinicalEvents, undefined)).toBe(
            clinicalEvents
        );
        expect(
            withPathologySlideEvents(clinicalEvents, {
                events: [],
                undatedViewableSlideCount: 0,
                trackConfig: jest.fn(),
            })
        ).toBe(clinicalEvents);
    });
});
