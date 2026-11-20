import { WsiRgbaRaster } from './wsiTissueCore';

/**
 * Where the tissue tools read slide pixels (the hybrid source):
 *
 * - **On screen**, at an effective magnification of `SCREEN_MIN_MAGNIFICATION`
 *   (10×) or more: the pixels OpenSeadragon has drawn, read from its canvas
 *   at the canvas's own resolution (CSS pixels × devicePixelRatio). Instant,
 *   and as sharp as what the user sees, but only what is in view.
 * - **Tiles**, zoomed out further: the tile server's tiles of the level
 *   nearest 10× (about 1 µm per pixel, finer than the view), fetched as
 *   blobs with the viewer's own tile URLs (`/wsi/tiles/zxy/…?studyId&key&enc`)
 *   and stitched into an offscreen raster. It starts as about 512×512
 *   pixels around the click and grows on each side the selection reaches
 *   (by half its span, at least `GROW_TILES` tiles), up to
 *   `TISSUE_RASTER_CAP` pixels a side.
 *
 * Both give rasters with their place on the slide (`originX`, `originY` in
 * level-0 image pixels and `scale` image pixels per raster pixel), so the
 * outlines are in image pixels either way.
 */

/** The effective magnification from which on-screen pixels are used. */
export const SCREEN_MIN_MAGNIFICATION = 10;
/** The magnification of the tiles fetched when zoomed out. */
export const TILE_ANALYSIS_MAGNIFICATION = 10;
/** The largest raster, in pixels a side (4096: 16.8 M pixels, 64 MB). */
export const TISSUE_RASTER_CAP = 4096;
/**
 * The first tile window around a click, in raster pixels a side (2 or 3
 * tiles each way): most clicks need no more, and each tile costs a
 * request; larger selections grow it.
 */
export const INITIAL_WINDOW = 512;
/**
 * Tiles added on a side the selection reaches: at least this many, and
 * half the window's span, so the window about doubles each time and a
 * large selection reaches the cap in a few steps.
 */
export const GROW_TILES = 2;

/**
 * What lies beyond a raster's side: `image` the slide's edge (nothing more),
 * `view` the edge of the view (on-screen pixels: the selection is cut
 * there), `cap` the size limit (cut there), `more` tiles still to fetch.
 */
export type WsiRasterEdge = 'image' | 'view' | 'cap' | 'more';

export interface WsiTissueRaster extends WsiRgbaRaster {
    /** Level-0 image pixel of the raster's top-left corner. */
    originX: number;
    originY: number;
    /** Level-0 image pixels per raster pixel. */
    scale: number;
    source: 'screen' | 'tiles';
    edges: {
        left: WsiRasterEdge;
        top: WsiRasterEdge;
        right: WsiRasterEdge;
        bottom: WsiRasterEdge;
    };
}

/** One level of the tile pyramid. */
export interface WsiTileLevel {
    level: number;
    /** Level-0 pixels per pixel of this level. */
    downsample: number;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
    columns: number;
    rows: number;
}

/** What the tissue tools need from the viewer; see `createOsdTissueHost`. */
export interface WsiTissuePixelHost {
    /** Level-0 image pixels per CSS pixel, as the slide is shown now. */
    imagePerScreen(): number;
    /** The slide's objective power, when known. */
    objectivePower(): number | undefined;
    /** Microns per pixel, when known. */
    mpp(): { x: number; y: number } | null | undefined;
    /** A key that changes when the view moves (to reuse a screen read). */
    viewKey(): string;
    /**
     * The slide as drawn now, or null (rotated or flipped, no canvas,
     * tainted, or its tiles still loading). A canvas larger than
     * `TISSUE_RASTER_CAP` a side is read in a window of that size around
     * `around` (level-0 image pixels), else around its centre.
     */
    readScreen(around?: {
        x: number;
        y: number;
    }): Promise<WsiTissueRaster | null>;
    /** The pyramid's levels the tile server serves. */
    levels(): WsiTileLevel[];
    /**
     * One tile's pixels, or null when it could not be fetched; rejects with
     * an `AbortError` when `signal` aborts.
     */
    fetchTile(
        level: number,
        column: number,
        row: number,
        signal?: AbortSignal
    ): Promise<WsiRgbaRaster | null>;
}

