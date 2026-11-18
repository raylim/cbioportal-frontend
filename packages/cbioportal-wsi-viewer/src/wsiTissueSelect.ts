import { WsiPoint, WsiRegion } from './wsiAnnotationGeometryUtils';
import { subtractRegions, unionRegions } from './wsiAnnotationShapeOps';
import {
    MAX_TISSUE_TOLERANCE,
    MIN_TISSUE_TOLERANCE,
    WsiFlatPolygon,
    WsiOutlineOptions,
} from './wsiTissueCore';
import { createTissueEngine, WsiTissueEngine } from './wsiTissueEngine';
import {
    INITIAL_WINDOW,
    pickLevel,
    targetDownsample,
    TISSUE_RASTER_CAP,
    useScreenPixels,
    WsiTileMosaic,
    WsiTissuePixelHost,
    WsiTissueRaster,
} from './wsiTissuePixels';

export { createOsdTissueHost } from './wsiTissuePixels';
export { createTissueEngine } from './wsiTissueEngine';

/**
 * The magic wand and the smart brush (tissue-aware selection): sessions
 * that read slide pixels (`wsiTissuePixels.ts`), run the selection in the
 * engine (`wsiTissueEngine.ts`, a Web Worker) and give outlines in level-0
 * image pixels. Loaded as its own async chunk when either tool is first
 * picked (`wsiTissueLoader.ts`).
 */

/** Holes smaller than this are filled (about 25 µm across: nuclei, specks). */
export const HOLE_FILL_UM2 = 500;
/** Parts smaller than this are dropped (crumbs of the smart brush). */
export const MIN_PART_UM2 = 50;
/** The outline's Douglas–Peucker tolerance, in µm of tissue. */
export const SIMPLIFY_UM = 1;
/** …and never under this many raster pixels (the staircase of the mask). */
const SIMPLIFY_MIN_RASTER_PX = 0.75;
/** Without a scale: holes under this many raster pixels are filled. */
const HOLE_FILL_RASTER_PX = 64;

let sharedEngine: Promise<WsiTissueEngine> | null = null;

/** One engine (one worker) for every session; started on first use. */
export function sharedTissueEngine(): Promise<WsiTissueEngine> {
    if (!sharedEngine) sharedEngine = createTissueEngine();
    return sharedEngine;
}

/** What a tissue tool shows while it works. */
export interface WsiTissueView {
    tool: 'wand' | 'smartBrush';
    /** The selection so far, in level-0 image pixels (may be empty). */
    region: WsiRegion;
    /** Saving cuts it out of the selected regions (Alt at the first click). */
    cut: boolean;
    tolerance: number;
    /** Computing or fetching. */
    busy: boolean;
    /** Tiles being fetched. */
    fetching: number;
    source: 'screen' | 'tiles' | null;
    /** Level-0 pixels per analysis pixel of the last step. */
    scale: number | null;
    /** Why the selection was cut short, if it was. */
    note: string | null;
    /** Wand clicks combined so far. */
    steps: number;
    /** Time from the last click (or stroke start) to its first outline. */
    ms: number | null;
    /** Where the last click or stroke started, in image pixels. */
    seed: WsiPoint | null;
    /** Which engine runs the selection. */
    engine: 'worker' | 'main' | null;
}

type StepKind = 'new' | 'add' | 'subtract';

/** A raster in the engine, with where it is on the slide. */
interface RasterContext {
    raster: Omit<WsiTissueRaster, 'data'>;
    rasterId: number;
    mosaic: WsiTileMosaic | null;
    viewKey: string | null;
}

interface WandStep {
    kind: StepKind;
    seed: WsiPoint;
    tolerance: number;
    region: WsiRegion;
    color: [number, number, number] | null;
    context: RasterContext | null;
    note: string | null;
}

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function clampTolerance(value: number): number {
    return Math.max(
        MIN_TISSUE_TOLERANCE,
        Math.min(MAX_TISSUE_TOLERANCE, Math.round(value))
    );
}

