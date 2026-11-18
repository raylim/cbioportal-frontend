import {
    fillSmallHoles,
    floodFill,
    labDistance,
    paintMask,
    prepareRaster,
    rgbToLab,
    seedColor,
    simplifyRing,
    smartBrushSelect,
    traceContours,
    wandSelect,
    WsiRgbaRaster,
} from './wsiTissueCore';

type Rgb = [number, number, number];
const WHITE: Rgb = [245, 245, 245];
const PINK: Rgb = [230, 150, 200];
const PURPLE: Rgb = [110, 60, 160];
const BROWN: Rgb = [150, 95, 50];

/** A raster painted by `color(x, y)` (null: transparent). */
function raster(
    width: number,
    height: number,
    color: (x: number, y: number) => Rgb | null
): WsiRgbaRaster {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const c = color(x, y);
            const i = (y * width + x) * 4;
            if (!c) continue;
            data[i] = c[0];
            data[i + 1] = c[1];
            data[i + 2] = c[2];
            data[i + 3] = 255;
        }
    }
    return { width, height, data };
}

const inBox = (
    x: number,
    y: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number
) => x >= x0 && x < x1 && y >= y0 && y < y1;

const OPTIONS = { maxHoleArea: 0, simplify: 0.5 };

function ringArea(ring: number[]): number {
    let sum = 0;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        sum += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1];
    }
    return Math.abs(sum) / 2;
}

const polygonArea = (rings: number[][]) =>
    rings.reduce((sum, ring, i) => sum + (i ? -1 : 1) * ringArea(ring), 0);

