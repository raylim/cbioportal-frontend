import {
    regionSelectorSvg,
    shapeRegion,
    WsiAnnotationShape,
    WsiMpp,
    WsiPoint,
} from './wsiAnnotationGeometryUtils';

/**
 * A 2-D affine map of level-0 image pixels of one slide to another's:
 * `x' = a·x + b·y + tx`, `y' = c·x + d·y + ty`.
 */
export interface WsiAffine {
    a: number;
    b: number;
    c: number;
    d: number;
    tx: number;
    ty: number;
}

/**
 * How point pairs are fitted: a similarity (rotation, one scale, shift, and
 * a mirror image when that fits better) or a full affine map (also shear and
 * a scale per axis).
 */
export type WsiTransformModel = 'similarity' | 'affine';

/** Point pairs a transform needs. Fewer cannot show an error. */
export const MIN_ALIGNMENT_PAIRS = 3;

export const IDENTITY_AFFINE: WsiAffine = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    tx: 0,
    ty: 0,
};

export function applyAffine(t: WsiAffine, p: WsiPoint): WsiPoint {
    return { x: t.a * p.x + t.b * p.y + t.tx, y: t.c * p.x + t.d * p.y + t.ty };
}

/** `outer` after `inner`: p ↦ outer(inner(p)). */
export function composeAffine(outer: WsiAffine, inner: WsiAffine): WsiAffine {
    return {
        a: outer.a * inner.a + outer.b * inner.c,
        b: outer.a * inner.b + outer.b * inner.d,
        c: outer.c * inner.a + outer.d * inner.c,
        d: outer.c * inner.b + outer.d * inner.d,
        tx: outer.a * inner.tx + outer.b * inner.ty + outer.tx,
        ty: outer.c * inner.tx + outer.d * inner.ty + outer.ty,
    };
}

/** The inverse map, or null when the map flattens the plane. */
export function invertAffine(t: WsiAffine): WsiAffine | null {
    const det = t.a * t.d - t.b * t.c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const a = t.d / det;
    const b = -t.b / det;
    const c = -t.c / det;
    const d = t.a / det;
    return {
        a,
        b,
        c,
        d,
        tx: -(a * t.tx + b * t.ty),
        ty: -(c * t.tx + d * t.ty),
    };
}

/**
 * A map's rotation, scale and mirroring, for turning and zooming a view
 * with it. The linear part is read as `scale · R(rotationDeg)`, or
 * `scale · R(rotationDeg) · diag(1, −1)` when it mirrors (negative
 * determinant); `scale` is the square root of the area ratio, so an affine
 * map's shear and unequal axes are averaged out.
 */
export function decomposeAffine(
    t: WsiAffine
): { scale: number; rotationDeg: number; reflected: boolean } {
    const det = t.a * t.d - t.b * t.c;
    const reflected = det < 0;
    const scale = Math.sqrt(Math.abs(det));
    const radians = reflected
        ? Math.atan2(t.b + t.c, t.a - t.d)
        : Math.atan2(t.c - t.b, t.a + t.d);
    return { scale, rotationDeg: (radians * 180) / Math.PI, reflected };
}

function centroid(points: WsiPoint[]): WsiPoint {
    const n = points.length;
    return {
        x: points.reduce((sum, p) => sum + p.x, 0) / n,
        y: points.reduce((sum, p) => sum + p.y, 0) / n,
    };
}

function squaredError(t: WsiAffine, src: WsiPoint[], dst: WsiPoint[]) {
    return src.reduce((sum, p, i) => {
        const q = applyAffine(t, p);
        return sum + (q.x - dst[i].x) ** 2 + (q.y - dst[i].y) ** 2;
    }, 0);
}

/**
 * The least-squares similarity map of `src` onto `dst` (rotation, one
 * scale and a shift; closed form, as complex numbers). A mirrored fit is
 * taken only when it has under half the squared error of the plain one, so
 * noise alone never mirrors a view. Null for under 2 pairs or coincident
 * source points.
 */
