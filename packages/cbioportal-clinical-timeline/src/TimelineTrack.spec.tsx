// react-markdown is ESM-only and incompatible with Jest's CJS transform;
// mock it to avoid a transform error. It is not exercised by these tests.
jest.mock('react-markdown', () => () => null);

import { assert } from 'chai';
import React from 'react';
import { mount } from 'enzyme';
import { TimelineStore } from './TimelineStore';
import {
    renderPoint,
    getStackColorsForEvents,
    getGroupedEventEntriesForTrack,
    getGroupedEventsForTrack,
    TimelineItemWithTooltip,
} from './TimelineTrack';
import { TimelineEvent, TimelineTrackSpecification } from './types';

function makeMinimalTrackAndEvent(): {
    track: TimelineTrackSpecification;
    event: TimelineEvent;
} {
    const track: TimelineTrackSpecification = {
        items: [],
        type: 'SPECIMEN',
        uid: 'test-track',
    };
    const event: TimelineEvent = {
        start: 0,
        end: 0,
        event: {
            attributes: [],
            eventType: 'SPECIMEN',
            patientId: 'P-001',
            startNumberOfDaysSinceDiagnosis: 0,
            studyId: 'study1',
            uniquePatientKey: 'key1',
        },
        containingTrack: track,
    };
    track.items = [event];
    return { track, event };
}

