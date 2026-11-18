/**
 * Tissue-aware selection on a raster of slide pixels: color distance, flood
 * fill (the magic wand), a brush that paints only similar pixels (the smart
 * brush), hole filling, contour tracing and outline simplification.
 *
 * Self-contained (only constants imported), so the same code runs in the selection Web
 * Worker (`wsiTissueWorker.ts`) and, without workers, on the main thread.
 * Coordinates are raster pixels: pixel (x, y) covers [x, x+1) × [y, y+1).
 *
 * **Color distance.** Pixels are compared with a seed color in CIELAB, with
 * the lightness difference weighted by `LIGHTNESS_WEIGHT` (0.5):
 * `√((0.5·ΔL*)² + Δa*² + Δb*²)`. Lab is close to perceptually uniform, so one
 * tolerance means about the same visual difference for every stain: eosin
 * pink, hematoxylin blue-purple, DAB brown and the white background differ
 * mostly in hue and chroma (a*, b*), which count fully. Within one tissue
 * class the staining intensity (lightness) varies with section thickness
 * and focus more than the hue does, so lightness counts half. The raster is
 * first smoothed with a 3×3 box blur, so single nuclei and noise do not
 * break a region up. A stain-separation measure (color deconvolution) was
 * not used: it needs per-stain vectors (H&E, H-DAB, other chromogens) that
 * vary by lab and scanner, while Lab needs none.
 */

/** Weight of the lightness difference in the color distance. */
export const LIGHTNESS_WEIGHT = 0.5;
export {
    DEFAULT_TISSUE_TOLERANCE,
    MIN_TISSUE_TOLERANCE,
    MAX_TISSUE_TOLERANCE,
} from './wsiTissueConstants';

/** RGBA pixels, row by row, as `ImageData`. */
export interface WsiRgbaRaster {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

/**
 * A raster prepared for selection: each pixel's quantized, smoothed color
 * (5 bits per channel, an index into the Lab table), or `VOID` where there
 * is no slide (transparent: outside the slide, or a tile that failed).
 */
export interface WsiPreparedRaster {
    width: number;
    height: number;
    bins: Uint16Array;
}

export const VOID = 0x8000;
const BITS = 5;
const LEVELS = 1 << BITS;
const SHIFT = 8 - BITS;

let labTable: Float32Array | null = null;

function srgbToLinear(value: number): number {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
    return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

/** CIELAB (D65) of an sRGB color. */
export function rgbToLab(
    r: number,
    g: number,
    b: number
): [number, number, number] {
    const R = srgbToLinear(r);
    const G = srgbToLinear(g);
    const B = srgbToLinear(b);
    const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
    const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
    const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
    const fx = labF(x);
    const fy = labF(y);
    const fz = labF(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The Lab color of each quantized bin (its centre), 3 floats per bin. */
function lab(): Float32Array {
    if (labTable) return labTable;
    const table = new Float32Array(LEVELS * LEVELS * LEVELS * 3);
    const centre = (q: number) =>
        Math.min(255, (q << SHIFT) + (1 << (SHIFT - 1)));
    let i = 0;
    for (let r = 0; r < LEVELS; r++) {
        for (let g = 0; g < LEVELS; g++) {
            for (let b = 0; b < LEVELS; b++) {
                const [L, A, B] = rgbToLab(centre(r), centre(g), centre(b));
                table[i++] = L;
                table[i++] = A;
                table[i++] = B;
            }
        }
    }
    labTable = table;
    return table;
}

/** The color distance between two Lab colors (see the module comment). */
export function labDistance(
    a: readonly number[],
    b: readonly number[]
): number {
    const dL = (a[0] - b[0]) * LIGHTNESS_WEIGHT;
    const da = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Smooths the raster (3×3 box blur, edges clamped) and quantizes it into
 * Lab bins. Pixels with alpha under 128, and their blurred neighbours'
 * contribution, are left out; a transparent pixel is `VOID`.
 */
export function prepareRaster(raster: WsiRgbaRaster): WsiPreparedRaster {
    const { width, height, data } = raster;
    const n = width * height;
    // Horizontal pass: sums of up to 3 opaque neighbours per channel.
    const sum = new Uint16Array(n * 3);
    const count = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let c = 0;
            for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= width) continue;
                const p = (row + xx) * 4;
                if (data[p + 3] < 128) continue;
                r += data[p];
                g += data[p + 1];
                b += data[p + 2];
                c++;
            }
            const o = (row + x) * 3;
            sum[o] = r;
            sum[o + 1] = g;
            sum[o + 2] = b;
            count[row + x] = c;
        }
    }
    const bins = new Uint16Array(n);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (data[i * 4 + 3] < 128) {
                bins[i] = VOID;
                continue;
            }
            let r = 0;
            let g = 0;
            let b = 0;
            let c = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;
                const j = yy * width + x;
                r += sum[j * 3];
                g += sum[j * 3 + 1];
                b += sum[j * 3 + 2];
                c += count[j];
            }
            const qr = Math.min(LEVELS - 1, Math.round(r / c) >> SHIFT);
            const qg = Math.min(LEVELS - 1, Math.round(g / c) >> SHIFT);
            const qb = Math.min(LEVELS - 1, Math.round(b / c) >> SHIFT);
            bins[i] = (qr << (2 * BITS)) | (qg << BITS) | qb;
        }
    }
    return { width, height, bins };
}

