// Inlined by rollup-plugin-web-worker-loader as a Blob URL worker; Jest maps
// `web-worker:*` to a stub, so the main-thread engine runs there.
import TissueWorker from 'web-worker:./wsiTissueWorker';
import {
    handleTissueMessage,
    WsiTissueComputed,
    WsiTissueEngineState,
    WsiTissueRequest,
} from './wsiTissueCompute';

/**
 * Runs tissue selection requests (`wsiTissueCompute.ts`): in a Web Worker
 * when the browser starts one, else on the main thread. The worker keeps
 * the flood fill and contour tracing (up to about 0.3 s on a 4096×4096
 * raster) off the main thread, so the slide keeps panning and the preview
 * keeps following the pointer.
 */
export interface WsiTissueEngine {
    /** 'worker' or 'main' (no Worker, or it did not answer). */
    readonly kind: 'worker' | 'main';
    /** Sends a raster (its pixels are transferred to the worker). */
    setRaster(raster: {
        width: number;
        height: number;
        data: Uint8ClampedArray;
    }): Promise<number>;
    run(
        request: Extract<WsiTissueRequest, { type: 'wand' | 'paint' }>
    ): Promise<WsiTissueComputed>;
    drop(rasterId: number): void;
    dispose(): void;
}

let nextRasterId = 1;

/** The engine on the main thread; each request yields to the UI first. */
export function createMainThreadEngine(): WsiTissueEngine {
    const state: WsiTissueEngineState = { rasters: new Map() };
    const later = <T>(run: () => T) =>
        new Promise<T>((resolve, reject) =>
            setTimeout(() => {
                try {
                    resolve(run());
                } catch (error) {
                    reject(error);
                }
            }, 0)
        );
    return {
        kind: 'main',
        setRaster(raster) {
            const rasterId = nextRasterId++;
            return later(() => {
                handleTissueMessage(state, {
                    type: 'raster',
                    rasterId,
                    ...raster,
                });
                return rasterId;
            });
        },
        run(request) {
            return later(
                () => handleTissueMessage(state, request) as WsiTissueComputed
            );
        },
        drop(rasterId) {
            state.rasters.delete(rasterId);
        },
        dispose() {
            state.rasters.clear();
        },
    };
}

/** How long a new worker has to answer before the main thread is used. */
const WORKER_START_TIMEOUT_MS = 3000;

function createWorkerEngine(worker: Worker): WsiTissueEngine {
    let nextId = 1;
    const pending = new Map<
        number,
        { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    worker.onmessage = (event: MessageEvent) => {
        const { id, result, error } = event.data || {};
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (error) entry.reject(new Error(error));
        else entry.resolve(result);
    };
    worker.onerror = (event: ErrorEvent) => {
        pending.forEach(entry =>
            entry.reject(new Error(event.message || 'Worker error'))
        );
        pending.clear();
    };
    const send = (message: any, transfer: Transferable[] = []) =>
        new Promise<any>((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            worker.postMessage({ ...message, id }, transfer);
        });
    return {
        kind: 'worker',
        async setRaster(raster) {
            const rasterId = nextRasterId++;
            await send({ type: 'raster', rasterId, ...raster }, [
                raster.data.buffer,
            ]);
            return rasterId;
        },
        run(request) {
            return send(request);
        },
        drop(rasterId) {
            void send({ type: 'drop', rasterId }).catch(() => undefined);
        },
        dispose() {
            worker.terminate();
            pending.forEach(entry => entry.reject(new Error('Disposed')));
            pending.clear();
        },
    };
}

/**
 * A worker engine when a worker starts and answers within
 * `WORKER_START_TIMEOUT_MS` (a Content Security Policy without `blob:`
 * workers, for one, stops it), else the main-thread engine.
 */
export async function createTissueEngine(): Promise<WsiTissueEngine> {
    let worker: Worker | null = null;
    try {
        if (typeof Worker === 'undefined') throw new Error('No Worker');
        worker = new (TissueWorker as any)() as Worker;
        const engine = createWorkerEngine(worker);
        const answered = await Promise.race([
            new Promise<boolean>(resolve => {
                // A drop of an unknown raster answers null.
                worker!.addEventListener('message', () => resolve(true), {
                    once: true,
                });
                worker!.addEventListener('error', () => resolve(false), {
                    once: true,
                });
                engine.drop(-1);
            }),
            new Promise<boolean>(resolve =>
                setTimeout(() => resolve(false), WORKER_START_TIMEOUT_MS)
            ),
        ]);
        if (!answered) throw new Error('The worker did not start');
        return engine;
    } catch (_) {
        try {
            worker?.terminate();
        } catch (__) {
            /* never started */
        }
        return createMainThreadEngine();
    }
}
