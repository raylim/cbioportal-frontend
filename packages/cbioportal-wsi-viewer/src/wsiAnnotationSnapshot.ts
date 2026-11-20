import { WsiAnnotationShape, WsiPoint } from './wsiAnnotationGeometryUtils';
import { POINT_MARKER_RADIUS } from './wsiAnnotationPointLayer';
import { SLIDE_LABEL_FONT_SIZE, WsiPlacedLabel } from './wsiAnnotationSpatial';

/**
 * Level-0 image pixels to the viewer's screen pixels, as the slide is shown
 * now: x' = a·x + c·y + e, y' = b·x + d·y + f (a canvas transform).
 */
export interface WsiScreenAffine {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

/** The annotations as they show on the slide, for the downloaded view. */
export interface WsiAnnotationScene {
    affine: WsiScreenAffine;
    /** Shapes other than points, in image pixels, bottom first. */
    shapes: Array<{ shape: WsiAnnotationShape; color: string }>;
    /** Points, in image pixels, drawn as fixed-size markers. */
    points: Array<WsiPoint & { color: string }>;
    /** Labels on the slide, in screen pixels (see `slideLabels`). */
    labels: WsiPlacedLabel[];
    /** The fill opacity of closed shapes, 0 to 1 (0 for outlines only). */
    fillOpacity: number;
    /** The font family of the labels on the slide. */
    fontFamily?: string;
    /** The quick ruler, in image pixels, with its reading. */
    ruler?: { start: WsiPoint; end: WsiPoint; text: string };
}

/** The quick ruler's line and halo colors, as on screen. */
export const RULER_COLOR = '#ffd400';
export const RULER_HALO = 'rgba(0,0,0,0.75)';
/** Half the length of the ticks across the ruler's ends, in screen pixels. */
export const RULER_TICK = 6;

/**
 * The ruler's ticks: across each end, perpendicular to the ruler, in
 * screen pixels.
 */
export function rulerTicks(
    a: WsiPoint,
    b: WsiPoint
): Array<[WsiPoint, WsiPoint]> {
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / length) * RULER_TICK;
    const ny = ((b.x - a.x) / length) * RULER_TICK;
    return [a, b].map(
        end =>
            [
                { x: end.x - nx, y: end.y - ny },
                { x: end.x + nx, y: end.y + ny },
            ] as [WsiPoint, WsiPoint]
    );
}

/** The outline width of shapes on the slide, in screen pixels. */
export const SHAPE_STROKE_WIDTH = 2;

/** Adds `shape` to the current path, in image pixels. */
function tracePath(
    context: CanvasRenderingContext2D,
    shape: WsiAnnotationShape
): boolean {
    switch (shape.kind) {
        case 'rectangle':
            context.rect(shape.x, shape.y, shape.width, shape.height);
            return true;
        case 'ellipse':
            context.ellipse(
                shape.cx,
                shape.cy,
                shape.rx,
                shape.ry,
                0,
                0,
                2 * Math.PI
            );
            return true;
        case 'multipolygon':
            shape.polygons.forEach(rings =>
                rings.forEach(ring => {
                    ring.forEach((point, index) =>
                        index
                            ? context.lineTo(point.x, point.y)
                            : context.moveTo(point.x, point.y)
                    );
                    context.closePath();
                })
            );
            return true;
        case 'polygon':
        case 'polyline':
        case 'line':
            shape.points.forEach((point, index) =>
                index
                    ? context.lineTo(point.x, point.y)
                    : context.moveTo(point.x, point.y)
            );
            if (shape.kind !== 'polygon') return false;
            context.closePath();
            return true;
        default:
            return false;
    }
}

/** A rectangle with rounded corners, as the slide's label band. */
function roundedRect(
    context: CanvasRenderingContext2D,
    { x, y, width, height }: WsiPlacedLabel,
    radius: number
) {
    const r = Math.min(radius, width / 2, height / 2);
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
}

/**
 * Draws `scene` onto a snapshot of the slide whose pixels are `scale` times
 * the viewer's screen pixels (the device pixel ratio for a canvas of the
 * viewer's size): shapes as Annotorious shows them, points as the point
 * layer does, then labels as the overlay does. Each shape is traced in
 * image pixels through the same image-to-screen mapping as the slide, so it
 * lands on the same tissue; outlines and markers keep their screen size.
 */
export function drawAnnotationScene(
    context: CanvasRenderingContext2D,
    scene: WsiAnnotationScene,
    scale: number
) {
    const { a, b, c, d, e, f } = scene.affine;
    const screen = (point: WsiPoint): WsiPoint => ({
        x: a * point.x + c * point.y + e,
        y: b * point.x + d * point.y + f,
    });
    context.save();
    context.lineJoin = 'round';
    for (const { shape, color } of scene.shapes) {
        context.setTransform(
            scale * a,
            scale * b,
            scale * c,
            scale * d,
            scale * e,
            scale * f
        );
        context.beginPath();
        const closed = tracePath(context, shape);
        // Filled and stroked in screen pixels: the path keeps the slide's
        // mapping, the line width does not.
        context.setTransform(scale, 0, 0, scale, 0, 0);
        if (closed && scene.fillOpacity > 0) {
            context.globalAlpha = scene.fillOpacity;
            context.fillStyle = color;
            // Holes are rings inside their part: even-odd leaves them empty.
            context.fill(shape.kind === 'multipolygon' ? 'evenodd' : 'nonzero');
        }
        context.globalAlpha = 1;
        context.strokeStyle = color;
        context.lineWidth = SHAPE_STROKE_WIDTH;
        context.stroke();
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.globalAlpha = 1;
    context.lineWidth = 1.5;
    context.strokeStyle = '#fff';
    for (const point of scene.points) {
        const { x, y } = screen(point);
        context.beginPath();
        context.arc(x, y, POINT_MARKER_RADIUS, 0, 2 * Math.PI);
        context.fillStyle = point.color;
        context.fill();
        context.stroke();
    }
    if (scene.ruler) {
        const a = screen(scene.ruler.start);
        const b = screen(scene.ruler.end);
        const segments: Array<[WsiPoint, WsiPoint]> = [
            [a, b],
            ...rulerTicks(a, b),
        ];
        context.lineCap = 'round';
        for (const [width, color] of [
            [4, RULER_HALO],
            [2, RULER_COLOR],
        ] as Array<[number, string]>) {
            context.beginPath();
            segments.forEach(([from, to]) => {
                context.moveTo(from.x, from.y);
                context.lineTo(to.x, to.y);
            });
            context.lineWidth = width;
            context.strokeStyle = color;
            context.stroke();
        }
        context.font = `600 12px ${scene.fontFamily || 'sans-serif'}`;
        context.textBaseline = 'alphabetic';
        context.lineWidth = 3;
        context.strokeStyle = RULER_HALO;
        context.fillStyle = '#fff';
        context.strokeText(scene.ruler.text, b.x + 12, b.y - 10);
        context.fillText(scene.ruler.text, b.x + 12, b.y - 10);
    }
    if (scene.labels.length) {
        context.font = `${SLIDE_LABEL_FONT_SIZE}px ${scene.fontFamily ||
            'sans-serif'}`;
        context.textBaseline = 'alphabetic';
        for (const label of scene.labels) {
            context.beginPath();
            roundedRect(context, label, 2);
            context.fillStyle = 'rgba(0,0,0,0.7)';
            context.fill();
            context.fillStyle = '#fff';
            context.fillText(
                label.text,
                label.x + 3,
                label.y + label.height - 4
            );
        }
    }
    context.restore();
}
