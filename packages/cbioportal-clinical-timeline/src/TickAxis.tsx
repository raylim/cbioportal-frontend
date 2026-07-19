import { TickIntervalEnum, TimelineTick } from './types';
import React from 'react';
import { TimelineStore } from './TimelineStore';
import { observer } from 'mobx-react';

interface ITickAxisProps {
    store: TimelineStore;
    width: number;
}

export const TICK_AXIS_HEIGHT = 20;
const TICK_LABEL_STYLE: any = {
    fontSize: 9,
    fontFamily: 'Arial',
    textAnchor: 'middle',
};
const MAJOR_TICK_HEIGHT = 6;
const MINOR_TICK_HEIGHT = 3;

export function getTimelineTickKey(tick: TimelineTick, index: number): string {
    return `${index}:${tick.start}:${tick.end}:${tick.realEnd ?? ''}:${tick.offset ?? ''}:${tick.isTrim ? 1 : 0}`;
}

export function getMinorTimelineTickKey(
    majorTickKey: string,
    minorIndex: number,
    position: number
): string {
    return `${majorTickKey}:minor:${minorIndex}:${position}`;
}

function makeSquiggle(onClick: () => void) {
    return (
        <g transform={`translate(-6 ${TICK_AXIS_HEIGHT - 6})`}>
            {/* this rect visually blocks the axis */}
            <rect y={5} height={1} width={20} fill={'#ffffff'} />
            {/* this rect is a mouse hitzone */}
            <rect
                y={0}
                height={10}
                width={20}
                fillOpacity={0}
                style={{ cursor: 'pointer' }}
                onClick={onClick}
            />
            <path
                d={'M0,5L2.5,8L5,0L7.5,10L10,0L12.5,10L15,0L17.5,8L20,5'}
                stroke={TICK_AXIS_COLOR}
                strokeWidth="1"
                fill="none"
                pointerEvents={'none'} // dont block mouse from clicking on rect
            />
        </g>
    );
}

export const TICK_AXIS_COLOR = '#ccc';

const TickAxis: React.FunctionComponent<ITickAxisProps> = observer(function({
    store,
    width,
}: ITickAxisProps) {
    const ticks = store.ticks;
    const tickPixelWidth = store.tickPixelWidth;
    const showMinorTicks = tickPixelWidth > 150;
    const showAllMinorLabels = tickPixelWidth > 700;
    const tickLayers = new Array<JSX.Element>(ticks.length);

    for (let index = 0; index < ticks.length; index += 1) {
        const tick = ticks[index];
        let content: JSX.Element | null = null;
        const tickKey = getTimelineTickKey(tick, index);
        const startPoint =
            tick === store.firstTick
                ? tick.end - store.tickInterval + 1
                : tick.start;
        const majorTickPosition = store.getTickPosition(startPoint);
        const transform = majorTickPosition
            ? `translate(${majorTickPosition.pixelLeft} 0)`
            : undefined;
        const minorTicks: JSX.Element[] = [];

        if (tick.isTrim) {
            content = makeSquiggle(store.toggleExpandedTrims);
        } else {
            const count = startPoint / store.tickInterval;
            const unit =
                store.tickInterval === TickIntervalEnum.MONTH ? 'm' : 'y';
            let majorLabel = '';

            if (count < 0) {
                majorLabel = `${count}${unit}`;
            } else if (count === 0) {
                majorLabel = '0';
            } else {
                majorLabel = `${count}${unit}`;
            }

            content = (
                <>
                    <text
                        dy={'1em'}
                        style={{
                            fill: '#333',
                            ...TICK_LABEL_STYLE,
                        }}
                    >
                        {majorLabel}
                    </text>
                    <rect
                        height={MAJOR_TICK_HEIGHT}
                        width={1}
                        transform={`translate(0 ${
                            TICK_AXIS_HEIGHT - MAJOR_TICK_HEIGHT
                        })`}
                        fill={'#aaa'}
                    />
                </>
            );

            if (showMinorTicks) {
                const minorTickWidth = TickIntervalEnum.MONTH;

                for (let minorIndex = 1; minorIndex < 12; minorIndex += 1) {
                    const position = store.getTickPosition(
                        startPoint + minorTickWidth * minorIndex
                    );
                    const minorTransform = position
                        ? `translate(${position.pixelLeft} 0)`
                        : undefined;
                    const minorPixelLeft = position?.pixelLeft;
                    let minorLabel = '';

                    if (
                        minorIndex % 4 === 0 ||
                        showAllMinorLabels
                    ) {
                        let minorCount = minorIndex;
                        if (count < 0) {
                            minorCount = 12 - minorIndex;
                            const nextMajorLabel =
                                count + 1 === 0 ? '' : `${count + 1}${unit}`;
                            minorLabel =
                                count === -1
                                    ? `-${minorCount}m`
                                    : `${nextMajorLabel} ${minorCount}m`;
                        } else {
                            minorLabel =
                                count === 0
                                    ? `${minorCount}m`
                                    : `${majorLabel} ${minorCount}m`;
                        }
                    }

                    if (
                        minorTransform &&
                        minorPixelLeft !== undefined
                    ) {
                        minorTicks.push(
                            <g
                                key={getMinorTimelineTickKey(
                                    tickKey,
                                    minorIndex,
                                    minorPixelLeft
                                )}
                                transform={minorTransform}
                            >
                                <text
                                    dy={'1.5em'}
                                    style={{
                                        fill: '#aaa',
                                        ...TICK_LABEL_STYLE,
                                    }}
                                >
                                    {minorLabel}
                                </text>
                                <rect
                                    height={MINOR_TICK_HEIGHT}
                                    width={1}
                                    transform={`translate(0 ${
                                        TICK_AXIS_HEIGHT - MINOR_TICK_HEIGHT
                                    })`}
                                    fill={'#aaa'}
                                />
                            </g>
                        );
                    }
                }
            }
        }

        const rightAfterTrim = index > 0 && ticks[index - 1].isTrim;
        tickLayers[index] = (
            <React.Fragment key={tickKey}>
                {!rightAfterTrim && transform && (
                    <g transform={transform}>{content}</g>
                )}
                {minorTicks}
            </React.Fragment>
        );
    }

    return (
        <>
            <g>
                <rect
                    transform={`translate(0 ${TICK_AXIS_HEIGHT - 1})`}
                    fill={TICK_AXIS_COLOR}
                    height={1}
                    width={width}
                />
                {tickLayers}
            </g>
        </>
    );
});

export default TickAxis;
