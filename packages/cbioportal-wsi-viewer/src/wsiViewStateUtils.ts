import {
    PathologySlideMatchFilter,
    TileMetadata,
    WsiStainFilter,
} from './wsiViewerTypes';

export type WsiHashViewport = {
    x: number;
    y: number;
    z: number;
};

/**
 * A `#wsi:` hash selects a slide and may also carry a viewport. The selection
 * form without coordinates (`#wsi:slide=X`) is written when a slide is chosen
 * before its viewport is known.
 */
export type WsiHashState =
    | ({ slideId: string } & WsiHashViewport)
    | { slideId: string; x?: undefined; y?: undefined; z?: undefined };

/**
 * The slide list's filters, kept in the same hash so a shared link opens the
 * list as it was. Only filters other than "all" are written.
 */
export type WsiHashFilters = {
    stain?: Exclude<WsiStainFilter, 'all'>;
    match?: Exclude<PathologySlideMatchFilter, 'all'>;
};

const HASH_STAIN_FILTERS: ReadonlyArray<WsiStainFilter> = [
    'hne',
    'ihc',
    'other',
    'unknown',
];
const HASH_MATCH_FILTERS: ReadonlyArray<PathologySlideMatchFilter> = [
    'part',
    'block',
    'unmatched',
];

export function hasWsiHashViewport(
    state: WsiHashState | null | undefined
): state is { slideId: string } & WsiHashViewport {
    return !!state && state.x !== undefined;
}

/**
 * Where the viewer keeps the selected slide and viewport so that a copied
 * link reopens the same view. The default keeps it in a `#wsi:` URL hash.
 */
export interface WsiUrlStateAdapter {
    /** The stored slide selection and viewport, or null when there is none. */
    read(): WsiHashState | null;
    /**
     * Stores the state and returns the shareable URL that carries it. With
     * `push`, the state gets its own history entry, so Back returns to the
     * previous one; otherwise it replaces the current entry.
     */
    write(state: WsiHashState, options?: { push?: boolean }): string;
    /** Removes the stored slide and viewport. */
    clear(): void;
    /** Shareable URL of the current page. */
    currentUrl(): string;
    /**
     * Calls the listener when the stored state changes outside the viewer
     * (e.g. browser navigation). Returns a function that unsubscribes.
     */
    subscribe(listener: () => void): () => void;
}

export function formatWsiHash(
    state: WsiHashState | null,
    filters: WsiHashFilters = {}
): string {
    const parts: string[] = [];
    if (state) {
        parts.push(`slide=${encodeURIComponent(state.slideId)}`);
        if (hasWsiHashViewport(state)) {
            parts.push(
                `x=${Math.round(state.x)}`,
                `y=${Math.round(state.y)}`,
                `z=${state.z.toFixed(6)}`
            );
        }
    }
    if (filters.stain) parts.push(`stain=${filters.stain}`);
    if (filters.match) parts.push(`match=${filters.match}`);
    return parts.length ? `wsi:${parts.join('&')}` : '';
}

/** Slide and viewport shown by an OpenSeadragon viewer, in image pixels. */
export function buildWsiViewState({
    selectedSlideId,
    osdViewer,
}: {
    selectedSlideId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    osdViewer: any;
}): WsiHashState | null {
    if (
        typeof window === 'undefined' ||
        !osdViewer?.viewport ||
        !selectedSlideId
    ) {
        return null;
    }

    try {
        const viewport = osdViewer.viewport;
        const center = viewport.viewportToImageCoordinates(
            viewport.getCenter()
        );
        return {
            slideId: selectedSlideId,
            x: center.x,
            y: center.y,
            z: viewport.getZoom(),
        };
    } catch (_) {
        return null;
    }
}

export function writeWsiHashToCurrentUrl(hash: string, push = false): string {
    const nextHash = !hash ? '' : hash.startsWith('#') ? hash : `#${hash}`;
    if (window.location.hash === nextHash) {
        return window.location.href;
    }

    const url = new URL(window.location.href);
    url.hash = nextHash;
    const href = url.toString();
    if (push) {
        window.history.pushState(null, '', href);
    } else {
        window.history.replaceState(null, '', href);
    }
    return href;
}

/**
 * Stores a slide selection. The stored viewport is kept when it belongs to
 * another slide, and nothing is written when the slide is already selected.
 */
export function writeSelectedSlideState(
    urlState: WsiUrlStateAdapter,
    selectedSlideId: string,
    push = false
): string {
    const existing = urlState.read();
    if (existing && existing.slideId === selectedSlideId) {
        return urlState.currentUrl();
    }

    // With `push`, the selection gets its own history entry for Back.
    const options = { push };
    if (hasWsiHashViewport(existing)) {
        return urlState.write(
            { ...existing, slideId: selectedSlideId },
            options
        );
    }

    return urlState.write({ slideId: selectedSlideId }, options);
}

/** Removes the slide and viewport from the hash; the list's filters stay. */
export function clearWsiHashFromCurrentUrl(): void {
    if (
        typeof window === 'undefined' ||
        !window.location.hash.startsWith('#wsi:')
    ) {
        return;
    }
    writeWsiHashToCurrentUrl(formatWsiHash(null, readWsiHashFilters()));
}