export function fitSimilarity(
    src: WsiPoint[],
    dst: WsiPoint[],
    allowReflection = true
): WsiAffine | null {
    if (src.length < 2 || src.length !== dst.length) return null;
    const ps = centroid(src);
    const qs = centroid(dst);
    let norm = 0;
    // Σ conj(p)·q and Σ p·q over the centred points.
    let re = 0;
    let im = 0;
    let reflRe = 0;
    let reflIm = 0;
    src.forEach((p, i) => {
        const px = p.x - ps.x;
        const py = p.y - ps.y;
        const qx = dst[i].x - qs.x;
        const qy = dst[i].y - qs.y;
        norm += px * px + py * py;
        re += px * qx + py * qy;
        im += px * qy - py * qx;
        reflRe += px * qx - py * qy;
        reflIm += px * qy + py * qx;
    });
    if (norm < 1e-12) return null;
    const shiftFor = (a: number, b: number, c: number, d: number) => ({
        a,
        b,
        c,
        d,
        tx: qs.x - (a * ps.x + b * ps.y),
        ty: qs.y - (c * ps.x + d * ps.y),
    });
    const ar = re / norm;
    const ai = im / norm;
    const plain = shiftFor(ar, -ai, ai, ar);
    if (!allowReflection) return plain;
    const br = reflRe / norm;
    const bi = reflIm / norm;
    const mirrored = shiftFor(br, bi, bi, -br);
    return squaredError(mirrored, src, dst) <
        0.5 * squaredError(plain, src, dst)
        ? mirrored
        : plain;
}

/** Solves a 3×3 system by Cramer's rule; null when it is singular. */
function solve3(m: number[][], v: number[]): number[] | null {
    const det = (x: number[][]) =>
        x[0][0] * (x[1][1] * x[2][2] - x[1][2] * x[2][1]) -
        x[0][1] * (x[1][0] * x[2][2] - x[1][2] * x[2][0]) +
        x[0][2] * (x[1][0] * x[2][1] - x[1][1] * x[2][0]);
    const d = det(m);
    const scale = Math.max(...m.map(row => Math.max(...row.map(Math.abs))));
    if (!Number.isFinite(d) || Math.abs(d) <= 1e-9 * scale ** 3) return null;
    return [0, 1, 2].map(
        column =>
            det(
                m.map((row, r) =>
                    row.map((cell, c) => (c === column ? v[r] : cell))
                )
            ) / d
    );
}

/**
 * The least-squares affine map of `src` onto `dst`. Null for under 3
 * pairs, or source points on one line.
 */
export function fitAffine(src: WsiPoint[], dst: WsiPoint[]): WsiAffine | null {
    if (src.length < 3 || src.length !== dst.length) return null;
    // Centred for conditioning: slide coordinates run to 10⁵ pixels.
    const ps = centroid(src);
    const qs = centroid(dst);
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let n = 0;
    const bx = [0, 0, 0];
    const by = [0, 0, 0];
    src.forEach((p, i) => {
        const x = p.x - ps.x;
        const y = p.y - ps.y;
        const u = dst[i].x - qs.x;
        const v = dst[i].y - qs.y;
        sxx += x * x;
        sxy += x * y;
        syy += y * y;
        n += 1;
        bx[0] += x * u;
        bx[1] += y * u;
        bx[2] += u;
        by[0] += x * v;
        by[1] += y * v;
        by[2] += v;
    });
    const normal = [
        [sxx, sxy, 0],
        [sxy, syy, 0],
        [0, 0, n],
    ];
    const rowX = solve3(normal, bx);
    const rowY = solve3(normal, by);
    if (!rowX || !rowY) return null;
    const [a, b] = rowX;
    const [c, d] = rowY;
    return {
        a,
        b,
        c,
        d,
        tx: qs.x + rowX[2] - (a * ps.x + b * ps.y),
        ty: qs.y + rowY[2] - (c * ps.x + d * ps.y),
    };
}

export function fitTransform(
    model: WsiTransformModel,
    src: WsiPoint[],
    dst: WsiPoint[]
): WsiAffine | null {
    return model === 'affine' ? fitAffine(src, dst) : fitSimilarity(src, dst);
}

/** One numbered pair: a point on each slide (null until placed). */
export interface WsiAlignmentPair {
    id: string;
    left: WsiPoint | null;
    right: WsiPoint | null;
}

/** A fitted alignment of the left slide onto the right one. */
export interface WsiAlignmentFit {
    model: WsiTransformModel;
    /** Left level-0 pixels to right level-0 pixels. */
    transform: WsiAffine;
    /** Right to left. */
    inverse: WsiAffine;
    /** Each complete pair's distance from its fitted place, by pair id. */
    residuals: Record<string, number>;
    /** Root mean square and largest of `residuals`. */
    rms: number;
    max: number;
    /** `µm` with the right slide's scale, else image pixels. */
    unit: 'um' | 'px';
    /** Complete pairs used. */
    count: number;
    /**
     * Whether the error says nothing: as many pairs as the model has
     * degrees of freedom to fit them exactly (3 for affine).
     */
    exact: boolean;
    reflected: boolean;
}

/** Pairs with both points placed. */
export function completePairs(
    pairs: ReadonlyArray<WsiAlignmentPair>
): Array<{ id: string; left: WsiPoint; right: WsiPoint }> {
    return pairs.filter(
        (pair): pair is { id: string; left: WsiPoint; right: WsiPoint } =>
            !!pair.left && !!pair.right
    );
}

