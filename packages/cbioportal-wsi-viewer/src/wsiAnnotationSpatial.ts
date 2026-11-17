import { WsiBounds } from './wsiAnnotationGeometryUtils';

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
