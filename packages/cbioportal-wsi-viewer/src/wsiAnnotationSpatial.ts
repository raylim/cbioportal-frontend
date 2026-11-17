import {
    WsiAnnotationShape,
    WsiBounds,
    WsiPoint,
} from './wsiAnnotationGeometryUtils';

/** An item to order by where it is on the slide. */
export interface WsiSpatialItem {
    id: string;
    bounds: WsiBounds;
}

/** Above this many items `spatialOrder` uses bands instead of nearest-next. */
const NEAREST_NEXT_LIMIT = 3000;

function centre(bounds: WsiBounds) {
    return {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
    };
}

/**
 * The order to visit items in so that the view moves little: starting with
 * the item nearest the slide's top-left corner, each next item is the
 * nearest one not yet visited (by bounding-box centre). Each step is then
 * usually about one item away; only the last few items can be further
 * apart. Above `NEAREST_NEXT_LIMIT` items, the order is by horizontal bands
 * a typical item high, alternately left to right and right to left, which
 * also keeps steps short and costs only a sort.
 */
export function spatialOrder(items: WsiSpatialItem[]): string[] {
    if (items.length <= 1) return items.map(item => item.id);
    const centres = items.map(item => centre(item.bounds));
    if (items.length > NEAREST_NEXT_LIMIT) return bandOrder(items, centres);
    const left = items.map((_, index) => index);
    let at = left.reduce((best, index) =>
        centres[index].x + centres[index].y < centres[best].x + centres[best].y
            ? index
            : best
    );
    const order: string[] = [];
    while (left.length) {
        order.push(items[at].id);
        left.splice(left.indexOf(at), 1);
        if (!left.length) break;
        const from = centres[at];
        let best = left[0];
        let bestDistance = Infinity;
        for (const index of left) {
            const distance =
                (centres[index].x - from.x) ** 2 +
                (centres[index].y - from.y) ** 2;
            if (distance < bestDistance) {
                best = index;
                bestDistance = distance;
            }
        }
        at = best;
    }
    return order;
}

function bandOrder(
    items: WsiSpatialItem[],
    centres: Array<{ x: number; y: number }>
): string[] {
    const heights = items
        .map(item => item.bounds.maxY - item.bounds.minY)
        .sort((a, b) => a - b);
    const band = Math.max(heights[Math.floor(heights.length / 2)] * 2, 1);
    const rows = centres.map(point => Math.floor(point.y / band));
    // Alternate by the bands that have items, so empty bands do not count.
    const rank = new Map(
        Array.from(new Set(rows))
            .sort((a, b) => a - b)
            .map((row, index) => [row, index])
    );
    return items
        .map((item, index) => ({
            id: item.id,
            row: rank.get(rows[index])!,
            x: centres[index].x,
        }))
        .sort((a, b) =>
            a.row !== b.row ? a.row - b.row : a.row % 2 ? b.x - a.x : a.x - b.x
        )
        .map(item => item.id);
}

/** A box on screen, in pixels over the slide. */
export interface WsiScreenBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A label to place on the slide, at the top-left of its shape's box. */
export interface WsiLabelCandidate {
    id: string;
    text: string;
    box: WsiScreenBox;
}

