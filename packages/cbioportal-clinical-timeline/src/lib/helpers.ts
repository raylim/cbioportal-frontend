import {
    POINT_COLOR,
    SegmentedAttributes,
    TimeLineColorGetter,
    TimelineEvent,
    TimelineEventAttribute,
    TimelineTick,
    TimelineTrackSpecification,
    TimelineTrackType,
} from '../types';
import { intersect } from './intersect';
import { COLOR_ATTRIBUTE_KEY, SHAPE_ATTRIBUTE_KEY } from '../styleAttributeKeys';

export const TIMELINE_TRACK_HEIGHT = 20;
export const TIMELINE_LINE_CHART_TRACK_HEIGHT = 50; // TODO: dynamic?
export const REMOVE_FOR_DOWNLOAD_CLASSNAME = 'tl-remove-for-download';
const MAX_FLATTENED_TRACKS_CACHE_ENTRIES = 100;

type AttributeLookupCacheEntry = {
    signature: string;
    valueByKey: Map<string, string>;
};

type PreparedTooltipAttributesCacheEntry = {
    attributeOrderSignature: string;
    attributesSignature: string;
    preparedAttributes: TimelineEventAttribute[];
};

type CachedAttributeSignatureEntry = {
    orderedSnapshot: string;
    signature: string;
};

type CachedTimelineEventSignatureEntry = {
    attributeRef: TimelineEventAttribute[] | undefined;
    attributesSignature: string;
    end: number;
    eventEndNumberOfDaysSinceDiagnosis: number | null | undefined;
    eventType: string;
    fullTicksSignature: string;
    start: number;
    eventStartNumberOfDaysSinceDiagnosis: number | null | undefined;
    signature: string;
    uniquePatientKey: string;
};

type CachedDescendantItemsEntry = {
    items: TimelineEvent[];
    signature: string;
};

type CachedSortedNestedTracksEntry = {
    signature: string;
    tracks: TimelineTrackSpecification[];
};

type CachedFlattenedTracksEntry = {
    flattenedTracks: Array<{
        track: TimelineTrackSpecification;
        indent: number;
        height: number;
    }>;
};

type CachedFullTicksEntry = {
    signature: string;
    tickInterval: number;
    ticks: TimelineTick[];
};

type CachedTrimmedTicksEntry = {
    falseTicks?: TimelineTick[];
    falseSignature?: string;
    trueTicks?: TimelineTick[];
    trueSignature?: string;
};

type CachedTrimmedSpacePointEntry = {
    signature: string;
    values: Map<number, number | undefined>;
};

type TimelineEventBounds = {
    lowerBound: number;
    upperBound: number;
};

const attributeLookupCache = new WeakMap<
    TimelineEventAttribute[],
    AttributeLookupCacheEntry
>();
const attributeSignatureCache = new WeakMap<
    TimelineEventAttribute[],
    CachedAttributeSignatureEntry
>();
const preparedTooltipAttributesCache = new WeakMap<
    TimelineEventAttribute[],
    PreparedTooltipAttributesCacheEntry
>();
const timelineEventSignatureCache = new WeakMap<
    TimelineEvent,
    CachedTimelineEventSignatureEntry
>();
const descendantItemsCache = new WeakMap<
    TimelineTrackSpecification,
    CachedDescendantItemsEntry
>();
const sortedNestedTracksCache = new WeakMap<
    TimelineTrackSpecification[],
    CachedSortedNestedTracksEntry
>();
const flattenedTracksCache = new Map<string, CachedFlattenedTracksEntry>();
const fullTicksCache = new WeakMap<TimelineEvent[], CachedFullTicksEntry>();
const trimmedTicksCache = new WeakMap<TimelineTick[], CachedTrimmedTicksEntry>();
const trimmedSpacePointCache = new WeakMap<
    TimelineTick[],
    CachedTrimmedSpacePointEntry
