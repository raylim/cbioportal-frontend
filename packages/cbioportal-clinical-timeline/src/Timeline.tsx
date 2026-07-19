import React, {
    MutableRefObject,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import { observer } from 'mobx-react-lite';
import TimelineTracks, {
    CustomTrackLayout,
    getCustomTrackKey,
    TimelineTrackRow,
} from './TimelineTracks';
import { TimelineStore } from './TimelineStore';
import jQuery from 'jquery';
import {
    flattenTracks,
    getPointInTrimmedSpaceFromScreenRead,
    REMOVE_FOR_DOWNLOAD_CLASSNAME,
} from './lib/helpers';
import intersect from './lib/intersect';
import TrackHeader, {
    EXPORT_TRACK_HEADER_BORDER_CLASSNAME,
    getTrackHeadersG,
} from './TrackHeader';
import TickAxis, { TICK_AXIS_COLOR, TICK_AXIS_HEIGHT } from './TickAxis';
import {
    EventPosition,
    TickIntervalEnum,
    TimelineTrackSpecification,
    ZoomBounds,
} from './types';
import './timeline.scss';
import { DownloadControls } from 'cbioportal-frontend-commons';
import CustomTrack, { CustomTrackSpecification } from './CustomTrack';
import CustomTrackHeader from './CustomTrackHeader';

import classNames from 'classnames';
import getSvg from './svg/getSvg';

interface ITimelineProps {
    store: TimelineStore;
    onClickDownload: () => void;
    customTracks?: CustomTrackSpecification[];
    width: number;
    hideLabels?: boolean;
    visibleTracks?: string[];
    hideXAxis?: boolean;
    disableZoom?: boolean;
    headerWidth?: number;
}

type VisibleTrackLayout = {
    filteredTracks: TimelineTrackRow[];
    totalHeight: number;
};

type CustomTrackLayoutSummary = {
    layouts: CustomTrackLayout[];
    totalHeight: number;
};

type CachedVisibleTrackLayoutEntry = {
    layout: VisibleTrackLayout;
    tracksSignature: string;
};

const visibleTrackLayoutCache = new WeakMap<
    TimelineTrackRow[],
    Map<string, CachedVisibleTrackLayoutEntry>
>();
const hoverStyleTextCache = new Map<string, Map<number, string>>();

function buildVisibleTracksSignature(visibleTracks?: string[]): string {
    if (!visibleTracks?.length) {
        return '__all__';
    }

    const orderedVisibleTracks = visibleTracks.slice();
    orderedVisibleTracks.sort((left, right) => left.localeCompare(right));

    let signature = '';
    for (let index = 0; index < orderedVisibleTracks.length; index += 1) {
        if (index > 0) {
            signature += '|';
        }
        signature += orderedVisibleTracks[index];
    }

    return signature;
}

function buildFlattenedTrackRowsSignature(
    tracks: TimelineTrackRow[]
): string {
    let signature = '';

    for (let index = 0; index < tracks.length; index += 1) {
        const row = tracks[index];
        if (index > 0) {
            signature += '||';
        }
        signature += `${row.track.uid || row.track.type}:${row.track.type}:${row.indent}:${row.height}`;
    }

    return signature;
}

export function getVisibleTrackLayout(
    tracks: TimelineTrackRow[],
    visibleTracks?: string[]
): VisibleTrackLayout {
    const visibleTracksSignature = buildVisibleTracksSignature(visibleTracks);
    const tracksSignature = buildFlattenedTrackRowsSignature(tracks);
    const cachedLayouts = visibleTrackLayoutCache.get(tracks);
    const cached = cachedLayouts?.get(visibleTracksSignature);

    if (cached && cached.tracksSignature === tracksSignature) {
        return cached.layout;
    }

    const filteredTracks: TimelineTrackRow[] = [];
    let totalHeight = 0;
    const visibleTrackSet = visibleTracks
        ? new Set<string>(visibleTracks)
        : undefined;

    for (let index = 0; index < tracks.length; index += 1) {
        const row = tracks[index];
        const isVisible =
            !visibleTrackSet || visibleTrackSet.has(row.track.type);

        if (isVisible) {
            filteredTracks.push(row);
            totalHeight += row.height;
        }
    }

    const layout = {
        filteredTracks,
        totalHeight,
    };
    const nextCachedLayouts = cachedLayouts || new Map();
    nextCachedLayouts.set(visibleTracksSignature, {
        layout,
        tracksSignature,
    });
    visibleTrackLayoutCache.set(tracks, nextCachedLayouts);

    return layout;
}

export function getCustomTrackLayoutSummary(
    customTracks: CustomTrackSpecification[] | undefined,
    store: TimelineStore
): CustomTrackLayoutSummary {
    if (!customTracks?.length) {
        return {
            layouts: [],
            totalHeight: 0,
        };
    }

    const layouts: CustomTrackLayout[] = [];
    let totalHeight = 0;

    for (let index = 0; index < customTracks.length; index += 1) {
        const track = customTracks[index];
        const height = track.height(store);
        layouts.push({
            height,
            index,
            track,
        });
        totalHeight += height;
    }

    return {
        layouts,
        totalHeight,
    };
}

export function getHoverTrackIndex(
    currentTarget: EventTarget & Element
): number | undefined {
    const datasetIndex = currentTarget.getAttribute('data-track-index');
    if (datasetIndex !== null) {
        const parsed = Number(datasetIndex);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    const parent = currentTarget.parentNode;
    if (!parent) {
        return undefined;
    }

    for (let index = 0; index < parent.children.length; index += 1) {
        if (parent.children[index] === currentTarget) {
            return index;
        }
    }

    return undefined;
}

export function getHoverStyleText(uniqueId: string, trackIndex: number): string {
    let cachedByTrackIndex = hoverStyleTextCache.get(uniqueId);

    if (!cachedByTrackIndex) {
        cachedByTrackIndex = new Map();
        hoverStyleTextCache.set(uniqueId, cachedByTrackIndex);
    }

    const cached = cachedByTrackIndex.get(trackIndex);
    if (cached) {
        return cached;
    }

    const nextStyleText = `
                    #${uniqueId} .tl-timeline-tracklabels > div:nth-child(${trackIndex +
                        1}) {
                        background:#F2F2F2;
                    }
                    
                     #${uniqueId} .tl-timeline .tl-track:nth-child(${trackIndex +
                        1}) .tl-track-highlight {
                        opacity: 1 !important;
                     }
                     
                     #${uniqueId} .tl-tracklegend:nth-of-type(${trackIndex +
                        1}) {
                        display:block !important;
                     }
                     
                `;
    cachedByTrackIndex.set(trackIndex, nextStyleText);
    return nextStyleText;
}

type ResizeObserverLike = {
    observe: (target: Element) => void;
    disconnect: () => void;
};

function handleMouseEvents(
    e: any,
    store: TimelineStore,
    refs: any,
    zoomDisabled: boolean = false
) {
    const $timeline = jQuery(refs.timeline.current);
    const $zoomSelectBox = jQuery(refs.zoomSelectBox.current);
    const $zoomSelectBoxMask = jQuery(refs.zoomSelectBoxMask.current);

    switch (e.type) {
        case 'mouseleave':
            jQuery(refs.cursor.current).hide();
            break;

        case 'mouseup':
            if (store.dragging) {
                if (
                    !!store.dragging.start &&
                    !!store.dragging.end &&
                    Math.abs(store.dragging.start! - store.dragging.end!) > 10
                ) {
                    const width = $timeline.width()!;
                    const percStart = store.dragging.start! / width;
                    const percEnd = store.dragging.end! / width;
                    const startVal = percStart * store.absoluteWidth;
                    const endVal = percEnd * store.absoluteWidth;
                    const myStart = getPointInTrimmedSpaceFromScreenRead(
                        startVal,
                        store.ticks
                    );
                    const myEnd = getPointInTrimmedSpaceFromScreenRead(
                        endVal,
                        store.ticks
                    );

                    if (myStart <= myEnd) {
                        store.setZoomBounds(myStart, myEnd);
                    } else {
                        store.setZoomBounds(myEnd, myStart);
                    }

                    setTimeout(() => {
                        setScroll(
                            store.zoomBounds,
                            refs.timelineViewPort.current,
                            store.getTickPosition
                        );
                    }, 10);
                }

                store.dragging = undefined;

                $zoomSelectBoxMask.hide();
                $zoomSelectBox.hide();
            }

            store.dragging = undefined;
            break;
        case 'mousedown':
            if (!zoomDisabled) {
                store.dragging = { start: null, end: null };
            }
            break;

        case 'mousemove':
            const pos =
                e.clientX -
                $timeline.offset()!.left +
                (jQuery(document).scrollLeft() || 0);
            if (store.dragging) {
                e.preventDefault();
                if (store.dragging.start === null) {
                    store.dragging.start = pos;
                }
                store.dragging.end = pos;

                $zoomSelectBoxMask.show();
                $zoomSelectBox.show().css({
                    left:
                        store.dragging.start < store.dragging.end
                            ? store.dragging.start
                            : store.dragging.end,
                    width: Math.abs(store.dragging.end - store.dragging.start),
                });
            } else {
                // if zooming is enabled and we're not dragging, show the zoom cursor
                if (!zoomDisabled) {
                    jQuery(refs.cursor.current).css({
                        left:
                            e.clientX -
                            $timeline.offset()!.left +
                            (jQuery(document).scrollLeft() || 0),
                        display: 'block',
                    });
                }
            }
            break;
    }
}

const hoverCallback = (
    e: React.MouseEvent<Element, MouseEvent>,
    styleTag: MutableRefObject<null>,
    uniqueId: string
) => {
    // this is pretty hacky but turns out to be fastest way to handle hover behavior
    // creating very smooth response as user moves mouse across timeline
    if (styleTag && styleTag.current) {
        switch (e.type) {
            case 'mouseenter':
                const trackIndex = getHoverTrackIndex(e.currentTarget);
                if (trackIndex !== undefined) {
                    jQuery(styleTag.current!).text(
                        getHoverStyleText(uniqueId, trackIndex)
                    );
                }
                break;
            default:
                // when mouse is moving INTO the tooltip, we do not want to abide the
                // mouseleave event. we treat it as if it's part of the track element
                if (
                    e.type === 'mouseleave' &&
                    (e?.relatedTarget as Element).getAttribute('class') ===
                        'arrow'
                ) {
                    break;
                } else {
                    // get rid of the above created inline style
                    jQuery(styleTag.current!).empty();
                }
                break;
        }
    }
};

function bindToDOMEvents(
    store: TimelineStore,
    refs: any,
    bindWindowResize: boolean
) {
    const keydown = function(e: JQuery.Event) {
        let preventDefault = false;
        switch (e.which) {
            case 37:
            //left
            case 40:
                //down
                if (store.prevTooltipEvent()) {
                    preventDefault = true;
                }
                break;
            case 38:
            //up
            case 39:
            //right
            case 32:
                //spacebar
                if (store.nextTooltipEvent()) {
                    preventDefault = true;
                }
                break;
            case 27:
                // escape
                store.removeAllTooltips();
                preventDefault = true;
                break;
        }
        if (preventDefault) {
            e.preventDefault();
        }
    };

    jQuery(document).on('keydown', keydown as any);

    const resize = function() {
        const nextViewPortWidth = getElementWidth(refs.timelineViewPort.current);
        if (
            nextViewPortWidth > 0 &&
            nextViewPortWidth !== store.viewPortWidth
        ) {
            store.viewPortWidth = nextViewPortWidth;
        }
    };
    if (bindWindowResize) {
        jQuery(window).on('resize', resize);
    }

    const mouseleave = function() {
        store.removeAllTooltips();
    };
    jQuery('body').on('mouseleave', mouseleave);

    return function() {
        if (bindWindowResize) {
            jQuery(window).off('resize', resize);
        }
        jQuery('body').off('mouseleave', mouseleave);
        jQuery(document).off('keydown', keydown);
    };
}

function getElementWidth(el: Element | null) {
    if (!el) {
        return 0;
    }

    const rectWidth = el.getBoundingClientRect().width;
    if (rectWidth > 0) {
        return rectWidth;
    }

    const clientWidth = (el as HTMLElement).clientWidth;
    if (clientWidth > 0) {
        return clientWidth;
    }

    return jQuery(el).width() || 0;
}

export function setScroll(
    zoomBounds: ZoomBounds | undefined,
    el: HTMLDivElement,
    getTickPosition: (start: number) => EventPosition | undefined
) {
    let pixelLeft = 0;

    if (zoomBounds) {
        const trimmedPos = getTickPosition(zoomBounds.start);

        if (trimmedPos) {
            pixelLeft = trimmedPos.pixelLeft;
        }
    }
    el.scrollLeft = pixelLeft;
}

const Timeline: React.FunctionComponent<ITimelineProps> = observer(function({
    store,
    customTracks,
    width,
    hideLabels = false,
    onClickDownload,
    visibleTracks,
    hideXAxis,
    headerWidth,
    disableZoom,
}: ITimelineProps) {
    const tracks = store.data;
    const SCROLLBAR_PADDING = 15;
    const { filteredTracks, totalHeight: visibleTrackHeight } =
        getVisibleTrackLayout(tracks, visibleTracks);
    const {
        layouts: customTrackLayouts,
        totalHeight: customTrackHeight,
    } = getCustomTrackLayoutSummary(customTracks, store);
    let height =
        TICK_AXIS_HEIGHT +
        visibleTrackHeight +
        customTrackHeight +
        SCROLLBAR_PADDING;

    const refs = {
        cursor: useRef(null),
        wrapper: useRef(null),
        timeline: useRef<SVGSVGElement>(null),
        timelineTracksArea: useRef<SVGGElement>(null),
        timelineHeadersArea: useRef(null),
        zoomSelectBox: useRef(null),
        zoomSelectBoxMask: useRef(null),
        cursorText: useRef(null),
        hoverStyleTag: useRef(null),
        timelineViewPort: useRef(null),
        scrollPanel: useRef(null),
    };

    const memoizedHoverCallback = useCallback(
        (e: React.MouseEvent) => {
            hoverCallback(e, refs.hoverStyleTag, store.uniqueId);
        },
        [refs.hoverStyleTag]
    );

    const measureViewport = useCallback(() => {
        const nextViewPortWidth = getElementWidth(refs.timelineViewPort.current);
        const nextHeadersWidth = getElementWidth(refs.timelineHeadersArea.current);

        if (
            nextViewPortWidth > 0 &&
            nextViewPortWidth !== store.viewPortWidth
        ) {
            store.viewPortWidth = nextViewPortWidth;
        }

        if (nextHeadersWidth > store.headersWidth) {
            // Keep the largest measured width so collapsing rows never
            // shrinks the label column after the first stable layout.
            store.headersWidth = nextHeadersWidth;
        }

        return nextViewPortWidth;
    }, [store]);

    // on mount, there will be no element to measure, so we need to do this on equivalent
    // of componentDidMount
    useEffect(() => {
        let cancelled = false;
        const timers: number[] = [];
        let resizeObserver: ResizeObserverLike | undefined;
        const ResizeObserverCtor = (window as Window & {
            ResizeObserver?: new (
                callback: (...args: any[]) => void
            ) => ResizeObserverLike;
        }).ResizeObserver;

        const scheduleMeasurement = (attempt: number) => {
            const timer = window.setTimeout(() => {
                if (cancelled) {
                    return;
                }

                const nextViewPortWidth = measureViewport();
                if (nextViewPortWidth > 0 || attempt >= 10) {
                    return;
                }

                scheduleMeasurement(attempt + 1);
            }, attempt === 0 ? 200 : 100);

            timers.push(timer);
        };

        scheduleMeasurement(0);

        if (ResizeObserverCtor) {
            resizeObserver = new ResizeObserverCtor(() => {
                measureViewport();
            });

            if (refs.timelineViewPort.current) {
                resizeObserver.observe(
                    refs.timelineViewPort.current as unknown as Element
                );
            }
            if (refs.timelineHeadersArea.current) {
                resizeObserver.observe(
                    refs.timelineHeadersArea.current as unknown as Element
                );
            }
        }

        const cleanupDomEvents = bindToDOMEvents(
            store,
            refs,
            !ResizeObserverCtor
        );

        return function cleanup() {
            cancelled = true;
            timers.forEach(timer => window.clearTimeout(timer));
            resizeObserver?.disconnect();
            cleanupDomEvents();
        };
    }, [measureViewport, store]);

    useEffect(() => {
        measureViewport();
    }, [measureViewport, width]);

    let myZoom = 1;
    if (store.zoomRange && store.zoomedWidth) {
        myZoom = store.absoluteWidth / store.zoomedWidth;
    }

    const renderWidth = store.viewPortWidth ? store.viewPortWidth * myZoom : 0;
    const trackHeaders = new Array<JSX.Element>(filteredTracks.length);
    for (let index = 0; index < filteredTracks.length; index += 1) {
        const track = filteredTracks[index];
        trackHeaders[index] = (
            <TrackHeader
                key={track.track.uid}
                store={store}
                track={track.track}
                height={track.height}
                hoverTrackIndex={index}
                paddingLeft={track.indent}
                handleTrackHover={memoizedHoverCallback}
            />
        );
    }
    const customTrackHeaders = new Array<JSX.Element>(customTrackLayouts.length);
    for (let index = 0; index < customTrackLayouts.length; index += 1) {
        const { height, track } = customTrackLayouts[index];
        customTrackHeaders[index] = (
            <CustomTrackHeader
                key={getCustomTrackKey(track, index)}
                store={store}
                specification={track}
                trackHeight={height}
                hoverTrackIndex={filteredTracks.length + index}
                handleTrackHover={memoizedHoverCallback}
                disableHover={track.disableHover}
            />
        );
    }

    return (
        <div
            ref={refs.wrapper}
            className={'tl-timeline-wrapper'}
            id={store.uniqueId}
        >
            <div className={'tl-timeline-reset-buttons'}>
                <div className={'tl-timeline-zoom-info'}>
                    {store.zoomBounds && (
                        <button
                            className={'btn btn-xs'}
                            onClick={() => {
                                store.setZoomBounds();
                            }}
                        >
                            <i className={'fa fa-search-minus'} /> reset zoom
                        </button>
                    )}

                    {!store.zoomBounds && disableZoom !== true && (
                        <span
                            onClick={() => {
                                store.setZoomBounds();
                            }}
                        >
                            <i className={'fa fa-search-plus'} /> drag to zoom
                        </span>
                    )}
                </div>

                {store.expandedTrims && (
                    <div>
                        <button
                            className={'btn btn-xs'}
                            onClick={store.toggleExpandedTrims}
                        >
                            reset axis
                        </button>
                    </div>
                )}
            </div>
            <style ref={refs.hoverStyleTag} />
            <div style={{ flexBasis: width - 28, display: 'flex' }}>
                {' '}
                {/* -20 for room for download controls*/}
                <div
                    className={'tl-timeline-leftbar'}
                    style={{ paddingTop: TICK_AXIS_HEIGHT, flexShrink: 0 }}
                >
                    <div
                        ref={refs.timelineHeadersArea}
                        className={classNames('tl-timeline-tracklabels', {
                            'tl-displaynone': hideLabels,
                        })}
                        style={{
                            width: headerWidth || 'auto',
                            minWidth: headerWidth || store.headersWidth,
                        }}
                    >
                        {trackHeaders}
                        {customTrackHeaders}
                    </div>
                </div>
                <div
                    className={'tl-viewport-pseudo-border'}
                    style={{ height: height - SCROLLBAR_PADDING }}
                />
                <div
                    ref={refs.timelineViewPort}
                    className={'tl-timelineviewport scrollbarAlwaysVisible'}
                    style={{ flexShrink: 1, height }}
                >
                    {store.viewPortWidth > 0 && store.ticks && (
                        <div
                            className={'tl-timeline'}
                            onMouseDown={e =>
                                handleMouseEvents(e, store, refs, disableZoom)
                            }
                            onMouseUp={e =>
                                handleMouseEvents(e, store, refs, disableZoom)
                            }
                            onMouseMove={e =>
                                handleMouseEvents(e, store, refs, disableZoom)
                            }
                            onMouseLeave={e =>
                                handleMouseEvents(e, store, refs, disableZoom)
                            }
                        >
                            <div
                                ref={refs.cursor}
                                style={{ height: height - SCROLLBAR_PADDING }}
                                className={'tl-cursor'}
                            >
                                <div ref={refs.cursorText} />
                            </div>
                            <div
                                ref={refs.zoomSelectBoxMask}
                                className={'tl-zoom-selectbox-mask'}
                            />
                            <div
                                ref={refs.zoomSelectBox}
                                style={{ height: height - SCROLLBAR_PADDING }}
                                className={'tl-zoom-selectbox'}
                            />

                            <svg
                                ref={refs.timeline}
                                width={renderWidth}
                                height={height}
                                className={'tl-timeline-svg'}
                            >
                                <g ref={refs.timelineTracksArea}>
                                    <TimelineTracks
                                        store={store}
                                        width={renderWidth}
                                        customTracks={customTracks}
                                        customTrackLayouts={
                                            customTrackLayouts
                                        }
                                        handleTrackHover={memoizedHoverCallback}
                                        legendContainer={
                                            refs.timelineViewPort.current
                                        }
                                        visibleTracks={visibleTracks}
                                        visibleTrackRows={filteredTracks}
                                    />
                                    {hideXAxis !== true && (
                                        <TickAxis
                                            store={store}
                                            width={renderWidth}
                                        />
                                    )}
                                    {/*TickAxis needs to go on top so its not covered by tracks*/}
                                </g>
                            </svg>
                        </div>
                    )}
                </div>
                <div
                    className={'tl-viewport-pseudo-border'}
                    style={{ height: height - SCROLLBAR_PADDING }}
                />
                <DownloadControls
                    buttons={['PDF', 'PNG', 'SVG']}
                    filename="timeline"
                    getSvg={() =>
                        getSvg(
                            store,
                            refs.timelineTracksArea.current,
                            customTracks,
                            customTrackLayouts,
                            visibleTracks
                        )
                    }
                    additionalRightButtons={[
                        {
                            key: 'Data (ZIP)',
                            content: <span>Data (ZIP)</span>,
                            onClick: onClickDownload,
                        },
                    ]}
                    dontFade={true}
                    type={'button'}
                    style={{ marginLeft: 7 }}
                />
            </div>
        </div>
    );
});

export default Timeline;
