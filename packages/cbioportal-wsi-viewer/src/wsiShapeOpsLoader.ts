export type WsiShapeOpsModule = typeof import('./wsiAnnotationShapeOps');

let shapeOpsPromise: Promise<WsiShapeOpsModule> | null = null;

/**
 * Loads the shape operations (`wsiAnnotationShapeOps.ts` with
 * polygon-clipping) when one first runs: merge, subtract, intersect, cut,
 * split. The host bundler emits it as an async chunk (`wsi-shapeops`).
 */
export function loadShapeOps(): Promise<WsiShapeOpsModule> {
    if (!shapeOpsPromise) {
        shapeOpsPromise = import(
            /* webpackChunkName: "wsi-shapeops" */ './wsiAnnotationShapeOps'
        ).catch(error => {
            // Do not cache a failed chunk load: the next operation retries.
            shapeOpsPromise = null;
            throw error;
        });
    }
    return shapeOpsPromise;
}
