import { TimelineStore } from './TimelineStore';
import * as React from 'react';
import { REMOVE_FOR_DOWNLOAD_CLASSNAME } from './lib/helpers';
import classNames from 'classnames';

export type CustomTrackSpecification = {
    uid?: string;
    renderHeader: (store: TimelineStore) => any; // any = react renderable, string or element or null or etc.
    renderTrack: (store: TimelineStore) => React.ReactElement<SVGGElement>;
    height: (store: TimelineStore) => number;
    labelForExport: string;
    disableHover?: boolean;
};

export interface ICustomTrackProps {
    store: TimelineStore;
    specification: CustomTrackSpecification;
    trackHeight?: number;
    width: number;
    y: number;
    handleTrackHover: (e: React.MouseEvent<any>) => void;
    disableHover?: boolean;
    hoverTrackIndex?: number;
}

const CustomTrack: React.FunctionComponent<ICustomTrackProps> = function({
    store,
    specification,
    trackHeight,
    width,
    y,
    handleTrackHover,
    disableHover,
    hoverTrackIndex,
}: ICustomTrackProps) {
    const resolvedTrackHeight = trackHeight ?? specification.height(store);

    return (
        <g
            data-track-index={hoverTrackIndex}
            className={classNames('tl-track', {
                'tl-hover-disabled': disableHover,
            })}
            transform={`translate(0 ${y})`}
            onMouseEnter={handleTrackHover}
            onMouseLeave={handleTrackHover}
        >
            <rect
                className={`tl-track-highlight ${REMOVE_FOR_DOWNLOAD_CLASSNAME}`}
                x={0}
                y={0}
                height={resolvedTrackHeight}
                width={width}
            />
            {specification.renderTrack(store)}
            <line
                x1={0}
                x2={width}
                y1={resolvedTrackHeight - 0.5}
                y2={resolvedTrackHeight - 0.5}
                stroke={'#eee'}
                strokeWidth={1}
                strokeDasharray={'3,2'}
            />
        </g>
    );
};

export default CustomTrack;