>();
const trimmedSpaceScreenReadCache = new WeakMap<
    TimelineTick[],
    CachedTrimmedSpacePointEntry
>();

function getTimelineEventBounds(events: TimelineEvent[]): TimelineEventBounds {
    let lowerBound = Number.POSITIVE_INFINITY;
    let upperBound = Number.NEGATIVE_INFINITY;

    for (const event of events) {
        lowerBound = Math.min(lowerBound, event.start);
        upperBound = Math.max(upperBound, event.end);
    }

    return {
        lowerBound,
        upperBound,
    };
}

export function getTrackHeight(track: TimelineTrackSpecification) {
    switch (track.trackType) {
        case TimelineTrackType.LINE_CHART:
            return TIMELINE_LINE_CHART_TRACK_HEIGHT;
        case TimelineTrackType.DEFAULT:
        case undefined:
        default:
            return TIMELINE_TRACK_HEIGHT;
    }
}

function buildAttributeLookupSignature(
    attributes: TimelineEventAttribute[]
): string {
    let orderedSnapshot = '';
    for (let index = 0; index < attributes.length; index += 1) {
        const attribute = attributes[index];
        if (index > 0) {
            orderedSnapshot += '|';
        }
        orderedSnapshot += `${attribute.key}:${attribute.value}`;
    }

    const cached = attributeSignatureCache.get(attributes);
    if (cached && cached.orderedSnapshot === orderedSnapshot) {
        return cached.signature;
    }

    const signature = orderedSnapshot;

    attributeSignatureCache.set(attributes, {
        orderedSnapshot,
        signature,
    });

    return signature;
}

function buildAttributeOrderSignature(attributeOrder?: string[]): string {
    return (attributeOrder || []).join('|');
}

export function buildTimelineEventSignature(event: TimelineEvent): string {
    const attributes = event.event.attributes;
    const attributesSignature = buildAttributeLookupSignature(attributes || []);
    const cached = timelineEventSignatureCache.get(event);
    if (
        cached &&
        cached.attributeRef === attributes &&
        cached.attributesSignature === attributesSignature &&
        cached.start === event.start &&
        cached.end === event.end &&
        cached.uniquePatientKey === (event.event.uniquePatientKey || '') &&
        cached.eventType === (event.event.eventType || '') &&
        cached.eventStartNumberOfDaysSinceDiagnosis ===
            event.event.startNumberOfDaysSinceDiagnosis &&
        cached.eventEndNumberOfDaysSinceDiagnosis ===
            event.event.endNumberOfDaysSinceDiagnosis
    ) {
        return cached.signature;
    }

    const signature = [
        event.start,
        event.end,
        event.event.uniquePatientKey || '',
        event.event.eventType || '',
        event.event.startNumberOfDaysSinceDiagnosis ?? '',
        event.event.endNumberOfDaysSinceDiagnosis ?? '',
        attributesSignature,
    ].join('::');
    const fullTicksSignature = [
        event.start,
        event.end,
        event.event.uniquePatientKey || '',
        event.event.eventType || '',
    ].join('::');

    timelineEventSignatureCache.set(event, {
        attributeRef: attributes,
        attributesSignature,
        end: event.end,
        eventEndNumberOfDaysSinceDiagnosis:
            event.event.endNumberOfDaysSinceDiagnosis,
        eventType: event.event.eventType || '',
        fullTicksSignature,
        start: event.start,
        eventStartNumberOfDaysSinceDiagnosis:
            event.event.startNumberOfDaysSinceDiagnosis,
        signature,
        uniquePatientKey: event.event.uniquePatientKey || '',
    });

    return signature;
}

function buildTrackItemsSignature(items: TimelineEvent[]): string {
    let signature = '';

    for (let index = 0; index < items.length; index += 1) {
        if (index > 0) {
            signature += '||';
        }
        signature += buildTimelineEventSignature(items[index]);
    }

    return signature;
}