/**
 * The magnification as the status bar shows it: the objective power times
 * screen pixels per image pixel; from the scale (10× is 1 µm per screen
 * pixel) without an objective power; null without either.
 */
export function effectiveMagnification(
    objectivePower: number | undefined,
    mpp: { x: number; y: number } | null | undefined,
    imagePerScreen: number
): number | null {
    if (!(imagePerScreen > 0)) return null;
    if (objectivePower && objectivePower > 0) {
        return objectivePower / imagePerScreen;
    }
    const micron = mpp ? (mpp.x + mpp.y) / 2 : 0;
    return micron > 0 ? 10 / (micron * imagePerScreen) : null;
}

/**
 * Whether to read on-screen pixels: at `SCREEN_MIN_MAGNIFICATION` or more;
 * without a magnification, at native resolution or closer.
 */
export function useScreenPixels(host: WsiTissuePixelHost): boolean {
    const perScreen = host.imagePerScreen();
    const magnification = effectiveMagnification(
        host.objectivePower(),
        host.mpp(),
        perScreen
    );
    return magnification !== null
        ? magnification >= SCREEN_MIN_MAGNIFICATION - 1e-6
        : perScreen <= 1;
}

/**
 * The level-0 pixels per analysis pixel wanted from tiles: 10× (the
 * objective power over 10, or 1 µm per pixel), else 4.
 */
export function targetDownsample(host: WsiTissuePixelHost): number {
    const power = host.objectivePower();
    if (power && power > 0) {
        return Math.max(1, power / TILE_ANALYSIS_MAGNIFICATION);
    }
    const mpp = host.mpp();
    const micron = mpp ? (mpp.x + mpp.y) / 2 : 0;
    return micron > 0 ? Math.max(1, 1 / micron) : 4;
}

/** The coarsest level at least as fine as `target` (a little slack), else the finest. */
export function pickLevel(
    levels: WsiTileLevel[],
    target: number
): WsiTileLevel | null {
    if (!levels.length) return null;
    const sorted = [...levels].sort((a, b) => a.downsample - b.downsample);
    let pick = sorted[0];
    sorted.forEach(level => {
        if (level.downsample <= target * 1.2) pick = level;
    });
    return pick;
}

/** Runs `tasks` with at most `limit` at once. */
async function runLimited<T>(
    tasks: Array<() => Promise<T>>,
    limit: number
): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
        while (next < tasks.length) {
            const index = next++;
            results[index] = await tasks[index]();
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(limit, tasks.length) }, worker)
    );
    return results;
}

/** Tiles fetched at once. */
const TILE_FETCH_CONCURRENCY = 6;

/**
 * A window of tiles of one level, grown tile by tile and stitched into a
 * raster, at most `cap` pixels a side.
 */
export class WsiTileMosaic {
    private tiles = new Map<string, WsiRgbaRaster | null>();
    /** The tile window, inclusive; empty until `cover`. */
    c0 = 0;
    c1 = -1;
    r0 = 0;
    r1 = -1;
    /** Tiles being fetched now. */
    fetching = 0;
    /** Whether a requested window was cut at the cap. */
    capped = false;
    /** Set by `abort`: fetches stop and the window is incomplete. */
    aborted = false;
    private readonly abortController =
        typeof AbortController !== 'undefined' ? new AbortController() : null;

    constructor(
        private readonly host: WsiTissuePixelHost,
        readonly level: WsiTileLevel,
        readonly cap = TISSUE_RASTER_CAP,
        private readonly onFetching: (count: number) => void = () => undefined
    ) {}