/** Raster polygons to image pixels. */
export function toImageRegion(
    polygons: WsiFlatPolygon[],
    raster: { originX: number; originY: number; scale: number }
): WsiRegion {
    return polygons.map(rings =>
        rings.map(ring => {
            const points: WsiPoint[] = [];
            for (let i = 0; i < ring.length; i += 2) {
                points.push({
                    x: raster.originX + ring[i] * raster.scale,
                    y: raster.originY + ring[i + 1] * raster.scale,
                });
            }
            return points;
        })
    );
}

/** Combines the wand's steps: the first, then each added or subtracted. */
export function combineSteps(
    steps: ReadonlyArray<{ kind: StepKind; region: WsiRegion }>
): WsiRegion {
    let region: WsiRegion = [];
    steps.forEach(step => {
        if (step.kind === 'new') region = step.region;
        else if (step.kind === 'add') {
            region = region.length
                ? unionRegions([region, step.region])
                : step.region;
        } else if (region.length && step.region.length) {
            region = subtractRegions(region, [step.region]);
        }
    });
    return region;
}

/** Outline options for a raster of `scale` image pixels per pixel. */
export function outlineOptions(
    scale: number,
    mpp: { x: number; y: number } | null | undefined
): WsiOutlineOptions {
    const pixelArea = mpp ? mpp.x * mpp.y * scale * scale : 0;
    const micron = mpp ? ((mpp.x + mpp.y) / 2) * scale : 0;
    return {
        maxHoleArea:
            pixelArea > 0 ? HOLE_FILL_UM2 / pixelArea : HOLE_FILL_RASTER_PX,
        simplify: Math.max(
            SIMPLIFY_MIN_RASTER_PX,
            micron > 0 ? SIMPLIFY_UM / micron : 0
        ),
        minPartArea: pixelArea > 0 ? MIN_PART_UM2 / pixelArea : 4,
    };
}

/** "about 4.1 mm" for a raster side, or pixels without a scale. */
function capSize(
    cap: number,
    scale: number,
    mpp: { x: number; y: number } | null | undefined
): string {
    if (!mpp) return `${cap} pixels`;
    const mm = (cap * scale * (mpp.x + mpp.y)) / 2 / 1000;
    return `about ${mm.toFixed(1)} mm`;
}

/**
 * One tool's session on one slide: the wand's pending selection, or the
 * smart brush's stroke. `onChange` gets the view after every change, and
 * null when there is nothing to show.
 */
export class WsiTissueSession {
    private engine: WsiTissueEngine | null = null;
    private enginePromise: Promise<WsiTissueEngine> | null = null;
    private steps: WandStep[] = [];
    private cut = false;
    private running = false;
    private wanted: { step: WandStep; tolerance: number } | null = null;
    private generation = 0;
    private fetching = 0;
    private startedAt = 0;
    private ms: number | null = null;
    private lastContext: RasterContext | null = null;
    private stroke: {
        points: WsiPoint[];
        radius: number;
        tolerance: number;
        context: Promise<RasterContext | null>;
        color: [number, number, number] | null;
        region: WsiRegion;
        note: string | null;
        painting: Promise<void> | null;
        again: boolean;
        ending: boolean;
        covering: Promise<void> | null;
    } | null = null;
    private view: WsiTissueView | null = null;
    private busyCount = 0;
    private idleWaiters: Array<() => void> = [];

    constructor(
        readonly tool: 'wand' | 'smartBrush',
        private readonly host: WsiTissuePixelHost,
        private readonly onChange: (view: WsiTissueView | null) => void,
        engineFactory: () => Promise<WsiTissueEngine> = sharedTissueEngine,
        /** The largest raster, in pixels a side. */
        private readonly cap = TISSUE_RASTER_CAP
    ) {
        this.enginePromise = engineFactory().then(engine => {
            this.engine = engine;
            return engine;
        });
    }