describe('TimelineItemWithTooltip', () => {
    it('reuses grouped events for the same track items and sort function', () => {
        const { event } = makeMinimalTrackAndEvent();
        const events = [
            event,
            {
                ...event,
                event: {
                    ...event.event,
                    uniquePatientKey: 'key2',
                },
            },
        ];
        const sortSimultaneousEvents = (items: TimelineEvent[]) =>
            items.slice().reverse();

        const first = getGroupedEventsForTrack(events, sortSimultaneousEvents);
        const second = getGroupedEventsForTrack(events, sortSimultaneousEvents);

        assert.strictEqual(second, first);
    });

    it('rebuilds grouped events when the simultaneous sort function changes', () => {
        const { event } = makeMinimalTrackAndEvent();
        const events = [
            event,
            {
                ...event,
                event: {
                    ...event.event,
                    uniquePatientKey: 'key2',
                },
            },
        ];
        const first = getGroupedEventsForTrack(events, items => items);
        const second = getGroupedEventsForTrack(events, items =>
            items.slice().reverse()
        );

        assert.notStrictEqual(second, first);
    });

    it('rebuilds grouped events when event coordinates mutate in place', () => {
        const { event } = makeMinimalTrackAndEvent();
        const events = [
            event,
            {
                ...event,
                start: 5,
                end: 5,
                event: {
                    ...event.event,
                    uniquePatientKey: 'key2',
                },
            },
        ];
        const sortSimultaneousEvents = (items: TimelineEvent[]) => items;

        const first = getGroupedEventsForTrack(events, sortSimultaneousEvents);
        events[1].start = 0;
        events[1].end = 0;
        const second = getGroupedEventsForTrack(events, sortSimultaneousEvents);

        assert.notStrictEqual(second, first);
        assert.deepEqual(Object.keys(first!), ['0-0', '5-5']);
        assert.deepEqual(Object.keys(second!), ['0-0']);
        assert.lengthOf(second!['0-0'], 2);
    });

    it('rebuilds grouped events when event identity fields mutate in place', () => {
        const { event } = makeMinimalTrackAndEvent();
        const events = [
            event,
            {
                ...event,
                event: {
                    ...event.event,
                    uniquePatientKey: 'key2',
                },
            },
        ];
        const sortSimultaneousEvents = (items: TimelineEvent[]) => items;

        const first = getGroupedEventsForTrack(events, sortSimultaneousEvents);
        events[1].event.uniquePatientKey = 'key3';
        const second = getGroupedEventsForTrack(events, sortSimultaneousEvents);

        assert.notStrictEqual(second, first);
        assert.lengthOf(second!['0-0'], 2);
    });

    it('reuses grouped event entries for the same track items and sort function', () => {
        const { event } = makeMinimalTrackAndEvent();
        const events = [
            event,
            {
                ...event,
                start: 5,
                end: 5,
                event: {
                    ...event.event,
                    uniquePatientKey: 'key2',
                },
            },
        ];
        const sortSimultaneousEvents = (items: TimelineEvent[]) => items;

        const first = getGroupedEventEntriesForTrack(
            events,
            sortSimultaneousEvents
        );
        const second = getGroupedEventEntriesForTrack(
            events,
            sortSimultaneousEvents
        );

        assert.strictEqual(second, first);
        assert.deepEqual(
            first!.map(entry => entry.positionKey),
            ['0-0', '5-5']
        );
    });

    it('reuses stacked event colors for the same warm event bucket and color getter', () => {
        const { event } = makeMinimalTrackAndEvent();
        const events = [
            event,
            {
                ...event,
                event: {
                    ...event.event,
                    uniquePatientKey: 'key2',
                },
            },
        ];
        const colorGetter = jest.fn((item: TimelineEvent) =>
            item.event.uniquePatientKey === 'key1' ? '#111111' : '#222222'
        );

        const first = getStackColorsForEvents(events, colorGetter);
        const second = getStackColorsForEvents(events, colorGetter);

        assert.strictEqual(second, first);
        assert.deepEqual(second, ['#111111', '#222222']);
        assert.equal(colorGetter.mock.calls.length, 2);
    });

    it('rebuilds stacked event colors when event identity fields mutate in place', () => {
        const { event } = makeMinimalTrackAndEvent();
        const events = [
            event,
            {
                ...event,
                event: {
                    ...event.event,
                    uniquePatientKey: 'key2',
                },
            },
        ];
        const colorGetter = jest.fn((item: TimelineEvent) =>
            item.event.uniquePatientKey === 'key1' ? '#111111' : '#222222'
        );

        const first = getStackColorsForEvents(events, colorGetter);
        events[1].event.uniquePatientKey = 'key3';
        const second = getStackColorsForEvents(events, colorGetter);

        assert.notStrictEqual(second, first);
        assert.equal(colorGetter.mock.calls.length, 4);
    });

    it('reuses same-track detection for the same warm event bucket', () => {
        const { event } = makeMinimalTrackAndEvent();
        const renderEvents = jest.fn(() => <g />);
        event.containingTrack.renderEvents = renderEvents;
        const events = [
            event,
            {
                ...event,
                event: {
                    ...event.event,
                    uniquePatientKey: 'key2',
                },
            },
        ];

        renderPoint(events, 10);
        renderPoint(events, 10);

        assert.equal(renderEvents.mock.calls.length, 2);
        const renderEventCalls = renderEvents.mock.calls as any[];
        assert.strictEqual(renderEventCalls[0][0], events);
        assert.strictEqual(renderEventCalls[1][0], events);
    });

    it('rebuilds same-track detection when grouped events mutate to a different track', () => {
        const { track, event } = makeMinimalTrackAndEvent();
        const renderEvents = jest.fn(() => <g />);
        track.renderEvents = renderEvents;
        const otherTrack: TimelineTrackSpecification = {
            items: [],
            type: 'TREATMENT',
            uid: 'other-track',
        };
        const events = [
            event,
            {
                ...event,
                event: {
                    ...event.event,
                    uniquePatientKey: 'key2',
                },
            },
        ];

        renderPoint(events, 10);
        assert.equal(renderEvents.mock.calls.length, 1);

        events[1].containingTrack = otherTrack;
        renderPoint(events, 10);

        assert.equal(renderEvents.mock.calls.length, 1);
    });

    it('updates mousePosition on every onMouseMove, not just on first tooltip creation', () => {
        const { track, event } = makeMinimalTrackAndEvent();
        const store = new TimelineStore([track]);

        const wrapper = mount(
            <TimelineItemWithTooltip
                x={50}
                store={store}
                track={track}
                events={[event]}
                content={null}
            />
        );

        // First move: tooltip is created and mousePosition is set
        wrapper.simulate('mousemove', { pageX: 100, pageY: 200 });
        assert.deepEqual(
            store.mousePosition,
            { x: 100, y: 200 },
            'mousePosition set on first move'
        );

        // Second move: tooltip already exists — mousePosition must still update.
        // Before the fix, setMousePosition was only called inside the `if (!uid)`
        // guard, so repeated moves would leave mousePosition frozen at the entry
        // point, causing the tooltip to obstruct the underlying SVG clickthrough.
        wrapper.simulate('mousemove', { pageX: 300, pageY: 400 });
        assert.deepEqual(
            store.mousePosition,
            { x: 300, y: 400 },
            'mousePosition updated on subsequent moves'
        );
    });

    it('keeps controls usable for a multi-event tooltip that is not globally hovered', () => {
        const { track, event } = makeMinimalTrackAndEvent();
        const store = new TimelineStore([track]);
        const secondEvent = {
            ...event,
            event: {
                ...event.event,
                uniquePatientKey: 'key2',
            },
        };
        const multiEventTooltipUid = store.addTooltip({
            track,
            events: [event, secondEvent],
        });
        const otherTooltipUid = store.addTooltip({
            track,
            events: [event],
        });
        store.setHoveredTooltipUid(otherTooltipUid);
        const [, tooltipModel, tooltipIndex] = store.tooltipModels.find(
            ([uid]) => uid === multiEventTooltipUid
        )!;
        const wrapper = mount(
            store.getTooltipContent(
                multiEventTooltipUid,
                tooltipModel,
                tooltipIndex
            )
        );

        assert.isTrue(wrapper.find('.btn-group').exists());
        wrapper
            .find('button')
            .last()
            .simulate('click');
        assert.equal(
            store.tooltipModels.find(
                ([uid]) => uid === multiEventTooltipUid
            )![2],
            1
        );
    });

    it('pins a multi-event tooltip at its initial hover position', () => {
        const { track, event } = makeMinimalTrackAndEvent();
        const store = new TimelineStore([track]);
        const wrapper = mount(
            <TimelineItemWithTooltip
                x={50}
                store={store}
                track={track}
                events={[event, { ...event }]}
                content={null}
            />
        );

        wrapper.simulate('mousemove', { pageX: 100, pageY: 200 });

        const [tooltipUid, tooltipModel] = store.tooltipModels[0];
        assert.isTrue(store.isTooltipPinned(tooltipUid));
        assert.deepEqual(tooltipModel.position, { x: 100, y: 200 });
    });
});
