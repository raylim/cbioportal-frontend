// react-markdown is ESM-only and incompatible with Jest's CJS transform.
jest.mock('react-markdown', () => () => null);

jest.mock('react-overlays/lib', () => ({
    Portal: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

jest.mock('react-bootstrap', () => ({
    Popover: ({
        children,
        arrowOffsetTop: _arrowOffsetTop,
        positionLeft: _positionLeft,
        positionTop: _positionTop,
        ...props
    }: any) => (
        <div {...props} className="mock-popover">
            {children}
        </div>
    ),
}));

const mockGetBrowserWindow = jest.fn(() => ({ outerWidth: 1000 }));

jest.mock('cbioportal-frontend-commons', () => ({
    getBrowserWindow: () => mockGetBrowserWindow(),
}));

const mockTimelineTrack = jest.fn(
    (_props?: any) => <g className="mock-timeline-track" />
);

jest.mock('./TimelineTrack', () => ({
    TimelineTrack: (props: any) => mockTimelineTrack(props),
    EventTooltipContent: () => <div className="mock-tooltip-content" />,
}));

import { assert } from 'chai';
import React from 'react';
import { act } from 'react';
import { mount } from 'enzyme';
import { TimelineStore } from './TimelineStore';
import {
    getCustomTrackKey,
    TimelineTracks,
    TimelineTrackLegend,
    TimelineTrackRow,
} from './TimelineTracks';
import { TimelineTrackSpecification } from './types';

function makeStoreWithTooltip() {
    const track: TimelineTrackSpecification = {
        items: [],
        type: 'SPECIMEN',
        uid: 'track-1',
    };
    const event = {
        start: 0,
        end: 0,
        event: {
            attributes: [],
            eventType: 'SPECIMEN',
            patientId: 'P-001',
            startNumberOfDaysSinceDiagnosis: 0,
            studyId: 'study-1',
            uniquePatientKey: 'event-1',
        },
        containingTrack: track,
    };
    track.items = [event];
    const store = new TimelineStore([track]);
    store.setMousePosition({ x: 125, y: 250 });
    const tooltipUid = store.addTooltip({
        track,
        events: [event],
    });
    return { store, tooltipUid };
}

describe('TimelineTracks', () => {
    beforeEach(() => {
        document.body.innerHTML =
            '<div class="tl-timelineviewport"></div><div id="root"></div>';
        mockGetBrowserWindow.mockClear();
        mockTimelineTrack.mockClear();
    });

    it('sets hovered tooltip uid and pins the tooltip on popover hover', () => {
        const { store, tooltipUid } = makeStoreWithTooltip();

        const wrapper = mount(
            <TimelineTracks
                store={store}
                width={800}
                handleTrackHover={() => {}}
            />,
            {
                attachTo: document.getElementById('root')!,
            }
        );

        wrapper.find('.mock-popover').simulate('mouseenter');

        assert.equal(store.hoveredTooltipUid, tooltipUid);
        assert.isTrue(store.isTooltipPinned(tooltipUid));
        assert.deepEqual(
            store.tooltipModels.find(([uid]) => uid === tooltipUid)![1]
                .position,
            { x: 125, y: 250 }
        );
    });

    it('prefers explicit custom track uids over label-plus-index keys', () => {
        assert.equal(
            getCustomTrackKey(
                {
                    uid: 'custom-track-1',
                    renderHeader: () => null,
                    renderTrack: () => <g />,
                    height: () => 20,
                    labelForExport: 'Repeated Label',
                },
                4
            ),
            'custom-track-1'
        );

        assert.equal(
            getCustomTrackKey(
                {
                    renderHeader: () => null,
                    renderTrack: () => <g />,
                    height: () => 20,
                    labelForExport: 'Repeated Label',
                },
                4
            ),
            'Repeated Label-4'
        );
    });

    it('does not rerender the track layer when only tooltip state changes', () => {
        const { store, tooltipUid } = makeStoreWithTooltip();

        mount(
            <TimelineTracks
                store={store}
                width={800}
                handleTrackHover={() => {}}
            />,
            {
                attachTo: document.getElementById('root')!,
            }
        );

        assert.equal(mockTimelineTrack.mock.calls.length, 1);

        act(() => {
            store.setHoveredTooltipUid(tooltipUid);
            store.pinTooltip(tooltipUid);
        });

        assert.equal(mockTimelineTrack.mock.calls.length, 1);
    });

    it('uses supplied visible track rows instead of recomputing from store data', () => {
        const firstTrack: TimelineTrackSpecification = {
            items: [
                {
                    start: 0,
                    end: 0,
                    event: {
                        attributes: [],
                        eventType: 'SPECIMEN',
                        patientId: 'P-001',
                        startNumberOfDaysSinceDiagnosis: 0,
                        studyId: 'study-1',
                        uniquePatientKey: 'event-1',
                    },
                    containingTrack: undefined as any,
                },
            ],
            type: 'SPECIMEN',
            uid: 'track-1',
        };
        const secondTrack: TimelineTrackSpecification = {
            items: [
                {
                    start: 5,
                    end: 5,
                    event: {
                        attributes: [],
                        eventType: 'TREATMENT',
                        patientId: 'P-001',
                        startNumberOfDaysSinceDiagnosis: 5,
                        studyId: 'study-1',
                        uniquePatientKey: 'event-2',
                    },
                    containingTrack: undefined as any,
                },
            ],
            type: 'TREATMENT',
            uid: 'track-2',
        };
        firstTrack.items[0].containingTrack = firstTrack;
        secondTrack.items[0].containingTrack = secondTrack;
        const store = new TimelineStore([firstTrack, secondTrack]);
        const visibleTrackRows: TimelineTrackRow[] = [
            {
                track: secondTrack,
                indent: 0,
                height: 40,
            },
        ];

        mount(
            <TimelineTracks
                store={store}
                width={800}
                handleTrackHover={() => {}}
                visibleTrackRows={visibleTrackRows}
            />,
            {
                attachTo: document.getElementById('root')!,
            }
        );

        assert.equal(mockTimelineTrack.mock.calls.length, 1);
        const firstCall = mockTimelineTrack.mock.calls[0] as
            | unknown[]
            | undefined;
        assert.isDefined(firstCall);
        const firstCallProps = firstCall![0] as {
            trackData: TimelineTrackSpecification;
            y: number;
            height: number;
        };
        assert.equal(firstCallProps.trackData.uid, 'track-2');
        assert.equal(firstCallProps.y, 0);
        assert.equal(firstCallProps.height, 40);
    });

    it('renders legends through the supplied container without querying the document', () => {
        const container = document.createElement('div');
        const getElementsByClassNameSpy = jest.spyOn(
            document,
            'getElementsByClassName'
        );

        const wrapper = mount(
            <TimelineTrackLegend
                container={container}
                y={25}
                track={{
                    items: [],
                    type: 'SPECIMEN',
                    uid: 'track-with-legend',
                    trackConf: {
                        legend: [{ color: '#ff0000', label: 'Red' }],
                    } as any,
                } as any}
            />
        );

        assert.equal(getElementsByClassNameSpy.mock.calls.length, 0);
        assert.include(container.textContent || '', 'Track Legend:');

        wrapper.unmount();
        getElementsByClassNameSpy.mockRestore();
    });

    it('reads browser outerWidth once per tooltip-layer render', () => {
        const { store } = makeStoreWithTooltip();
        const secondTrack: TimelineTrackSpecification = {
            items: [],
            type: 'TREATMENT',
            uid: 'track-2',
        };
        const secondEvent = {
            start: 5,
            end: 5,
            event: {
                attributes: [],
                eventType: 'TREATMENT',
                patientId: 'P-001',
                startNumberOfDaysSinceDiagnosis: 5,
                studyId: 'study-1',
                uniquePatientKey: 'event-2',
            },
            containingTrack: secondTrack,
        };
        secondTrack.items = [secondEvent];
        store.addTooltip({
            track: secondTrack,
            events: [secondEvent],
        });

        mount(
            <TimelineTracks
                store={store}
                width={800}
                handleTrackHover={() => {}}
            />,
            {
                attachTo: document.getElementById('root')!,
            }
        );

        assert.equal(store.tooltipModels.length, 2);
        assert.equal(mockGetBrowserWindow.mock.calls.length, 1);
    });
});
