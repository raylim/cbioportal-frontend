import { WsiRegion } from './wsiAnnotationGeometryUtils';
import {
    regionArea,
    regionBounds,
    subtractRegions,
} from './wsiAnnotationShapeOps';
import { createMainThreadEngine } from './wsiTissueEngine';
import {
    effectiveMagnification,
    pickLevel,
    targetDownsample,
    useScreenPixels,
    WsiTileMosaic,
} from './wsiTissuePixels';
import {
    combineSteps,
    outlineOptions,
    WsiTissueSession,
    WsiTissueView,
} from './wsiTissueSelect';
import { testSlideHost, TestSlideHostOptions } from './wsiTissueTestSlide';

const square = (x: number, y: number, size: number): WsiRegion => [
    [
        [
            { x, y },
            { x: x + size, y },
            { x: x + size, y: y + size },
            { x, y: y + size },
        ],
    ],
];

/** A wand session on the synthetic slide, with its last view. */
function session(
    tool: 'wand' | 'smartBrush',
    options: TestSlideHostOptions = {},
    cap?: number
) {
    const host = testSlideHost(options);
    const views: Array<WsiTissueView | null> = [];
    const engine = createMainThreadEngine();
    const tissue = new WsiTissueSession(
        tool,
        host,
        view => views.push(view),
        () => Promise.resolve(engine),
        cap
    );
    return {
        host,
        tissue,
        views,
        last: () => views[views.length - 1],
    };
}

/** The area of what two regions do not share, over the first's area. */
function mismatch(a: WsiRegion, b: WsiRegion): number {
    const apart =
        regionArea(subtractRegions(a, [b])) +
        regionArea(subtractRegions(b, [a]));
    return apart / regionArea(a);
}

const PURPLE_AREA = Math.PI * 600 * 600;

// The synthetic slide is rendered pixel by pixel in JavaScript.
jest.setTimeout(60_000);

