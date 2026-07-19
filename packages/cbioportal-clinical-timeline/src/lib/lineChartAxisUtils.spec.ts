import { assert } from 'chai';
import {
    getLineChartYCoordinateForEvents,
    getTicksForLineChartAxis,
    getTrackValueRange,
} from './lineChartAxisUtils';
import { TimelineEvent, TimelineTrackSpecification, TimelineTrackType } from '../types';

function makeLineChartTrack(
    values: number[],
    getLineChartValue?: (event: TimelineEvent) => number | null
): TimelineTrackSpecification {
    const track: TimelineTrackSpecification = {
        uid: 'line-track',
        type: 'MEASUREMENTS',
        trackType: TimelineTrackType.LINE_CHART,
        items: [],
        getLineChartValue:
            getLineChartValue ||
            ((event: TimelineEvent) =>
                Number(event.event.attributes[0]?.value ?? 0)),
    };

    track.items = values.map((value, index) => ({
        start: index,
        end: index,
        event: {
            attributes: [{ key: 'RESULT', value: String(value) }],
            eventType: 'MEASUREMENTS',
            patientId: 'P-1',
            startNumberOfDaysSinceDiagnosis: index,
            studyId: 'study',
            uniquePatientKey: `event-${index}`,
        },
        containingTrack: track,
    }));

    return track;
}

describe('lineChartAxisUtils', () => {
    it('reuses the cached track value range for the same warm track items', () => {
        const track = makeLineChartTrack([1, 5, 3]);

        const first = getTrackValueRange(track);
        const second = getTrackValueRange(track);

        assert.strictEqual(second, first);
        assert.deepEqual(second, { min: 1, max: 5 });
    });

    it('rebuilds the cached track value range when line-chart values mutate in place', () => {
        const track = makeLineChartTrack([1, 5, 3]);

        const first = getTrackValueRange(track);
        track.items[1].event.attributes[0].value = '9';
        const second = getTrackValueRange(track);

        assert.notStrictEqual(second, first);
        assert.deepEqual(second, { min: 1, max: 9 });
    });

    it('reuses axis ticks through the cached value range for unchanged inputs', () => {
        const track = makeLineChartTrack([2, 4, 6]);

        const first = getTicksForLineChartAxis(track);
        const second = getTicksForLineChartAxis(track);

        assert.strictEqual(second, first);
    });

    it('scans line-chart values only once on a cold tick build', () => {
        const getLineChartValue = jest.fn((event: TimelineEvent) =>
            Number(event.event.attributes[0]?.value ?? 0)
        );
        const track = makeLineChartTrack([2, 4, 6], getLineChartValue);

        const ticks = getTicksForLineChartAxis(track);

        assert.lengthOf(ticks, 3);
        assert.equal(getLineChartValue.mock.calls.length, 3);
    });

    it('rebuilds cached axis ticks when line-chart values mutate in place', () => {
        const track = makeLineChartTrack([2, 4, 6]);

        const first = getTicksForLineChartAxis(track);
        track.items[2].event.attributes[0].value = '8';
        const second = getTicksForLineChartAxis(track);

        assert.notStrictEqual(second, first);
        assert.deepEqual(second.map(tick => tick.label), ['2', '5', '8']);
    });

    it('reuses grouped line-chart value scans for unchanged event buckets', () => {
        const track = makeLineChartTrack([3, 7, 5]);
        const groupedEvents = [track.items[0], track.items[1]];
        const range = getTrackValueRange(track);

        const first = getLineChartYCoordinateForEvents(
            groupedEvents,
            track,
            60,
            range
        );
        const second = getLineChartYCoordinateForEvents(
            groupedEvents,
            track,
            60,
            range
        );

        assert.strictEqual(second, first);
    });

    it('scans grouped line-chart values only once on a cold grouped-y build', () => {
        const getLineChartValue = jest.fn((event: TimelineEvent) =>
            Number(event.event.attributes[0]?.value ?? 0)
        );
        const track = makeLineChartTrack([3, 7, 5], getLineChartValue);
        const groupedEvents = [track.items[0], track.items[1]];
        const range = getTrackValueRange(track);

        const y = getLineChartYCoordinateForEvents(
            groupedEvents,
            track,
            60,
            range
        );

        assert.isNotNull(y);
        assert.equal(getLineChartValue.mock.calls.length, 5);
    });

    it('updates grouped line-chart value scans when grouped event values mutate in place', () => {
        const track = makeLineChartTrack([3, 7, 5]);
        const groupedEvents = [track.items[0], track.items[1]];
        const range = { min: 0, max: 10 };

        const first = getLineChartYCoordinateForEvents(
            groupedEvents,
            track,
            60,
            range
        );

        track.items[1].event.attributes[0].value = '9';
        const second = getLineChartYCoordinateForEvents(
            groupedEvents,
            track,
            60,
            range
        );

        assert.notStrictEqual(second, first);
        assert.isBelow(second!, first!);
    });
});