function buildFullTicksSignature(events: TimelineEvent[]): string {
    let signature = '';

    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        buildTimelineEventSignature(event);

        if (index > 0) {
            signature += '|';
        }

        signature +=
            timelineEventSignatureCache.get(event)?.fullTicksSignature || '';
    }

    return signature;
}

function buildTrimmedTicksSignature(ticks: TimelineTick[]): string {
    let signature = '';

    for (let index = 0; index < ticks.length; index += 1) {
        const tick = ticks[index];

        if (index > 0) {
            signature += '|';
        }

        signature += [
            tick.start,
            tick.end,
            tick.realEnd ?? '',
            tick.offset ?? '',
            tick.isTrim ? 1 : 0,
            tick.events?.length ?? 0,
        ].join('::');
    }

    return signature;
}

function buildTrackTreeSignature(track: TimelineTrackSpecification): string {
    let childTrackSignature = '';
    const childTracks = track.tracks;

    if (childTracks) {
        for (let index = 0; index < childTracks.length; index += 1) {
            if (index > 0) {
                childTrackSignature += '|';
            }
            childTrackSignature += buildTrackTreeSignature(childTracks[index]);
        }
    }

    return `${track.uid}::${track.type}::${buildTrackItemsSignature(
        track.items || []
    )}::${childTrackSignature}`;
}

function buildFlattenedTrackSignature(
    track: TimelineTrackSpecification,
    isTrackCollapsed: (trackUid: string) => boolean
): string {
    let childTrackSignature = '';
    const childTracks = track.tracks;

    if (childTracks) {
        for (let index = 0; index < childTracks.length; index += 1) {
            if (index > 0) {
                childTrackSignature += '|';
            }
            childTrackSignature += buildFlattenedTrackSignature(
                childTracks[index],
                isTrackCollapsed
            );
        }
    }

    return `${buildTrackTreeSignature(track)}::${
        isTrackCollapsed(track.uid) ? 1 : 0
    }::${childTrackSignature}`;
}

function getSortedNestedTracks(
    tracks: TimelineTrackSpecification[]
): TimelineTrackSpecification[] {
    let signature = '';
    for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        const firstItem = track.items && track.items.length ? track.items[0] : null;

        if (index > 0) {
            signature += '|';
        }

        signature += [
            track.uid,
            firstItem?.start ?? '',
            firstItem?.end ?? '',
            firstItem?.event.uniquePatientKey ?? '',
        ].join('::');
    }
    const cached = sortedNestedTracksCache.get(tracks);

    if (cached && cached.signature === signature) {
        return cached.tracks;
    }

    const sortedTracks = tracks.slice();
    sortedTracks.sort((left, right) => {
        const leftStart =
            left.items && left.items.length ? left.items[0].start : 0;
        const rightStart =
            right.items && right.items.length ? right.items[0].start : 0;
        return leftStart - rightStart;
    });
    sortedNestedTracksCache.set(tracks, {
        signature,
        tracks: sortedTracks,
    });
    return sortedTracks;
}

function getAttributeValueByExactKey(
    attributes: TimelineEventAttribute[],
    name: string
): string | undefined {
    const signature = buildAttributeLookupSignature(attributes);
    const cached = attributeLookupCache.get(attributes);

    if (cached && cached.signature === signature) {
        return cached.valueByKey.get(name);
    }

    const valueByKey = new Map<string, string>();
    for (let index = 0; index < attributes.length; index += 1) {
        const attribute = attributes[index];
        valueByKey.set(attribute.key, attribute.value);
    }
    attributeLookupCache.set(attributes, {
        signature,
        valueByKey,
    });

    return valueByKey.get(name);
}

export function getAttributeValue(name: string | RegExp, event: TimelineEvent) {
    const attributes = event?.event?.attributes || [];

    if (name instanceof RegExp) {
        const attribute = attributes.find(att => name.test(att.key));
        return attribute?.value;
    }

    return getAttributeValueByExactKey(attributes, name);
}

