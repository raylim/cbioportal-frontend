import { assert } from 'chai';
import { configureTracks } from './configureTracks';
import {
    ITimelineConfig,
    TimelineEvent,
    TimelineTrackSpecification,
} from './types';

function makeTrackTypeMatch(
    source: string,
    flags: string,
    testImpl: (type: string) => boolean
): RegExp {
    return {
        source,
        flags,
        test: jest.fn(testImpl),
    } as unknown as RegExp;
}

function makeTrack(type: string): TimelineTrackSpecification {
    const track: TimelineTrackSpecification = {
        items: [],
        type,
        uid: type,
    };
    const event: TimelineEvent = {
        start: 0,
        end: 0,
        event: {
            attributes: [],
            eventType: type,
            patientId: 'P-1',
            startNumberOfDaysSinceDiagnosis: 0,
            studyId: 'study',
            uniquePatientKey: `${type}-event`,
        },
        containingTrack: track,
    };
    track.items = [event];
    return track;
}

describe('configureTracks', () => {
    it('reuses resolved renderer matches for repeated track types', () => {
        const matchingTest = makeTrackTypeMatch(
            '^SPECIMEN$',
            '',
            (type: string) => type === 'SPECIMEN'
        );
        const otherTest = makeTrackTypeMatch(
            '^TREATMENT$',
            '',
            (type: string) => type === 'TREATMENT'
        );
        const configureTrack = jest.fn();
        const timelineConfig: ITimelineConfig = {
            trackEventRenderers: [
                {
                    trackTypeMatch: matchingTest,
                    configureTrack,
                },
                {
                    trackTypeMatch: otherTest,
                    configureTrack: jest.fn(),
                },
            ],
        };
        const tracks = [makeTrack('SPECIMEN'), makeTrack('SPECIMEN')];

        configureTracks(tracks, timelineConfig);

        assert.equal((matchingTest.test as jest.Mock).mock.calls.length, 1);
        assert.equal((otherTest.test as jest.Mock).mock.calls.length, 0);
        assert.equal(configureTrack.mock.calls.length, 2);
    });

    it('recomputes renderer matches when the renderer list mutates in place', () => {
        const firstConfigureTrack = jest.fn();
        const secondConfigureTrack = jest.fn();
        const firstTest = makeTrackTypeMatch(
            '^SPECIMEN$',
            '',
            (type: string) => type === 'SPECIMEN'
        );
        const secondTest = makeTrackTypeMatch(
            '^SPECIMEN$',
            'i',
            (type: string) => type === 'SPECIMEN'
        );
        const renderers = [
            {
                trackTypeMatch: firstTest,
                configureTrack: firstConfigureTrack,
            },
        ];
        const timelineConfig: ITimelineConfig = {
            trackEventRenderers: renderers as any,
        };

        configureTracks([makeTrack('SPECIMEN')], timelineConfig);
        renderers[0] = {
            trackTypeMatch: secondTest,
            configureTrack: secondConfigureTrack,
        } as any;

        configureTracks([makeTrack('SPECIMEN')], timelineConfig);

        assert.equal((firstTest.test as jest.Mock).mock.calls.length, 1);
        assert.equal((secondTest.test as jest.Mock).mock.calls.length, 1);
        assert.equal(firstConfigureTrack.mock.calls.length, 1);
        assert.equal(secondConfigureTrack.mock.calls.length, 1);
    });

    it('computes the renderer signature once per configureTracks traversal', () => {
        let sourceReadCount = 0;
        let flagsReadCount = 0;
        const nestedTrack = makeTrack('SPECIMEN');
        const parentTrack = makeTrack('SPECIMEN');
        parentTrack.tracks = [nestedTrack];
        const trackTypeMatch = {
            get source() {
                sourceReadCount += 1;
                return '^SPECIMEN$';
            },
            get flags() {
                flagsReadCount += 1;
                return '';
            },
            test: jest.fn((type: string) => type === 'SPECIMEN'),
        } as unknown as RegExp;
        const configureTrack = jest.fn();
        const timelineConfig: ITimelineConfig = {
            trackEventRenderers: [
                {
                    trackTypeMatch,
                    configureTrack,
                },
            ],
        };

        configureTracks([parentTrack], timelineConfig);

        assert.equal(sourceReadCount, 1);
        assert.equal(flagsReadCount, 1);
        assert.equal(configureTrack.mock.calls.length, 2);
    });
});
