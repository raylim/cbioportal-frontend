import { ICivicVariantIndex, ICivicVariantSummary } from 'cbioportal-utils';
import { OncoKbAPI } from 'oncokb-ts-api-client';
import { hashUrlState, WsiUrlStateAdapter } from './wsiViewStateUtils';

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
    /**
     * The portal authenticates users. Protected hierarchy and metadata
     * responses are then never kept in sessionStorage.
     */
    authEnabled: boolean;
    /** OpenSeadragon `prefixUrl`; OpenSeadragon's own default when unset. */
    osdPrefixUrl?: string;
    /** Slide and viewport link state; the `#wsi:` URL hash when unset. */
    urlState?: WsiUrlStateAdapter;
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
}

/** Services read by the viewer's module-level caches and controller. */
export interface WsiViewerRuntime {
    buildApiUrl: (path: string) => string;
    authEnabled: boolean;
    fetchImpl: typeof fetch;
    osdPrefixUrl?: string;
    urlState: WsiUrlStateAdapter;
    molecular?: WsiMolecularServices;
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
    authEnabled: false,
    fetchImpl: globalFetch,
    urlState: hashUrlState,
};

let runtime: WsiViewerRuntime = DEFAULT_RUNTIME;

/** Installs the host services. Call once, before any viewer renders. */
export function configureWsiViewerRuntime(config: WsiViewerConfig): void {
    runtime = {
        buildApiUrl: config.buildApiUrl,
        authEnabled: config.authEnabled,
        fetchImpl: config.fetchImpl ?? globalFetch,
        osdPrefixUrl: config.osdPrefixUrl,
        urlState: config.urlState ?? hashUrlState,
        molecular: config.molecular,
    };
}

export function getWsiViewerRuntime(): Readonly<WsiViewerRuntime> {
    return runtime;
}

export function resetWsiViewerRuntime(): void {
    runtime = DEFAULT_RUNTIME;
}