const TRIM_TICK_THRESHHOLD = 4;

const TICK_OFFSET = 30;

export function getTrimmedTicks(
    ticks: TimelineTick[],
    expandedTrims: boolean
): TimelineTick[] {
    const signature = buildTrimmedTicksSignature(ticks);
    const cached = trimmedTicksCache.get(ticks);
    if (expandedTrims) {
        if (cached?.trueSignature === signature && cached.trueTicks) {
            return cached.trueTicks;
        }
    } else if (cached?.falseSignature === signature && cached.falseTicks) {
        return cached.falseTicks;
    }

    let tickCache: TimelineTick[] = [];
    let offset = 0;
    const trimmedTicks: TimelineTick[] = [];

    for (let tickIndex = 0; tickIndex < ticks.length; tickIndex += 1) {
        const tick = ticks[tickIndex];
        if (tick.events!.length === 0) {
            tick.offset = offset;
            tickCache.push(tick);
            // see if we are going to collapse a new trim region
        } else {
            const isTrim =
                !expandedTrims && tickCache.length >= TRIM_TICK_THRESHHOLD;
            if (isTrim) {
                // we want to leave the first trimmed tick as a normal tick
                // because it serves as an end to last tick region
                // otherwise, it will appear as though points are inside the trimmed region

                trimmedTicks.push(tickCache[0]);

                const collapsedTicks = tickCache.slice(1, -1);

                trimmedTicks.push({
                    isTrim: true,
                    start: collapsedTicks[0].start,
                    end: collapsedTicks[0].end,
                    realEnd: collapsedTicks[collapsedTicks.length - 1].end,
                    offset: offset,
                } as TimelineTick);

                const lastTick = tickCache[tickCache.length - 1];
                for (
                    let trimmedTickIndex = 0;
                    trimmedTickIndex < collapsedTicks.length;
                    trimmedTickIndex += 1
                ) {
                    const trimmedTick = collapsedTicks[trimmedTickIndex];
                    offset += trimmedTick.end - trimmedTick.start + 1;
                }

                lastTick.offset = offset;

                trimmedTicks.push(lastTick);

                tickCache = []; // start new cache;
            } else {
                // we don't have enough for trim so just put em in as regular ticks
                for (
                    let cachedTickIndex = 0;
                    cachedTickIndex < tickCache.length;
                    cachedTickIndex += 1
                ) {
                    trimmedTicks.push(tickCache[cachedTickIndex]);
                }
            }

            trimmedTicks.push(tick);
            tickCache = []; // start new cache
        }
        tick.offset = offset;
    }

    const nextCached = cached || {};
    const finalSignature = buildTrimmedTicksSignature(ticks);
    if (expandedTrims) {
        nextCached.trueSignature = finalSignature;
        nextCached.trueTicks = trimmedTicks;
    } else {
        nextCached.falseSignature = finalSignature;
        nextCached.falseTicks = trimmedTicks;
    }
    trimmedTicksCache.set(ticks, nextCached);

    return trimmedTicks;
}

export function getFullTicks(events: TimelineEvent[], tickInterval: number) {
    const signature = buildFullTicksSignature(events);
    const cached = fullTicksCache.get(events);
    if (
        cached &&
        cached.signature === signature &&
        cached.tickInterval === tickInterval
    ) {
        return cached.ticks;
    }

    const ticks: TimelineTick[] = [];
    const { lowerBound, upperBound } = getTimelineEventBounds(events);

    const floor = Math.floor(lowerBound / tickInterval) * tickInterval;

    let place = floor;

    const ceiling = Math.ceil(upperBound / tickInterval) * tickInterval;

    do {
        const start = place;
        const end = place + tickInterval - 1;
        ticks.push({
            start,
            end,
            events: [],
        });
        place += tickInterval;
    } while (place < ceiling);

    const BUFFER = 20; // Math.ceil((upperBound - lowerBound) * 0.02);

    let diff = Math.abs(ticks[0].start) - Math.abs(lowerBound);

    if (diff < BUFFER) {
        // need new tick
        ticks.unshift({
            start: ticks[0].start - BUFFER,
            end: ticks[0].start - 1,
            events: [],
        });
    } else {
        ticks[0].start = lowerBound - BUFFER;
    }

    ticks[ticks.length - 1].end = upperBound + BUFFER;

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const event = events[eventIndex];
        for (let tickIndex = 0; tickIndex < ticks.length; tickIndex += 1) {
            const tick = ticks[tickIndex];
            if (intersect(event.start, event.end, tick.start, tick.end)) {
                tick.events!.push(event);
            }
        }
    }

    fullTicksCache.set(events, {
        signature,
        tickInterval,
        ticks,
    });

    return ticks;
}

