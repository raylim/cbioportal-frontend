import { ICivicVariantIndex, ICivicVariantSummary } from 'cbioportal-utils';
import { OncoKbAPI } from 'oncokb-ts-api-client';

/** The OncoKB annotation endpoints the viewer calls. */
export type WsiOncoKbClient = Pick<
    OncoKbAPI,
    | 'annotateMutationsByProteinChangePostUsingPOST_1'
    | 'annotateCopyNumberAlterationsPostUsingPOST_1'
    | 'annotateStructuralVariantsPostUsingPOST_1'
>;

/**
 * Host services for the molecular tables' OncoKB and CIViC annotations and
 * mutation type colors. Without them, the tables show the portal's sample
 * molecular data unannotated.
 */
export interface WsiMolecularServices {
    /** Annotate variants with OncoKB. */
    showOncoKb: boolean;
    /** Annotate variants with CIViC. */
    showCivic: boolean;
    /**
     * OncoKB API URL, also the namespace of the viewer's annotation caches.
     * An empty URL disables OncoKB annotations.
     */
    getOncoKbApiUrl: () => string;
    /**
     * OncoKB client for that URL. Annotations are optional, so failures
     * should not reach the host's global error reporting.
     */
    getOncoKbClient: () => WsiOncoKbClient;
    /** CIViC variants of one gene for a copy number alteration (2 or -2). */
    getCivicCnaVariants: (
        alteration: number,
        geneSymbol: string,
        civicVariants: ICivicVariantIndex
    ) => { [name: string]: ICivicVariantSummary };
    /** Simplified mutation type (`missense`, `frameshift`, ...). */
    getSimplifiedMutationType: (mutationType: string) => string;
}

/**
 * Host services shared by every viewer on the page. Hosts install them once,
 * at startup, with `configureWsiViewerRuntime`.
 */
export interface WsiViewerConfig {
    /**
     * Resolves a portal API path such as `api/wsi/v2/hierarchy/...` to the
     * URL to request, including any deployment context path.
     */
    buildApiUrl: (path: string) => string;
    /** OpenSeadragon `prefixUrl`; OpenSeadragon's own default when unset. */
    osdPrefixUrl?: string;
    /**
     * Fetch used for hierarchy, slide access and thumbnail requests; the
     * global `fetch` when unset. OpenSeadragon loads tiles itself.
     */
    fetchImpl?: typeof fetch;
    /**
     * Molecular annotation services. Portal molecular data is fetched
     * through `buildApiUrl` and `fetchImpl` either way.
     */
    molecular?: WsiMolecularServices;
    /**
     * Annotation authoring against the annotation service at `apiUrl`,
     * authorized with study-scoped portal tokens. Off when unset.
     */
    annotations?: WsiAnnotationsConfig;
    /**
     * Research assistant panel. It talks to the annotation service, so it is
     * shown only when `annotations` is configured too.
     */
    agent?: WsiAgentConfig;
}

export interface WsiAgentConfig {
    enabled: boolean;
}

export interface WsiAnnotationsConfig {
    /** Annotation service base URL, without a trailing slash. */
    apiUrl: string;
}

/** Services read by the viewer's module-level caches and controller. */
export interface WsiViewerRuntime {
    buildApiUrl: (path: string) => string;
    fetchImpl: typeof fetch;
    osdPrefixUrl?: string;
    molecular?: WsiMolecularServices;
    annotations?: WsiAnnotationsConfig;
    agent?: WsiAgentConfig;
}

// Resolves the global at call time so a replaced `window.fetch` is used.
const globalFetch: typeof fetch = (...args: Parameters<typeof fetch>) =>
    fetch(...args);

const DEFAULT_RUNTIME: WsiViewerRuntime = {
    buildApiUrl: () => {
        throw new Error(
            'WSI viewer is not configured: call configureWsiViewerRuntime at startup'
        );
    },
    fetchImpl: globalFetch,
};

let runtime: WsiViewerRuntime = DEFAULT_RUNTIME;

/** Installs the host services. Call once, before any viewer renders. */
export function configureWsiViewerRuntime(config: WsiViewerConfig): void {
    runtime = {
        buildApiUrl: config.buildApiUrl,
        fetchImpl: config.fetchImpl ?? globalFetch,
        osdPrefixUrl: config.osdPrefixUrl,
        molecular: config.molecular,
        annotations: config.annotations,
        agent: config.agent,
    };
}

export function getWsiViewerRuntime(): Readonly<WsiViewerRuntime> {
    return runtime;
}

export function resetWsiViewerRuntime(): void {
    runtime = DEFAULT_RUNTIME;
}
