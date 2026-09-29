import React from 'react';
import { Link } from 'react-router-dom';
import _ from 'lodash';
import {
    getAttributeValue,
    ITrackEventConfig,
    renderStack,
    renderSuperscript,
    TimelineEvent,
    TimelineTrackSpecification,
} from 'cbioportal-clinical-timeline';
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import {
    buildWsiSampleTimelineMap,
    WsiSampleTimelineMap,
} from 'cbioportal-wsi-viewer';
import { getTextWidth } from 'cbioportal-frontend-commons';
import SampleMarker, { MultipleSampleMarker } from './SampleMarker';
import {
    getNumberRangeLabel,
    getSortedSampleInfo,
} from './TimelineWrapperUtils';
import { ISampleMetaDeta } from './TimelineWrapper';
import {
    buildPathologySlideRow,
    buildPathologySlideTooltipContent,
    PATHOLOGY_SLIDES_EVENT_TYPE,
    PathologySlideEvent,
    pathologySlideSampleId,
} from './pathologySlidesTableUtils';

export interface PathologySlideMarkerSample {
    sampleId: string;
    color: string;
    label: string;
}

/**
 * The patient sample a PATHOLOGY SLIDES event is matched to, with its
 * SampleManager color and number, or null when the event is unmatched or
 * names a sample outside this patient view.
 */
export function pathologySlideMarkerSample(
    event: PathologySlideEvent,
    caseMetaData: ISampleMetaDeta
): PathologySlideMarkerSample | null {
    const sampleId = pathologySlideSampleId(event);
    const label = sampleId ? caseMetaData.label[sampleId] : undefined;
    if (!sampleId || !label) {
        return null;
    }
    return {
        sampleId,
        color: caseMetaData.color[sampleId] || '#333333',
        label,
    };
}

/** Fill of the marker for slides not linked to a sequenced sample. */
export const UNMATCHED_MARKER_COLOR = '#999999';

const SAMPLE_MARKER_RADIUS = 7;

/**
 * How a group of simultaneous PATHOLOGY SLIDES events is drawn:
 * - "sample": every event belongs to one sample; its numbered marker.
 * - "samples": events from several samples (unmatched ones add no number);
 *   the multi-sample marker with each sample listed once.
 * - "unmatched": no event belongs to a patient sample; a grey marker.
 * `count` is the number of events, shown as a superscript when above one.
 */
export type PathologySlideGroupMarker = { count: number } & (
    | { kind: 'sample'; sample: PathologySlideMarkerSample }
    | { kind: 'samples'; samples: PathologySlideMarkerSample[] }
    | { kind: 'unmatched' }
);

export function pathologySlideGroupMarker(
    events: PathologySlideEvent[],
    caseMetaData: ISampleMetaDeta
): PathologySlideGroupMarker {
    const count = events.length;
    const markerSamples = events.map(e =>
        pathologySlideMarkerSample(e, caseMetaData)
    );
    const samples = _.uniqBy(
        markerSamples.filter(
            (s): s is PathologySlideMarkerSample => s !== null
        ),
        s => s.sampleId
    );
    if (samples.length === 0) {
        return { kind: 'unmatched', count };
    }
    if (samples.length === 1 && !markerSamples.includes(null)) {
        return { kind: 'sample', sample: samples[0], count };
    }
    return { kind: 'samples', samples, count };
}

/** Superscript event count placed just right of a marker's top edge. */
function countSuperscript(count: number, y: number, markerHalfWidth: number) {
    return (
        <g transform={`translate(${markerHalfWidth - 3} 0)`}>
            {renderSuperscript(count, y)}
        </g>
    );
}

