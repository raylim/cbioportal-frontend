import { assert } from 'chai';
import {
    colorGetterFactory,
    flattenTracks,
    formatDate,
    getAttributeValue,
    getFullTicks,
    getPreparedTooltipAttributes,
    getPointInTrimmedSpace,
    getPointInTrimmedSpaceFromScreenRead,
    getTrimmedTicks,
    sortNestedTracks,
    segmentAndSortAttributesForTooltip,
} from './helpers';
import intersect from './intersect';
import {
    TickIntervalEnum,
    TimelineEvent,
    TimelineTrackSpecification,
} from '../types';

describe('getPointInTrimmedSpace', () => {
    let ticks: any;

    beforeEach(() => {
        ticks = [
            { start: -20, end: -1, offset: 0 },
            { start: 0, end: 364, offset: 0 },
            {
                start: 365,
                end: 729,
                offset: 0,
            },
            { start: 730, end: 1094, offset: 0 },
            {
                isTrim: true,
                start: 1095,
                end: 1459,
                realEnd: 2189,
                offset: 0,
            },
            { start: 2190, end: 2554, offset: 1095 },
            {
                start: 2555,
                end: 2919,
                offset: 1095,
            },
            { start: 2920, end: 3284, offset: 1095 },
            {
                start: 3285,
                end: 3649,
                offset: 1095,
            },
            { start: 3650, end: 4014, offset: 1095 },
            {
                start: 4015,
                end: 4379,
                offset: 1095,
            },
            { start: 4380, end: 4744, offset: 1095 },
            {
                start: 4745,
                end: 5109,
                offset: 1095,
            },
            { start: 5110, end: 5474, offset: 1095 },
            {
                start: 5475,
                end: 5839,
                offset: 1095,
            },
            { start: 5840, end: 6204, offset: 1095 },
            {
                start: 6205,
                end: 6569,
                offset: 1095,
            },
            {
                isTrim: true,
                start: 6570,
                end: 6934,
                realEnd: 7299,
                offset: 1095,
            },
            {
                start: 7300,
                end: 7664,
                offset: 1337,
            },
            { start: 7665, end: 7785, offset: 1337 },
        ];
    });

    it('', () => {
        assert.isUndefined(
            getPointInTrimmedSpace(-21, ticks),
            'point prior to start of first tick is undefined'
        );

        assert.equal(
            getPointInTrimmedSpace(-20, ticks),
            -20,
            'point at start of first tick is equal to itself'
        );

        assert.equal(
            getPointInTrimmedSpace(-1, ticks),
            -1,
            'point at end of first tick is equal to itself'
        );

        assert.equal(
            getPointInTrimmedSpace(-1, ticks),
            -1,
            'point at end of first tick is equal to itself'
        );
    });

    it('points around/after trim regions incorporate trims', () => {
        assert.equal(getPointInTrimmedSpace(0, ticks), 0);
        assert.equal(getPointInTrimmedSpace(20, ticks), 20);
        assert.equal(
            getPointInTrimmedSpace(1500, ticks),
            1095,
            'point in trimmed region maps to start of trim'
        );
        assert.equal(
            getPointInTrimmedSpace(2200, ticks),
            1105,
            'point after trim observers is reduced by offset'
        );
    });

    it('point outside of limit returns undefined', () => {
        assert.equal(getPointInTrimmedSpace(-21, ticks), undefined);
        assert.equal(getPointInTrimmedSpace(7786, ticks), undefined);
    });

    it('updates trimmed-space lookups when tick layout mutates in place', () => {
        assert.equal(getPointInTrimmedSpace(2200, ticks), 1105);

        ticks[5].offset = 1200;

        assert.equal(getPointInTrimmedSpace(2200, ticks), 1000);
    });
});

describe('getPointInTrimmedSpaceFromScreenRead', () => {
    let ticks: any;

    beforeEach(() => {
        ticks = [
            { start: -20, end: -1, offset: 0 },
            { start: 0, end: 364, offset: 0 },
            { isTrim: true, start: 365, end: 729, realEnd: 1094, offset: 0 },
            { start: 1095, end: 1459, offset: 365 },
        ];
    });

    it('maps the same warm screen-space read consistently', () => {
        assert.equal(getPointInTrimmedSpaceFromScreenRead(10, ticks), -10);
        assert.equal(getPointInTrimmedSpaceFromScreenRead(10, ticks), -10);
    });

    it('updates screen-space reads when tick layout mutates in place', () => {
        assert.equal(getPointInTrimmedSpaceFromScreenRead(400, ticks), 1112);

        ticks[3].start = 1200;

        assert.equal(getPointInTrimmedSpaceFromScreenRead(400, ticks), 1217);
    });
});