export function getPerc(n: number, l: number) {
    return (n / l) * 100;
}

// this function accpts a raw point and adjust it according to the offsets of trimmed regions that proceed it
// this gives us a point on the timeline minus empty areas (trims) excised to avoid white space
export function getPointInTrimmedSpace(x: number, regions: TimelineTick[]) {
    const signature = buildTrimmedTicksSignature(regions);
    const cached = trimmedSpacePointCache.get(regions);
    if (cached && cached.signature === signature && cached.values.has(x)) {
        return cached.values.get(x);
    }

    let region: TimelineTick | undefined;
    for (let index = 0; index < regions.length; index += 1) {
        const candidate = regions[index];
        if (candidate.start <= x && (candidate.end >= x || candidate.realEnd! >= x)) {
            region = candidate;
            break;
        }
    }

    let result: number | undefined;
    if (region) {
        if (region.isTrim) {
            // this point is in a trimmed region so just return the start of the trimmed region (adjusted for offset)
            result = region.start - (region.offset || 0);
        } else {
            result = x - (region.offset || 0);
        }
    }

    const nextValues =
        cached && cached.signature === signature ? cached.values : new Map();
    nextValues.set(x, result);
    trimmedSpacePointCache.set(regions, {
        signature,
        values: nextValues,
    });

    return result;
}

export function getPointInTrimmedSpaceFromScreenRead(
    val: number,
    ticks: TimelineTick[]
) {
    const signature = buildTrimmedTicksSignature(ticks);
    const cached = trimmedSpaceScreenReadCache.get(ticks);
    if (cached && cached.signature === signature && cached.values.has(val)) {
        return cached.values.get(val)!;
    }

    let rem = val;
    let result = 0;
    for (let index = 0; index < ticks.length; index += 1) {
        const tick = ticks[index];
        if (!tick.isTrim) {
            if (rem >= tick.end - tick.start) {
                rem = rem - (tick.end - tick.start);
            } else {
                result = tick.start + rem;
                break;
            }
        }
    }

    const nextValues =
        cached && cached.signature === signature ? cached.values : new Map();
    nextValues.set(val, result);
    trimmedSpaceScreenReadCache.set(ticks, {
        signature,
        values: nextValues,
    });

    return result;
}

export function sortNestedTracks(tracks: TimelineTrackSpecification[]) {
    return getSortedNestedTracks(tracks);
}

export function formatDate(dayCount: number) {
    let negative = dayCount < 0;
    dayCount = Math.abs(dayCount);

    let years, months, days;

    years = Math.floor(dayCount / 365);
    months = Math.floor((dayCount - years * 365) / 30);
    days = Math.floor(dayCount - years * 365 - months * 30);

    let arr = [];

    if (years > 0) arr.push(`${years} year${years === 1 ? '' : 's'}`);
    if (months > 0) arr.push(`${months} month${months === 1 ? '' : 's'}`);
    if (dayCount === 0 || days > 0)
        arr.push(`${days} day${days === 1 ? '' : 's'}`);

    const formattedDate = arr.join(', ');
    return `${negative ? '-' : ''}${formattedDate}`;
}

