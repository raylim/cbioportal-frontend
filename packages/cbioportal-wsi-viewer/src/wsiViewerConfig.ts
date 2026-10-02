import { hashUrlState, WsiUrlStateAdapter } from './wsiViewStateUtils';

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
    authEnabled: boolean;
    fetchImpl: typeof fetch;
    osdPrefixUrl?: string;
    urlState: WsiUrlStateAdapter;
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