    /** Runs `work`, counting it until it settles (see `whenIdle`). */
    private async track<T>(work: Promise<T>): Promise<T> {
        this.busyCount += 1;
        try {
            return await work;
        } finally {
            this.busyCount -= 1;
            if (!this.busyCount) {
                this.idleWaiters.splice(0).forEach(resolve => resolve());
            }
        }
    }

    /** Resolves once no click or tolerance change is being worked on. */
    whenIdle(): Promise<void> {
        return this.busyCount
            ? new Promise(resolve => this.idleWaiters.push(resolve))
            : Promise.resolve();
    }

    private async getEngine(): Promise<WsiTissueEngine> {
        return this.engine || this.enginePromise!;
    }

    private emit(patch: Partial<WsiTissueView> = {}) {
        const base: WsiTissueView = this.view || {
            tool: this.tool,
            region: [],
            cut: false,
            tolerance: 0,
            busy: false,
            fetching: 0,
            source: null,
            scale: null,
            note: null,
            steps: 0,
            ms: null,
            seed: null,
            engine: this.engine?.kind ?? null,
        };
        this.view = {
            ...base,
            engine: this.engine?.kind ?? base.engine,
            fetching: this.fetching,
            ...patch,
        };
        this.onChange(this.view);
    }

    /** Whether the wand has a selection waiting for Enter. */
    get pending(): boolean {
        return this.steps.length > 0;
    }

    get region(): WsiRegion {
        return combineSteps(this.steps);
    }

    get isCut(): boolean {
        return this.cut;
    }

    /** The wand's current tolerance (its last step's). */
    get tolerance(): number | null {
        const last = this.steps[this.steps.length - 1];
        return last ? last.tolerance : null;
    }

    /** Reads a raster for a click at `seed`, reusing the last when it fits. */
    private async rasterFor(seed: WsiPoint): Promise<RasterContext | null> {
        const engine = await this.getEngine();
        const last = this.lastContext;
        const screen = useScreenPixels(this.host);
        if (screen) {
            const key = this.host.viewKey();
            if (
                last &&
                !last.mosaic &&
                last.viewKey === key &&
                seed.x >= last.raster.originX &&
                seed.y >= last.raster.originY &&
                seed.x <
                    last.raster.originX +
                        last.raster.width * last.raster.scale &&
                seed.y <
                    last.raster.originY + last.raster.height * last.raster.scale
            ) {
                return last;
            }
            const raster = await this.host.readScreen();
            if (raster) {
                const { data, ...meta } = raster;
                const rasterId = await engine.setRaster(raster);
                return (this.lastContext = {
                    raster: meta,
                    rasterId,
                    mosaic: null,
                    viewKey: key,
                });
            }
            // Rotated, flipped or tainted: tiles instead.
        }
        if (last?.mosaic && last.mosaic.contains(seed.x, seed.y)) return last;
        const level = pickLevel(
            this.host.levels(),
            targetDownsample(this.host)
        );
        if (!level) return null;
        const mosaic = new WsiTileMosaic(this.host, level, this.cap, count => {
            this.fetching = count;
            this.emit();
        });
        const half = (INITIAL_WINDOW / 2) * level.downsample;
        await mosaic.cover({
            minX: seed.x - half,
            minY: seed.y - half,
            maxX: seed.x + half,
            maxY: seed.y + half,
        });
        return (this.lastContext = await this.loadMosaic(mosaic));
    }

    private async loadMosaic(mosaic: WsiTileMosaic): Promise<RasterContext> {
        const engine = await this.getEngine();
        const raster = mosaic.raster();
        const { data, ...meta } = raster;
        const rasterId = await engine.setRaster(raster);
        return { raster: meta, rasterId, mosaic, viewKey: null };
    }

