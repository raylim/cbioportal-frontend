import { WsiRgbaRaster } from './wsiTissueCore';
import {
    WsiTileLevel,
    WsiTissuePixelHost,
    WsiTissueRaster,
} from './wsiTissuePixels';

/**
 * A synthetic slide for tests of the tissue tools: a function from level-0
 * image pixels to a color, served as tiles of a pyramid and as an on-screen
 * canvas for a given view.
 */

export type Rgb = [number, number, number];

export const SLIDE_WHITE: Rgb = [243, 243, 243];
export const SLIDE_PINK: Rgb = [232, 160, 205];
export const SLIDE_PURPLE: Rgb = [120, 70, 165];
export const SLIDE_BROWN: Rgb = [150, 95, 50];

export interface TestDisk {
    x: number;
    y: number;
    r: number;
    color: Rgb;
}

/**
 * The default slide (8192 pixels square at 0.25 µm per pixel): a pink disk
 * of tissue (radius 2400) holding a purple disk (radius 600 at 3000, 4000),
 * a white lumen (radius 300 at 5000, 4200) and a brown disk (radius 250 at
 * 4300, 5600); later disks lie over earlier ones.
 */
export const TEST_SLIDE_DISKS: TestDisk[] = [
    { x: 4096, y: 4096, r: 2400, color: SLIDE_PINK },
    { x: 3000, y: 4000, r: 600, color: SLIDE_PURPLE },
    { x: 5000, y: 4200, r: 300, color: SLIDE_WHITE },
    { x: 4300, y: 5600, r: 250, color: SLIDE_BROWN },
];

export function slideColor(
    x: number,
    y: number,
    disks: TestDisk[] = TEST_SLIDE_DISKS
): Rgb {
    let color = SLIDE_WHITE;
    disks.forEach(disk => {
        const dx = x - disk.x;
        const dy = y - disk.y;
        if (dx * dx + dy * dy <= disk.r * disk.r) color = disk.color;
    });
    return color;
}

/** Renders level-0 box `width`×`height` raster pixels from (x0, y0), `scale` image pixels each. */
export function renderSlide(
    x0: number,
    y0: number,
    width: number,
    height: number,
    scale: number,
    disks: TestDisk[] = TEST_SLIDE_DISKS,
    size = 8192
): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
            const x = x0 + (i + 0.5) * scale;
            const y = y0 + (j + 0.5) * scale;
            const o = (j * width + i) * 4;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const [r, g, b] = slideColor(x, y, disks);
            data[o] = r;
            data[o + 1] = g;
            data[o + 2] = b;
            data[o + 3] = 255;
        }
    }
    return data;
}

export interface TestSlideHostOptions {
    size?: number;
    tileSize?: number;
    disks?: TestDisk[];
    /** Level-0 pixels per CSS pixel. */
    imagePerScreen?: number;
    /** The view's top-left corner, in level-0 pixels. */
    viewX?: number;
    viewY?: number;
    viewWidth?: number;
    viewHeight?: number;
    devicePixelRatio?: number;
    objectivePower?: number;
    mpp?: { x: number; y: number } | null;
    /** The screen read fails (a tainted or rotated canvas). */
    screenUnavailable?: boolean;
    /** Tiles that fail, as "level,column,row". */
    failTiles?: string[];
}

/** A pixel host over the synthetic slide; counts tile fetches. */
export function testSlideHost(
    options: TestSlideHostOptions = {}
): WsiTissuePixelHost & {
    fetched: string[];
    screenReads: number;
    options: TestSlideHostOptions;
} {
    const size = options.size ?? 8192;
    const tileSize = options.tileSize ?? 256;
    const disks = options.disks ?? TEST_SLIDE_DISKS;
    const levels: WsiTileLevel[] = [];
    const maxLevel = Math.ceil(Math.log2(size));
    for (let level = maxLevel - 6; level <= maxLevel; level++) {
        const downsample = Math.pow(2, maxLevel - level);
        const width = Math.ceil(size / downsample);
        levels.push({
            level,
            downsample,
            width,
            height: width,
            tileWidth: tileSize,
            tileHeight: tileSize,
            columns: Math.ceil(width / tileSize),
            rows: Math.ceil(width / tileSize),
        });
    }
    const host = {
        options,
        fetched: [] as string[],
        screenReads: 0,
        imagePerScreen: () => options.imagePerScreen ?? 1,
        objectivePower: () => options.objectivePower ?? 40,
        mpp: () =>
            options.mpp === undefined ? { x: 0.25, y: 0.25 } : options.mpp,
        viewKey: () =>
            [
                options.viewX,
                options.viewY,
                options.imagePerScreen,
                options.viewWidth,
            ].join(','),
        async readScreen(): Promise<WsiTissueRaster | null> {
            host.screenReads += 1;
            if (options.screenUnavailable) return null;
            const ratio = options.devicePixelRatio ?? 1;
            const perScreen = options.imagePerScreen ?? 1;
            const width = Math.round((options.viewWidth ?? 1600) * ratio);
            const height = Math.round((options.viewHeight ?? 1200) * ratio);
            const scale = perScreen / ratio;
            const originX = options.viewX ?? 0;
            const originY = options.viewY ?? 0;
            return {
                width,
                height,
                data: renderSlide(
                    originX,
                    originY,
                    width,
                    height,
                    scale,
                    disks,
                    size
                ),
                originX,
                originY,
                scale,
                source: 'screen',
                edges: {
                    left: originX <= 0 ? 'image' : 'view',
                    top: originY <= 0 ? 'image' : 'view',
                    right: originX + width * scale >= size ? 'image' : 'view',
                    bottom: originY + height * scale >= size ? 'image' : 'view',
                },
            };
        },
        levels: () => levels,
        async fetchTile(
            level: number,
            column: number,
            row: number
        ): Promise<WsiRgbaRaster | null> {
            const key = `${level},${column},${row}`;
            host.fetched.push(key);
            if (options.failTiles?.includes(key)) return null;
            const info = levels.find(item => item.level === level)!;
            const width = Math.min(tileSize, info.width - column * tileSize);
            const height = Math.min(tileSize, info.height - row * tileSize);
            return {
                width,
                height,
                data: renderSlide(
                    column * tileSize * info.downsample,
                    row * tileSize * info.downsample,
                    width,
                    height,
                    info.downsample,
                    disks,
                    size
                ),
            };
        },
    };
    return host;
}