    private get maxColumns(): number {
        return Math.max(1, Math.floor(this.cap / this.level.tileWidth));
    }

    private get maxRows(): number {
        return Math.max(1, Math.floor(this.cap / this.level.tileHeight));
    }

    /** Whether level-0 point (x, y) is in the window. */
    contains(x: number, y: number): boolean {
        const { downsample, tileWidth, tileHeight } = this.level;
        const column = Math.floor(x / downsample / tileWidth);
        const row = Math.floor(y / downsample / tileHeight);
        return (
            column >= this.c0 &&
            column <= this.c1 &&
            row >= this.r0 &&
            row <= this.r1
        );
    }

    /**
     * Extends the window to the tiles holding level-0 box [minX, maxX] ×
     * [minY, maxY], keeping what it has and staying within the cap (the
     * part past the cap is left out and `capped` set). Fetches the new
     * tiles. Returns whether the window changed.
     */
    async cover(box: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    }): Promise<boolean> {
        const { downsample, tileWidth, tileHeight, columns, rows } = this.level;
        const clampC = (c: number) => Math.max(0, Math.min(columns - 1, c));
        const clampR = (r: number) => Math.max(0, Math.min(rows - 1, r));
        let c0 = clampC(Math.floor(box.minX / downsample / tileWidth));
        let c1 = clampC(Math.floor(box.maxX / downsample / tileWidth));
        let r0 = clampR(Math.floor(box.minY / downsample / tileHeight));
        let r1 = clampR(Math.floor(box.maxY / downsample / tileHeight));
        if (this.c1 >= this.c0) {
            const want = { c0, c1, r0, r1 };
            c0 = Math.min(c0, this.c0);
            c1 = Math.max(c1, this.c1);
            r0 = Math.min(r0, this.r0);
            r1 = Math.max(r1, this.r1);
            // Past the cap: keep the current window, add what fits.
            if (c1 - c0 + 1 > this.maxColumns) {
                this.capped = true;
                const spare = this.maxColumns - (this.c1 - this.c0 + 1);
                const left = Math.min(
                    spare,
                    this.c0 - Math.min(want.c0, this.c0)
                );
                c0 = this.c0 - left;
                c1 = Math.min(c1, this.c1 + spare - left);
            }
            if (r1 - r0 + 1 > this.maxRows) {
                this.capped = true;
                const spare = this.maxRows - (this.r1 - this.r0 + 1);
                const top = Math.min(
                    spare,
                    this.r0 - Math.min(want.r0, this.r0)
                );
                r0 = this.r0 - top;
                r1 = Math.min(r1, this.r1 + spare - top);
            }
        } else {
            if (c1 - c0 + 1 > this.maxColumns) {
                this.capped = true;
                const mid = Math.floor((c0 + c1) / 2);
                c0 = Math.max(0, mid - Math.floor(this.maxColumns / 2));
                c1 = Math.min(columns - 1, c0 + this.maxColumns - 1);
            }
            if (r1 - r0 + 1 > this.maxRows) {
                this.capped = true;
                const mid = Math.floor((r0 + r1) / 2);
                r0 = Math.max(0, mid - Math.floor(this.maxRows / 2));
                r1 = Math.min(rows - 1, r0 + this.maxRows - 1);
            }
        }
        const changed =
            c0 !== this.c0 ||
            c1 !== this.c1 ||
            r0 !== this.r0 ||
            r1 !== this.r1;
        this.c0 = c0;
        this.c1 = c1;
        this.r0 = r0;
        this.r1 = r1;
        await this.fetchMissing();
        return changed;
    }

    /**
     * Adds tiles on each side in `sides` that can grow: `GROW_TILES`, or
     * half the window's span when that is more.
     * Returns whether the window grew.
     */
    async grow(sides: {
        left?: boolean;
        top?: boolean;
        right?: boolean;
        bottom?: boolean;
    }): Promise<boolean> {
        const { columns, rows } = this.level;
        let { c0, c1, r0, r1 } = this;
        const stepC = Math.max(GROW_TILES, Math.ceil((c1 - c0 + 1) / 2));
        const stepR = Math.max(GROW_TILES, Math.ceil((r1 - r0 + 1) / 2));
        const take = (room: number, spare: number, step: number) =>
            Math.max(0, Math.min(step, room, spare));
        let spareC = this.maxColumns - (c1 - c0 + 1);
        let spareR = this.maxRows - (r1 - r0 + 1);
        if (sides.left) {
            const n = take(c0, spareC, stepC);
            c0 -= n;
            spareC -= n;
        }
        if (sides.right) {
            const n = take(columns - 1 - c1, spareC, stepC);
            c1 += n;
            spareC -= n;
        }
        if (sides.top) {
            const n = take(r0, spareR, stepR);
            r0 -= n;
            spareR -= n;
        }
        if (sides.bottom) {
            const n = take(rows - 1 - r1, spareR, stepR);
            r1 += n;
            spareR -= n;
        }
        const changed =
            c0 !== this.c0 ||
            c1 !== this.c1 ||
            r0 !== this.r0 ||
            r1 !== this.r1;
        if (!changed) return false;
        this.c0 = c0;
        this.c1 = c1;
        this.r0 = r0;
        this.r1 = r1;
        await this.fetchMissing();
        return true;
    }

    /**
     * Stops fetching: tiles not yet fetched are not requested, and those in
     * flight are cancelled. The mosaic is not used again.
     */
    abort() {
        if (this.aborted) return;
        this.aborted = true;
        this.abortController?.abort();
    }

    private async fetchMissing() {
        const tasks: Array<() => Promise<void>> = [];
        for (let r = this.r0; r <= this.r1; r++) {
            for (let c = this.c0; c <= this.c1; c++) {
                const key = `${c},${r}`;
                if (this.tiles.has(key)) continue;
                tasks.push(async () => {
                    let tile: WsiRgbaRaster | null = null;
                    if (!this.aborted) {
                        try {
                            tile = await this.host.fetchTile(
                                this.level.level,
                                c,
                                r,
                                this.abortController?.signal
                            );
                        } catch (_) {
                            tile = null;
                        }
                    }
                    if (!this.aborted) this.tiles.set(key, tile);
                    this.fetching -= 1;
                    if (!this.aborted) this.onFetching(this.fetching);
                });
            }
        }
        if (!tasks.length) return;
        this.fetching += tasks.length;
        this.onFetching(this.fetching);
        await runLimited(tasks, TILE_FETCH_CONCURRENCY);
    }

    /** The edge of the window on each side. */
    private edges(): WsiTissueRaster['edges'] {
        const { columns, rows } = this.level;
        const columnsFull = this.c1 - this.c0 + 1 >= this.maxColumns;
        const rowsFull = this.r1 - this.r0 + 1 >= this.maxRows;
        const side = (atImage: boolean, full: boolean): WsiRasterEdge =>
            atImage ? 'image' : full ? 'cap' : 'more';
        return {
            left: side(this.c0 === 0, columnsFull),
            right: side(this.c1 === columns - 1, columnsFull),
            top: side(this.r0 === 0, rowsFull),
            bottom: side(this.r1 === rows - 1, rowsFull),
        };
    }

    /** The window's tiles stitched into one raster (failed tiles transparent). */
    raster(): WsiTissueRaster {
        const {
            tileWidth,
            tileHeight,
            width: levelWidth,
            height: levelHeight,
        } = this.level;
        const x0 = this.c0 * tileWidth;
        const y0 = this.r0 * tileHeight;
        const width = Math.min((this.c1 + 1) * tileWidth, levelWidth) - x0;
        const height = Math.min((this.r1 + 1) * tileHeight, levelHeight) - y0;
        const data = new Uint8ClampedArray(Math.max(0, width * height * 4));
        for (let r = this.r0; r <= this.r1; r++) {
            for (let c = this.c0; c <= this.c1; c++) {
                const tile = this.tiles.get(`${c},${r}`);
                if (!tile) continue;
                const tx = c * tileWidth - x0;
                const ty = r * tileHeight - y0;
                const w = Math.min(tile.width, width - tx);
                const h = Math.min(tile.height, height - ty);
                for (let y = 0; y < h; y++) {
                    const from = y * tile.width * 4;
                    data.set(
                        tile.data.subarray(from, from + w * 4),
                        ((ty + y) * width + tx) * 4
                    );
                }
            }
        }
        return {
            width,
            height,
            data,
            originX: x0 * this.level.downsample,
            originY: y0 * this.level.downsample,
            scale: this.level.downsample,
            source: 'tiles',
            edges: this.edges(),
        };
    }
}