describe('intersect', () => {
    it('detects overlaps', () => {
        assert.isTrue(intersect(-100, -10, -50, 20), 'overlap');
        assert.isTrue(intersect(-50, 20, -100, -10), 'overlap');
        assert.isTrue(intersect(-100, -10, -10, 20), 'overlap single point');
        assert.isTrue(
            intersect(-100, -10, -30, -20),
            'one contains other - negative'
        );
        assert.isTrue(
            intersect(100, 110, 105, 108),
            'one contains other - positive'
        );
        assert.isTrue(
            intersect(-10, 5, -5, 3),
            'one contains other - spanning zero'
        );
        assert.isFalse(intersect(-100, -10, -9, 20), 'no overlap');

        assert.isTrue(intersect(100, -10, -9, 20), 'reversed coordinates');
    });
});

describe('formatDate', () => {
    it('formats correctly', () => {
        assert.equal(formatDate(0), '0 days');
        assert.equal(formatDate(1), '1 day');
        assert.equal(formatDate(29), '29 days');
        assert.equal(formatDate(31), '1 month, 1 day');
        assert.equal(formatDate(59), '1 month, 29 days');
        assert.equal(formatDate(365), '1 year');
        assert.equal(formatDate(365 * 2), '2 years');
        assert.equal(formatDate(365 * 3), '3 years');
        assert.equal(formatDate(365 * 3 + 1), '3 years, 1 day');
        assert.equal(
            formatDate(365 * 3 + 30 * 2 + 1),
            '3 years, 2 months, 1 day'
        );
    });
});

describe('getAttributeValue', () => {
    it('gets attribute value by regexp', () => {
        const event: TimelineEvent = {
            end: 13524,
            start: 13524,
            event: {
                uniquePatientKey: 'UC0wMDAwMDA0Om1za2ltcGFjdF90ZXN0X2p1bmU',
                studyId: 'mskimpact_test_june',
                patientId: 'P-0000004',
                eventType: 'Sample acquisition',
                attributes: [
                    { key: 'SURGICAL_METHOD', value: 'Biopsy' },
                    {
                        key: 'SAMPLE_TYPE',
                        value: 'Primary',
                    },
                    {
                        key: 'CANCER_TYPE_DETAILED',
                        value: 'Breast Invasive Ductal Carcinoma',
                    },
                    {
                        key: 'SAMPLE_ID',
                        value: 'P-0000004-T01-IM3',
                    },
                    { key: 'CANCER_TYPE', value: 'Breast Cancer' },
                ],
                startNumberOfDaysSinceDiagnosis: 13524,
            },
        } as any;

        assert.equal(
            getAttributeValue('CANCER_TYPE_DETAILED', event),
            'Breast Invasive Ductal Carcinoma'
        );
        assert.equal(
            getAttributeValue(/_DETAILED/, event),
            'Breast Invasive Ductal Carcinoma'
        );
        assert.equal(getAttributeValue('CANCER_TYPE_DETA', event), undefined);
    });

    it('updates exact-key lookups when the attributes array mutates in place', () => {
        const event: TimelineEvent = {
            end: 5,
            start: 5,
            event: {
                uniquePatientKey: 'patient-1',
                studyId: 'study',
                patientId: 'P-1',
                eventType: 'SPECIMEN',
                attributes: [{ key: 'SAMPLE_ID', value: 'S-1' }],
                startNumberOfDaysSinceDiagnosis: 5,
            },
        } as any;

        assert.equal(getAttributeValue('SAMPLE_ID', event), 'S-1');

        event.event.attributes[0].value = 'S-2';

        assert.equal(getAttributeValue('SAMPLE_ID', event), 'S-2');
    });

    it('updates exact-key lookups when attribute rows are appended in place', () => {
        const event: TimelineEvent = {
            end: 5,
            start: 5,
            event: {
                uniquePatientKey: 'patient-1',
                studyId: 'study',
                patientId: 'P-1',
                eventType: 'SPECIMEN',
                attributes: [{ key: 'SAMPLE_ID', value: 'S-1' }],
                startNumberOfDaysSinceDiagnosis: 5,
            },
        } as any;

        assert.equal(getAttributeValue('RESULT', event), undefined);

        event.event.attributes.push({ key: 'RESULT', value: 'Positive' });

        assert.equal(getAttributeValue('RESULT', event), 'Positive');
    });
});

