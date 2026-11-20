/**
 * @jest-environment jsdom
 */
import { regionArea } from './wsiAnnotationShapeOps';
import { createMainThreadEngine, WsiTissueEngine } from './wsiTissueEngine';
import {
    createOsdTissueHost,
    WsiTileLevel,
    WsiTissuePixelHost,
    WsiTissueRaster,
} from './wsiTissuePixels';
import { WsiTissueSession, WsiTissueView } from './wsiTissueSelect';

type Rect = { x0: number; y0: number; x1: number; y1: number };
const PURPLE = [120, 70, 165];

/** Purple rectangles on a transparent slide, 1024 px square, downsample 1. */
function paint(rects: Rect[], x0: number, y0: number, w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const ix = x0 + x;
            const iy = y0 + y;
            if (
                rects.some(
                    r => ix >= r.x0 && ix < r.x1 && iy >= r.y0 && iy < r.y1
                )
            ) {
                const p = (y * w + x) * 4;
                data[p] = PURPLE[0];
                data[p + 1] = PURPLE[1];
                data[p + 2] = PURPLE[2];
                data[p + 3] = 255;
            }
        }
    }
    return data;
}

function host(
    rects: Rect[],
    mode: 'screen' | 'tiles',
    size = 1024
): WsiTissuePixelHost {
    const level: WsiTileLevel = {
        level: 0,
        downsample: 1,
        width: size,
        height: size,
        tileWidth: 64,
        tileHeight: 64,
        columns: size / 64,
        rows: size / 64,
    };
    return {
        imagePerScreen: () => (mode === 'screen' ? 1 : 100),
        objectivePower: () => 40,
        mpp: () => null,
        viewKey: () => 'fixed',
        async readScreen(): Promise<WsiTissueRaster | null> {
            return {
                width: size,
                height: size,
                data: paint(rects, 0, 0, size, size),
                originX: 0,
                originY: 0,
                scale: 1,
                source: 'screen',
                edges: {
                    left: 'image',
                    top: 'image',
                    right: 'image',
                    bottom: 'image',
                },
            };
        },
        levels: () => [level],
        async fetchTile(_l, c, r) {
            return {
                width: 64,
                height: 64,
                data: paint(rects, c * 64, r * 64, 64, 64),
            };
        },
    };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean, tries = 500) {
    for (let i = 0; i < tries && !check(); i++) await tick();
    if (!check()) throw new Error('timed out');
}

