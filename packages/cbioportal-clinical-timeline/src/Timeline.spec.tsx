const mockJQueryOn = jest.fn();
const mockJQueryOff = jest.fn();

jest.mock('jquery', () => {
    const chain = {
        width: () => 0,
        height: () => 0,
        offset: () => ({ left: 0, top: 0 }),
        scrollLeft: () => 0,
        hide: () => chain,
        show: () => chain,
        css: () => chain,
        text: () => chain,
        empty: () => chain,
        on: (...args: any[]) => {
            mockJQueryOn(...args);
            return chain;
        },
        off: (...args: any[]) => {
            mockJQueryOff(...args);
            return chain;
        },
    };

    return () => chain;
});

jest.mock('react-markdown', () => () => null);

jest.mock('./TimelineTracks', () => ({
    __esModule: true,
    default: () => null,
    getCustomTrackKey: (track: { uid?: string; labelForExport: string }, index: number) =>
        track.uid || `${track.labelForExport}-${index}`,
}));

jest.mock('./TrackHeader', () => ({
    __esModule: true,
    ...jest.requireActual('./TrackHeader'),
    default: () => null,
    EXPORT_TRACK_HEADER_BORDER_CLASSNAME: 'mock-track-header-border',
    getTrackHeadersG: () => document.createElementNS('http://www.w3.org/2000/svg', 'g'),
}));

