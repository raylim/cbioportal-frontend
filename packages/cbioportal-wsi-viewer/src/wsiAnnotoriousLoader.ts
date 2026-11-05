export type AnnotoriousModule = typeof import('@annotorious/openseadragon');

let annotoriousModule: AnnotoriousModule | null = null;
let annotoriousPromise: Promise<AnnotoriousModule> | null = null;

/**
 * Loads Annotorious and its stylesheet on first use. The host bundler emits
 * them as an async chunk, so viewers without annotations never download it.
 */
export function loadAnnotorious(): Promise<AnnotoriousModule> {
    if (!annotoriousPromise) {
        const loadPromise = Promise.all([
            // Rspack handles these imports as an async chunk; the project
            // TypeScript target predates the dynamic import syntax.
            // @ts-ignore
            import(
                /* webpackChunkName: "wsi-annotorious" */ '@annotorious/openseadragon'
            ),
            // The stylesheet has no type declarations.
            // @ts-ignore
            import('@annotorious/openseadragon/annotorious-openseadragon.css'),
        ]).then(([mod]) => {
            annotoriousModule = mod as AnnotoriousModule;
            return annotoriousModule;
        });
        annotoriousPromise = loadPromise.catch(error => {
            // Do not cache a failed chunk load: the next slide open retries.
            annotoriousPromise = null;
            throw error;
        });
    }
    return annotoriousPromise;
}

/** The loaded module, or null until `loadAnnotorious` has resolved. */
export function getLoadedAnnotorious(): AnnotoriousModule | null {
    return annotoriousModule;
}
