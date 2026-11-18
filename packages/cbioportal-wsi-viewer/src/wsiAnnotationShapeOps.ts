import polygonClipping, { MultiPolygon, Ring } from 'polygon-clipping';
import {
    polygonArea,
    WsiBounds,
    WsiPoint,
    WsiRegion,
} from './wsiAnnotationGeometryUtils';

/**
 * Boolean operations on regions (image pixels), with polygon-clipping
 * (Martinez–Rueda–Feito sweep line, MIT): union, difference, intersection,
 * and splitting a region by a line. Results are regions: each polygon its
 * outer ring then its holes, rings without a repeated last point. Pieces
 * smaller than `MIN_PIECE_AREA` square image pixels (slivers left by
 * rounding) are dropped.
 */

/** Pieces smaller than this, in square image pixels, are dropped. */
export const MIN_PIECE_AREA = 1;

/**
 * Half the width of the cut a split line makes, in image pixels: the pieces
 * are this far from the line on each side (0.2 px apart in all, about
 * 0.05 µm at 0.25 µm per pixel).
 */
export const SPLIT_HALF_WIDTH = 0.1;

function toClip(region: WsiRegion): MultiPolygon {
    return region.map(rings =>
        rings.map(ring => {
            const pairs: Ring = ring.map(point => [point.x, point.y]);
            const first = pairs[0];
            const last = pairs[pairs.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                pairs.push([first[0], first[1]]);
            }
            return pairs;
        })
    );
}

/** The area of one polygon of a region: its outer ring less its holes. */
export function polygonPartArea(rings: WsiPoint[][]): number {
    return rings.reduce(
        (sum, ring, index) => sum + (index ? -1 : 1) * polygonArea(ring),
        0
    );
}

/** A region's area in square image pixels: outer rings less holes. */
export function regionArea(region: WsiRegion): number {
    return region.reduce((sum, rings) => sum + polygonPartArea(rings), 0);
}

function fromClip(result: MultiPolygon): WsiRegion {
    return result
        .map(polygon =>
            polygon
                .map(ring => {
                    const points = ring.map(([x, y]) => ({ x, y }));
                    const first = points[0];
                    const last = points[points.length - 1];
                    return points.length > 1 &&
                        first.x === last.x &&
                        first.y === last.y
                        ? points.slice(0, -1)
                        : points;
                })
                .filter(ring => ring.length >= 3)
        )
        .filter(
            rings =>
                rings.length > 0 && polygonPartArea(rings) >= MIN_PIECE_AREA
        );
}

/** The union of regions: what any of them covers. */
export function unionRegions(regions: WsiRegion[]): WsiRegion {
    if (!regions.length) return [];
    const [first, ...rest] = regions.map(toClip);
    return fromClip(polygonClipping.union(first, ...rest));
}

/** `subject` without what any of `clips` covers. */
export function subtractRegions(
    subject: WsiRegion,
    clips: WsiRegion[]
): WsiRegion {
    if (!clips.length) return subject;
    return fromClip(
        polygonClipping.difference(toClip(subject), ...clips.map(toClip))
    );
}

/** Where all the regions overlap. */
export function intersectRegions(regions: WsiRegion[]): WsiRegion {
    if (regions.length < 2) return regions[0] || [];
    const [first, ...rest] = regions.map(toClip);
    return fromClip(polygonClipping.intersection(first, ...rest));
}

/** A region's parts, each a region of one polygon with its holes. */
export function regionParts(region: WsiRegion): WsiRegion[] {
    return region.map(rings => [rings]);
}

/** The bounding box of a region's outer rings. */
export function regionBounds(region: WsiRegion): WsiBounds | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    region.forEach(rings =>
        (rings[0] || []).forEach(point => {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        })
    );
    return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

/** Whether two boxes overlap. */
export function boundsOverlap(a: WsiBounds, b: WsiBounds): boolean {
    return (
        a.minX <= b.maxX &&
        b.minX <= a.maxX &&
        a.minY <= b.maxY &&
        b.minY <= a.maxY
    );
}

/**
 * The band a cut along `path` removes: a thin rectangle `2 * halfWidth`
 * wide around each segment, reaching `halfWidth` past its ends, merged.
 */
function cutBand(path: WsiPoint[], halfWidth: number): WsiRegion {
    const quads: WsiRegion[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i];
        const b = path[i + 1];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (!length) continue;
        const ux = ((b.x - a.x) / length) * halfWidth;
        const uy = ((b.y - a.y) / length) * halfWidth;
        // Along the segment (u) and across it (-uy, ux).
        quads.push([
            [
                [
                    { x: a.x - ux - uy, y: a.y - uy + ux },
                    { x: b.x + ux - uy, y: b.y + uy + ux },
                    { x: b.x + ux + uy, y: b.y + uy - ux },
                    { x: a.x - ux + uy, y: a.y - uy - ux },
                ],
            ],
        ]);
    }
    return quads.length ? unionRegions(quads) : [];
}

/**
 * Splits a region along a line or polyline drawn across it: the pieces
 * left after cutting a band `2 * halfWidth` wide along `path`, each its
 * own region (a polygon with its holes), largest first. A line that does
 * not cross the region from edge to edge leaves one piece.
 */
export function splitRegionByPath(
    region: WsiRegion,
    path: WsiPoint[],
    halfWidth = SPLIT_HALF_WIDTH
): WsiRegion[] {
    const band = cutBand(path, halfWidth);
    const rest = band.length ? subtractRegions(region, [band]) : region;
    return regionParts(rest).sort((a, b) => regionArea(b) - regionArea(a));
}