describe('tissue pixel sources', () => {
    it('reads on-screen pixels from 10× and fetches tiles below', () => {
        expect(effectiveMagnification(40, null, 1)).toBe(40);
        expect(effectiveMagnification(40, null, 4)).toBe(10);
        // Without an objective power, 10× is 1 µm per screen pixel.
        expect(effectiveMagnification(undefined, { x: 0.25, y: 0.25 }, 4)).toBe(
            10
        );
        expect(effectiveMagnification(undefined, null, 4)).toBeNull();
        const at = (imagePerScreen: number, extra: TestSlideHostOptions = {}) =>
            useScreenPixels(testSlideHost({ imagePerScreen, ...extra }));
        expect(at(1)).toBe(true);
        expect(at(4)).toBe(true);
        expect(at(4.5)).toBe(false);
        expect(at(32)).toBe(false);
        // A 20× scan: 10× is 2 image pixels per screen pixel.
        expect(at(2, { objectivePower: 20 })).toBe(true);
        expect(at(2.5, { objectivePower: 20 })).toBe(false);
        // Neither power nor scale: on screen only at native resolution.
        expect(at(1, { objectivePower: 0, mpp: null })).toBe(true);
        expect(at(2, { objectivePower: 0, mpp: null })).toBe(false);
    });

    it('fetches the tiles of the level nearest 10×', () => {
        const host = testSlideHost();
        expect(targetDownsample(host)).toBe(4);
        expect(pickLevel(host.levels(), 4)!.downsample).toBe(4);
        // A 20× scan wants downsample 2.
        expect(targetDownsample(testSlideHost({ objectivePower: 20 }))).toBe(2);
        // Without that level, the coarsest finer one.
        const levels = host.levels().filter(level => level.downsample !== 4);
        expect(pickLevel(levels, 4)!.downsample).toBe(2);
        expect(pickLevel([], 4)).toBeNull();
    });

    it('stitches tiles into one raster, with edge and failed tiles', async () => {
        // 1000 pixels square: at downsample 4 the level is 250 pixels, one
        // partial tile; at downsample 1 it is 4×4 tiles, the last partial.
        const host = testSlideHost({ size: 1000, failTiles: ['10,1,1'] });
        const level = host.levels().find(item => item.downsample === 1)!;
        const mosaic = new WsiTileMosaic(host, level);
        await mosaic.cover({ minX: 300, minY: 300, maxX: 900, maxY: 900 });
        expect([mosaic.c0, mosaic.c1, mosaic.r0, mosaic.r1]).toEqual([
            1,
            3,
            1,
            3,
        ]);
        const raster = mosaic.raster();
        expect(raster.width).toBe(1000 - 256);
        expect(raster.height).toBe(1000 - 256);
        expect(raster.originX).toBe(256);
        expect(raster.scale).toBe(1);
        expect(raster.edges).toEqual({
            left: 'more',
            top: 'more',
            right: 'image',
            bottom: 'image',
        });
        const alpha = (x: number, y: number) =>
            raster.data[((y - 256) * raster.width + (x - 256)) * 4 + 3];
        // Tile (1, 1) failed: transparent; its neighbour is opaque.
        expect(alpha(300, 300)).toBe(0);
        expect(alpha(600, 300)).toBe(255);
        expect(alpha(999, 999)).toBe(255);
        // Growing left and up adds the first column and row once.
        expect(await mosaic.grow({ left: true, top: true })).toBe(true);
        expect([mosaic.c0, mosaic.r0]).toEqual([0, 0]);
        expect(await mosaic.grow({ left: true })).toBe(false);
        expect(host.fetched.filter(key => key === '10,2,2')).toHaveLength(1);
    });

    it('caps the raster and says which sides are cut', async () => {
        const host = testSlideHost();
        const level = host.levels().find(item => item.downsample === 1)!;
        const mosaic = new WsiTileMosaic(host, level, 1024);
        await mosaic.cover({ minX: 0, minY: 0, maxX: 4000, maxY: 300 });
        expect(mosaic.capped).toBe(true);
        expect(mosaic.c1 - mosaic.c0 + 1).toBe(4);
        expect(await mosaic.grow({ right: true })).toBe(false);
        const raster = mosaic.raster();
        expect(raster.width).toBe(1024);
        expect(raster.edges.right).toBe('cap');
        expect(raster.edges.bottom).toBe('more');
    });
});