/** Decodes an image blob into RGBA pixels. */
async function decodeTile(blob: Blob): Promise<WsiRgbaRaster | null> {
    if (typeof createImageBitmap !== 'function') return null;
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas: any =
        typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(width, height)
            : Object.assign(document.createElement('canvas'), {
                  width,
                  height,
              });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const image = context.getImageData(0, 0, width, height);
    return { width, height, data: image.data };
}

/**
 * How long to wait for the view's tiles before reading the canvas; still
 * loading after that, the tiles are used instead, so an outline never comes
 * from a half-drawn view.
 */
export const FULLY_LOADED_WAIT_MS = 5000;

/**
 * The tissue tools' pixel host on an OpenSeadragon viewer: its canvas for
 * on-screen pixels and its tile source's URLs for tiles. `imagePoint` maps
 * a point of the viewer element (CSS pixels) to level-0 image pixels as
 * shown now.
 */
export function createOsdTissueHost(options: {
    viewer: any;
    imagePoint: (x: number, y: number) => { x: number; y: number } | null;
    mpp: () => { x: number; y: number } | null | undefined;
    objectivePower: () => number | undefined;
    fetchImpl?: typeof fetch;
}): WsiTissuePixelHost {
    const { viewer, imagePoint } = options;
    const perScreen = () => {
        const a = imagePoint(0, 0);
        const b = imagePoint(100, 0);
        return a && b ? Math.hypot(b.x - a.x, b.y - a.y) / 100 || 1 : 1;
    };
    const tiledImage = () => viewer?.world?.getItemAt?.(0);
    // Whether the view's tiles are all drawn, waiting up to
    // `FULLY_LOADED_WAIT_MS` for them.
    const waitFullyLoaded = () =>
        new Promise<boolean>(resolve => {
            const item = tiledImage();
            if (!item || item.getFullyLoaded?.() !== false) {
                resolve(true);
                return;
            }
            const done = (loaded: boolean) => {
                clearTimeout(timer);
                item.removeHandler?.('fully-loaded-change', handler);
                resolve(loaded);
            };
            const handler = (event: any) => {
                if (event?.fullyLoaded) done(true);
            };
            const timer = setTimeout(() => done(false), FULLY_LOADED_WAIT_MS);
            item.addHandler?.('fully-loaded-change', handler);
        });
    return {
        imagePerScreen: perScreen,
        objectivePower: options.objectivePower,
        mpp: options.mpp,
        viewKey() {
            const a = imagePoint(0, 0);
            const b = imagePoint(100, 100);
            const canvas = viewer?.drawer?.canvas;
            return [a?.x, a?.y, b?.x, b?.y, canvas?.width, canvas?.height]
                .map(value =>
                    value === undefined ? '' : Math.round(value * 100)
                )
                .join(',');
        },
        async readScreen(around) {
            const viewport = viewer?.viewport;
            const rotation = viewport?.getRotation?.(true) ?? 0;
            if (rotation % 360 !== 0 || viewport?.getFlip?.()) return null;
            const canvas = viewer?.drawer?.canvas as
                | HTMLCanvasElement
                | undefined;
            if (!canvas || typeof canvas.getContext !== 'function') return null;
            // Still loading: tiles, rather than a half-drawn view.
            if (!(await waitFullyLoaded())) return null;
            const cssWidth =
                canvas.clientWidth || viewer?.container?.clientWidth;
            if (!cssWidth || !canvas.width || !canvas.height) return null;
            const ratio = canvas.width / cssWidth;
            const origin = imagePoint(0, 0);
            const along = imagePoint(100, 0);
            if (!origin || !along) return null;
            const scale = (along.x - origin.x) / 100 / ratio;
            if (!(scale > 0)) return null;
            const width = Math.min(canvas.width, TISSUE_RASTER_CAP);
            const height = Math.min(canvas.height, TISSUE_RASTER_CAP);
            // The window around the point (canvas pixels), kept on the canvas.
            const centreX = around
                ? (around.x - origin.x) / scale
                : canvas.width / 2;
            const centreY = around
                ? (around.y - origin.y) / scale
                : canvas.height / 2;
            const place = (centre: number, size: number, total: number) =>
                Math.max(
                    0,
                    Math.min(total - size, Math.floor(centre - size / 2))
                );
            const x0 = place(centreX, width, canvas.width);
            const y0 = place(centreY, height, canvas.height);
            let data: Uint8ClampedArray;
            try {
                const context = canvas.getContext(
                    '2d'
                ) as CanvasRenderingContext2D;
                data = context.getImageData(x0, y0, width, height).data;
            } catch (_) {
                // A tainted canvas (a cross-origin tile without CORS).
                return null;
            }
            const originX = origin.x + x0 * scale;
            const originY = origin.y + y0 * scale;
            const size = tiledImage()?.source?.dimensions;
            const imageWidth = size?.x ?? Infinity;
            const imageHeight = size?.y ?? Infinity;
            return {
                width,
                height,
                data,
                originX,
                originY,
                scale,
                source: 'screen',
                edges: {
                    left: originX <= 0 ? 'image' : 'view',
                    top: originY <= 0 ? 'image' : 'view',
                    right:
                        originX + width * scale >= imageWidth
                            ? 'image'
                            : 'view',
                    bottom:
                        originY + height * scale >= imageHeight
                            ? 'image'
                            : 'view',
                },
            };
        },
        levels() {
            const source = tiledImage()?.source;
            if (!source?.getLevelScale) return [];
            const levels: WsiTileLevel[] = [];
            const min = source.minLevel ?? 0;
            const max = source.maxLevel ?? 0;
            for (let level = min; level <= max; level++) {
                const scale = source.getLevelScale(level);
                const tiles = source.getNumTiles(level);
                if (!(scale > 0) || !tiles) continue;
                levels.push({
                    level,
                    downsample: 1 / scale,
                    width: Math.ceil(source.dimensions.x * scale),
                    height: Math.ceil(source.dimensions.y * scale),
                    tileWidth: source.getTileWidth(level),
                    tileHeight: source.getTileHeight(level),
                    columns: tiles.x,
                    rows: tiles.y,
                });
            }
            return levels;
        },
        async fetchTile(level, column, row, signal) {
            const source = tiledImage()?.source;
            const url = source?.getTileUrl?.(level, column, row);
            if (!url) return null;
            // Fetched as blobs, so the pixels can always be read (no canvas
            // taint), with the session cookie as the viewer's own requests.
            const fetchImpl = options.fetchImpl || fetch;
            const response = await fetchImpl(url, {
                credentials: 'include',
                signal,
            });
            if (!response.ok) return null;
            return decodeTile(await response.blob());
        },
    };
}
