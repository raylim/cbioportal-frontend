export type WsiTissueModule = typeof import('./wsiTissueSelect');

let tissueModule: WsiTissueModule | null = null;
let tissuePromise: Promise<WsiTissueModule> | null = null;

/**
 * Loads the magic wand and smart brush (`wsiTissueSelect.ts`, its pixel
 * sources and its Web Worker) when either tool is first picked. The host
 * bundler emits it as an async chunk (`wsi-tissue`).
 */
export function loadTissueTools(): Promise<WsiTissueModule> {
    if (!tissuePromise) {
        tissuePromise = import(
            /* webpackChunkName: "wsi-tissue" */ './wsiTissueSelect'
        )
            .then(mod => {
                tissueModule = mod;
                return mod;
            })
            .catch(error => {
                // Do not cache a failed chunk load: the next pick retries.
                tissuePromise = null;
                throw error;
            });
    }
    return tissuePromise;
}

/** The loaded module, or null until `loadTissueTools` has resolved. */
export function getLoadedTissueTools(): WsiTissueModule | null {
    return tissueModule;
}
