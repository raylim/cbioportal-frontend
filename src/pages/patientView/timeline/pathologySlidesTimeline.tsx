import React from 'react';
import { Link } from 'react-router-dom';
import _ from 'lodash';
import {
    getAttributeValue,
    ITrackEventConfig,
    TimelineEvent,
    TimelineTrackSpecification,
} from 'cbioportal-clinical-timeline';
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import {
    buildWsiSampleTimelineMap,
    WsiSampleTimelineMap,
} from 'shared/components/wsiViewer/wsiSampleTimeline';
import SampleMarker from './SampleMarker';
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
 * PATHOLOGY SLIDES track: a matched event is drawn as its sample's numbered,
 * colored marker and an unmatched one as the default grey point. Overlapping
 * events keep the default count-and-stack rendering, colored by sample.
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

            cat.eventColorGetter = e => markerSample(e)?.color;

            cat.sortSimultaneousEvents = (events: TimelineEvent[]) =>
                _.sortBy<TimelineEvent>(events, [
                    (e: TimelineEvent) => {
                        const label = parseInt(markerSample(e)?.label || '');
                        return isNaN(label) ? Number.POSITIVE_INFINITY : label;
                    },
                    (e: TimelineEvent) => getAttributeValue('SUBTYPE', e) || '',
                ]);

            cat.renderEvents = (events: TimelineEvent[], y: number) => {
                const sample =
                    events.length === 1 ? markerSample(events[0]) : null;
                return sample ? (
                    <SampleMarker
                        color={sample.color}
                        label={sample.label}
                        y={y}
                    />
                ) : null;
            };

            cat.renderTooltip = (e: TimelineEvent) => (
                <PathologySlideTooltip
                    event={e.event}
                    sampleTimelines={sampleTimelines}
                />
            );
        },
    };
}