describe('color getter helpers', () => {
    it('colorGetterFactory resolves to custom getter or default', () => {
        const ev = ({
            event: {
                attributes: [{ key: 'STYLE_COLOR', value: '#12345' }],
            },
        } as unknown) as TimelineEvent;

        assert.equal(
            colorGetterFactory(undefined)(ev),
            '#12345',
            'if no custom getter passwed, we default getter plucks color from STYLE_COLOR'
        );

        assert.equal(
            colorGetterFactory(() => {})(ev),
            '#12345',
            'if custom color getter returns void, we use default color getter'
        );

        assert.equal(
            colorGetterFactory(() => undefined)(ev),
            '#12345',
            'if custom color getter returns undefined, we use default color getter'
        );

        assert.equal(
            colorGetterFactory(() => '#54321')(ev),
            '#54321',
            'if there IS a custom getter, it gets used'
        );
    });

    it('colorGetterFactory returns default color if there is not STYLE_COLOR attr', () => {
        const ev = ({
            event: {
                attributes: [],
            },
        } as unknown) as TimelineEvent;

        assert.equal(
            colorGetterFactory(undefined)(ev),
            'rgb(31, 119, 180)',
            'if no custom getter passwed, we default getter plucks color from STYLE_COLOR'
        );
    });
});

describe('order attributes according to config', () => {
    const atts = [
        { key: 'key1', value: 'someValue' },
        { key: 'key2', value: 'someValue' },
        { key: 'key3', value: 'someValue' },
        { key: 'key4', value: 'someValue' },
    ];

    it('places attributes in order by config', () => {
        const processedAtts = segmentAndSortAttributesForTooltip(atts, [
            'key4',
            'key2',
        ]);

        assert.deepEqual(
            processedAtts.map(a => a.key),
            ['key4', 'key2', 'key1', 'key3']
        );
    });

    it('handles missing attributes in config', () => {
        const processedAtts = segmentAndSortAttributesForTooltip(atts, [
            'key10',
            'key2',
        ]);

        assert.deepEqual(
            processedAtts.map(a => a.key),
            ['key2', 'key1', 'key3', 'key4']
        );
    });

    it('preserves duplicate configured keys against the last matching attribute', () => {
        const processedAtts = segmentAndSortAttributesForTooltip(
            [
                { key: 'key1', value: 'firstValue' },
                { key: 'key1', value: 'lastValue' },
                { key: 'key2', value: 'otherValue' },
            ],
            ['key1', 'key1']
        );

        assert.deepEqual(
            processedAtts.map(a => `${a.key}:${a.value}`),
            ['key1:lastValue', 'key1:lastValue', 'key2:otherValue']
        );
    });

    it('reuses prepared tooltip attributes for the same warm inputs', () => {
        const tooltipAttributes = [
            { key: 'STYLE_COLOR', value: '#12345' },
            { key: 'key1', value: 'someValue' },
            { key: 'key2', value: 'someValue' },
        ];

        const first = getPreparedTooltipAttributes(tooltipAttributes, ['key2']);
        const second = getPreparedTooltipAttributes(
            tooltipAttributes,
            ['key2']
        );

        assert.strictEqual(second, first);
        assert.deepEqual(second.map(a => a.key), ['key2', 'key1']);
    });

    it('rebuilds prepared tooltip attributes when attrs mutate in place', () => {
        const tooltipAttributes = [
            { key: 'STYLE_COLOR', value: '#12345' },
            { key: 'key1', value: 'someValue' },
        ];

        const first = getPreparedTooltipAttributes(tooltipAttributes, ['key1']);

        tooltipAttributes.push({ key: 'key2', value: 'laterValue' });

        const second = getPreparedTooltipAttributes(
            tooltipAttributes,
            ['key1']
        );

        assert.notStrictEqual(second, first);
        assert.deepEqual(second.map(a => a.key), ['key1', 'key2']);
    });
});

