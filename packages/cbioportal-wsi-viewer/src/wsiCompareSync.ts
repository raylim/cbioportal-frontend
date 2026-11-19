import { WsiMpp, WsiPoint } from './wsiAnnotationGeometryUtils';
import {
    applyAffine,
    decomposeAffine,
    invertAffine,
    WsiAffine,
    WsiAlignmentFit,
} from './wsiCompareTransform';

/**
 * What a view shows: the image point at its centre (level-0 pixels), its
 * zoom in screen pixels per image pixel, its rotation in degrees
 * (clockwise) and whether it is mirrored.
 */
export interface WsiViewPose {
    center: WsiPoint;
    zoom: number;
    rotation: number;
    flip: boolean;
}

/**
 * How synchronized views follow each other:
 * - `aligned`: through the fitted alignment of the point pairs;
 * - `anchor`: the same distance in µm from an anchor point set on each
 *   slide (pixels when a slide has no scale), no rotation;
 * - `relative`: the same place relative to each image's size, and the same
 *   share of the image width on screen.
 */
export type WsiSyncMode = 'aligned' | 'anchor' | 'relative';

/** A view-following map from one slide's pixels to the other's. */
export interface WsiSyncMapping {
    transform: WsiAffine;
    /** Follower pixels per leader pixel, for the zoom. */
    scale: number;
    rotationDeg: number;
    reflected: boolean;
}

export interface WsiSyncSlide {
    width: number;
    height: number;
    mpp?: WsiMpp | null;
}

function mappingOf(transform: WsiAffine): WsiSyncMapping {
    return { transform, ...decomposeAffine(transform) };
}

/**
 * The left-to-right map synchronized views follow in `mode`. Null when it
 * cannot be made (no fit for `aligned`, no anchor for `anchor`, or images
 * without a size).
 */
export function leftToRightMapping(
    mode: WsiSyncMode,
    context: {
        fit?: WsiAlignmentFit | null;
        anchor?: { left: WsiPoint; right: WsiPoint } | null;
        left: WsiSyncSlide;
        right: WsiSyncSlide;
    }
): WsiSyncMapping | null {
    const { left, right } = context;
    if (mode === 'aligned') {
        return context.fit ? mappingOf(context.fit.transform) : null;
    }
    if (mode === 'anchor') {
        const anchor = context.anchor;
        if (!anchor) return null;
        const physical = !!(left.mpp && right.mpp);
        const sx = physical ? left.mpp!.x / right.mpp!.x : 1;
        const sy = physical ? left.mpp!.y / right.mpp!.y : 1;
        return mappingOf({
            a: sx,
            b: 0,
            c: 0,
            d: sy,
            tx: anchor.right.x - sx * anchor.left.x,
            ty: anchor.right.y - sy * anchor.left.y,
        });
    }
    if (!(left.width > 0 && left.height > 0 && right.width > 0)) return null;
    const sx = right.width / left.width;
    const sy = right.height / left.height;
    return {
        transform: { a: sx, b: 0, c: 0, d: sy, tx: 0, ty: 0 },
        // The same share of the image width on screen.
        scale: sx,
        rotationDeg: 0,
        reflected: false,
    };
}

/** The map the other way, for a right-hand leader. */
export function invertMapping(mapping: WsiSyncMapping): WsiSyncMapping | null {
    const inverse = invertAffine(mapping.transform);
    if (!inverse) return null;
    if (mapping.rotationDeg === 0 && !mapping.reflected) {
        return {
            transform: inverse,
            scale: 1 / mapping.scale,
            rotationDeg: 0,
            reflected: false,
        };
    }
    return mappingOf(inverse);
}

/** An angle in [0, 360). */
export function normalizeDegrees(degrees: number): number {
    const value = degrees % 360;
    return value < 0 ? value + 360 : value;
}

/**
 * The follower's view for the leader's `pose`: the leader's centre mapped,
 * its zoom divided by the map's scale, its rotation turned by the map's
 * (`ρ − θ`), and the leader's mirroring. A mirroring map (`s·R(θ)·diag(1,
 * −1)`, one section lying flipped) gets `ρ − θ − 180°`: the follower then
 * shows the leader's tissue in the same orientation, mirrored left to
 * right. The view itself is not mirrored to undo it, because OpenSeadragon
 * maps screen and image points without its flip, so annotations would be
 * drawn in the wrong place.
 */
export function followerPose(
    pose: WsiViewPose,
    mapping: WsiSyncMapping
): WsiViewPose {
    return {
        center: applyAffine(mapping.transform, pose.center),
        zoom: pose.zoom / mapping.scale,
        rotation: normalizeDegrees(
            pose.rotation - mapping.rotationDeg - (mapping.reflected ? 180 : 0)
        ),
        flip: pose.flip,
    };
}

/**
 * `target` turned by whole turns to lie within 180° of `current`, so a view
 * does not spin the long way round.
 */
export function nearestTurn(target: number, current: number): number {
    let value = target;
    while (value - current > 180) value -= 360;
    while (value - current < -180) value += 360;
    return value;
}

/**
 * The pose an OpenSeadragon viewer shows; its target (where an animation
 * ends) unless `current`. Null before an image is open.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readViewPose(viewer: any, current = false): WsiViewPose | null {
    const viewport = viewer?.viewport;
    if (!viewport || !viewer.world?.getItemCount?.()) return null;
    try {
        const center = viewport.viewportToImageCoordinates(
            viewport.getCenter(current)
        );
        const zoom = viewport.viewportToImageZoom(viewport.getZoom(current));
        if (
            !Number.isFinite(center.x) ||
            !Number.isFinite(center.y) ||
            !(zoom > 0)
        ) {
            return null;
        }
        return {
            center: { x: center.x, y: center.y },
            zoom,
            rotation: Number(viewport.getRotation?.(current)) || 0,
            flip: !!viewport.getFlip?.(),
        };
    } catch (_) {
        return null;
    }
}

/**
 * Moves an OpenSeadragon viewer to `pose`: mirroring, rotation, zoom about
 * the centre, then the centre; animated unless `immediately`.
 */
export function applyViewPose(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewer: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openSeadragon: any,
    pose: WsiViewPose,
    immediately: boolean
): boolean {
    const viewport = viewer?.viewport;
    if (!viewport || !openSeadragon || !viewer.world?.getItemCount?.()) {
        return false;
    }
    try {
        if (viewport.getFlip && !!viewport.getFlip() !== pose.flip) {
            viewport.setFlip(pose.flip);
        }
        if (viewport.setRotation) {
            const current = Number(viewport.getRotation?.()) || 0;
            const rotation = nearestTurn(pose.rotation, current);
            if (Math.abs(rotation - current) > 1e-6) {
                viewport.setRotation(rotation, immediately);
            }
        }
        viewport.zoomTo(
            viewport.imageToViewportZoom(pose.zoom),
            undefined,
            immediately
        );
        viewport.panTo(
            viewport.imageToViewportCoordinates(
                new openSeadragon.Point(pose.center.x, pose.center.y)
            ),
            immediately
        );
        return true;
    } catch (_) {
        return false;
    }
}