describe('tissue selection core', () => {
    it('measures color distance in Lab with lightness counting half', () => {
        const white = rgbToLab(255, 255, 255);
        expect(white[0]).toBeCloseTo(100, 1);
        expect(Math.abs(white[1])).toBeLessThan(0.01);
        // A pure lightness difference counts half.
        expect(labDistance([60, 10, 10], [40, 10, 10])).toBeCloseTo(10, 5);
        expect(labDistance([50, 30, 10], [50, 10, 10])).toBeCloseTo(20, 5);
        // H&E: eosin pink and hematoxylin purple are far apart; so are DAB
        // brown and hematoxylin, and pink tissue and the white background.
        const d = (a: Rgb, b: Rgb) =>
            labDistance(rgbToLab(...a), rgbToLab(...b));
        expect(d(PINK, PURPLE)).toBeGreaterThan(30);
        expect(d(BROWN, PURPLE)).toBeGreaterThan(30);
        expect(d(PINK, WHITE)).toBeGreaterThan(30);
    });

    it('flood fills the connected similar region from the click', () => {
        // Two pink boxes on white; only the clicked one is filled.
        const r = prepareRaster(
            raster(60, 40, (x, y) =>
                inBox(x, y, 5, 5, 25, 35) || inBox(x, y, 35, 5, 55, 35)
                    ? PINK
                    : WHITE
            )
        );
        const color = seedColor(r, 15, 20)!;
        const result = floodFill(r, 15, 20, color, 15);
        // The 3×3 blur blends the boxes' edges: the fill keeps the box
        // less at most its blended rim.
        expect(result.count).toBeGreaterThanOrEqual(18 * 28);
        expect(result.count).toBeLessThan(22 * 32);
        expect(result.minX).toBeGreaterThanOrEqual(4);
        expect(result.maxX).toBeLessThanOrEqual(25);
        expect(result.touches).toEqual({
            left: false,
            top: false,
            right: false,
            bottom: false,
        });
        // Transparent pixels are never filled.
        const voided = prepareRaster(
            raster(10, 10, x => (x < 5 ? PINK : null))
        );
        expect(
            floodFill(voided, 2, 5, seedColor(voided, 2, 5)!, 80).count
        ).toBe(50);
    });

    it('grows with the tolerance: a darker pink joins only above its distance', () => {
        const DARKER: Rgb = [200, 120, 175];
        const r = prepareRaster(raster(40, 20, x => (x < 20 ? PINK : DARKER)));
        const pinkLab = rgbToLab(...PINK);
        const gap = labDistance(pinkLab, rgbToLab(...DARKER));
        const color = seedColor(r, 5, 10)!;
        const narrow = floodFill(r, 5, 10, color, gap * 0.5);
        expect(narrow.maxX).toBeLessThan(21);
        const wide = floodFill(r, 5, 10, color, gap * 1.5);
        expect(wide.count).toBe(40 * 20);
        expect(wide.touches).toEqual({
            left: true,
            top: true,
            right: true,
            bottom: true,
        });
    });

    it('traces a square into one ring with its corners cut (marching squares)', () => {
        const r = prepareRaster(
            raster(20, 20, (x, y) =>
                inBox(x, y, 5, 5, 15, 15) ? PURPLE : WHITE
            )
        );
        const mask = new Uint8Array(400);
        for (let y = 5; y < 15; y++)
            for (let x = 5; x < 15; x++) mask[y * 20 + x] = 1;
        const polygons = traceContours(
            {
                mask,
                count: 100,
                minX: 5,
                minY: 5,
                maxX: 14,
                maxY: 14,
                touches: {
                    left: false,
                    top: false,
                    right: false,
                    bottom: false,
                },
            },
            20,
            0.1
        );
        expect(r.width).toBe(20);
        expect(polygons).toHaveLength(1);
        expect(polygons[0]).toHaveLength(1);
        // Edge midpoints: the 10×10 square less 4 corner triangles of 1/8.
        expect(ringArea(polygons[0][0])).toBeCloseTo(99.5, 5);
        // Simplified to the 8 vertices of the cut corners.
        expect(polygons[0][0].length / 2).toBe(8);
    });

    it('keeps a large hole and fills a small one', () => {
        // A 40×40 pink square with a 12×12 white hole and a 2×2 white speck.
        const r = prepareRaster(
            raster(50, 50, (x, y) =>
                inBox(x, y, 5, 5, 45, 45) &&
                !inBox(x, y, 10, 10, 22, 22) &&
                !inBox(x, y, 33, 33, 35, 35)
                    ? PINK
                    : WHITE
            )
        );
        const color = seedColor(r, 30, 12)!;
        const kept = wandSelect(r, 30, 12, 15, OPTIONS, undefined, color);
        expect(kept.polygons).toHaveLength(1);
        // Outer ring, the hole and the speck (the blur shrinks the speck but
        // keeps a pixel or so of it).
        expect(kept.polygons[0].length).toBeGreaterThanOrEqual(2);
        const filled = wandSelect(
            r,
            30,
            12,
            15,
            { ...OPTIONS, maxHoleArea: 50 },
            undefined,
            color
        );
        expect(filled.polygons[0]).toHaveLength(2);
        const hole = filled.polygons[0][1];
        expect(ringArea(hole)).toBeGreaterThan(9 * 9);
        expect(ringArea(hole)).toBeLessThan(14 * 14);
        expect(filled.count).toBeGreaterThan(kept.count);
    });

    it('fills small holes directly on a mask', () => {
        const width = 10;
        const mask = new Uint8Array(100).fill(0);
        for (let y = 1; y < 9; y++)
            for (let x = 1; x < 9; x++) mask[y * width + x] = 1;
        mask[4 * width + 4] = 0;
        const result = {
            mask,
            count: 63,
            minX: 1,
            minY: 1,
            maxX: 8,
            maxY: 8,
            touches: { left: false, top: false, right: false, bottom: false },
        };
        expect(fillSmallHoles(result, width, 2)).toBe(1);
        expect(mask[44]).toBe(1);
        expect(result.count).toBe(64);
    });

    it('splits regions touching only at a corner into two parts', () => {
        const width = 6;
        const mask = new Uint8Array(36);
        // Two 2×2 blocks meeting diagonally at (3, 3).
        [
            [1, 1],
            [2, 1],
            [1, 2],
            [2, 2],
            [3, 3],
            [4, 3],
            [3, 4],
            [4, 4],
        ].forEach(([x, y]) => (mask[y * width + x] = 1));
        const polygons = traceContours(
            {
                mask,
                count: 8,
                minX: 1,
                minY: 1,
                maxX: 4,
                maxY: 4,
                touches: {
                    left: false,
                    top: false,
                    right: false,
                    bottom: false,
                },
            },
            width,
            0.01
        );
        expect(polygons).toHaveLength(2);
        polygons.forEach(polygon => {
            expect(polygon).toHaveLength(1);
            expect(ringArea(polygon[0])).toBeCloseTo(3.5, 5);
        });
    });

    it('simplifies a closed ring with Douglas–Peucker', () => {
        // A square with extra points along its sides and a 0.2 bump.
        const ring = [0, 0, 5, 0.2, 10, 0, 10, 5, 10, 10, 5, 10, 0, 10, 0, 5];
        expect(simplifyRing(ring, 0.5)).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
        const bumped = simplifyRing(ring, 0.1)!;
        expect(bumped.length / 2).toBe(5);
        expect(simplifyRing([0, 0, 1, 1], 0.1)).toBeNull();
    });

    it('paints only similar pixels under the smart brush, stopping at the edge', () => {
        // Pink on the left half, purple on the right; a stroke along the
        // middle of the pink half with a radius that reaches the purple.
        const r = prepareRaster(raster(60, 30, x => (x < 30 ? PINK : PURPLE)));
        const path = [
            { x: 22, y: 5 },
            { x: 22, y: 25 },
        ];
        const result = paintMask(r, path, 12, seedColor(r, 22, 5)!, 15);
        expect(result.count).toBeGreaterThan(0);
        expect(result.maxX).toBeLessThan(30);
        expect(result.minX).toBeGreaterThanOrEqual(10);
        // Similar tissue across a gap is not reached.
        const gap = prepareRaster(
            raster(60, 30, x => (x < 20 || x >= 26 ? PINK : PURPLE))
        );
        const across = paintMask(
            gap,
            [
                { x: 15, y: 5 },
                { x: 15, y: 25 },
            ],
            14,
            seedColor(gap, 15, 5)!,
            15
        );
        expect(across.maxX).toBeLessThan(20);
        // Multi-part: a stroke over pink, purple, pink paints two parts.
        const stripes = prepareRaster(
            raster(60, 20, x => (x >= 25 && x < 35 ? PURPLE : PINK))
        );
        const parts = smartBrushSelect(
            stripes,
            [
                { x: 5, y: 10 },
                { x: 55, y: 10 },
            ],
            4,
            15,
            OPTIONS
        );
        expect(parts.polygons).toHaveLength(2);
        expect(polygonArea(parts.polygons[0])).toBeGreaterThan(50);
    });

    it('selects nothing where the seed is off the slide', () => {
        const r = prepareRaster(raster(10, 10, () => null));
        const result = wandSelect(r, 5, 5, 20, OPTIONS);
        expect(result.polygons).toEqual([]);
        expect(result.color).toBeNull();
    });
});