function getAllDescendantData(
    track: TimelineTrackSpecification,
    accumulator: TimelineEvent[]
) {
    const signature = buildTrackTreeSignature(track);
    const cached = descendantItemsCache.get(track);

    if (cached && cached.signature === signature) {
        accumulator.push(...cached.items);
        return accumulator;
    }

    const descendantItems: TimelineEvent[] = [];
    // add root items
    descendantItems.push(...track.items);
    // recursively add items from nested tracks
    if (track.tracks) {
        for (const nestedTrack of track.tracks) {
            getAllDescendantData(nestedTrack, descendantItems);
        }
    }
    descendantItemsCache.set(track, {
        items: descendantItems,
        signature,
    });
    accumulator.push(...descendantItems);
    return accumulator;
}

function flattenTrack(
    track: TimelineTrackSpecification,
    indent: number,
    isTrackCollapsed: (trackUid: string) => boolean
): { track: TimelineTrackSpecification; indent: number; height: number }[] {
    const ret = [{ track, indent, height: getTrackHeight(track) }];

    if (track.tracks) {
        if (!isTrackCollapsed(track.uid)) {
            // if track is not collapsed, then sort nested tracks and recurse
            const sortedNestedTracks = sortNestedTracks(track.tracks);
            for (let index = 0; index < sortedNestedTracks.length; index += 1) {
                const flattenedChildren = flattenTrack(
                    sortedNestedTracks[index],
                    indent + 17,
                    isTrackCollapsed
                );
                for (
                    let childIndex = 0;
                    childIndex < flattenedChildren.length;
                    childIndex += 1
                ) {
                    ret.push(flattenedChildren[childIndex]);
                }
            }
        } else {
            // otherwise, put all nested data into root track
            ret[0].track = {
                ...track,
                items: getAllDescendantData(track, []),
            };
        }
    }

    return ret;
}

export function flattenTracks(
    tracks: TimelineTrackSpecification[],
    isTrackCollapsed: (trackUid: string) => boolean
) {
    let signature = '';
    for (let index = 0; index < tracks.length; index += 1) {
        if (index > 0) {
            signature += '||';
        }
        signature += buildFlattenedTrackSignature(
            tracks[index],
            isTrackCollapsed
        );
    }
    const cached = flattenedTracksCache.get(signature);

    if (cached) {
        flattenedTracksCache.delete(signature);
        flattenedTracksCache.set(signature, cached);
        return cached.flattenedTracks;
    }

    const flattenedTracks: Array<{
        track: TimelineTrackSpecification;
        indent: number;
        height: number;
    }> = [];
    for (let index = 0; index < tracks.length; index += 1) {
        const flattenedTrackRows = flattenTrack(
            tracks[index],
            5,
            isTrackCollapsed
        );
        for (
            let rowIndex = 0;
            rowIndex < flattenedTrackRows.length;
            rowIndex += 1
        ) {
            flattenedTracks.push(flattenedTrackRows[rowIndex]);
        }
    }
    if (flattenedTracksCache.has(signature)) {
        flattenedTracksCache.delete(signature);
    }
    flattenedTracksCache.set(signature, { flattenedTracks });
    if (flattenedTracksCache.size > MAX_FLATTENED_TRACKS_CACHE_ENTRIES) {
        const oldestKey = flattenedTracksCache.keys().next().value;
        if (oldestKey) {
            flattenedTracksCache.delete(oldestKey);
        }
    }

    return flattenedTracks;
}

export function isTrackVisible(
    track: TimelineTrackSpecification,
    visibleTracks: string[]
) {
    return visibleTracks.includes(track.type);
}

export function getTrackEventCustomColorGetterFromConfiguration(
    track: TimelineTrackSpecification
) {
    return track.eventColorGetter || track.timelineConfig?.eventColorGetter;
}

export function defaultColorGetter(e: TimelineEvent) {
    return getSpecifiedColorIfExists(e) || POINT_COLOR;
}

