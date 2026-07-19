import * as React from 'react';
import { CustomTrackSpecification } from './CustomTrack';
import { TimelineStore } from './TimelineStore';
import classNames from 'classnames';

interface ICustomTrackHeaderProps {
    store: TimelineStore;
    specification: CustomTrackSpecification;
    trackHeight?: number;
    handleTrackHover: (e: React.MouseEvent<any>) => void;
    disableHover?: boolean;
    hoverTrackIndex?: number;
}

const CustomTrackHeader: React.FunctionComponent<ICustomTrackHeaderProps> = function({
    store,
    specification,
    trackHeight,
    handleTrackHover,
    disableHover,
    hoverTrackIndex,
}: ICustomTrackHeaderProps) {
    const resolvedTrackHeight = trackHeight ?? specification.height(store);

    return (
        <div
            data-track-index={hoverTrackIndex}
            className={classNames('tl-custom-track-header', {
                'tl-hover-disabled': disableHover,
            })}
            style={{ paddingLeft: 5, height: resolvedTrackHeight }}
            onMouseEnter={handleTrackHover}
            onMouseLeave={handleTrackHover}
        >
            {specification.renderHeader(store)}
        </div>
    );
};

export default CustomTrackHeader;