    /**
     * A wand click at `seed`: `new` starts a selection (`cut`: it will be
     * cut out of the selected regions), `add` adds the region (Shift),
     * `subtract` cuts it out of the selection (Alt).
     */
    wandClick(
        seed: WsiPoint,
        kind: StepKind,
        tolerance: number,
        cut = false
    ): Promise<void> {
        return this.track(this.click(seed, kind, tolerance, cut));
    }

    private async click(
        seed: WsiPoint,
        kind: StepKind,
        tolerance: number,
        cut: boolean
    ): Promise<void> {
        if (kind === 'new' || !this.steps.length) {
            this.generation += 1;
            this.steps = [];
            this.wanted = null;
            this.cut = cut;
            kind = 'new';
        }
        const step: WandStep = {
            kind,
            seed,
            tolerance: clampTolerance(tolerance),
            region: [],
            color: null,
            context: null,
            note: null,
        };
        this.steps.push(step);
        this.startedAt = now();
        this.ms = null;
        this.emit({
            busy: true,
            cut: this.cut,
            tolerance: step.tolerance,
            steps: this.steps.length,
            seed,
            note: null,
            region: combineSteps(this.steps),
        });
        const generation = this.generation;
        const context = await this.rasterFor(seed);
        if (generation !== this.generation || !this.steps.includes(step)) {
            return;
        }
        if (!context) {
            this.steps.pop();
            this.emit({
                busy: false,
                note: 'No slide pixels to select from here.',
            });
            return;
        }
        step.context = context;
        this.emit({
            source: context.raster.source,
            scale: context.raster.scale,
        });
        await this.compute(step, this.wanted?.tolerance ?? step.tolerance);
    }

    /** Changes the last step's tolerance; the outline follows. */
    setTolerance(tolerance: number) {
        const step = this.steps[this.steps.length - 1];
        if (!step) return;
        const value = clampTolerance(tolerance);
        step.tolerance = value;
        this.emit({ tolerance: value });
        if (!step.context) return;
        void this.track(this.compute(step, value));
    }

    /** Runs the wand for `step` at `tolerance`; the latest request wins. */
    private async compute(step: WandStep, tolerance: number): Promise<void> {
        this.wanted = { step, tolerance };
        if (this.running) return;
        this.running = true;
        try {
            while (this.wanted) {
                const { step: target, tolerance: value } = this.wanted;
                this.wanted = null;
                if (!this.steps.includes(target) || !target.context) continue;
                this.emit({ busy: true });
                await this.runStep(target, value);
                if (!this.steps.includes(target)) continue;
                this.markOutlined(target);
                this.emit({
                    busy: !!this.wanted,
                    region: combineSteps(this.steps),
                    tolerance: value,
                    note: target.note,
                    ms: this.ms,
                    source: target.context!.raster.source,
                    scale: target.context!.raster.scale,
                });
            }
        } catch (error) {
            this.emit({
                busy: false,
                note: `The selection failed: ${(error as Error)?.message ||
                    error}`,
            });
        } finally {
            this.running = false;
        }
    }