export function renderPathologySlideGroupMarker(
    marker: PathologySlideGroupMarker,
    y: number
): JSX.Element {
    let shape: JSX.Element;
    let halfWidth: number;
    switch (marker.kind) {
        case 'sample':
            shape = (
                <SampleMarker
                    color={marker.sample.color}
                    label={marker.sample.label}
                    y={y}
                />
            );
            halfWidth = SAMPLE_MARKER_RADIUS;
            break;
        case 'samples': {
            const colors = marker.samples.map(s => s.color);
            const labels = marker.samples.map(s => s.label);
            // Same width as MultipleSampleMarker's pill.
            const label = getNumberRangeLabel(
                getSortedSampleInfo(colors, labels).map(p => p.label)
            );
            halfWidth = Math.ceil(getTextWidth(label, 'Arial', '10px')) / 2 + 4;
            shape = (
                <MultipleSampleMarker colors={colors} labels={labels} y={y} />
            );
            break;
        }
        default:
            if (marker.count > 1) {
                shape = renderStack(
                    _.times(marker.count, () => UNMATCHED_MARKER_COLOR),
                    y
                );
                halfWidth = 4.5;
            } else {
                shape = (
                    <circle
                        cx="0"
                        cy={y}
                        r={SAMPLE_MARKER_RADIUS}
                        fill={UNMATCHED_MARKER_COLOR}
                    />
                );
                halfWidth = SAMPLE_MARKER_RADIUS;
            }
    }
    return (
        <g>
            {shape}
            {marker.count > 1 && countSuperscript(marker.count, y, halfWidth)}
        </g>
    );
}

export const PathologySlideTooltip: React.FunctionComponent<{
    event: PathologySlideEvent;
    sampleTimelines: WsiSampleTimelineMap;
}> = function({ event, sampleTimelines }) {
    const content = buildPathologySlideTooltipContent(
        buildPathologySlideRow(event, sampleTimelines)
    );
    return (
        <div data-test="pathology-slide-tooltip">
            <strong>{content.title}</strong>
            <table style={{ marginTop: 5 }}>
                <tbody>
                    {content.lines.map(line => (
                        <tr key={line.label}>
                            <th style={{ paddingRight: 10 }}>{line.label}</th>
                            <td
                                title={line.tooltip}
                                style={
                                    line.tooltip
                                        ? { cursor: 'help' }
                                        : undefined
                                }
                            >
                                {line.value}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {content.openPath && (
                <div style={{ marginTop: 5 }}>
                    <Link
                        to={content.openPath}
                        className="btn btn-default btn-xs"
                        aria-label={content.openLabel}
                        title={content.openLabel}
                    >
                        Open slides
                    </Link>
                </div>
            )}
        </div>
    );
};

/**
 * PATHOLOGY SLIDES track: events are drawn with the SampleManager's numbered,
 * colored sample markers (see pathologySlideGroupMarker), with a count when
 * several share a day.
 */
export function pathologySlidesTrackConfig(
    caseMetaData: ISampleMetaDeta,
    clinicalEvents: ClinicalEvent[] | undefined
): ITrackEventConfig {
    return {
        trackTypeMatch: new RegExp(`^${PATHOLOGY_SLIDES_EVENT_TYPE}$`, 'i'),
        configureTrack: (cat: TimelineTrackSpecification) => {
            const sampleTimelines = buildWsiSampleTimelineMap(clinicalEvents);
            const markerSample = (e: TimelineEvent) =>
                pathologySlideMarkerSample(e.event, caseMetaData);

            cat.eventColorGetter = e =>
                markerSample(e)?.color || UNMATCHED_MARKER_COLOR;

            cat.sortSimultaneousEvents = (events: TimelineEvent[]) =>
                _.sortBy<TimelineEvent>(events, [
                    (e: TimelineEvent) => {
                        const label = parseInt(markerSample(e)?.label || '');
                        return isNaN(label) ? Number.POSITIVE_INFINITY : label;
                    },
                    (e: TimelineEvent) => getAttributeValue('SUBTYPE', e) || '',
                ]);

            cat.renderEvents = (events: TimelineEvent[], y: number) =>
                renderPathologySlideGroupMarker(
                    pathologySlideGroupMarker(
                        events.map(e => e.event),
                        caseMetaData
                    ),
                    y
                );

            cat.renderTooltip = (e: TimelineEvent) => (
                <PathologySlideTooltip
                    event={e.event}
                    sampleTimelines={sampleTimelines}
                />
            );
        },
    };
}