describe('Tissue sessions: overlapping clicks, shared rasters, large canvases', () => {
    it('computes every Shift+click, even when two arrive while one runs', async () => {
        const rects: Rect[] = [
            { x0: 100, y0: 100, x1: 200, y1: 200 },
            { x0: 400, y0: 100, x1: 500, y1: 200 },
            { x0: 700, y0: 100, x1: 800, y1: 200 },
        ];
        const inner = createMainThreadEngine();
        let gate: (() => void) | null = null;
        let runs = 0;
        const engine: WsiTissueEngine = {
            ...inner,
            kind: 'main',
            setRaster: (r, b) => inner.setRaster(r, b),
            run: async request => {
                runs += 1;
                if (runs === 1) {
                    // The first click's outline takes a while (a big raster).
                    await new Promise<void>(resolve => (gate = resolve));
                }
                return inner.run(request);
            },
            drop: id => inner.drop(id),
            dispose: () => inner.dispose(),
        };
        const views: Array<WsiTissueView | null> = [];
        const session = new WsiTissueSession(
            'wand',
            host(rects, 'screen'),
            view => views.push(view),
            () => Promise.resolve(engine)
        );
        void session.wandClick({ x: 150, y: 150 }, 'new', 15);
        await until(() => !!gate);
        void session.wandClick({ x: 450, y: 150 }, 'add', 15);
        await tick();
        await tick();
        void session.wandClick({ x: 750, y: 150 }, 'add', 15);
        await tick();
        await tick();
        gate!();
        await session.whenIdle();
        expect(views[views.length - 1]!.steps).toBe(3);
        // Each square is 100×100; all three Shift-combined.
        expect(regionArea(session.region)).toBeGreaterThan(29000);
    });

    it('keeps an earlier step working after a later step grew the shared tile window', async () => {
        // A small square, and a long stripe that runs past the first window.
        const rects: Rect[] = [
            { x0: 290, y0: 290, x1: 330, y1: 330 },
            { x0: 0, y0: 400, x1: 1024, y1: 420 },
        ];
        const engine = createMainThreadEngine();
        const views: Array<WsiTissueView | null> = [];
        const session = new WsiTissueSession(
            'wand',
            host(rects, 'tiles'),
            view => views.push(view),
            () => Promise.resolve(engine)
        );
        await session.wandClick({ x: 310, y: 310 }, 'new', 15);
        const square = regionArea(session.region);
        // Shift+click on the stripe: same window, then it grows to the right.
        await session.wandClick({ x: 310, y: 410 }, 'add', 15);
        expect(views[views.length - 1]!.steps).toBe(2);
        // Ctrl+Z takes back the stripe; scroll changes the first's tolerance.
        expect(session.undoStep()).toBe(true);
        session.setTolerance(20);
        await session.whenIdle();
        const last = views[views.length - 1]!;
        expect(last.note).toBeNull();
        expect(regionArea(session.region)).toBeCloseTo(square, 6);
        expect(square).toBeGreaterThan(1500);
    });

    it('selects at a click anywhere on a large hi-DPI canvas', async () => {
        // 2600×1200 CSS pixels at devicePixelRatio 2: a 5200×2400 canvas.
        const cssWidth = 2600;
        const ratio = 2;
        const canvas = document.createElement('canvas');
        canvas.width = cssWidth * ratio;
        canvas.height = 1200 * ratio;
        Object.defineProperty(canvas, 'clientWidth', { value: cssWidth });
        // Slide = canvas at 0.5 image px per canvas px (1 per CSS px).
        const rects: Rect[] = [
            { x0: 100, y0: 500, x1: 300, y1: 700 },
            { x0: 1200, y0: 500, x1: 1400, y1: 700 },
        ];
        (canvas as any).getContext = () => ({
            getImageData: (x: number, y: number, w: number, h: number) => {
                // canvas px (x, y) shows image (x / 2, y / 2)
                const data = new Uint8ClampedArray(w * h * 4);
                for (let yy = 0; yy < h; yy++) {
                    for (let xx = 0; xx < w; xx++) {
                        const ix = (x + xx) / 2;
                        const iy = (y + yy) / 2;
                        if (
                            rects.some(
                                r =>
                                    ix >= r.x0 &&
                                    ix < r.x1 &&
                                    iy >= r.y0 &&
                                    iy < r.y1
                            )
                        ) {
                            const p = (yy * w + xx) * 4;
                            data.set([...PURPLE, 255], p);
                        }
                    }
                }
                return { data };
            },
        });
        const viewer = {
            drawer: { canvas },
            container: { clientWidth: cssWidth },
            viewport: { getRotation: () => 0, getFlip: () => false },
            world: {
                getItemAt: () => ({
                    getFullyLoaded: () => true,
                    source: { dimensions: { x: 100000, y: 100000 } },
                }),
            },
        };
        const pixelHost = createOsdTissueHost({
            viewer,
            imagePoint: (x, y) => ({ x, y }),
            mpp: () => null,
            objectivePower: () => 40,
        });
        const views: Array<WsiTissueView | null> = [];
        const session = new WsiTissueSession(
            'wand',
            pixelHost,
            view => views.push(view),
            () => Promise.resolve(createMainThreadEngine())
        );
        // Control: the square in the middle of the view is selected.
        await session.wandClick({ x: 1300, y: 600 }, 'new', 15);
        expect(regionArea(session.region)).toBeGreaterThan(30000);
        // A click on the square near the left of the view.
        await session.wandClick({ x: 200, y: 600 }, 'new', 15);
        const last = views[views.length - 1]!;
        expect(last.source).toBe('screen');
        expect(Math.round(regionArea(session.region))).toBeGreaterThan(30000);
    });

    it("shows nothing after Esc while the click's tiles still load, and cancels them", async () => {
        const rects: Rect[] = [{ x0: 290, y0: 290, x1: 330, y1: 330 }];
        const base = host(rects, 'tiles');
        const waiting: Array<() => void> = [];
        const signals: AbortSignal[] = [];
        const slow: WsiTissuePixelHost = {
            ...base,
            fetchTile: (l, c, r, signal) => {
                if (signal) signals.push(signal);
                return new Promise(resolve =>
                    waiting.push(() => resolve(base.fetchTile(l, c, r)))
                );
            },
        };
        const views: Array<WsiTissueView | null> = [];
        const session = new WsiTissueSession(
            'wand',
            slow,
            view => views.push(view),
            () => Promise.resolve(createMainThreadEngine())
        );
        const click = session.wandClick({ x: 310, y: 310 }, 'new', 15);
        await until(() => waiting.length > 0);
        // Esc: the outline is dropped.
        session.discard();
        expect(views[views.length - 1]).toBeNull();
        while (waiting.length) {
            waiting.splice(0).forEach(go => go());
            await tick();
        }
        await click;
        expect(views[views.length - 1]).toBeNull();
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.every(signal => signal.aborted)).toBe(true);
    });

    it("cancels a click's tile fetches when a new click starts another outline", async () => {
        const rects: Rect[] = [
            { x0: 50, y0: 50, x1: 90, y1: 90 },
            { x0: 900, y0: 900, x1: 940, y1: 940 },
        ];
        const base = host(rects, 'tiles');
        const held: Array<{ signal?: AbortSignal; go: () => void }> = [];
        const slow: WsiTissuePixelHost = {
            ...base,
            fetchTile: (l, c, r, signal) =>
                new Promise(resolve =>
                    held.push({
                        signal,
                        go: () => resolve(base.fetchTile(l, c, r)),
                    })
                ),
        };
        const views: Array<WsiTissueView | null> = [];
        const session = new WsiTissueSession(
            'wand',
            slow,
            view => views.push(view),
            () => Promise.resolve(createMainThreadEngine())
        );
        const first = session.wandClick({ x: 70, y: 70 }, 'new', 15);
        await until(() => held.length > 0);
        const firstFetches = held.splice(0);
        const second = session.wandClick({ x: 920, y: 920 }, 'new', 15);
        expect(firstFetches.every(({ signal }) => signal?.aborted)).toBe(true);
        firstFetches.forEach(({ go }) => go());
        while (!session.region.length) {
            held.splice(0).forEach(({ go }) => go());
            await tick();
        }
        await Promise.all([first, second]);
        const last = views[views.length - 1]!;
        expect(last.seed).toEqual({ x: 920, y: 920 });
        expect(last.fetching).toBe(0);
        expect(regionArea(session.region)).toBeGreaterThan(1500);
    });
});