    private async runStep(step: WandStep, tolerance: number) {
        const engine = await this.getEngine();
        const mpp = this.host.mpp();
        for (;;) {
            const context = step.context!;
            const { raster } = context;
            const result = await engine.run({
                type: 'wand',
                rasterId: context.rasterId,
                x: (step.seed.x - raster.originX) / raster.scale,
                y: (step.seed.y - raster.originY) / raster.scale,
                tolerance,
                options: outlineOptions(raster.scale, mpp),
                color: step.color,
            });
            step.color = result.color;
            const growable = {
                left: result.touches.left && raster.edges.left === 'more',
                top: result.touches.top && raster.edges.top === 'more',
                right: result.touches.right && raster.edges.right === 'more',
                bottom: result.touches.bottom && raster.edges.bottom === 'more',
            };
            if (
                context.mosaic &&
                (growable.left ||
                    growable.top ||
                    growable.right ||
                    growable.bottom)
            ) {
                // An outline at once while the window grows; the time to the
                // outline is the time to this first one.
                step.region = toImageRegion(result.polygons, raster);
                this.markOutlined(step);
                this.emit({ region: combineSteps(this.steps), ms: this.ms });
                // A newer tolerance or click: stop growing for this one.
                if (this.wanted || !this.steps.includes(step)) return;
                if (await context.mosaic.grow(growable)) {
                    if (!this.steps.includes(step)) return;
                    const grown = await this.loadMosaic(context.mosaic);
                    engine.drop(context.rasterId);
                    step.context = grown;
                    if (this.lastContext === context) this.lastContext = grown;
                    continue;
                }
            }
            step.region = toImageRegion(result.polygons, raster);
            const cutAt = (['left', 'top', 'right', 'bottom'] as const).filter(
                side =>
                    result.touches[side] &&
                    (raster.edges[side] === 'view' ||
                        raster.edges[side] === 'cap')
            );
            step.note = !cutAt.length
                ? null
                : raster.source === 'screen'
                ? 'The outline stops at the edge of the view: zoom out to select more.'
                : `The outline stops at the ${this.cap}-pixel limit (${capSize(
                      this.cap,
                      raster.scale,
                      mpp
                  )} across): add the rest with Shift+click.`;
            return;
        }
    }

    /** Records the time from the click to its first outline. */
    private markOutlined(step: WandStep) {
        if (this.ms === null && step === this.steps[this.steps.length - 1]) {
            this.ms = now() - this.startedAt;
        }
    }

    /** Takes back the last click; false when none is left. */
    undoStep(): boolean {
        if (!this.steps.length) return false;
        this.steps.pop();
        this.wanted = null;
        if (!this.steps.length) {
            this.discard();
            return false;
        }
        const last = this.steps[this.steps.length - 1];
        this.emit({
            region: combineSteps(this.steps),
            steps: this.steps.length,
            tolerance: last.tolerance,
            note: last.note,
            seed: last.seed,
            busy: false,
        });
        return true;
    }

    /** Drops the selection or stroke. */
    discard() {
        this.generation += 1;
        this.steps = [];
        this.wanted = null;
        this.cut = false;
        this.stroke = null;
        this.view = null;
        this.onChange(null);
    }

    // The smart brush.

    /** Starts a stroke at `start`, `radius` image pixels wide each side. */
    strokeStart(start: WsiPoint, radius: number, tolerance: number) {
        this.generation += 1;
        this.startedAt = now();
        this.ms = null;
        const context = this.strokeContext(start, radius);
        this.stroke = {
            points: [start],
            radius,
            tolerance: clampTolerance(tolerance),
            context,
            color: null,
            region: [],
            note: null,
            painting: null,
            again: false,
            ending: false,
            covering: null,
        };
        this.emit({
            busy: true,
            region: [],
            tolerance: clampTolerance(tolerance),
            seed: start,
            note: null,
            steps: 0,
        });
        void context.then(() => this.schedulePaint());
    }

    private async strokeContext(
        start: WsiPoint,
        radius: number
    ): Promise<RasterContext | null> {
        if (useScreenPixels(this.host)) {
            const raster = await this.host.readScreen();
            if (raster) {
                const engine = await this.getEngine();
                const { data, ...meta } = raster;
                const rasterId = await engine.setRaster(raster);
                return { raster: meta, rasterId, mosaic: null, viewKey: null };
            }
        }
        const level = pickLevel(
            this.host.levels(),
            targetDownsample(this.host)
        );
        if (!level) return null;
        const mosaic = new WsiTileMosaic(this.host, level, this.cap, count => {
            this.fetching = count;
            this.emit();
        });
        await mosaic.cover({
            minX: start.x - radius,
            minY: start.y - radius,
            maxX: start.x + radius,
            maxY: start.y + radius,
        });
        return this.loadMosaic(mosaic);
    }

