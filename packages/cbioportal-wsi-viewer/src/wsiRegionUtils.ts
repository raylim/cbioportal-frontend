import {
    polygonArea,
    WsiBounds,
    WsiPoint,
    WsiRegion,
} from './wsiAnnotationGeometryUtils';

/**
 * Measuring regions (image pixels): area, bounds and parts. Kept apart from
 * the boolean operations (`wsiAnnotationShapeOps.ts`, with polygon-clipping),
 * which load as their own async chunk when a shape operation first runs.
 */

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
