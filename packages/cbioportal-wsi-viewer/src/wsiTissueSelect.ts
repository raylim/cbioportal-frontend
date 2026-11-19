import { WsiPoint, WsiRegion } from './wsiAnnotationGeometryUtils';
import { loadShapeOps, WsiShapeOpsModule } from './wsiShapeOpsLoader';
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
/** The smoothing blur's radius, in µm of tissue. */
export const BLUR_RADIUS_UM = 1;
/** The seed color is the mean within this radius of the click, in µm. */
export const SEED_RADIUS_UM = 2.5;
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

/** A smart brush stroke, painted while drawn and finished on its own. */
interface Stroke {
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
    /** Discarded (Esc, another slide): nothing more is painted or shown. */
    dropped: boolean;
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

/**
 * Combines the wand's steps: the first, then each added or subtracted. A
 * step still without a region changes nothing. `ops` (the shape
 * operations, loaded with the session) are needed once two steps have
 * regions.
 */
export function combineSteps(
    steps: ReadonlyArray<{ kind: StepKind; region: WsiRegion }>,
    ops: Pick<WsiShapeOpsModule, 'unionRegions' | 'subtractRegions'> | null
): WsiRegion {
    let region: WsiRegion = [];
    steps.forEach(step => {
        if (step.kind === 'new') region = step.region;
        else if (!step.region.length) return;
        else if (step.kind === 'add') {
            region = region.length
                ? need(ops).unionRegions([region, step.region])
                : step.region;
        } else if (region.length) {
            region = need(ops).subtractRegions(region, [step.region]);
        }
    });
    return region;
}

function need<T>(ops: T | null): T {
    if (!ops) throw new Error('The shape operations are not loaded.');
    return ops;
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
        seedRadius: Math.max(
            2,
            micron > 0 ? Math.round(SEED_RADIUS_UM / micron) : 2
        ),
    };
}

/**
 * The smoothing blur's radius for a raster of `scale` image pixels per
 * pixel: about `BLUR_RADIUS_UM` (1 at 1 µm per pixel, 4 at 0.25), so the
 * same tissue is smoothed alike at any zoom; 1 without a scale.
 */
