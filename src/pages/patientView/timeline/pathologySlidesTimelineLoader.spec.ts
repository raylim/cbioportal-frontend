import { ClinicalEvent } from 'cbioportal-ts-api-client';
import {
    loadPathologySlidesTimeline,
    PathologySlidesTimelineModule,
    PathologySlidesTimelineRequest,
    patientWsiSlideCount,
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
    loadPathologySlideEvents: PathologySlidesTimelineModule['loadPathologySlideEvents']
) {
    const module: PathologySlidesTimelineModule = {
        loadPathologySlideEvents: jest.fn(loadPathologySlideEvents),
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

describe('loadPathologySlidesTimeline', () => {
    it('loads the slide events and track for a patient with slides', async () => {
        const { module, importModule } = mockModule(() =>
            Promise.resolve([SLIDE_EVENT])
        );

        const timeline = await loadPathologySlidesTimeline(
            request(),
            importModule
        );

        expect(importModule).toHaveBeenCalledTimes(1);
        expect(module.loadPathologySlideEvents).toHaveBeenCalledWith(
            'mskimpact',
            'P-0000024',
            'user-1'
        );
        expect(timeline).toEqual({
            events: [SLIDE_EVENT],
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
            Promise.resolve([SLIDE_EVENT])
        );

        expect(
            await loadPathologySlidesTimeline(noSlides, importModule)
        ).toBeUndefined();
        expect(importModule).not.toHaveBeenCalled();
        expect(module.loadPathologySlideEvents).not.toHaveBeenCalled();
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
                trackConfig: jest.fn(),
            })
        ).toBe(clinicalEvents);
    });
});