describe('track flattening helpers', () => {
    function makeTrack(
        uid: string,
        start: number,
        childTracks?: TimelineTrackSpecification[]
    ): TimelineTrackSpecification {
        const track: TimelineTrackSpecification = {
            uid,
            type: uid,
            items: [
                {
                    start,
                    end: start,
                    event: {
                        attributes: [],
                        eventType: uid,
                        patientId: 'P-1',
                        startNumberOfDaysSinceDiagnosis: start,
                        studyId: 'study',
                        uniquePatientKey: `${uid}-${start}`,
                    },
                    containingTrack: undefined as any,
                },
            ],
            tracks: childTracks,
        };
        track.items[0].containingTrack = track;
        return track;
    }

    it('reuses sorted nested tracks for the same warm input array', () => {
        const tracks = [makeTrack('later', 10), makeTrack('earlier', 5)];

        const first = sortNestedTracks(tracks);
        const second = sortNestedTracks(tracks);

        assert.strictEqual(second, first);
        assert.deepEqual(second.map(track => track.uid), ['earlier', 'later']);
    });

    it('reuses flattened track rows for the same warm tree and collapse state', () => {
        const child = makeTrack('child', 5);
        const root = makeTrack('root', 1, [child]);
        const isCollapsed = () => false;

        const first = flattenTracks([root], isCollapsed);
        const second = flattenTracks([root], isCollapsed);

        assert.strictEqual(second, first);
        assert.deepEqual(second.map(row => row.track.uid), ['root', 'child']);
    });

    it('rebuilds flattened track rows when the collapse state changes', () => {
        const child = makeTrack('child', 5);
        const root = makeTrack('root', 1, [child]);
        let collapsed = false;

        const first = flattenTracks([root], uid =>
            uid === 'root' ? collapsed : false
        );

        collapsed = true;

        const second = flattenTracks([root], uid =>
            uid === 'root' ? collapsed : false
        );

        assert.notStrictEqual(second, first);
        assert.deepEqual(first.map(row => row.track.uid), ['root', 'child']);
        assert.deepEqual(second.map(row => row.track.uid), ['root']);
    });

    it('rebuilds collapsed descendant items when nested track content mutates in place', () => {
        const child = makeTrack('child', 5);
        const root = makeTrack('root', 1, [child]);

        const first = flattenTracks([root], () => true);

        child.items.push({
            start: 7,
            end: 7,
            event: {
                attributes: [],
                eventType: 'child',
                patientId: 'P-1',
                startNumberOfDaysSinceDiagnosis: 7,
                studyId: 'study',
                uniquePatientKey: 'child-7',
            },
            containingTrack: child,
        });

        const second = flattenTracks([root], () => true);

        assert.notStrictEqual(second[0].track.items, first[0].track.items);
        assert.lengthOf(first[0].track.items, 2);
        assert.lengthOf(second[0].track.items, 3);
    });
});

describe('tick generation helpers', () => {
    function makeEvent(start: number, end: number, key: string): TimelineEvent {
        return {
            start,
            end,
            event: {
                attributes: [],
                eventType: 'SPECIMEN',
                patientId: 'P-1',
                startNumberOfDaysSinceDiagnosis: start,
                endNumberOfDaysSinceDiagnosis: end,
                studyId: 'study',
                uniquePatientKey: key,
            },
            containingTrack: undefined as any,
        };
    }

    it('reuses full ticks for the same warm event list', () => {
        const events = [makeEvent(0, 0, 'a'), makeEvent(400, 400, 'b')];

        const first = getFullTicks(events, TickIntervalEnum.YEAR);
        const second = getFullTicks(events, TickIntervalEnum.YEAR);

        assert.strictEqual(second, first);
    });

    it('rebuilds full ticks when event coordinates mutate in place', () => {
        const events = [makeEvent(0, 0, 'a'), makeEvent(400, 400, 'b')];

        const first = getFullTicks(events, TickIntervalEnum.YEAR);
        events[1].start = 800;
        events[1].end = 800;
        const second = getFullTicks(events, TickIntervalEnum.YEAR);

        assert.notStrictEqual(second, first);
    });

    it('reuses trimmed ticks for the same warm tick set and trim mode', () => {
        const fullTicks = getFullTicks(
            [makeEvent(0, 0, 'a'), makeEvent(400, 400, 'b')],
            TickIntervalEnum.YEAR
        );

        const first = getTrimmedTicks(fullTicks, false);
        const second = getTrimmedTicks(fullTicks, false);

        assert.strictEqual(second, first);
    });

    it('rebuilds trimmed ticks when the source tick content mutates in place', () => {
        const fullTicks = getFullTicks(
            [makeEvent(0, 0, 'a'), makeEvent(400, 400, 'b')],
            TickIntervalEnum.YEAR
        );

        const first = getTrimmedTicks(fullTicks, false);
        fullTicks[0].events!.push(makeEvent(-10, -10, 'c'));
        const second = getTrimmedTicks(fullTicks, false);

        assert.notStrictEqual(second, first);
    });

    it('assigns events to every overlapping full tick after building the tick array', () => {
        const spanningEvent = makeEvent(100, 500, 'span');
        const trailingEvent = makeEvent(800, 800, 'tail');

        const fullTicks = getFullTicks(
            [spanningEvent, trailingEvent],
            TickIntervalEnum.YEAR
        );

        const populatedTicks = fullTicks.filter(tick => tick.events!.length > 0);

        assert.lengthOf(populatedTicks, 3);
        assert.sameMembers(
            populatedTicks[0].events!.map(event => event.event.uniquePatientKey),
            ['span']
        );
        assert.sameMembers(
            populatedTicks[1].events!.map(event => event.event.uniquePatientKey),
            ['span']
        );
        assert.sameMembers(
            populatedTicks[2].events!.map(event => event.event.uniquePatientKey),
            ['tail']
        );
    });
});
