import { ClinicalEvent } from 'cbioportal-ts-api-client';
import {
    loadPathologySlidesTimeline,
    PathologySlidesTimelineModule,
    PathologySlidesTimelineRequest,
    patientWsiSlideCount,
    undatedPathologySlideCount,
    withPathologySlideEvents,
} from './pathologySlidesTimelineLoader';

const SLIDE_EVENT = {
    eventType: 'PATHOLOGY SLIDES',
    startNumberOfDaysSinceDiagnosis: -136,
    attributes: [],
} as any;

function slideCount(value: string) {
    return [
        { clinicalAttributeId: 'SAMPLE_COUNT', value: '1' },
        { clinicalAttributeId: 'WSI_PATIENT_SLIDE_COUNT', value },
    ];
}

function request(
    overrides: Partial<PathologySlidesTimelineRequest> = {}
): PathologySlidesTimelineRequest {
    return {
        tileServerUrl: '/wsi',
        clinicalDataPatient: slideCount('10'),
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

describe('patientWsiSlideCount', () => {
    it('reads WSI_PATIENT_SLIDE_COUNT', () => {
        expect(patientWsiSlideCount(slideCount('77'))).toBe(77);
    });

    it('is 0 when the attribute is missing or not a number', () => {
        expect(patientWsiSlideCount([])).toBe(0);
        expect(patientWsiSlideCount(slideCount('NA'))).toBe(0);
    });
});

describe('undatedPathologySlideCount', () => {
    const timeline = (undatedViewableSlideCount: number) =>
        ({ events: [], undatedViewableSlideCount } as any);
    const precomputed = (value: string) => [
        ...slideCount('10'),
        { clinicalAttributeId: 'WSI_PATIENT_UNDATED_SLIDE_COUNT', value },
    ];

    it('uses the precomputed attribute without waiting for the timeline', () => {
        expect(undatedPathologySlideCount(precomputed('3'), undefined)).toBe(3);
        expect(undatedPathologySlideCount(precomputed('0'), timeline(5))).toBe(
            0
        );
    });

    it('falls back to the hierarchy count when the attribute is missing', () => {
        expect(undatedPathologySlideCount(slideCount('10'), timeline(2))).toBe(
            2
        );
        expect(undatedPathologySlideCount(precomputed('NA'), timeline(2))).toBe(
            2
        );
    });

    it('is undefined until the fallback timeline has loaded', () => {
        expect(
            undatedPathologySlideCount(slideCount('10'), undefined)
        ).toBeUndefined();
    });
});

describe('loadPathologySlidesTimeline', () => {
    it('loads the slide events and track for a patient with slides', async () => {
        const { module, importModule } = mockModule(() =>
            Promise.resolve({
                events: [SLIDE_EVENT],
                undatedViewableSlideCount: 2,
            })
        );

        const timeline = await loadPathologySlidesTimeline(
            request(),
            importModule
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
        [
            'the slide count is 0',
            request({ clinicalDataPatient: slideCount('0') }),
        ],
        ['the slide count is missing', request({ clinicalDataPatient: [] })],
        ['no tile server is configured', request({ tileServerUrl: null })],
    ])('loads nothing when %s', async (_reason, noSlides) => {
        const { module, importModule } = mockModule(() =>
            Promise.resolve({
                events: [SLIDE_EVENT],
                undatedViewableSlideCount: 2,
            })
        );

        expect(
            await loadPathologySlidesTimeline(noSlides, importModule)
        ).toBeUndefined();
        expect(importModule).not.toHaveBeenCalled();
        expect(module.loadPathologySlideTimelineData).not.toHaveBeenCalled();
    });

    it('resolves undefined when the hierarchy fails to load', async () => {
        const { importModule } = mockModule(() =>
            Promise.reject(new Error('Server returned 503'))
        );

        expect(
            await loadPathologySlidesTimeline(request(), importModule)
        ).toBeUndefined();
    });

    it('resolves undefined when the module fails to load', async () => {
        expect(
            await loadPathologySlidesTimeline(request(), () =>
                Promise.reject(new Error('ChunkLoadError'))
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
