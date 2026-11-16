import { WsiPoint } from './wsiAnnotationGeometryUtils';

/** A point annotation as the point layer draws it. */
export interface WsiPointMarker {
    id: string;
    x: number;
    y: number;
    color: string;
}

/** Marker radius in screen pixels, the same at every zoom. */
export const POINT_MARKER_RADIUS = 5;

const REDRAW_EVENTS = ['update-viewport', 'resize', 'open', 'rotate', 'flip'];

/**
 * Draws point annotations on a canvas over the OpenSeadragon viewer, as
 * fixed-size markers. Annotorious has no point shape and would draw a
 * point as a zero-size circle; one canvas redrawn per frame stays fast with
 * hundreds of points. The canvas ignores the pointer.
 */
export class WsiPointLayer {
    private readonly canvas: HTMLCanvasElement;
    private markers: WsiPointMarker[] = [];
    private visible = true;
    private frame: number | null = null;

    constructor(private readonly viewer: any, private readonly osd: any) {
        this.canvas = document.createElement('canvas');
        this.canvas.setAttribute('data-testid', 'wsi-annotation-points');
        this.canvas.setAttribute('aria-hidden', 'true');
        Object.assign(this.canvas.style, {
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '2',
        });
        (viewer.canvas || viewer.element)?.appendChild(this.canvas);
        REDRAW_EVENTS.forEach(event =>
            viewer.addHandler?.(event, this.requestDraw)
        );
    }

    setMarkers(markers: WsiPointMarker[]) {
        this.markers = markers;
        this.requestDraw();
    }

    setVisible(visible: boolean) {
        this.visible = visible;
        this.requestDraw();
    }

    /**
     * The marker within `tolerance` screen pixels of `position` (viewer
     * element coordinates), the nearest first.
     */
    hitTest(position: WsiPoint, tolerance = POINT_MARKER_RADIUS + 3) {
        const transform = this.transform();
        if (!transform || !this.visible) return null;
        let best: WsiPointMarker | null = null;
        let bestDistance = tolerance;
        for (const marker of this.markers) {
            const screen = transform(marker);
            const distance = Math.hypot(
                screen.x - position.x,
                screen.y - position.y
            );
            if (distance <= bestDistance) {
                best = marker;
                bestDistance = distance;
            }
        }
        return best;
    }

    destroy() {
        if (this.frame !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this.frame);
        }
        this.frame = null;
        REDRAW_EVENTS.forEach(event =>
            this.viewer.removeHandler?.(event, this.requestDraw)
        );
        this.canvas.remove();
    }

    private readonly requestDraw = () => {
        if (this.frame !== null) return;
        if (typeof requestAnimationFrame !== 'function') {
            this.draw();
            return;
        }
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            this.draw();
        });
    };

    /**
     * Image pixels to viewer element pixels. The viewport's mapping is
     * affine, so three mapped points give it for every marker in a frame.
     */
    private transform(): ((point: WsiPoint) => WsiPoint) | null {
        const viewport = this.viewer?.viewport;
        if (!viewport?.imageToViewerElementCoordinates || !this.osd?.Point) {
            return null;
        }
        const map = (x: number, y: number): WsiPoint =>
            viewport.imageToViewerElementCoordinates(new this.osd.Point(x, y));
        const unit = 1000;
        const origin = map(0, 0);
        const xAxis = map(unit, 0);
        const yAxis = map(0, unit);
        const ax = (xAxis.x - origin.x) / unit;
        const ay = (xAxis.y - origin.y) / unit;
        const bx = (yAxis.x - origin.x) / unit;
        const by = (yAxis.y - origin.y) / unit;
        return point => ({
            x: origin.x + ax * point.x + bx * point.y,
            y: origin.y + ay * point.x + by * point.y,
        });
    }

    private draw() {
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        const ratio =
            (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        if (
            this.canvas.width !== Math.round(width * ratio) ||
            this.canvas.height !== Math.round(height * ratio)
        ) {
            this.canvas.width = Math.round(width * ratio);
            this.canvas.height = Math.round(height * ratio);
        }
        const context = this.canvas.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        const transform = this.transform();
        if (!transform || !this.visible) return;
        context.lineWidth = 1.5;
        context.strokeStyle = '#fff';
        for (const marker of this.markers) {
            const { x, y } = transform(marker);
            if (
                x < -POINT_MARKER_RADIUS ||
                y < -POINT_MARKER_RADIUS ||
                x > width + POINT_MARKER_RADIUS ||
                y > height + POINT_MARKER_RADIUS
            ) {
                continue;
            }
            context.beginPath();
            context.arc(x, y, POINT_MARKER_RADIUS, 0, 2 * Math.PI);
            context.fillStyle = marker.color;
            context.fill();
            context.stroke();
        }
    }
}
