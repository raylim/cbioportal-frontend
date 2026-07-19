import { TimelineEvent, TimelineTrackSpecification } from '../types';
import { buildTimelineEventSignature, getTrackHeight } from './helpers';
import { tickFormatNumeral } from 'cbioportal-frontend-commons';

type CachedTrackValueRangeEntry = {
    getLineChartValue?: TimelineTrackSpecification['getLineChartValue'];
    signature: string;
    range: { min: number; max: number };
};

type CachedLineChartItemsSnapshotEntry = {
    getLineChartValue?: TimelineTrackSpecification['getLineChartValue'];
    orderedSnapshot: string;
    range: { min: number; max: number };
    signature: string;
};

type CachedLineChartTicksEntry = {
    getLineChartValue?: TimelineTrackSpecification['getLineChartValue'];
    signature: string;
    trackHeight: number;
    ticks: { label: string; offset: number }[];
};

type CachedGroupedLineChartValueEntry = {
    getLineChartValue?: TimelineTrackSpecification['getLineChartValue'];
    hasFiniteValue: boolean;
    maxFiniteValue: number;
    orderedSnapshot: string;
    signature: string;
    maxValue: number | null;
};

const trackValueRangeCache = new WeakMap<
    TimelineEvent[],
    CachedTrackValueRangeEntry
>();
const lineChartItemsSnapshotCache = new WeakMap<
    TimelineEvent[],
    CachedLineChartItemsSnapshotEntry
>();
const lineChartTicksCache = new WeakMap<
    TimelineEvent[],
    CachedLineChartTicksEntry
>();
const groupedLineChartValueCache = new WeakMap<
    TimelineEvent[],
    CachedGroupedLineChartValueEntry
>();

function getLineChartItemsSnapshot(
    items: TimelineEvent[],
    getLineChartValue: NonNullable<TimelineTrackSpecification['getLineChartValue']>
): CachedLineChartItemsSnapshotEntry {
    let orderedSnapshot = '';
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < items.length; index += 1) {
        const event = items[index];
        const value = getLineChartValue(event);
        if (index > 0) {
            orderedSnapshot += '|';
        }
        orderedSnapshot += `${buildTimelineEventSignature(event)}::${
            value == null ? '' : value
        }`;

        if (value === null || !Number.isFinite(value)) {
            continue;
        }

        min = Math.min(value, min);
        max = Math.max(value, max);
    }

    const cached = lineChartItemsSnapshotCache.get(items);

    if (
        cached &&
        cached.getLineChartValue === getLineChartValue &&
        cached.orderedSnapshot === orderedSnapshot
    ) {
        return cached;
    }

    if (max === min) {
        max = min + 1;
    }

    const snapshot = {
        getLineChartValue,
        orderedSnapshot,
        range: { min, max },
        signature: orderedSnapshot,
    };
    lineChartItemsSnapshotCache.set(items, snapshot);
    return snapshot;
}

function getCachedMaxLineChartValue(
    events: TimelineEvent[],
    getLineChartValue: NonNullable<TimelineTrackSpecification['getLineChartValue']>
) {
    const cached = groupedLineChartValueCache.get(events);
    let orderedSnapshot = '';
    let hasFiniteValue = false;
    let maxFiniteValue = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const value = getLineChartValue(event);
        if (index > 0) {
            orderedSnapshot += '|';
        }
        orderedSnapshot += `${buildTimelineEventSignature(event)}::${
            value == null ? '' : value
        }`;
        if (value === null || !Number.isFinite(value)) {
            continue;
        }

        hasFiniteValue = true;
        maxFiniteValue = Math.max(maxFiniteValue, value);
    }

    if (
        cached &&
        cached.getLineChartValue === getLineChartValue &&
        cached.orderedSnapshot === orderedSnapshot
    ) {
        return cached.maxValue;
    }

    const maxValue = hasFiniteValue ? maxFiniteValue : null;

    groupedLineChartValueCache.set(events, {
        getLineChartValue,
        hasFiniteValue,
        maxFiniteValue,
        orderedSnapshot,
        signature: orderedSnapshot,
        maxValue,
    });

    return maxValue;
}

export function getTicksForLineChartAxis(track: TimelineTrackSpecification) {
    const getLineChartValue = track.getLineChartValue!;
    const items = track.items || [];
    const snapshot = getLineChartItemsSnapshot(items, getLineChartValue);
    const signature = snapshot.signature;
    const trackHeight = getTrackHeight(track);
    const cached = lineChartTicksCache.get(items);

    if (
        cached &&
        cached.getLineChartValue === getLineChartValue &&
        cached.signature === signature &&
        cached.trackHeight === trackHeight
    ) {
        return cached.ticks;
    }

    const range = snapshot.range;
    const rawTickValues = [range.min, (range.min + range.max) / 2, range.max];
    const ticks = new Array<{ label: string; offset: number }>(
        rawTickValues.length
    );
    for (let index = 0; index < rawTickValues.length; index += 1) {
        const value = rawTickValues[index];
        ticks[index] = {
            label: tickFormatNumeral(value, rawTickValues),
            offset: getLineChartYCoordinateForValue(
                value,
                track,
                trackHeight,
                range
            ),
        };
    }

    lineChartTicksCache.set(items, {
        getLineChartValue,
        signature,
        trackHeight,
        ticks,
    });

    return ticks;
}

export function getTrackValueRange(track: TimelineTrackSpecification) {
    // We are assuming this is a line chart track
    const getLineChartValue = track.getLineChartValue!;
    const items = track.items || [];
    const snapshot = getLineChartItemsSnapshot(items, getLineChartValue);
    const signature = snapshot.signature;
    const cached = trackValueRangeCache.get(items);

    if (
        cached &&
        cached.getLineChartValue === getLineChartValue &&
        cached.signature === signature
    ) {
        return cached.range;
    }
    const range = snapshot.range;
    trackValueRangeCache.set(items, {
        getLineChartValue,
        signature,
        range,
    });
    return range;
}

export function getLineChartYCoordinateForValue(
    value: number,
    track: TimelineTrackSpecification,
    trackHeight: number,
    trackValueRange: { min: number; max: number }
) {
    const padding = Math.min(trackHeight / 7, 15); // pad proportionally but no more padding than 15
    const plottingHeight = trackHeight - 2 * padding;
    const plottingProportion =
        (value - trackValueRange.min) /
        (trackValueRange.max - trackValueRange.min);

    return padding + (1 - plottingProportion) * plottingHeight; // 1-p because SVG y axis points down
}

export function getLineChartYCoordinateForEvents(
    events: TimelineEvent[],
    track: TimelineTrackSpecification,
    trackHeight: number,
    trackValueRange: { min: number; max: number }
) {
    const maxValue = getCachedMaxLineChartValue(
        events,
        track.getLineChartValue!
    );
    if (maxValue === null) {
        return null;
    }

    return getLineChartYCoordinateForValue(
        maxValue,
        track,
        trackHeight,
        trackValueRange
    );
}