/**
 * Fits the left-to-right map of the complete pairs, with each pair's
 * residual: the distance between its right point and where the map puts
 * its left point, in µm of the right slide (per axis) when it has a scale.
 * Null under `MIN_ALIGNMENT_PAIRS` complete pairs or when the points
 * cannot fix a map (all on one line for affine, coincident).
 */
export function fitAlignment(
    pairs: ReadonlyArray<WsiAlignmentPair>,
    model: WsiTransformModel,
    rightMpp?: WsiMpp | null
): WsiAlignmentFit | null {
    const complete = completePairs(pairs);
    if (complete.length < MIN_ALIGNMENT_PAIRS) return null;
    const src = complete.map(pair => pair.left);
    const dst = complete.map(pair => pair.right);
    const transform = fitTransform(model, src, dst);
    const inverse = transform && invertAffine(transform);
    if (!transform || !inverse) return null;
    const residuals: Record<string, number> = {};
    let sum = 0;
    let max = 0;
    complete.forEach(pair => {
        const mapped = applyAffine(transform, pair.left);
        const dx = (mapped.x - pair.right.x) * (rightMpp ? rightMpp.x : 1);
        const dy = (mapped.y - pair.right.y) * (rightMpp ? rightMpp.y : 1);
        const distance = Math.hypot(dx, dy);
        residuals[pair.id] = distance;
        sum += distance * distance;
        max = Math.max(max, distance);
    });
    return {
        model,
        transform,
        inverse,
        residuals,
        rms: Math.sqrt(sum / complete.length),
        max,
        unit: rightMpp ? 'um' : 'px',
        count: complete.length,
        exact: model === 'affine' && complete.length === 3,
        reflected: decomposeAffine(transform).reflected,
    };
}

function mapPoints(t: WsiAffine, points: WsiPoint[]): WsiPoint[] {
    return points.map(point => applyAffine(t, point));
}

/**
 * A shape's geometry moved through `t`: points, lines and polylines keep
 * their kind; rectangles and ellipses become polygons (a rotated or sheared
 * box is no longer axis-aligned), and polygons and regions keep every ring,
 * holes and parts included.
 */
export function mapShape(
    shape: WsiAnnotationShape,
    t: WsiAffine
): WsiAnnotationShape {
    switch (shape.kind) {
        case 'point': {
            const p = applyAffine(t, shape);
            return { kind: 'point', x: p.x, y: p.y };
        }
        case 'line':
            return {
                kind: 'line',
                points: mapPoints(t, shape.points) as [WsiPoint, WsiPoint],
            };
        case 'polyline':
            return { kind: 'polyline', points: mapPoints(t, shape.points) };
        case 'multipolygon':
            return {
                kind: 'multipolygon',
                polygons: shape.polygons.map(rings =>
                    rings.map(ring => mapPoints(t, ring))
                ),
            };
        case 'polygon':
            return { kind: 'polygon', points: mapPoints(t, shape.points) };
        default: {
            const region = shapeRegion(shape)!;
            const mapped = region.map(rings =>
                rings.map(ring => mapPoints(t, ring))
            );
            return mapped.length === 1 && mapped[0].length === 1
                ? { kind: 'polygon', points: mapped[0][0] }
                : { kind: 'multipolygon', polygons: mapped };
        }
    }
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * The SVG selector value of a shape, in image pixels rounded to 0.01: a
 * point as a circle of radius 0, a `<line>`, a `<polyline>`, and regions
 * as `regionSelectorSvg` writes them.
 */
export function shapeSelectorSvg(shape: WsiAnnotationShape): string {
    switch (shape.kind) {
        case 'point':
            return `<svg><circle cx="${round(shape.x)}" cy="${round(
                shape.y
            )}" r="0" /></svg>`;
        case 'line': {
            const [p, q] = shape.points;
            return `<svg><line x1="${round(p.x)}" y1="${round(
                p.y
            )}" x2="${round(q.x)}" y2="${round(q.y)}" /></svg>`;
        }
        case 'polyline':
            return `<svg><polyline points="${shape.points
                .map(p => `${round(p.x)},${round(p.y)}`)
                .join(' ')}" /></svg>`;
        case 'polygon':
            return regionSelectorSvg([[shape.points]]);
        case 'multipolygon':
            return regionSelectorSvg(shape.polygons);
        default:
            return regionSelectorSvg(shapeRegion(shape)!);
    }
}

/** "8.2 µm", "1.24 mm" or "15 px", for an alignment error. */
export function formatAlignmentError(value: number, unit: 'um' | 'px'): string {
    if (unit === 'px') return `${Math.round(value)} px`;
    if (value >= 1000) return `${(value / 1000).toFixed(2)} mm`;
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} µm`;
}