    /** Adds a point to the stroke. */
    strokeAdd(point: WsiPoint) {
        const stroke = this.stroke;
        if (!stroke) return;
        stroke.points.push(point);
        this.schedulePaint();
    }

    /** Covers the stroke with tiles (tiles source); restitches when grown. */
    private async coverStroke(): Promise<void> {
        const stroke = this.stroke;
        if (!stroke) return;
        const context = await stroke.context;
        if (!context?.mosaic || this.stroke !== stroke) return;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        stroke.points.forEach(point => {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        });
        const r = stroke.radius;
        const grew = await context.mosaic.cover({
            minX: minX - r,
            minY: minY - r,
            maxX: maxX + r,
            maxY: maxY + r,
        });
        if (!grew || this.stroke !== stroke) return;
        const grown = await this.loadMosaic(context.mosaic);
        (await this.getEngine()).drop(context.rasterId);
        stroke.context = Promise.resolve(grown);
    }

    private schedulePaint() {
        const stroke = this.stroke;
        if (!stroke || stroke.ending) return;
        if (stroke.painting) {
            stroke.again = true;
            return;
        }
        stroke.painting = this.paint(stroke).finally(() => {
            stroke.painting = null;
            if (stroke.again && !stroke.ending && this.stroke === stroke) {
                stroke.again = false;
                this.schedulePaint();
            }
        });
    }

    private async paint(stroke: NonNullable<WsiTissueSession['stroke']>) {
        if (!stroke.covering) {
            stroke.covering = this.coverStroke().finally(() => {
                stroke.covering = null;
            });
        }
        await stroke.covering;
        const context = await stroke.context;
        if (this.stroke !== stroke) return;
        if (!context) {
            stroke.note = 'No slide pixels to paint here.';
            this.emit({ busy: false, note: stroke.note });
            return;
        }
        const { raster } = context;
        const engine = await this.getEngine();
        const points = stroke.points.slice();
        const path = points.map(point => ({
            x: (point.x - raster.originX) / raster.scale,
            y: (point.y - raster.originY) / raster.scale,
        }));
        const result = await engine.run({
            type: 'paint',
            rasterId: context.rasterId,
            path,
            radius: stroke.radius / raster.scale,
            tolerance: stroke.tolerance,
            options: outlineOptions(raster.scale, this.host.mpp()),
            color: stroke.color,
        });
        if (this.stroke !== stroke) return;
        stroke.color = result.color;
        stroke.region = toImageRegion(result.polygons, raster);
        const outside = path.some(
            point =>
                point.x < 0 ||
                point.y < 0 ||
                point.x >= raster.width ||
                point.y >= raster.height
        );
        stroke.note = outside
            ? raster.source === 'screen'
                ? 'Only the part of the stroke in view was painted.'
                : `Only the part of the stroke within the ${this.cap}-pixel limit was painted.`
            : null;
        if (this.ms === null && stroke.region.length) {
            this.ms = now() - this.startedAt;
        }
        this.emit({
            busy: false,
            region: stroke.region,
            note: stroke.note,
            ms: this.ms,
            source: raster.source,
            scale: raster.scale,
        });
    }

    /**
     * Ends the stroke: waits for its tiles and its last paint, and returns
     * the painted region (empty when nothing similar was under it).
     */
    async strokeEnd(): Promise<{ region: WsiRegion; note: string | null }> {
        const stroke = this.stroke;
        if (!stroke) return { region: [], note: null };
        stroke.ending = true;
        stroke.again = false;
        while (stroke.painting) await stroke.painting;
        // One final paint with every point.
        await this.paint(stroke);
        const outcome = { region: stroke.region, note: stroke.note };
        if (this.stroke === stroke) this.stroke = null;
        return outcome;
    }

    /** Ends the session; the shared engine stays for the next one. */
    dispose() {
        this.discard();
        const context = this.lastContext;
        this.lastContext = null;
        if (context) {
            void this.enginePromise?.then(engine =>
                engine.drop(context.rasterId)
            );
        }
    }
}