export function getSpecifiedColorIfExists(e: TimelineEvent) {
    return getAttributeValue(COLOR_ATTRIBUTE_KEY, e);
}

// event color getter can be configured in a Timeline's baseConfiguration
// we want to allow configuration at that level to defer to the default color getter
// by returning undefined.
// this factory allows to run the custom configured eventColorGetter and if it returns false
// defer to the defaultColorGetter
export const colorGetterFactory = (eventColorGetter?: TimeLineColorGetter) => {
    return (e: TimelineEvent) => {
        if (eventColorGetter) {
            return eventColorGetter(e) || defaultColorGetter(e);
        } else {
            return defaultColorGetter(e);
        }
    };
};

export function segmentAndSortAttributesForTooltip(
    attributes: TimelineEventAttribute[],
    attributeOrder: string[]
) {
    const orderedKeys = new Set(attributeOrder || []);
    const orderedByKey = new Map<string, TimelineEventAttribute>();
    const rest: TimelineEventAttribute[] = [];

    for (const attribute of attributes) {
        if (orderedKeys.has(attribute.key)) {
            orderedByKey.set(attribute.key, attribute);
        } else {
            rest.push(attribute);
        }
    }

    const orderedAttributes: TimelineEventAttribute[] = [];
    const resolvedAttributeOrder = attributeOrder || [];

    for (
        let index = 0;
        index < resolvedAttributeOrder.length;
        index += 1
    ) {
        const attribute = orderedByKey.get(resolvedAttributeOrder[index]);
        if (attribute) {
            orderedAttributes.push(attribute);
        }
    }

    return orderedAttributes.concat(rest);
}

function prepareTooltipAttributesUncached(
    attributes: TimelineEventAttribute[],
    attributeOrder?: string[]
) {
    if (!attributeOrder?.length) {
        const filteredAttributes: TimelineEventAttribute[] = [];

        for (let index = 0; index < attributes.length; index += 1) {
            const attr = attributes[index];
            if (
                attr.key !== COLOR_ATTRIBUTE_KEY &&
                attr.key !== SHAPE_ATTRIBUTE_KEY
            ) {
                filteredAttributes.push(attr);
            }
        }

        return filteredAttributes;
    }

    const orderedKeys = new Set(attributeOrder);
    const orderedByKey = new Map<string, TimelineEventAttribute>();
    const rest: TimelineEventAttribute[] = [];

    for (const attribute of attributes) {
        if (
            attribute.key === COLOR_ATTRIBUTE_KEY ||
            attribute.key === SHAPE_ATTRIBUTE_KEY
        ) {
            continue;
        }

        if (orderedKeys.has(attribute.key)) {
            orderedByKey.set(attribute.key, attribute);
        } else {
            rest.push(attribute);
        }
    }

    const first: TimelineEventAttribute[] = [];
    for (let index = 0; index < attributeOrder.length; index += 1) {
        const attribute = orderedByKey.get(attributeOrder[index]);
        if (attribute) {
            first.push(attribute);
        }
    }

    return first.concat(rest);
}

export function getPreparedTooltipAttributes(
    attributes: TimelineEventAttribute[],
    attributeOrder?: string[]
) {
    const attributesSignature = buildAttributeLookupSignature(attributes);
    const attributeOrderSignature = buildAttributeOrderSignature(attributeOrder);
    const cached = preparedTooltipAttributesCache.get(attributes);

    if (
        cached &&
        cached.attributesSignature === attributesSignature &&
        cached.attributeOrderSignature === attributeOrderSignature
    ) {
        return cached.preparedAttributes;
    }

    const preparedAttributes = prepareTooltipAttributesUncached(
        attributes,
        attributeOrder
    );

    preparedTooltipAttributesCache.set(attributes, {
        attributeOrderSignature,
        attributesSignature,
        preparedAttributes,
    });

    return preparedAttributes;
}
