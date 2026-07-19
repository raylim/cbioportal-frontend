import { TimelineTrack } from './TimelineTrack';
import React from 'react';
import { TimelineStore } from './TimelineStore';
import { observer } from 'mobx-react';
// react-overlays v0.7's @types predate React 18 (no children on props, stricter container).
import { Portal as PortalUntyped } from 'react-overlays/lib';
const Portal = (PortalUntyped as unknown) as React.ComponentType<{
    container?: HTMLElement | React.ReactNode | Function;
    children?: React.ReactNode;
}>;
import { Popover } from 'react-bootstrap';
import CustomTrack, { CustomTrackSpecification } from './CustomTrack';
import { TICK_AXIS_HEIGHT } from './TickAxis';
import { getBrowserWindow } from 'cbioportal-frontend-commons';
import ReactDOM from 'react-dom';
import { TimelineTrackSpecification } from './types';

export type TimelineTrackRow = {
    track: TimelineTrackSpecification;
    indent: number;
    height: number;
};

export type CustomTrackLayout = {
    height: number;
    index: number;
    track: CustomTrackSpecification;
};

export interface ITimelineTracks {
    store: TimelineStore;
    customTrackLayouts?: CustomTrackLayout[];
    width: number;
    handleTrackHover: (e: React.MouseEvent<SVGGElement>) => void;
    customTracks?: CustomTrackSpecification[];
    legendContainer?: Element | null;
    visibleTracks?: string[];
    visibleTrackRows?: TimelineTrackRow[];
}

export function getCustomTrackKey(
    track: CustomTrackSpecification,
    index: number
): string {
    return track.uid || `${track.labelForExport}-${index}`;
}

const TimelineTrackLayers: React.FunctionComponent<ITimelineTracks> = observer(
    function({
        store,
        width,
        handleTrackHover,
        customTracks,
        customTrackLayouts,
        legendContainer,
        visibleTracks,
        visibleTrackRows,
    }) {
        const tracks = visibleTrackRows || store.data;
        const resolvedCustomTrackLayouts: CustomTrackLayout[] = customTrackLayouts
            ? customTrackLayouts
            : [];
        const visibleTrackSet = visibleTrackRows
            ? undefined
            : visibleTracks
              ? new Set<string>(visibleTracks)
              : undefined;
        let nextY = 0;

        if (!customTrackLayouts && customTracks?.length) {
            for (let index = 0; index < customTracks.length; index += 1) {
                const track = customTracks[index];
                resolvedCustomTrackLayouts.push({
                    height: track.height(store),
                    index,
                    track,
                });
            }
        }

        const trackLayers = new Array<JSX.Element | null>(tracks.length);
        for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
            const track = tracks[trackIndex];
            const isTrackVisible = visibleTrackRows
                ? true
                : !visibleTrackSet || visibleTrackSet.has(track.track.type);
            const y = nextY;

            nextY += isTrackVisible ? track.height : 0;

            if (isTrackVisible) {
                trackLayers[trackIndex] = (
                    <React.Fragment key={track.track.uid}>
                        <TimelineTrack
                            limit={store.trimmedLimit}
                            trackData={track.track}
                            getPosition={store.getPosition}
                            handleTrackHover={handleTrackHover}
                            hoverTrackIndex={trackIndex}
                            store={store}
                            y={y}
                            height={track.height}
                            width={width}
                        />
                        <TimelineTrackLegend
                            container={legendContainer}
                            y={y + 20}
                            track={track.track}
                        />
                    </React.Fragment>
                );
            } else {
                trackLayers[trackIndex] = null;
            }
        }

        const customTrackLayers = new Array<JSX.Element>(
            resolvedCustomTrackLayouts.length
        );
        for (let index = 0; index < resolvedCustomTrackLayouts.length; index += 1) {
            const { height, track } = resolvedCustomTrackLayouts[index];
            const y = nextY;
            nextY += height;
            customTrackLayers[index] = (
                <CustomTrack
                    key={getCustomTrackKey(track, index)}
                    hoverTrackIndex={tracks.length + index}
                    store={store}
                    specification={track}
                    trackHeight={height}
                    handleTrackHover={handleTrackHover}
                    width={width}
                    y={y}
                    disableHover={track.disableHover}
                />
            );
        }

        return (
            <g transform={`translate(0 ${TICK_AXIS_HEIGHT})`}>
                {trackLayers}
                {customTrackLayers}
            </g>
        );
    }
);

const TimelineTooltipLayers: React.FunctionComponent<{
    store: TimelineStore;
}> = observer(function({ store }) {
    const tooltipModels = store.tooltipModels;
    const browserOuterWidth = getBrowserWindow().outerWidth || 1;
    const tooltips = new Array<JSX.Element>(tooltipModels.length);

    for (let index = 0; index < tooltipModels.length; index += 1) {
        const [uid, model, tooltipIndex] = tooltipModels[index];
        const position = model.position || store.mousePosition;
        const placementLeft = position.x / browserOuterWidth > 0.5;
        tooltips[index] = (
            <Portal container={document.body} key={uid}>
                <Popover
                    onMouseEnter={() => {
                        store.setHoveredTooltipUid(uid);
                        store.pinTooltip(uid);
                    }}
                    onMouseLeave={() => {
                        store.removeTooltip(uid);
                    }}
                    arrowOffsetTop={17}
                    placement={placementLeft ? 'left' : 'right'}
                    style={{
                        transform: placementLeft ? 'translate(-100%, 0)' : '',
                        minWidth: 400,
                    }}
                    className={'tl-timeline-tooltip cbioTooltip'}
                    positionLeft={position.x + (placementLeft ? -3 : 3)}
                    positionTop={position.y - 17}
                >
                    {store.getTooltipContent(uid, model, tooltipIndex)}
                </Popover>
            </Portal>
        );
    }

    return <>{tooltips}</>;
});

export const TimelineTracks: React.FunctionComponent<ITimelineTracks> = function(
    props
) {
    return (
        <>
            <TimelineTrackLayers {...props} />
            <TimelineTooltipLayers store={props.store} />
        </>
    );
};

export default TimelineTracks;

export const TimelineTrackLegend: React.FC<{
    container?: Element | null;
    y: number;
    track: TimelineTrackSpecification;
}> = function({ container, y, track }) {
    if (!container) {
        return null;
    }

    let legendEl = <span className={'tl-tracklegend'}></span>;

    if (track.trackConf?.legend) {
        const legendRows = new Array<JSX.Element>(track.trackConf.legend.length);
        for (let index = 0; index < track.trackConf.legend.length; index += 1) {
            const item = track.trackConf.legend[index];
            legendRows[index] = (
                <tr key={`${item.label}-${item.color}`}>
                    <td>
                        <svg
                            viewBox="0 0 10 10"
                            height={8}
                            width={8}
                            xmlns="http://www.w3.org/2000/svg"
                        >
                            <circle
                                cx="5"
                                cy="5"
                                r="4"
                                fill={item.color}
                                stroke={'#000000'}
                            />
                        </svg>
                    </td>
                    <td>{item.label}</td>
                </tr>
            );
        }
        legendEl = (
            <div
                className={'positionAbsolute tl-tracklegend tl-displaynone'}
                style={{ top: y }}
            >
                <strong>Track Legend:</strong>
                <table>
                    <tbody>{legendRows}</tbody>
                </table>
            </div>
        );
    } else {
        // we need to have an element for the css selector stratetgy to work
        legendEl = (
            <div className={'positionAbsolute tl-tracklegend hidden'}></div>
        );
    }

    return ReactDOM.createPortal(legendEl, container);
};