/**
 * The seed color: the mean Lab color of the opaque pixels within `radius`
 * of (x, y), or null when there are none.
 */
export function seedColor(
    raster: WsiPreparedRaster,
    x: number,
    y: number,
    radius = 2
): [number, number, number] | null {
    const table = lab();
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    let L = 0;
    let A = 0;
    let B = 0;
    let c = 0;
    for (let yy = cy - radius; yy <= cy + radius; yy++) {
        if (yy < 0 || yy >= raster.height) continue;
        for (let xx = cx - radius; xx <= cx + radius; xx++) {
            if (xx < 0 || xx >= raster.width) continue;
            const bin = raster.bins[yy * raster.width + xx];
            if (bin & VOID) continue;
            L += table[bin * 3];
            A += table[bin * 3 + 1];
            B += table[bin * 3 + 2];
            c++;
        }
    }
    return c ? [L / c, A / c, B / c] : null;
}

/** Each bin's color distance from `seed`; `VOID` is never similar. */
export function binDistances(seed: readonly number[]): Float32Array {
    const table = lab();
    const out = new Float32Array(LEVELS * LEVELS * LEVELS);
    for (let i = 0; i < out.length; i++) {
        const dL = (table[i * 3] - seed[0]) * LIGHTNESS_WEIGHT;
        const da = table[i * 3 + 1] - seed[1];
        const db = table[i * 3 + 2] - seed[2];
        out[i] = Math.sqrt(dL * dL + da * da + db * db);
    }
    return out;
}

/** A mask's extent, and which raster borders it reaches. */
export interface WsiMaskResult {
    /** 1 inside, 0 outside; the raster's size. */
    mask: Uint8Array;
    count: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    touches: { left: boolean; top: boolean; right: boolean; bottom: boolean };
}

function emptyResult(mask: Uint8Array): WsiMaskResult {
    return {
        mask,
        count: 0,
        minX: 0,
        minY: 0,
        maxX: -1,
        maxY: -1,
        touches: { left: false, top: false, right: false, bottom: false },
    };
}

function similar(
    raster: WsiPreparedRaster,
    distances: Float32Array,
    tolerance: number,
    i: number
): boolean {
    const bin = raster.bins[i];
    return !(bin & VOID) && distances[bin] <= tolerance;
}

/**
 * Scanline flood fill (4-connected) from `start` pixels over the pixels
 * `allowed` accepts. Writes 1 into `mask` (cleared first) and returns the
 * extent.
 */
