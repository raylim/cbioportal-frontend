import * as React from 'react';
import { observer } from 'mobx-react';
import { WsiAnnotationController } from './wsiAnnotationController';
import { WsiScreenBox } from './wsiAnnotationSpatial';

/** Space between a shape and its highlight, in screen pixels. */
const HIGHLIGHT_PADDING = 6;
/** The smallest highlight, e.g. around a point. */
const HIGHLIGHT_MIN = 20;

function padded(box: WsiScreenBox, padding: number, min: number) {
    const width = Math.max(box.width + 2 * padding, min);
    const height = Math.max(box.height + 2 * padding, min);
    return {
        x: box.x + box.width / 2 - width / 2,
        y: box.y + box.height / 2 - height / 2,
        width,
        height,
    };
}

/**
 * Drawn over the slide, in screen pixels, following it as it moves: the
 * highlight of the focused annotation (under review, stepped to, or opened
 * by a link). It ignores the pointer, and is not part of exports or of the
 * downloaded view, which draw the slide's canvas only.
 */
export const WsiAnnotationOverlay = observer(
    ({ controller }: { controller: WsiAnnotationController }) => {
        const focused = controller.focusedBox;
        if (!focused) return null;
        const box = padded(focused, HIGHLIGHT_PADDING, HIGHLIGHT_MIN);
        return (
            <svg
                data-testid="annotation-overlay"
                aria-hidden="true"
                style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    overflow: 'hidden',
                    zIndex: 18,
                }}
            >
                <g data-testid="annotation-focus-highlight">
                    <rect
                        {...box}
                        rx={3}
                        fill="none"
                        stroke="rgba(0,0,0,0.7)"
                        strokeWidth={4}
                    />
                    <rect
                        {...box}
                        rx={3}
                        fill="none"
                        stroke="#ffd400"
                        strokeWidth={2}
                        strokeDasharray="6 4"
                    />
                </g>
            </svg>
        );
    }
);