/** The slide list's filters in the current hash. */
export function readWsiHashFilters(): WsiHashFilters {
    if (
        typeof window === 'undefined' ||
        !window.location.hash.startsWith('#wsi:')
    ) {
        return {};
    }
    try {
        const params = new URLSearchParams(window.location.hash.slice(5));
        const stain = params.get('stain') as WsiStainFilter | null;
        const match = params.get('match') as PathologySlideMatchFilter | null;
        const filters: WsiHashFilters = {};
        if (stain && HASH_STAIN_FILTERS.includes(stain)) {
            filters.stain = stain as WsiHashFilters['stain'];
        }
        if (match && HASH_MATCH_FILTERS.includes(match)) {
            filters.match = match as WsiHashFilters['match'];
        }
        return filters;
    } catch (_) {
        return {};
    }
}

/**
 * Stores the slide list's filters in the hash, keeping the slide and
 * viewport; "all" removes a filter. Replaces the current history entry.
 */
export function writeWsiHashFilters(
    stain: WsiStainFilter,
    match: PathologySlideMatchFilter
): string {
    return writeWsiHashToCurrentUrl(
        formatWsiHash(readWsiHashState(), {
            stain: stain === 'all' ? undefined : stain,
            match: match === 'all' ? undefined : match,
        })
    );
}

export function scheduleHashStateWrite({
    timer,
    selectedSlideId,
    osdViewer,
    urlState = hashUrlState,
}: {
    timer: ReturnType<typeof setTimeout> | null;
    selectedSlideId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    osdViewer: any;
    urlState?: WsiUrlStateAdapter;
}): ReturnType<typeof setTimeout> {
    if (timer !== null) {
        clearTimeout(timer);
    }
    return setTimeout(() => {
        const state = buildWsiViewState({
            selectedSlideId,
            osdViewer,
        });
        if (state) {
            urlState.write(state);
        }
    }, 80);
}

export function readWsiHashState(): WsiHashState | null {
    if (typeof window === 'undefined') return null;
    const hash = window.location.hash;
    const prefix = '#wsi:';
    if (!hash.startsWith(prefix)) return null;
    try {
        const params = new URLSearchParams(hash.slice(prefix.length));
        const slideId = params.get('slide') ?? '';
        if (!slideId) return null;
        if (!params.has('x') && !params.has('y') && !params.has('z')) {
            return { slideId };
        }
        const x = parseFloat(params.get('x') ?? 'NaN');
        const y = parseFloat(params.get('y') ?? 'NaN');
        const z = parseFloat(params.get('z') ?? 'NaN');
        // A partial or malformed viewport is rejected rather than guessed.
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
            return null;
        }
        return { slideId, x, y, z };
    } catch (_) {
        return null;
    }
}

/**
 * Replaces the hash with only the given filters, e.g. when a host moves to
 * another patient: the next patient's list opens filtered the same way.
 */
export function writeOnlyWsiHashFilters(filters: WsiHashFilters): string {
    return writeWsiHashToCurrentUrl(formatWsiHash(null, filters));
}

/** Keeps the view state in the `#wsi:` hash of the current URL. */
export const hashUrlState: WsiUrlStateAdapter = {
    read: readWsiHashState,
    write: (state, options) =>
        writeWsiHashToCurrentUrl(
            formatWsiHash(state, readWsiHashFilters()),
            options?.push
        ),
    clear: clearWsiHashFromCurrentUrl,
    currentUrl: () => window.location.href,
    subscribe(listener) {
        // Back and Forward between entries the viewer pushed raise popstate.
        window.addEventListener('hashchange', listener);
        window.addEventListener('popstate', listener);
        return () => {
            window.removeEventListener('hashchange', listener);
            window.removeEventListener('popstate', listener);
        };
    },
};

export function clampImageCoordinates(
    xText: string,
    yText: string,
    dimensions?: TileMetadata['dimensions']
): { x: number; y: number } | null {
    let x = parseInt(xText, 10);
    let y = parseInt(yText, 10);
    if (!isFinite(x) || !isFinite(y)) return null;
    if (dimensions) {
        x = Math.max(0, Math.min(x, dimensions.width - 1));
        y = Math.max(0, Math.min(y, dimensions.height - 1));
    }
    return { x, y };
}

export function buildWsiDownloadFilename({
    patientId,
    slideId,
    x,
    y,
}: {
    patientId?: string | null;
    slideId?: string | number | null;
    x: number;
    y: number;
}): string {
    return `wsi-${patientId ?? 'patient'}-${slideId ??
        'slide'}-x${x}-y${y}.jpg`;
}

export function downloadCanvasAsJpeg(
    canvas: HTMLCanvasElement,
    filename: string
): void {
    canvas.toBlob(
        blob => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(url);
        },
        'image/jpeg',
        0.92
    );
}

export async function copyCurrentUrlToClipboard(
    url = window.location.href
): Promise<void> {
    try {
        await navigator.clipboard.writeText(url);
    } catch (_) {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    }
}
