/**
 * @jest-environment jsdom
 */
import { createOsdTissueHost, FULLY_LOADED_WAIT_MS } from './wsiTissuePixels';

/**
 * A stand-in OpenSeadragon viewer: a canvas of `cssWidth`×`cssHeight` CSS
 * pixels at `ratio` device pixels each, showing the slide from image point
 * (`x0`, `y0`) at `perScreen` image pixels per CSS pixel; a tile source of
 * an 8192-pixel slide with 256-pixel tiles.
 */
function fakeViewer(
    options: {
        ratio?: number;
        perScreen?: number;
        x0?: number;
        y0?: number;
        rotation?: number;
        tainted?: boolean;
        fullyLoaded?: boolean;
    } = {}
) {
    const ratio = options.ratio ?? 2;
    const cssWidth = 400;
    const cssHeight = 300;
    const handlers: Record<string, Array<(event: any) => void>> = {};
    const canvas = document.createElement('canvas');
    canvas.width = cssWidth * ratio;
    canvas.height = cssHeight * ratio;
    Object.defineProperty(canvas, 'clientWidth', { value: cssWidth });
    const reads: number[][] = [];
    (canvas as any).getContext = () => ({
        getImageData: (x: number, y: number, w: number, h: number) => {
            if (options.tainted) {
                throw new DOMException('tainted', 'SecurityError');
            }
            reads.push([x, y, w, h]);
            return { data: new Uint8ClampedArray(w * h * 4).fill(200) };
        },
    });
    const item = {
        getFullyLoaded: () => options.fullyLoaded ?? true,
        addHandler: (name: string, handler: any) =>
            (handlers[name] = [...(handlers[name] || []), handler]),
        removeHandler: jest.fn(),
        source: {
            dimensions: { x: 8192, y: 8192 },
            minLevel: 8,
            maxLevel: 13,
            getLevelScale: (level: number) => Math.pow(2, level - 13),
            getNumTiles: (level: number) => ({
                x: Math.ceil((8192 * Math.pow(2, level - 13)) / 256),
                y: Math.ceil((8192 * Math.pow(2, level - 13)) / 256),
            }),
            getTileWidth: () => 256,
            getTileHeight: () => 256,
            getTileUrl: (level: number, x: number, y: number) =>
                `/wsi/tiles/zxy/${level}/${x}/${y}?studyId=s`,
        },
    };
    const viewer = {
        drawer: { canvas },
        container: { clientWidth: cssWidth },
        viewport: {
            getRotation: () => options.rotation ?? 0,
            getFlip: () => false,
        },
        world: { getItemAt: () => item },
    };
    const perScreen = options.perScreen ?? 0.5;
    const x0 = options.x0 ?? 1000;
    const y0 = options.y0 ?? 2000;
    const imagePoint = (x: number, y: number) => ({
        x: x0 + x * perScreen,
        y: y0 + y * perScreen,
    });
    return { viewer, imagePoint, reads, handlers };
}

describe('the OpenSeadragon pixel host', () => {
    afterEach(() => jest.useRealTimers());

    it('reads the canvas at its own resolution, placed in image pixels', async () => {
        const { viewer, imagePoint, reads } = fakeViewer();
        const host = createOsdTissueHost({
            viewer,
            imagePoint,
            mpp: () => ({ x: 0.25, y: 0.25 }),
            objectivePower: () => 40,
        });
        expect(host.imagePerScreen()).toBeCloseTo(0.5, 9);
        const raster = (await host.readScreen())!;
        // devicePixelRatio 2: 800×600 canvas pixels, a quarter image pixel
        // each.
        expect(reads).toEqual([[0, 0, 800, 600]]);
        expect(raster.width).toBe(800);
        expect(raster.scale).toBeCloseTo(0.25, 9);
        expect([raster.originX, raster.originY]).toEqual([1000, 2000]);
        expect(raster.source).toBe('screen');
        expect(raster.edges).toEqual({
            left: 'view',
            top: 'view',
            right: 'view',
            bottom: 'view',
        });
    });

    it('gives no screen pixels when rotated, tainted or still loading', async () => {
        const rotated = fakeViewer({ rotation: 90 });
        const tainted = fakeViewer({ tainted: true });
        const hostOf = (fake: ReturnType<typeof fakeViewer>) =>
            createOsdTissueHost({
                viewer: fake.viewer,
                imagePoint: fake.imagePoint,
                mpp: () => null,
                objectivePower: () => undefined,
            });
        expect(await hostOf(rotated).readScreen()).toBeNull();
        expect(await hostOf(tainted).readScreen()).toBeNull();
        // Loading: waits for the view's tiles; read once they are drawn.
        const loading = fakeViewer({ fullyLoaded: false });
        const read = hostOf(loading).readScreen();
        loading.handlers['fully-loaded-change'].forEach(handler =>
            handler({ fullyLoaded: true })
        );
        expect((await read)!.source).toBe('screen');
        // Still loading after the wait: none (the tiles are used instead).
        jest.useFakeTimers();
        const slow = fakeViewer({ fullyLoaded: false });
        const late = hostOf(slow).readScreen();
        jest.advanceTimersByTime(FULLY_LOADED_WAIT_MS + 1);
        expect(await late).toBeNull();
        expect(slow.reads).toEqual([]);
    });

    it('lists the levels and fetches tiles as blobs with the viewer’s URLs', async () => {
        const { viewer, imagePoint } = fakeViewer();
        const fetchImpl = jest.fn(async () => ({
            ok: true,
            blob: async () => new Blob(['png']),
        }));
        (global as any).createImageBitmap = jest.fn(async () =>
            Object.assign(document.createElement('canvas'), {
                width: 2,
                height: 1,
            })
        );
        const host = createOsdTissueHost({
            viewer,
            imagePoint,
            mpp: () => ({ x: 0.25, y: 0.25 }),
            objectivePower: () => 40,
            fetchImpl: fetchImpl as any,
        });
        const levels = host.levels();
        expect(levels.map(level => level.downsample)).toEqual([
            32,
            16,
            8,
            4,
            2,
            1,
        ]);
        expect(levels.find(level => level.downsample === 4)).toMatchObject({
            level: 11,
            width: 2048,
            columns: 8,
            tileWidth: 256,
        });
        const tile = await host.fetchTile(11, 3, 4);
        expect(fetchImpl).toHaveBeenCalledWith(
            '/wsi/tiles/zxy/11/3/4?studyId=s',
            {
                credentials: 'include',
            }
        );
        expect(tile!.width).toBe(2);
        delete (global as any).createImageBitmap;
    });
});
