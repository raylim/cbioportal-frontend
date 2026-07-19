import { TimelineTrackSpecification } from './types';
import { getTrackHeight } from './lib/helpers';
import React from 'react';
import { getTicksForLineChartAxis } from './lib/lineChartAxisUtils';
import { CBIOPORTAL_VICTORY_THEME } from 'cbioportal-frontend-commons';

export interface ILineChartAxisProps {
    track: TimelineTrackSpecification;
    standalone: boolean;
}
export const LINE_CHART_AXIS_SVG_WIDTH = 50;
export const LINE_CHART_AXIS_TICK_WIDTH = 5;

export function getLineChartAxisTickKey(
    track: TimelineTrackSpecification,
    tick: { label: string; offset: number }
): string {
    return `${track.uid}:${tick.label}:${tick.offset}`;
}

const LineChartAxis: React.FunctionComponent<ILineChartAxisProps> = function({
    track,
    standalone,
}) {
    const trackHeight = getTrackHeight(track);
    const ticks = getTicksForLineChartAxis(track);
    const tickElements: JSX.Element[] = [];

    const width = LINE_CHART_AXIS_SVG_WIDTH;
    const tickWidth = LINE_CHART_AXIS_TICK_WIDTH;
    for (let index = 0; index < ticks.length; index += 1) {
        const tick = ticks[index];
        tickElements.push(
            <g
                key={getLineChartAxisTickKey(track, tick)}
                transform={`translate(0, ${tick.offset})`}
            >
                <text
                    // font family has to be inline, not from CSS,
                    //  because otherwise it won't download properly.
                    fontFamily={CBIOPORTAL_VICTORY_THEME.axis.fontFamily}
                    fontSize="10px"
                    textAnchor="end"
                    dy={'0.3em'}
                    dx={-3}
                    fill={'#aaa'}
                >
                    {tick.label}
                </text>
                <line
                    x1={0}
                    x2={tickWidth}
                    y1={0}
                    y2={0}
                    strokeWidth={1}
                    stroke={'#aaa'}
                />
            </g>
        );
    }

    const ticksGroup = (
        <g transform={`translate(${width - tickWidth},0)`}>
            {tickElements}
        </g>
    );
    if (standalone) {
        return (
            <svg height={trackHeight} width={width}>
                {ticksGroup}
            </svg>
        );
    } else {
        return ticksGroup;
    }
};

export default LineChartAxis;