function fill(
    width: number,
    height: number,
    starts: number[],
    allowed: (i: number) => boolean,
    mask: Uint8Array
): WsiMaskResult {
    mask.fill(0);
    const result = emptyResult(mask);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    const stack: number[] = [];
    starts.forEach(i => {
        if (!mask[i] && allowed(i)) stack.push(i);
    });
    while (stack.length) {
        const i = stack.pop()!;
        if (mask[i]) continue;
        const y = (i / width) | 0;
        const row = y * width;
        let x0 = i - row;
        let x1 = x0;
        while (x0 > 0 && !mask[row + x0 - 1] && allowed(row + x0 - 1)) x0--;
        while (x1 < width - 1 && !mask[row + x1 + 1] && allowed(row + x1 + 1)) {
            x1++;
        }
        for (let x = x0; x <= x1; x++) mask[row + x] = 1;
        count += x1 - x0 + 1;
        if (x0 < minX) minX = x0;
        if (x1 > maxX) maxX = x1;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (const ny of [y - 1, y + 1]) {
            if (ny < 0 || ny >= height) continue;
            const nrow = ny * width;
            let inRun = false;
            for (let x = x0; x <= x1; x++) {
                const j = nrow + x;
                const open = !mask[j] && allowed(j);
                if (open && !inRun) stack.push(j);
                inRun = open;
            }
        }
    }
    if (!count) return result;
    return {
        mask,
        count,
        minX,
        minY,
        maxX,
        maxY,
        touches: {
            left: minX === 0,
            top: minY === 0,
            right: maxX === width - 1,
            bottom: maxY === height - 1,
        },
    };
}

/**
 * The magic wand: the 4-connected region of pixels within `tolerance` of
 * `color` that holds (x, y), or the nearest such pixel within 2 pixels when
 * (x, y) itself is not similar.
 */
export function floodFill(
    raster: WsiPreparedRaster,
    x: number,
    y: number,
    color: readonly number[],
    tolerance: number,
    mask = new Uint8Array(raster.width * raster.height)
): WsiMaskResult {
    const { width, height } = raster;
    const distances = binDistances(color);
    const allowed = (i: number) => similar(raster, distances, tolerance, i);
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    let start = -1;
    let best = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            const xx = cx + dx;
            const yy = cy + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            const i = yy * width + xx;
            const d = dx * dx + dy * dy;
            if (d < best && allowed(i)) {
                best = d;
                start = i;
            }
        }
    }
    if (start < 0) {
        mask.fill(0);
        return emptyResult(mask);
    }
    return fill(width, height, [start], allowed, mask);
}

/** A path point, in raster pixels. */
export interface WsiXYPoint {
    x: number;
    y: number;
}

/**
 * The smart brush: the pixels within `radius` of the stroke `path` whose
 * color is within `tolerance` of `color`, and connected (inside the band) to
 * a similar pixel on the stroke itself. So the brush stops at tissue edges
 * and does not jump over a gap to similar tissue on the other side.
 */
export function paintMask(
    raster: WsiPreparedRaster,
    path: readonly WsiXYPoint[],
    radius: number,
    color: readonly number[],
    tolerance: number,
    mask = new Uint8Array(raster.width * raster.height)
): WsiMaskResult {
    const { width, height } = raster;
    const band = new Uint8Array(width * height);
    const r2 = radius * radius;
    const segments = path.length > 1 ? path.length - 1 : 1;
    for (let s = 0; s < segments; s++) {
        const a = path[s];
        const b = path[Math.min(s + 1, path.length - 1)];
        const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
        const x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + radius));
        const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
        const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + radius));
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const length2 = vx * vx + vy * vy;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const i = y * width + x;
                if (band[i]) continue;
                const px = x + 0.5 - a.x;
                const py = y + 0.5 - a.y;
                const t = length2
                    ? Math.max(0, Math.min(1, (px * vx + py * vy) / length2))
                    : 0;
                const dx = px - t * vx;
                const dy = py - t * vy;
                if (dx * dx + dy * dy <= r2) band[i] = 1;
            }
        }
    }
    const distances = binDistances(color);
    const allowed = (i: number) =>
        band[i] === 1 && similar(raster, distances, tolerance, i);
    const starts: number[] = [];
    for (let s = 0; s < segments; s++) {
        const a = path[s];
        const b = path[Math.min(s + 1, path.length - 1)];
        const steps = Math.max(
            1,
            Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2)
        );
        for (let k = 0; k <= steps; k++) {
            const x = Math.floor(a.x + ((b.x - a.x) * k) / steps);
            const y = Math.floor(a.y + ((b.y - a.y) * k) / steps);
            if (x >= 0 && y >= 0 && x < width && y < height) {
                starts.push(y * width + x);
            }
        }
    }
    return fill(width, height, starts, allowed, mask);
}