describe('tissue sessions', () => {
    it('outlines the same tissue from on-screen pixels and from tiles', async () => {
        // The purple disk at (3000, 4000), radius 600: in view at 40×.
        // 20× with devicePixelRatio 2: one image pixel per canvas pixel.
        const screen = session('wand', {
            imagePerScreen: 2,
            viewX: 2300,
            viewY: 3300,
            devicePixelRatio: 2,
            viewWidth: 700,
            viewHeight: 700,
        });
        await screen.tissue.wandClick({ x: 3000, y: 4000 }, 'new', 15);
        expect(screen.last()!.source).toBe('screen');
        expect(screen.host.fetched).toHaveLength(0);
        const fromScreen = screen.tissue.region;
        // Zoomed out to 2.5×: 10× tiles around the click.
        const tiles = session('wand', { imagePerScreen: 16 });
        await tiles.tissue.wandClick({ x: 3000, y: 4000 }, 'new', 15);
        expect(tiles.last()!.source).toBe('tiles');
        expect(tiles.host.screenReads).toBe(0);
        expect(tiles.host.fetched.every(key => key.startsWith('11,'))).toBe(
            true
        );
        const fromTiles = tiles.tissue.region;
        [fromScreen, fromTiles].forEach(region => {
            expect(region).toHaveLength(1);
            expect(region[0]).toHaveLength(1);
            expect(regionArea(region) / PURPLE_AREA).toBeGreaterThan(0.97);
            expect(regionArea(region) / PURPLE_AREA).toBeLessThan(1.03);
            const box = regionBounds(region)!;
            expect(box.minX).toBeCloseTo(2400, -1);
            expect(box.maxY).toBeCloseTo(4600, -1);
        });
        // In image pixels, and within 3% of each other.
        expect(mismatch(fromScreen, fromTiles)).toBeLessThan(0.03);
        expect(screen.last()!.ms).not.toBeNull();
    });

    it('falls back to tiles when the screen cannot be read', async () => {
        const run = session('wand', {
            imagePerScreen: 1,
            viewX: 2200,
            viewY: 3300,
            screenUnavailable: true,
        });
        await run.tissue.wandClick({ x: 3000, y: 4000 }, 'new', 15);
        expect(run.last()!.source).toBe('tiles');
        expect(regionArea(run.tissue.region) / PURPLE_AREA).toBeGreaterThan(
            0.97
        );
    });

    it('grows the tile window as the fill spreads, keeping the lumen a hole', async () => {
        // A click on the pink tissue: the disk (radius 2400 = 1200 pixels
        // at 10×) outgrows the first 1024-pixel window.
        const run = session('wand', { imagePerScreen: 32 });
        await run.tissue.wandClick({ x: 4096, y: 2000 }, 'new', 12);
        const region = run.tissue.region;
        const box = regionBounds(region)!;
        expect(box.minY).toBeLessThan(1720);
        expect(box.maxY).toBeGreaterThan(6470);
        // The purple disk, the lumen and the brown disk are holes; the
        // pink area is the disk less them.
        expect(region).toHaveLength(1);
        expect(region[0].length).toBe(4);
        const expected =
            Math.PI * (2400 * 2400 - 600 * 600 - 300 * 300 - 250 * 250);
        expect(regionArea(region) / expected).toBeGreaterThan(0.97);
        expect(regionArea(region) / expected).toBeLessThan(1.03);
        expect(run.last()!.note).toBeNull();
        // Pixels a side: within the 4096 cap.
        expect(run.host.fetched.length).toBeLessThanOrEqual(16 * 16);
    });

    it('says when the outline is cut at the size limit or the view', async () => {
        // The white background, at 10× tiles, spreads past the cap.
        const run = session('wand', { imagePerScreen: 32 }, 1024);
        await run.tissue.wandClick({ x: 300, y: 300 }, 'new', 10);
        expect(run.last()!.note).toBe(
            'The outline stops at the 1024-pixel limit (about 1.0 mm across): add the rest with Shift+click.'
        );
        const box = regionBounds(run.tissue.region)!;
        expect(box.maxX).toBeLessThanOrEqual(1024 * 4);
        const view = session('wand', {
            imagePerScreen: 1,
            viewX: 3500,
            viewY: 3500,
            viewWidth: 600,
            viewHeight: 600,
        });
        await view.tissue.wandClick({ x: 4096, y: 3800 }, 'new', 12);
        expect(view.last()!.note).toBe(
            'The outline stops at the edge of the view: zoom out to select more.'
        );
    });

    it('changes the outline with the tolerance, the latest change winning', async () => {
        // The pink and a slightly darker pink half.
        const run = session('wand', {
            imagePerScreen: 1,
            viewX: 0,
            viewY: 0,
            viewWidth: 400,
            viewHeight: 200,
            size: 400,
            disks: [
                { x: 0, y: 0, r: 0, color: [0, 0, 0] },
                { x: 600, y: 100, r: 400, color: [185, 100, 160] },
                { x: -200, y: 100, r: 400, color: [232, 160, 205] },
            ],
        });
        await run.tissue.wandClick({ x: 50, y: 100 }, 'new', 8);
        const narrow = regionArea(run.tissue.region);
        run.tissue.setTolerance(20);
        run.tissue.setTolerance(40);
        await run.tissue.whenIdle();
        expect(run.tissue.tolerance).toBe(40);
        expect(run.last()!.tolerance).toBe(40);
        expect(regionArea(run.tissue.region)).toBeGreaterThan(narrow * 1.5);
    });

    it('adds with Shift and cuts with Alt, and takes back a click', async () => {
        const run = session('wand', {
            imagePerScreen: 4,
            viewX: 1500,
            viewY: 1500,
            viewWidth: 1400,
            viewHeight: 1400,
        });
        // The purple disk, then the brown disk added.
        await run.tissue.wandClick({ x: 3000, y: 4000 }, 'new', 15);
        await run.tissue.wandClick({ x: 4300, y: 5600 }, 'add', 15);
        expect(run.tissue.region).toHaveLength(2);
        const both = regionArea(run.tissue.region);
        expect(both / (PURPLE_AREA + Math.PI * 250 * 250)).toBeGreaterThan(
            0.96
        );
        // Back to the purple disk alone.
        expect(run.tissue.undoStep()).toBe(true);
        expect(run.tissue.region).toHaveLength(1);
        expect(run.last()!.steps).toBe(1);
        // A pink click over the lumen, then the lumen cut out: a hole.
        await run.tissue.wandClick({ x: 4600, y: 4200 }, 'new', 12);
        const pink = run.tissue.region;
        await run.tissue.wandClick({ x: 5000, y: 4200 }, 'subtract', 12);
        // The lumen was a hole already; cutting it again keeps it so.
        expect(regionArea(run.tissue.region)).toBeCloseTo(regionArea(pink), -2);
        expect(run.tissue.undoStep()).toBe(true);
        expect(run.tissue.undoStep()).toBe(false);
        expect(run.tissue.pending).toBe(false);
        expect(run.last()).toBeNull();
    });

    it('combines steps: Shift unions, Alt subtracts', () => {
        const a = square(0, 0, 100);
        const b = square(50, 0, 100);
        const hole = square(20, 20, 10);
        expect(
            regionArea(
                combineSteps([
                    { kind: 'new', region: a },
                    { kind: 'add', region: b },
                ])
            )
        ).toBe(15000);
        const holed = combineSteps([
            { kind: 'new', region: a },
            { kind: 'subtract', region: hole },
        ]);
        expect(holed[0]).toHaveLength(2);
        expect(regionArea(holed)).toBe(9900);
        // Subtracting from nothing leaves nothing.
        expect(combineSteps([{ kind: 'subtract', region: a }])).toEqual([]);
    });

    it('sets hole filling and simplification in µm', () => {
        // 1 µm per raster pixel: holes under 500 pixels, 1 pixel tolerance.
        expect(outlineOptions(4, { x: 0.25, y: 0.25 })).toEqual({
            maxHoleArea: 500,
            simplify: 1,
            minPartArea: 50,
        });
        // 0.125 µm per pixel (on screen at 80×): the 0.75-pixel floor is
        // under 1 µm, so 8 pixels.
        expect(outlineOptions(0.5, { x: 0.25, y: 0.25 }).simplify).toBe(8);
        expect(outlineOptions(1, null)).toEqual({
            maxHoleArea: 64,
            simplify: 0.75,
            minPartArea: 4,
        });
    });

    it('paints with the smart brush up to the edge of the tissue', async () => {
        // A stroke along the purple disk's left edge, 200 µm wide: only the
        // purple side is painted.
        for (const imagePerScreen of [2, 16]) {
            const run = session('smartBrush', {
                imagePerScreen,
                viewX: 2000,
                viewY: 3000,
                viewWidth: 1200,
                viewHeight: 1200,
            });
            run.tissue.strokeStart({ x: 2440, y: 3800 }, 400, 15);
            [3850, 3900, 3950, 4000, 4050, 4100, 4150, 4200].forEach(y =>
                run.tissue.strokeAdd({ x: 2440, y })
            );
            const { region } = await run.tissue.strokeEnd();
            expect(region.length).toBeGreaterThanOrEqual(1);
            const box = regionBounds(region)!;
            // The disk's edge is at x = 2400 at y = 4000.
            expect(box.minX).toBeGreaterThan(2390);
            expect(box.maxX).toBeLessThan(2860);
            // Everything painted is inside the disk.
            region.forEach(rings =>
                rings[0].forEach(point =>
                    expect(
                        Math.hypot(point.x - 3000, point.y - 4000)
                    ).toBeLessThan(612)
                )
            );
            expect(run.last()!.source).toBe(
                imagePerScreen === 2 ? 'screen' : 'tiles'
            );
        }
    });
});