export function blurRadius(
    scale: number,
    mpp: { x: number; y: number } | null | undefined
): number {
    const micron = mpp ? ((mpp.x + mpp.y) / 2) * scale : 0;
    return micron > 0 ? Math.max(1, Math.round(BLUR_RADIUS_UM / micron)) : 1;
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
    /**
     * The steps waiting to be computed, each at its latest tolerance, in
     * the order they were asked for: every click is computed once.
     */
    private wanted = new Map<WandStep, number>();
    private generation = 0;
    /** Tiles being fetched for the current selection or stroke. */
    private fetching = 0;
    private startedAt = 0;
    private ms: number | null = null;
    private lastContext: RasterContext | null = null;
    /**
     * Rasters in the engine. One is dropped only once no step, stroke or
     * reuse refers to it (`releaseRasters`).
     */
    private contexts = new Set<RasterContext>();
    /** A grown raster replaces the one it grew from. */
    private replaced = new Map<RasterContext, RasterContext>();
    /** Mosaics still fetching for the current selection. */
    private mosaics = new Set<WsiTileMosaic>();
    /** The stroke being drawn (strokes being finished are held by their caller). */
    private stroke: Stroke | null = null;
    /** Strokes being finished, whose rasters must stay. */
    private ending = new Set<Stroke>();
    private view: WsiTissueView | null = null;
    /** The shape operations, for Shift+ and Alt+clicks (their own chunk). */
    private ops: WsiShapeOpsModule | null = null;
    private readonly opsReady: Promise<WsiShapeOpsModule | null>;
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
        this.opsReady = loadShapeOps().then(
            ops => (this.ops = ops),
            () => null
        );
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
        return combineSteps(this.steps, this.ops);
    }

    get isCut(): boolean {
        return this.cut;
    }

    /** The wand's current tolerance (its last step's). */
    get tolerance(): number | null {
        const last = this.steps[this.steps.length - 1];
        return last ? last.tolerance : null;
    }

    /** The raster that now stands for `context` (it may have grown). */
    private current(context: RasterContext): RasterContext {
        let at = context;
        for (
            let next = this.replaced.get(at);
            next;
            next = this.replaced.get(at)
        ) {
            at = next;
        }
        return at;
    }

    /** Records a raster in the engine. */
    private keepRaster(context: RasterContext): RasterContext {
        this.contexts.add(context);
        return context;
    }

    /**
     * Drops the engine's rasters that nothing refers to any more: no step
     * of the selection, no stroke being drawn or finished, and not the one
     * kept for the next click.
     */
    private releaseRasters() {
        const used = new Set<RasterContext>();
        const use = (context: RasterContext | null | undefined) => {
            if (context) used.add(this.current(context));
        };
        this.steps.forEach(step => use(step.context));
        use(this.lastContext);
        const strokes = [this.stroke, ...Array.from(this.ending)];
        const pending: Array<Promise<RasterContext | null>> = [];
        strokes.forEach(stroke => stroke && pending.push(stroke.context));
        const drop = () => {
            const engine = this.engine;
            if (!engine) return;
            this.contexts.forEach(context => {
                if (used.has(context)) return;
                this.contexts.delete(context);
                engine.drop(context.rasterId);
            });
            this.replaced.forEach((to, from) => {
                if (!this.contexts.has(from) && !this.contexts.has(to)) {
                    this.replaced.delete(from);
                }
            });
        };
        if (!pending.length) {
            drop();
            return;
        }
        // A stroke's raster may still be on its way: wait for it.
        void Promise.all(pending).then(contexts => {
            contexts.forEach(use);
            drop();
        });
    }

    /** A tile mosaic whose fetching counts for this selection or stroke only. */
    private newMosaic(level: ReturnType<typeof pickLevel> & object) {
        const generation = this.generation;
        const mosaic = new WsiTileMosaic(this.host, level, this.cap, () => {
            if (generation !== this.generation || mosaic.aborted) return;
            let fetching = 0;
            this.mosaics.forEach(item => (fetching += item.fetching));
            this.fetching = fetching;
            this.emit();
        });
        this.mosaics.add(mosaic);
        return mosaic;
    }

    /** Stops the tile fetches of an earlier selection or stroke. */
    private abortFetches() {
        this.mosaics.forEach(mosaic => {
            if (mosaic.fetching > 0) {
                mosaic.abort();
                if (this.lastContext?.mosaic === mosaic) {
                    this.lastContext = null;
                }
            }
        });
        this.mosaics.clear();
        this.fetching = 0;
    }

    /**
     * Reads a raster for a click at `seed` and gives it to `step` (at once,
     * so no release can drop it in between), reusing the last when it fits.
     */
    private async rasterFor(
        seed: WsiPoint,
        step: WandStep
    ): Promise<RasterContext | null> {
        const engine = await this.getEngine();
        const last = this.lastContext ? this.current(this.lastContext) : null;
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
                return (step.context = last);
            }
            const raster = await this.host.readScreen(seed);
            if (raster) {
                const { data, ...meta } = raster;
                const rasterId = await engine.setRaster(
                    raster,
                    blurRadius(raster.scale, this.host.mpp())
                );
                const context = this.keepRaster({
                    raster: meta,
                    rasterId,
                    mosaic: null,
                    viewKey: key,
                });
                this.lastContext = context;
                return (step.context = context);
            }
            // Rotated, flipped or tainted: tiles instead.
        }
        if (
            last?.mosaic &&
            !last.mosaic.aborted &&
            last.mosaic.contains(seed.x, seed.y)
        ) {
            return (step.context = last);
        }
        const level = pickLevel(
            this.host.levels(),
            targetDownsample(this.host)
        );
        if (!level) return null;
        const mosaic = this.newMosaic(level);
        const half = (INITIAL_WINDOW / 2) * level.downsample;
        await mosaic.cover({
            minX: seed.x - half,
            minY: seed.y - half,
            maxX: seed.x + half,
            maxY: seed.y + half,
        });
        if (mosaic.aborted) return null;
        const context = await this.loadMosaic(mosaic);
        this.lastContext = context;
        return (step.context = context);
    }

    private async loadMosaic(mosaic: WsiTileMosaic): Promise<RasterContext> {
        const engine = await this.getEngine();
        const raster = mosaic.raster();
        const { data, ...meta } = raster;
        const rasterId = await engine.setRaster(
            raster,
            blurRadius(raster.scale, this.host.mpp())
        );
        return this.keepRaster({
            raster: meta,
            rasterId,
            mosaic,
            viewKey: null,
        });
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
            this.abortFetches();
            this.steps = [];
            this.wanted.clear();
            this.cut = cut;
            kind = 'new';
            this.releaseRasters();
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
            region: combineSteps(this.steps, this.ops),
        });
        const generation = this.generation;
        const context = await this.rasterFor(seed, step);
        if (generation !== this.generation || !this.steps.includes(step)) {
            return;
        }
        if (!context) {
            this.steps.splice(this.steps.indexOf(step), 1);
            this.emit({
                busy: this.wanted.size > 0,
                steps: this.steps.length,
                region: combineSteps(this.steps, this.ops),
                note: 'No slide pixels to select from here.',
            });
            return;
        }
        this.emit({
            source: context.raster.source,
            scale: context.raster.scale,
        });
        await this.compute(step, step.tolerance);
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

    /**
     * Runs the wand for `step` at `tolerance`. Steps are computed one at a
     * time in the order asked, each once at its latest tolerance.
     */
    private async compute(step: WandStep, tolerance: number): Promise<void> {
        // Re-inserted, so a step asked again goes after the others waiting.
        this.wanted.delete(step);
        this.wanted.set(step, tolerance);
        if (this.running) return;
        this.running = true;
        let generation = this.generation;
        try {
            while (this.wanted.size) {
                generation = this.generation;
                const [target, value] = this.wanted.entries().next().value as [
                    WandStep,
                    number
                ];
                this.wanted.delete(target);
                if (!this.steps.includes(target) || !target.context) continue;
                this.emit({ busy: true });
                if (!this.ops && this.steps.length > 1) {
                    if (!(await this.opsReady)) {
                        throw new Error('the shape operations did not load');
                    }
                }
                await this.runStep(target, value);
                if (
                    generation !== this.generation ||
                    !this.steps.includes(target)
                ) {
                    continue;
                }
                this.markOutlined(target);
                const last = this.steps[this.steps.length - 1];
                this.emit({
                    busy: this.wanted.size > 0,
                    region: combineSteps(this.steps, this.ops),
                    tolerance: last.tolerance,
                    note: target.note,
                    ms: this.ms,
                    source: target.context!.raster.source,
                    scale: target.context!.raster.scale,
                });
            }
        } catch (error) {
            if (generation === this.generation) {
                this.emit({
                    busy: false,
                    note: `The selection failed: ${(error as Error)?.message ||
                        error}`,
                });
            }
        } finally {
            this.running = false;
            // A new selection started while this one ran: compute it now.
            if (this.wanted.size) {
                const [next, value] = this.wanted.entries().next().value as [
                    WandStep,
                    number
                ];
                void this.track(this.compute(next, value));
            }
        }
    }

    private async runStep(step: WandStep, tolerance: number) {
        const engine = await this.getEngine();
        const mpp = this.host.mpp();
        for (;;) {
            const context = this.current(step.context!);
            step.context = context;
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
            if (!this.steps.includes(step)) return;
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
                this.emit({
                    region: combineSteps(this.steps, this.ops),
                    ms: this.ms,
                });
                // A newer tolerance or click: stop growing for this one.
                if (this.wanted.size || !this.steps.includes(step)) return;
                if (await context.mosaic.grow(growable)) {
                    if (!this.steps.includes(step) || context.mosaic.aborted) {
                        return;
                    }
                    const grown = await this.loadMosaic(context.mosaic);
                    // Every step on the old raster moves to the grown one
                    // (same tiles and more), and the old one goes.
                    this.replaced.set(context, grown);
                    this.steps.forEach(other => {
                        if (other.context === context) other.context = grown;
                    });
                    if (this.lastContext === context) this.lastContext = grown;
                    this.releaseRasters();
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
        const removed = this.steps.pop()!;
        this.wanted.delete(removed);
        if (!this.steps.length) {
            this.discard();
            return false;
        }
        const last = this.steps[this.steps.length - 1];
        this.emit({
            region: combineSteps(this.steps, this.ops),
            steps: this.steps.length,
            tolerance: last.tolerance,
            note: last.note,
            seed: last.seed,
            busy: this.wanted.size > 0,
        });
        this.releaseRasters();
        return true;
    }

    /**
     * Drops the selection or the stroke being drawn; nothing the dropped
     * work still finishes shows. A stroke already ending is finished.
     */
    discard() {
        this.generation += 1;
        this.abortFetches();
        this.steps = [];
        this.wanted.clear();
        this.cut = false;
        if (this.stroke && !this.stroke.ending) this.stroke.dropped = true;
        this.stroke = null;
        this.view = null;
        this.onChange(null);
        this.releaseRasters();
    }

    /** Drops one stroke (a split takes its path, not its paint). */
    cancelStroke(handle: object) {
        const stroke = handle as Stroke;
        stroke.dropped = true;
        if (this.stroke === stroke) {
            this.stroke = null;
            this.view = null;
            this.onChange(null);
        }
        this.releaseRasters();
    }

    /** Hides the outline unless a stroke is being drawn. */
    clearUnlessDrawing() {
        if (this.stroke || this.steps.length) return;
        this.view = null;
        this.onChange(null);
    }

    // The smart brush.

    /**
     * Starts a stroke at `start`, `radius` image pixels wide each side, and
     * returns it: `strokeAdd` and `strokeEnd` take it, so a stroke finishes
     * on its own while the next one is drawn.
     */
    strokeStart(start: WsiPoint, radius: number, tolerance: number): object {
        if (this.stroke && !this.stroke.ending) this.stroke.dropped = true;
        this.generation += 1;
        this.startedAt = now();
        this.ms = null;
        this.view = null;
        const context = this.strokeContext(start, radius);
        const stroke: Stroke = {
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
            dropped: false,
        };
        this.stroke = stroke;
        this.emit({
            busy: true,
            region: [],
            tolerance: clampTolerance(tolerance),
            seed: start,
            note: null,
            steps: 0,
        });
        void context.then(() => this.schedulePaint(stroke));
        return stroke;
    }

    private async strokeContext(
        start: WsiPoint,
        radius: number
    ): Promise<RasterContext | null> {
        if (useScreenPixels(this.host)) {
            const raster = await this.host.readScreen(start);
            if (raster) {
                const engine = await this.getEngine();
                const { data, ...meta } = raster;
                const rasterId = await engine.setRaster(
                    raster,
                    blurRadius(raster.scale, this.host.mpp())
                );
                return this.keepRaster({
                    raster: meta,
                    rasterId,
                    mosaic: null,
                    viewKey: null,
                });
            }
        }
        const level = pickLevel(
            this.host.levels(),
            targetDownsample(this.host)
        );
        if (!level) return null;
        const mosaic = this.newMosaic(level);
        await mosaic.cover({
            minX: start.x - radius,
            minY: start.y - radius,
            maxX: start.x + radius,
            maxY: start.y + radius,
        });
        return this.loadMosaic(mosaic);
    }

    /** Adds a point to the stroke (the one being drawn by default). */
    strokeAdd(point: WsiPoint, handle?: object) {
        const stroke = (handle as Stroke | undefined) || this.stroke;
        if (!stroke || stroke.dropped || stroke.ending) return;
        stroke.points.push(point);
        this.schedulePaint(stroke);
    }

    /** Covers the stroke with tiles (tiles source); restitches when grown. */
    private async coverStroke(stroke: Stroke): Promise<void> {
        const context = await stroke.context;
        if (!context?.mosaic || stroke.dropped) return;
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
        if (!grew || stroke.dropped || context.mosaic.aborted) return;
        const grown = await this.loadMosaic(context.mosaic);
        stroke.context = Promise.resolve(grown);
        this.replaced.set(context, grown);
        this.releaseRasters();
    }

    private schedulePaint(stroke: Stroke) {
        if (stroke.dropped || stroke.ending) return;
        if (stroke.painting) {
            stroke.again = true;
            return;
        }
        stroke.painting = this.paint(stroke).finally(() => {
            stroke.painting = null;
            if (stroke.again && !stroke.ending && !stroke.dropped) {
                stroke.again = false;
                this.schedulePaint(stroke);
            }
        });
    }

    private async paint(stroke: Stroke) {
        if (!stroke.covering) {
            stroke.covering = this.coverStroke(stroke).finally(() => {
                stroke.covering = null;
            });
        }
        await stroke.covering;
        const context = await stroke.context;
        if (stroke.dropped) return;
        // Only the stroke being drawn shows; one being finished does not
        // replace a newer stroke's outline.
        const shown = () => this.stroke === stroke;
        if (!context) {
            stroke.note = 'No slide pixels to paint here.';
            if (shown()) this.emit({ busy: false, note: stroke.note });
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
        if (stroke.dropped) return;
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
        if (!shown()) return;
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
    async strokeEnd(
        handle?: object
    ): Promise<{ region: WsiRegion; note: string | null }> {
        const stroke = (handle as Stroke | undefined) || this.stroke;
        if (!stroke || stroke.dropped) return { region: [], note: null };
        stroke.ending = true;
        stroke.again = false;
        this.ending.add(stroke);
        try {
            while (stroke.painting) await stroke.painting;
            // One final paint with every point.
            await this.paint(stroke);
            return { region: stroke.region, note: stroke.note };
        } finally {
            this.ending.delete(stroke);
            if (this.stroke === stroke) this.stroke = null;
            this.releaseRasters();
        }
    }

    /** Ends the session; the shared engine stays for the next one. */
    dispose() {
        this.discard();
        this.lastContext = null;
        this.ending.clear();
        this.releaseRasters();
    }
}