/**
 * Fills the holes of a mask smaller than `maxHoleArea` pixels: background
 * pockets (8-connected, as the 4-connected foreground's complement) that do
 * not reach the mask's bounding box. Larger holes stay. Returns how many
 * pixels were filled.
 */
export function fillSmallHoles(
    result: WsiMaskResult,
    width: number,
    maxHoleArea: number
): number {
    const { mask, minX, minY, maxX, maxY } = result;
    if (maxX < minX || maxHoleArea <= 0) return 0;
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    // 0 unvisited background, 1 foreground, 2 visited background.
    const seen = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (mask[(minY + y) * width + minX + x]) seen[y * w + x] = 1;
        }
    }
    const component: number[] = [];
    const flood = (start: number): boolean => {
        // Returns whether the pocket reaches the box border.
        component.length = 0;
        const stack = [start];
        seen[start] = 2;
        let border = false;
        while (stack.length) {
            const i = stack.pop()!;
            component.push(i);
            const x = i % w;
            const y = (i / w) | 0;
            if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const xx = x + dx;
                    const yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
                    const j = yy * w + xx;
                    if (seen[j] === 0) {
                        seen[j] = 2;
                        stack.push(j);
                    }
                }
            }
        }
        return border;
    };
    let filled = 0;
    for (let i = 0; i < w * h; i++) {
        if (seen[i] !== 0) continue;
        const border = flood(i);
        if (!border && component.length < maxHoleArea) {
            component.forEach(j => {
                mask[(minY + ((j / w) | 0)) * width + minX + (j % w)] = 1;
            });
            filled += component.length;
        }
    }
    result.count += filled;
    return filled;
}

/** A polygon: its outer ring, then its holes; rings as flat [x, y, …]. */
export type WsiFlatPolygon = number[][];

/** Twice the signed area of a flat ring (positive: clockwise on screen). */
function ringArea2(ring: number[]): number {
    let sum = 0;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        sum += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1];
    }
    return sum;
}

