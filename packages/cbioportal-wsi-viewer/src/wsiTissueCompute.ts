import {
    prepareRaster,
    smartBrushSelect,
    wandSelect,
    WsiOutlineOptions,
    WsiPreparedRaster,
    WsiTissueResult,
    WsiXYPoint,
} from './wsiTissueCore';

/**
 * The tissue engine's requests, the same in the Web Worker and on the main
 * thread: a raster is sent once (its pixels transferred) and prepared, then
 * wand and brush requests name it by `rasterId`.
 */
export type WsiTissueRequest =
    | {
          type: 'raster';
          rasterId: number;
          width: number;
          height: number;
          data: Uint8ClampedArray;
          /** The smoothing box blur's radius, in pixels. */
          blurRadius?: number;
      }
    | { type: 'drop'; rasterId: number }
    | {
          type: 'wand';
          rasterId: number;
          x: number;
          y: number;
          tolerance: number;
          options: WsiOutlineOptions;
          color?: [number, number, number] | null;
      }
    | {
          type: 'paint';
          rasterId: number;
          path: WsiXYPoint[];
          radius: number;
          tolerance: number;
          options: WsiOutlineOptions;
          color?: [number, number, number] | null;
      };

/** A wand or brush result, with the time it took in the engine. */
export interface WsiTissueComputed extends WsiTissueResult {
    ms: number;
}

/** Prepared rasters by id, each with a reusable mask. */
export interface WsiTissueEngineState {
    rasters: Map<number, { prepared: WsiPreparedRaster; mask: Uint8Array }>;
}

/** Rasters kept at once; the oldest is dropped (about 50 MB at the cap). */
const MAX_RASTERS = 3;

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Runs one request against `state`. */
export function handleTissueMessage(
    state: WsiTissueEngineState,
    message: WsiTissueRequest
): WsiTissueComputed | { rasterId: number } | null {
    switch (message.type) {
        case 'raster': {
            const prepared = prepareRaster(message, message.blurRadius);
            state.rasters.set(message.rasterId, {
                prepared,
                mask: new Uint8Array(message.width * message.height),
            });
            while (state.rasters.size > MAX_RASTERS) {
                state.rasters.delete(state.rasters.keys().next().value);
            }
            return { rasterId: message.rasterId };
        }
        case 'drop':
            state.rasters.delete(message.rasterId);
            return null;
        case 'wand':
        case 'paint': {
            const entry = state.rasters.get(message.rasterId);
            if (!entry) throw new Error('The raster is gone');
            const started = now();
            const result =
                message.type === 'wand'
                    ? wandSelect(
                          entry.prepared,
                          message.x,
                          message.y,
                          message.tolerance,
                          message.options,
                          entry.mask,
                          message.color
                      )
                    : smartBrushSelect(
                          entry.prepared,
                          message.path,
                          message.radius,
                          message.tolerance,
                          message.options,
                          entry.mask,
                          message.color
                      );
            return { ...result, ms: now() - started };
        }
    }
    return null;
}