jest.mock('./CustomTrackHeader', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('./TickAxis', () => ({
    __esModule: true,
    default: () => null,
    TICK_AXIS_COLOR: '#000000',
    TICK_AXIS_HEIGHT: 20,
}));

jest.mock('./svg/getSvg', () => ({
    __esModule: true,
    default: () => '<svg />',
}));

jest.mock('cbioportal-frontend-commons', () => ({
    DownloadControls: () => null,
}));

import { assert } from 'chai';
import React from 'react';
import { mount } from 'enzyme';
import Timeline, {
    getCustomTrackLayoutSummary,
    getHoverTrackIndex,
    getHoverStyleText,
    getVisibleTrackLayout,
    setScroll,
} from './Timeline';
import { getTrackLabel } from './TrackHeader';
import { TimelineStore } from './TimelineStore';
import { TimelineTrackSpecification } from './types';
import { CustomTrackSpecification } from './CustomTrack';

function makeTrack(uid: string, start: number): TimelineTrackSpecification {
    const track: TimelineTrackSpecification = {
        uid,
        type: uid,
        items: [],
    };

    track.items = [
        {
            start,
            end: start,
            event: {
                attributes: [],
                eventType: uid,
                patientId: 'P-001',
                startNumberOfDaysSinceDiagnosis: start,
                studyId: 'study-1',
                uniquePatientKey: `${uid}-${start}`,
            },
            containingTrack: track,
        },
    ];

    return track;
}

describe('Timeline', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="root"></div>';
        mockJQueryOn.mockClear();
        mockJQueryOff.mockClear();
        (global as any).ResizeObserver = class {
            observe() {}
            disconnect() {}
        };
    });

    afterEach(() => {
        delete (global as any).ResizeObserver;
    });

    it('renders track and custom headers without React key warnings', () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation();
        const store = new TimelineStore([
            makeTrack('SPECIMEN', 0),
            makeTrack('SEQUENCING', 10),
        ]);
        const customTracks: CustomTrackSpecification[] = [
            {
                uid: 'custom-1',
                renderHeader: () => null,
                renderTrack: () => <g />,
                height: () => 20,
                labelForExport: 'Repeated Label',
            },
            {
                uid: 'custom-2',
                renderHeader: () => null,
                renderTrack: () => <g />,
                height: () => 20,
                labelForExport: 'Repeated Label',
            },
        ];

        const wrapper = mount(
            <Timeline
                store={store}
                width={800}
                onClickDownload={() => {}}
                customTracks={customTracks}
            />,
            {
                attachTo: document.getElementById('root')!,
            }
        );

        wrapper.unmount();

        const keyWarnings = consoleError.mock.calls.filter(
            call =>
                typeof call[0] === 'string' &&
                call[0].includes(
                    'Each child in a list should have a unique "key" prop'
                )
        );

        assert.deepEqual(keyWarnings, []);
        consoleError.mockRestore();
    });

    it('reuses visible track layout for equivalent visible-track arrays', () => {
        const tracks = [
            { track: makeTrack('SPECIMEN', 0), indent: 5, height: 20 },
            { track: makeTrack('TREATMENT', 10), indent: 5, height: 30 },
        ];

        const first = getVisibleTrackLayout(tracks, ['TREATMENT', 'SPECIMEN']);
        const second = getVisibleTrackLayout(tracks, ['SPECIMEN', 'TREATMENT']);

        assert.strictEqual(second, first);
        assert.deepEqual(
            second.filteredTracks.map(row => row.track.uid),
            ['SPECIMEN', 'TREATMENT']
        );
        assert.equal(second.totalHeight, 50);
    });

    it('builds custom-track layouts and total height in one ordered pass', () => {
        const store = new TimelineStore([makeTrack('SPECIMEN', 0)]);
        const firstHeight = jest.fn(() => 20);
        const secondHeight = jest.fn(() => 35);
        const customTracks: CustomTrackSpecification[] = [
            {
                uid: 'custom-1',
                renderHeader: () => null,
                renderTrack: () => <g />,
                height: firstHeight,
                labelForExport: 'First',
            },
            {
                uid: 'custom-2',
                renderHeader: () => null,
                renderTrack: () => <g />,
                height: secondHeight,
                labelForExport: 'Second',
            },
        ];

        const summary = getCustomTrackLayoutSummary(customTracks, store);

        assert.equal(firstHeight.mock.calls.length, 1);
        assert.equal(secondHeight.mock.calls.length, 1);
        assert.deepEqual(summary.layouts, [
            {
                height: 20,
                index: 0,
                track: customTracks[0],
            },
            {
                height: 35,
                index: 1,
                track: customTracks[1],
            },
        ]);
        assert.equal(summary.totalHeight, 55);
    });

    it('prefers explicit hover track indices over sibling scans', () => {
        const parent = document.createElement('div');
        const first = document.createElement('div');
        const second = document.createElement('div');
        first.setAttribute('data-track-index', '7');
        parent.appendChild(first);
        parent.appendChild(second);

        assert.equal(getHoverTrackIndex(first), 7);
        assert.equal(getHoverTrackIndex(second), 1);
    });

    it('reuses cached hover style text for the same timeline id and track index', () => {
        const first = getHoverStyleText('timeline-1', 3);
        const second = getHoverStyleText('timeline-1', 3);
        const third = getHoverStyleText('timeline-1', 4);

        assert.strictEqual(second, first);
        assert.notStrictEqual(third, first);
        assert.include(first, '#timeline-1 .tl-timeline-tracklabels');
    });

    it('reuses cached track labels and rebuilds them when label content changes', () => {
        const track = makeTrack('LONG_TRACK_NAME', 0);

        const first = getTrackLabel(track);
        const second = getTrackLabel(track);

        assert.strictEqual(second, first);
        assert.equal(first, 'LONGTRACKNAME');

        track.label = 'CUSTOM_LABEL';
        const third = getTrackLabel(track);

        assert.notStrictEqual(third, first);
        assert.equal(third, 'CUSTOMLABEL');
    });

    it('rebuilds visible track layout when flattened track rows mutate in place', () => {
        const tracks = [
            { track: makeTrack('SPECIMEN', 0), indent: 5, height: 20 },
            { track: makeTrack('TREATMENT', 10), indent: 5, height: 30 },
        ];

        const first = getVisibleTrackLayout(tracks, ['SPECIMEN']);

        tracks[0].height = 25;

        const second = getVisibleTrackLayout(tracks, ['SPECIMEN']);

        assert.notStrictEqual(second, first);
        assert.equal(first.totalHeight, 20);
        assert.equal(second.totalHeight, 25);
    });

    it('does not rebind global DOM listeners when only width changes', () => {
        const store = new TimelineStore([makeTrack('SPECIMEN', 0)]);
        const wrapper = mount(
            <Timeline
                store={store}
                width={800}
                onClickDownload={() => {}}
            />,
            {
                attachTo: document.getElementById('root')!,
            }
        );

        const onCallsAfterMount = mockJQueryOn.mock.calls.length;
        const offCallsAfterMount = mockJQueryOff.mock.calls.length;

        wrapper.setProps({
            width: 900,
        });

        assert.equal(mockJQueryOn.mock.calls.length, onCallsAfterMount);
        assert.equal(mockJQueryOff.mock.calls.length, offCallsAfterMount);

        wrapper.unmount();
    });

    it('skips the window resize listener when ResizeObserver is available', () => {
        const store = new TimelineStore([makeTrack('SPECIMEN', 0)]);

        const wrapper = mount(
            <Timeline
                store={store}
                width={800}
                onClickDownload={() => {}}
            />,
            {
                attachTo: document.getElementById('root')!,
            }
        );

        const onEventNames = mockJQueryOn.mock.calls.map(call => call[0]);
        const offEventNames = mockJQueryOff.mock.calls.map(call => call[0]);

        assert.notInclude(onEventNames, 'resize');

        wrapper.unmount();

        const offEventNamesAfterUnmount = mockJQueryOff.mock.calls.map(
            call => call[0]
        );
        assert.notInclude(offEventNamesAfterUnmount, 'resize');
        assert.sameMembers(
            onEventNames.filter(name => name !== undefined),
            ['keydown', 'mouseleave']
        );
        assert.sameMembers(
            offEventNamesAfterUnmount.filter(name => name !== undefined),
            ['mouseleave', 'keydown']
        );
        assert.deepEqual(offEventNames, []);
    });

    it('scrolls to the zoom start using the tick-position path', () => {
        const el = document.createElement('div');
        const getTickPosition = jest.fn((start: number) => ({
            left: `${start}%`,
            width: '0%',
            pixelLeft: 123,
            pixelWidth: 0,
        }));

        setScroll(
            {
                start: 45,
                end: 90,
            },
            el as HTMLDivElement,
            getTickPosition
        );

        assert.equal(getTickPosition.mock.calls.length, 1);
        assert.equal(getTickPosition.mock.calls[0][0], 45);
        assert.equal(el.scrollLeft, 123);
    });
});