function ringContains(ring: number[], x: number, y: number): boolean {
    let inside = false;
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[2 * i];
        const yi = ring[2 * i + 1];
        const xj = ring[2 * j];
        const yj = ring[2 * j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function distanceToSegment(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number
): number {
    const vx = bx - ax;
    const vy = by - ay;
    const length2 = vx * vx + vy * vy;
    const t = length2
        ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / length2))
        : 0;
    return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

/** Douglas–Peucker on an open chain of flat points [from, to]. */
function simplifyChain(
    ring: number[],
    from: number,
    to: number,
    tolerance: number,
    keep: Uint8Array
) {
    const stack: Array<[number, number]> = [[from, to]];
    while (stack.length) {
        const [first, last] = stack.pop()!;
        let farthest = -1;
        let farthestDistance = tolerance;
        for (let i = first + 1; i < last; i++) {
            const d = distanceToSegment(
                ring[2 * i],
                ring[2 * i + 1],
                ring[2 * first],
                ring[2 * first + 1],
                ring[2 * last],
                ring[2 * last + 1]
            );
            if (d > farthestDistance) {
                farthest = i;
                farthestDistance = d;
            }
        }
        if (farthest >= 0) {
            keep[farthest] = 1;
            stack.push([first, farthest], [farthest, last]);
        }
    }
}

/**
 * Douglas–Peucker on a closed ring: split at its first vertex and the vertex
 * farthest from it, each half simplified. Null when fewer than 3 vertices
 * are left.
 */
export function simplifyRing(
    ring: number[],
    tolerance: number
): number[] | null {
    const n = ring.length / 2;
    if (n < 3) return null;
    let far = 0;
    let farDistance = -1;
    for (let i = 1; i < n; i++) {
        const d = Math.hypot(ring[2 * i] - ring[0], ring[2 * i + 1] - ring[1]);
        if (d > farDistance) {
            far = i;
            farDistance = d;
        }
    }
    const closed = ring.concat([ring[0], ring[1]]);
    const keep = new Uint8Array(n + 1);
    keep[0] = 1;
    keep[far] = 1;
    keep[n] = 1;
    simplifyChain(closed, 0, far, tolerance, keep);
    simplifyChain(closed, far, n, tolerance, keep);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        if (keep[i]) out.push(ring[2 * i], ring[2 * i + 1]);
    }
    return out.length >= 6 ? out : null;
}

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * The outlines of a mask, as polygons with holes, in raster pixels.
 *
 * Boundary edges between mask and background pixels are followed around
 * each region (crack following), keeping the mask on the right; at a vertex
 * where two regions touch diagonally the walk turns right, so the mask is
 * 4-connected and its background 8-connected, as the fill and the hole
 * filling assume. The vertices are then moved to the midpoints of the pixel
 * edges, which is the marching-squares contour of the mask at 0.5 (the
 * staircase becomes 45° steps), and simplified with Douglas–Peucker at
 * `tolerance` raster pixels. Rings whose area is under `minArea` square
 * pixels (outer rings and holes) are dropped.
 */
export function traceContours(
    result: WsiMaskResult,
    width: number,
    tolerance: number,
    minArea = 0
): WsiFlatPolygon[] {
    const { mask, minX, minY, maxX, maxY } = result;
    if (maxX < minX) return [];
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const inside = (x: number, y: number) =>
        x >= 0 &&
        y >= 0 &&
        x < w &&
        y < h &&
        mask[(minY + y) * width + minX + x] === 1;
    // Whether the boundary edge leaving vertex (x, y) in direction d exists.
    const edge = (x: number, y: number, d: number): boolean => {
        switch (d) {
            case 0: // east: the top of pixel (x, y)
                return inside(x, y) && !inside(x, y - 1);
            case 1: // south: the right of pixel (x - 1, y)
                return inside(x - 1, y) && !inside(x, y);
            case 2: // west: the bottom of pixel (x - 1, y - 1)
                return inside(x - 1, y - 1) && !inside(x - 1, y);
            default:
                // north: the left of pixel (x, y - 1)
                return inside(x, y - 1) && !inside(x - 1, y - 1);
        }
    };
    const vw = w + 1;
    const used = new Uint8Array(vw * (h + 1));
    const outers: number[][] = [];
    const holes: number[][] = [];
    for (let y = 0; y <= h; y++) {
        for (let x = 0; x <= w; x++) {
            for (let d0 = 0; d0 < 4; d0++) {
                if (used[y * vw + x] & (1 << d0) || !edge(x, y, d0)) continue;
                // Walk the loop, collecting the midpoint of each unit edge.
                const ring: number[] = [];
                let cx = x;
                let cy = y;
                let d = d0;
                for (;;) {
                    used[cy * vw + cx] |= 1 << d;
                    const nx = cx + DX[d];
                    const ny = cy + DY[d];
                    ring.push(minX + (cx + nx) / 2, minY + (cy + ny) / 2);
                    cx = nx;
                    cy = ny;
                    // The edge after this one: a right turn, else straight
                    // on, else a left turn. This pairs the edges at every
                    // vertex, so the walk comes back to its first edge.
                    let next = -1;
                    for (const turn of [1, 0, 3]) {
                        const nd = (d + turn) % 4;
                        if (edge(cx, cy, nd)) {
                            next = nd;
                            break;
                        }
                    }
                    if (next < 0 || used[cy * vw + cx] & (1 << next)) break;
                    d = next;
                }
                const simplified = simplifyRing(ring, tolerance);
                if (!simplified) continue;
                const area2 = ringArea2(simplified);
                if (Math.abs(area2) / 2 < minArea) continue;
                (area2 > 0 ? outers : holes).push(simplified);
            }
        }
    }
    // Each hole goes with the smallest outer ring holding it.
    const polygons: WsiFlatPolygon[] = outers.map(ring => [ring]);
    const areas = outers.map(ring => Math.abs(ringArea2(ring)));
    holes.forEach(hole => {
        let best = -1;
        for (let i = 0; i < outers.length; i++) {
            if (
                ringContains(outers[i], hole[0], hole[1]) &&
                (best < 0 || areas[i] < areas[best])
            ) {
                best = i;
            }
        }
        if (best >= 0) polygons[best].push(hole);
    });
    return polygons;
}