export interface WsiPlacedLabel {
    id: string;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Label text size on the slide, in pixels. */
export const SLIDE_LABEL_FONT_SIZE = 11;
/** Shapes smaller than this on screen (both sides) get no label. */
export const SLIDE_LABEL_MIN_SHAPE = 24;
/** The most labels shown at once. */
export const SLIDE_LABEL_LIMIT = 150;
const LABEL_MAX_CHARS = 40;
const LABEL_HEIGHT = SLIDE_LABEL_FONT_SIZE + 4;
/** An estimate of the width of one character of label text. */
const LABEL_CHAR_WIDTH = SLIDE_LABEL_FONT_SIZE * 0.6;

function overlaps(a: WsiScreenBox, b: WsiScreenBox) {
    return (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
    );
}

/**
 * Places labels on the slide: one at the top-left of each shape's box on
 * screen, for shapes at least `SLIDE_LABEL_MIN_SHAPE` pixels on a side and
 * inside `view`. Larger shapes go first; a label that would overlap one
 * already placed is left out, and at most `SLIDE_LABEL_LIMIT` show.
 */
export function placeSlideLabels(
    candidates: WsiLabelCandidate[],
    view: { width: number; height: number } | null
): WsiPlacedLabel[] {
    const placed: WsiPlacedLabel[] = [];
    const sorted = candidates
        .filter(
            candidate =>
                candidate.text.trim() &&
                (candidate.box.width >= SLIDE_LABEL_MIN_SHAPE ||
                    candidate.box.height >= SLIDE_LABEL_MIN_SHAPE) &&
                (!view ||
                    overlaps(candidate.box, {
                        x: 0,
                        y: 0,
                        width: view.width,
                        height: view.height,
                    }))
        )
        .sort(
            (a, b) =>
                b.box.width * b.box.height - a.box.width * a.box.height ||
                a.id.localeCompare(b.id)
        );
    for (const candidate of sorted) {
        if (placed.length >= SLIDE_LABEL_LIMIT) break;
        const raw = candidate.text.trim();
        const text =
            raw.length > LABEL_MAX_CHARS
                ? `${raw.slice(0, LABEL_MAX_CHARS - 1)}…`
                : raw;
        const label: WsiPlacedLabel = {
            id: candidate.id,
            text,
            // Inside the shape's top-left corner, but on screen.
            x: Math.max(candidate.box.x + 2, 2),
            y: Math.max(candidate.box.y + 2, 2),
            width: text.length * LABEL_CHAR_WIDTH + 6,
            height: LABEL_HEIGHT,
        };
        if (!placed.some(other => overlaps(label, other))) placed.push(label);
    }
    return placed;
}

/** Whether box `inner` lies inside box `outer`. */
export function boundsInside(inner: WsiBounds, outer: WsiBounds): boolean {
    return (
        inner.minX >= outer.minX &&
        inner.maxX <= outer.maxX &&
        inner.minY >= outer.minY &&
        inner.maxY <= outer.maxY
    );
}

function distanceToSegment(p: WsiPoint, a: WsiPoint, b: WsiPoint): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length
        ? Math.max(
              0,
              Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)
          )
        : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insidePolygon(p: WsiPoint, points: WsiPoint[]): boolean {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i];
        const b = points[j];
        if (
            a.y > p.y !== b.y > p.y &&
            p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
        ) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Whether `point` (image pixels) is on `shape`: inside an area, or within
 * `tolerance` image pixels of a line or point.
 */
export function shapeContainsPoint(
    shape: WsiAnnotationShape,
    point: WsiPoint,
    tolerance: number
): boolean {
    switch (shape.kind) {
        case 'rectangle':
            return (
                point.x >= shape.x - tolerance &&
                point.x <= shape.x + shape.width + tolerance &&
                point.y >= shape.y - tolerance &&
                point.y <= shape.y + shape.height + tolerance
            );
        case 'ellipse': {
            const rx = shape.rx + tolerance;
            const ry = shape.ry + tolerance;
            return (
                ((point.x - shape.cx) / rx) ** 2 +
                    ((point.y - shape.cy) / ry) ** 2 <=
                1
            );
        }
        case 'point':
            return (
                Math.hypot(point.x - shape.x, point.y - shape.y) <= tolerance
            );
        case 'polygon':
            return (
                insidePolygon(point, shape.points) ||
                shape.points.some(
                    (a, i) =>
                        distanceToSegment(
                            point,
                            a,
                            shape.points[(i + 1) % shape.points.length]
                        ) <= tolerance
                )
            );
        default:
            return shape.points.some(
                (a, i) =>
                    i + 1 < shape.points.length &&
                    distanceToSegment(point, a, shape.points[i + 1]) <=
                        tolerance
            );
    }
}

/** Runs `task` on each item, at most `limit` at a time; results in order. */
export async function runLimited<T, R>(
    items: T[],
    limit: number,
    task: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index]);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, worker)
    );
    return results;
}