/** What the wand or the smart brush selected, in raster pixels. */
export interface WsiTissueResult {
    polygons: WsiFlatPolygon[];
    /** Pixels selected, after hole filling. */
    count: number;
    /** The raster borders the selection reaches. */
    touches: WsiMaskResult['touches'];
    /** The seed color, Lab; null when the seed was not on the slide. */
    color: [number, number, number] | null;
}

/** Options for turning a mask into outlines. */
export interface WsiOutlineOptions {
    /** Holes smaller than this many raster pixels are filled. */
    maxHoleArea: number;
    /** Douglas–Peucker tolerance, in raster pixels. */
    simplify: number;
    /** Parts smaller than this many square raster pixels are dropped. */
    minPartArea?: number;
}

function outline(
    result: WsiMaskResult,
    width: number,
    options: WsiOutlineOptions,
    color: [number, number, number] | null
): WsiTissueResult {
    fillSmallHoles(result, width, options.maxHoleArea);
    return {
        polygons: traceContours(
            result,
            width,
            options.simplify,
            options.minPartArea ?? 0
        ),
        count: result.count,
        touches: result.touches,
        color,
    };
}

/** The magic wand from a click at (x, y): fill, fill holes, outline. */
export function wandSelect(
    raster: WsiPreparedRaster,
    x: number,
    y: number,
    tolerance: number,
    options: WsiOutlineOptions,
    mask?: Uint8Array,
    color?: [number, number, number] | null
): WsiTissueResult {
    const seed = color || seedColor(raster, x, y);
    if (!seed) {
        return {
            polygons: [],
            count: 0,
            touches: emptyResult(new Uint8Array(0)).touches,
            color: null,
        };
    }
    const result = floodFill(raster, x, y, seed, tolerance, mask);
    return outline(result, raster.width, options, seed);
}

/**
 * The smart brush along `path`: the color under the stroke's first point
 * (or `color`), painted within `radius`, then outlined.
 */
export function smartBrushSelect(
    raster: WsiPreparedRaster,
    path: readonly WsiXYPoint[],
    radius: number,
    tolerance: number,
    options: WsiOutlineOptions,
    mask?: Uint8Array,
    color?: [number, number, number] | null
): WsiTissueResult {
    const seed =
        color || (path.length ? seedColor(raster, path[0].x, path[0].y) : null);
    if (!seed || !path.length) {
        return {
            polygons: [],
            count: 0,
            touches: emptyResult(new Uint8Array(0)).touches,
            color: null,
        };
    }
    const result = paintMask(raster, path, radius, seed, tolerance, mask);
    return outline(result, raster.width, options, seed);
}
