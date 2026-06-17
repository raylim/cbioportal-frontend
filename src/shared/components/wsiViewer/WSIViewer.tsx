import * as React from 'react';
import { observer } from 'mobx-react';
import { observable, action, computed, makeObservable } from 'mobx';
import { DefaultTooltip } from 'cbioportal-frontend-commons';
import LoadingIndicator from 'shared/components/loadingIndicator/LoadingIndicator';
import * as OpenSeadragonLib from 'openseadragon';
import { createOSDAnnotator, W3CImageFormat } from '@annotorious/openseadragon';
import '@annotorious/openseadragon/annotorious-openseadragon.css';
import {
    Slide,
    Sample,
    PatientHierarchy,
    TileMetadata,
    W3CAnnotation,
    MutationDetail,
    CNADetail,
} from './wsiViewerTypes';

// ---- design tokens (matches iframe viewer) ----
const C = {
    blue: '#2986e2',
    blueDark: '#1a6cc4',
    blueLight: '#e8f1fb',
    orange: '#f5a623',
    text: '#333',
    muted: '#737373',
    border: '#ddd',
    navBg: '#fafafa',
    sidebarBg: '#f5f5f5',
} as const;

const NAV_W = 252;
const SIDEBAR_W = 220;

/**
 * Annotation layers — semantic categories that also determine annotation color.
 * The `type` value is stored in `body.type` in the API so colors are persisted.
 */
// ---- Named-color palette ----

export interface NamedColor {
    name: string;
    hex: string;
}

const LOCALSTORAGE_COLORS_KEY = 'wsi_annotation_colors_v2';

export const DEFAULT_NAMED_COLORS: NamedColor[] = [
    { name: 'Default', hex: '#3b82f6' }, // fallback color for drawing when no annotations exist yet
];

// ---- Annotation layers ----

const LOCALSTORAGE_LAYERS_KEY = 'wsi_annotation_layers_v1';

export const DEFAULT_LAYER_NAME = 'Default';

function loadCustomLayerNames(): string[] {
    try {
        const raw = localStorage.getItem(LOCALSTORAGE_LAYERS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as string[];
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (_) {
        /* ignore */
    }
    return [DEFAULT_LAYER_NAME];
}

function saveCustomLayerNames(names: string[]) {
    try {
        localStorage.setItem(LOCALSTORAGE_LAYERS_KEY, JSON.stringify(names));
    } catch (_) {
        /* ignore */
    }
}

/**
 * Parse the API's body.type field into a { name, hex } pair.
 * Supports three formats:
 *   "My Label|#ef4444"  → { name: "My Label", hex: "#ef4444" }
 *   "#ef4444"           → { name: "", hex: "#ef4444" }
 *   "tumor" (legacy)    → { name: "tumor", hex: <legacy map> }
 */
/** Returns true only for a valid CSS hex color (#rgb, #rrggbb, #rgba, #rrggbbaa). */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
function sanitizeHex(hex: string, fallback: string): string {
    return HEX_COLOR_RE.test(hex) ? hex : fallback;
}

export function parseColorLabel(
    bodyType: string | undefined
): { name: string; hex: string } {
    const fallback = DEFAULT_NAMED_COLORS[0].hex;
    if (!bodyType) return { name: '', hex: fallback };
    if (bodyType.includes('|')) {
        const idx = bodyType.indexOf('|');
        const rawHex = bodyType.slice(idx + 1) || fallback;
        // Validate hex so an API-controlled value cannot inject CSS (e.g. url(...)).
        return {
            name: bodyType.slice(0, idx),
            hex: sanitizeHex(rawHex, fallback),
        };
    }
    if (bodyType.startsWith('#'))
        return { name: '', hex: sanitizeHex(bodyType, fallback) };
    // Legacy layer names from the previous implementation.
    const LEGACY: Record<string, string> = {
        general: '#3b82f6',
        tumor: '#ef4444',
        stroma: '#22c55e',
        normal: '#14b8a6',
        tils: '#8b5cf6',
        necrosis: '#f97316',
    };
    return { name: bodyType, hex: LEGACY[bodyType] ?? fallback };
}

/** Serialize { name, hex } back to body.type. */
export function serializeColorLabel(name: string, hex: string): string {
    // Strip pipe from the name to prevent corrupting the "name|hex" encoding.
    const safeName = name.trim().replace(/\|/g, '');
    return safeName ? `${safeName}|${hex}` : hex;
}

function loadNamedColors(): NamedColor[] {
    try {
        const raw = localStorage.getItem(LOCALSTORAGE_COLORS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as NamedColor[];
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (_) {
        /* ignore */
    }
    return [...DEFAULT_NAMED_COLORS];
}

function saveNamedColors(colors: NamedColor[]) {
    try {
        localStorage.setItem(LOCALSTORAGE_COLORS_KEY, JSON.stringify(colors));
    } catch (_) {
        /* ignore */
    }
}

// ---- shared style constants ----
const inlineIconStyle: React.CSSProperties = {
    verticalAlign: 'middle',
    display: 'inline-block',
};
const ellipsisStyle: React.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};
const sectionTitleStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: C.muted,
    textTransform: 'uppercase',
    letterSpacing: '.8px',
};
/** Shared header/cell base styles for the compact sidebar tables. */
const compactThStyle: React.CSSProperties = {
    fontSize: 10,
    color: C.muted,
    fontWeight: 600,
    textAlign: 'left',
    paddingBottom: 4,
    userSelect: 'none',
};
const compactTdBase: React.CSSProperties = {
    fontSize: 11,
    paddingTop: 3,
    paddingBottom: 3,
    verticalAlign: 'middle',
};
const compactTableStyle: React.CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    marginTop: 8,
    tableLayout: 'fixed',
};

// ---- shared utility functions ----

/** Derive patient ID from sample ID by stripping the tumour-aliquot suffix. */
function getPatientId(sampleId: string): string {
    return sampleId.replace(/-T\d+.*$/i, '');
}

/** Build a cBioPortal patient URL (without sample). */
function buildPatientUrl(studyId: string, sampleId: string): string {
    return `/patient?studyId=${encodeURIComponent(
        studyId
    )}&caseId=${encodeURIComponent(getPatientId(sampleId))}`;
}

/** Build a cBioPortal sample URL (patient URL + sampleId param). */
function buildSampleUrl(studyId: string, sampleId: string): string {
    return `${buildPatientUrl(studyId, sampleId)}&sampleId=${encodeURIComponent(
        sampleId
    )}`;
}

/** Build an OncoKB gene/variant URL. */
function buildOncoKbUrl(gene: string, variant?: string): string {
    return `https://www.oncokb.org/gene/${encodeURIComponent(gene)}${
        variant ? '/' + encodeURIComponent(variant) : ''
    }`;
}

/** Split a `"GENE variant"` mutation token into `{ gene, variant }`. */
function parseMutationToken(token: string): { gene: string; variant: string } {
    const spaceIdx = token.indexOf(' ');
    return spaceIdx > 0
        ? { gene: token.slice(0, spaceIdx), variant: token.slice(spaceIdx + 1) }
        : { gene: token, variant: '' };
}

/** Split a semicolon/comma-delimited mutation list into individual tokens. */
function parseMutationTokens(value: string | null | undefined): string[] {
    return (value ?? '')
        .split(/[;,]\s*/)
        .map(s => s.trim())
        .filter(Boolean);
}

/** Normalize block display label from raw block_label + block_number fields. */
function normalizeBlockLabel(
    label: string | null | undefined,
    number?: string | number | null
): string {
    return (label || '').trim() || (number != null ? String(number) : '');
}

/**
 * POST a JSON body and return the parsed response, or null if the response is
 * not ok.  All fetch calls that use method:POST + JSON body share this helper.
 */
async function postJson<T>(url: string, body: unknown): Promise<T | null> {
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return resp.json() as Promise<T>;
}

/**
 * Fetch the first molecular profile ID of a given alteration type for a study.
 * Returns null if no profile is found or the request fails.
 */
async function getFirstMolecularProfileId(
    base: string,
    studyId: string,
    alterationType: string
): Promise<string | null> {
    const resp = await fetch(
        `${base}/api/studies/${encodeURIComponent(
            studyId
        )}/molecular-profiles` +
            `?molecularAlterationType=${alterationType}&projection=SUMMARY`
    );
    if (!resp.ok) return null;
    const profiles: Array<{ molecularProfileId: string }> = await resp.json();
    return profiles[0]?.molecularProfileId ?? null;
}

/** Stain classification for a slide — single source of truth. */
function getStainKind(slide: {
    is_hne?: boolean;
    is_ihc?: boolean;
}): 'hne' | 'ihc' | 'other' {
    return slide.is_hne ? 'hne' : slide.is_ihc ? 'ihc' : 'other';
}

/** Human-readable stain badge label (e.g. "H&E", "IHC", ""). */
function getStainBadge(slide: { is_hne?: boolean; is_ihc?: boolean }): string {
    return slide.is_hne ? 'H&E' : slide.is_ihc ? 'IHC' : '';
}

/** Sidebar nav dot colour for a slide. */
function getStainDotColor(slide: {
    is_hne?: boolean;
    is_ihc?: boolean;
}): string {
    return slide.is_hne ? C.blue : slide.is_ihc ? C.orange : '#aaa';
}

// OpenSeadragon is a CommonJS module; handle both CJS and ESM bundle shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OpenSeadragon: typeof import('openseadragon') =
    (OpenSeadragonLib as any).default ?? (OpenSeadragonLib as any);

interface Props {
    /** URL of the form https://tile-server/patient/{patient_id} */
    url: string;
    height: number;
    /** cBioPortal study ID — used to build sample links in the sidebar */
    studyId?: string;
    /**
     * Base URL of the native annotation API (e.g. https://tiles.mskcc.org).
     * When set, Annotorious read-write editing is enabled and annotations are
     * stored in the tile server's embedded SQLite database.
     * Null/undefined = annotation editing disabled.
     */
    annotationApiUrl?: string | null;
    /**
     * Bearer token for the annotation API (Keycloak JWT).
     * When null/undefined and annotationApiUrl is set, unauthenticated calls
     * are made (works only if ANNOTATION_AUTH_ENABLED=false on the server).
     */
    authToken?: string | null;
}

@observer
export default class WSIViewer extends React.Component<Props, {}> {
    @observable private hierarchy: PatientHierarchy | null = null;
    @observable private selectedSlide: Slide | null = null;
    @observable private selectedSample: Sample | null = null;
    @observable private selectedMeta: TileMetadata | null = null;
    @observable private loading = true;
    @observable private error: string | null = null;
    @observable private viewerReady = false;
    /** True once OSD has drawn the first tile; used to show/hide the thumbnail
     *  underlay that covers the grey canvas while initial tiles are loading. */
    @observable private tilesReady = false;
    /** Separate flag that controls spinner visibility; set true on slide select,
     *  set false after viewerReady AND at least MIN_SPINNER_MS have elapsed.
     *  Decoupled from viewerReady so viewport setup isn't delayed. */
    @observable private spinnerVisible = false;
    @observable private stainFilter: 'all' | 'hne' | 'ihc' = 'all';
    /** Coordinate bar — input field values */
    @observable coordInputX = '';
    @observable coordInputY = '';
    /** Current cursor position in image pixels (null when viewer not ready or cursor outside) */
    @observable cursorPos: { x: number; y: number } | null = null;

    // ---- Annotation state ----
    /** Annotations for the currently displayed slide */
    @observable private annotations: W3CAnnotation[] = [];
    /** Whether the annotation overlay is currently visible */
    @observable private annotationsVisible = true;
    /** True while fetching annotations from the API */
    @observable private annotationsLoading = false;
    /** Tooltip shown when clicking an annotation */
    @observable private annotationTooltip: {
        x: number;
        y: number;
        text: string;
        layerName?: string;
    } | null = null;
    /** Active Annotorious drawing tool, or null when not drawing. */
    @observable private activeDrawingTool:
        | 'rectangle'
        | 'ellipse'
        | 'circle'
        | 'line'
        | 'polygon'
        | null = null;
    /** User-added palette entries (persisted to localStorage). */
    @observable private customColors: NamedColor[] = loadNamedColors();
    /**
     * Full palette = DEFAULT_NAMED_COLORS ∪ colors seen in loaded annotations ∪ user-custom colors.
     * Always derived fresh so the palette stays in sync with annotations automatically.
     */
    @computed get namedColors(): NamedColor[] {
        const seen = new Set<string>();
        const result: NamedColor[] = [];
        const add = (name: string, hex: string) => {
            const key = `${name}|${hex}`;
            if (!seen.has(key)) {
                seen.add(key);
                result.push({ name, hex });
            }
        };
        for (const c of DEFAULT_NAMED_COLORS) add(c.name, c.hex);
        for (const ann of this.annotations) {
            const hex = ann.color ?? DEFAULT_NAMED_COLORS[0].hex;
            const name = ann.colorName ?? '';
            if (hex && name) add(name, hex);
        }
        for (const c of this.customColors) add(c.name, c.hex);
        return result;
    }
    /** Hex color selected for the next drawn annotation. */
    @observable private activeColorHex: string =
        loadNamedColors()[0]?.hex ?? DEFAULT_NAMED_COLORS[0].hex;
    /** Name associated with the active color (may be empty for ad-hoc colors). */
    @observable private activeColorName: string =
        loadNamedColors()[0]?.name ?? DEFAULT_NAMED_COLORS[0].name;

    // ---- Layer state ----
    /** User-created layer names (persisted to localStorage). */
    @observable private customLayerNames: string[] = loadCustomLayerNames();
    /** Layer new annotations are assigned to. */
    @observable private activeLayerName: string =
        loadCustomLayerNames()[0] ?? DEFAULT_LAYER_NAME;
    /** Layer names currently hidden from the Annotorious overlay. */
    @observable private hiddenLayerNames: Set<string> = new Set();
    /**
     * All unique layer names = custom ∪ annotation-derived (same reactive pattern as namedColors).
     */
    @computed get layerNames(): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        const add = (n: string) => {
            if (!seen.has(n)) {
                seen.add(n);
                result.push(n);
            }
        };
        for (const name of this.customLayerNames) add(name);
        for (const ann of this.annotations)
            add((ann as any).layerName ?? DEFAULT_LAYER_NAME);
        return result;
    }

    /** Maps annotation ID → hex color for live Annotorious style lookup. */
    private annotationColorMap = new Map<string, string>();
    /** ID of the annotation currently being label-edited in the sidebar, or null. */
    @observable private editingAnnotationId: string | null = null;
    /** Current text in the sidebar inline label editor. */
    @observable private editingLabelText = '';
    /** In-progress custom shape draw (ellipse/circle/line) — both screen and image coords. */
    @observable.ref private customDrawState: {
        tool: 'ellipse' | 'circle' | 'line';
        /** Screen pixels relative to the OSD viewer element (for SVG preview). */
        startPx: { x: number; y: number };
        currentPx: { x: number; y: number };
        /** Image pixels (for annotation target). */
        startImg: { x: number; y: number };
        currentImg: { x: number; y: number };
    } | null = null;

    private viewerContainerRef = React.createRef<HTMLDivElement>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private osdViewer: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private osdMouseTracker: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private customDrawTracker: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private annotorious: any = null;
    /** In-memory cache of prefetched slide metadata keyed by image_id */
    private metaCache = new Map<string, TileMetadata>();
    /** Monotonically-increasing counter; each mountOSD call captures its value
     *  and bails if a newer call has started by the time an async step resumes. */
    private mountSeq = 0;
    private loadingStart = 0;
    private static readonly MIN_SPINNER_MS = 250;
    /** Timer handle for the minimum-spinner-duration callback */
    private spinnerTimer: ReturnType<typeof setTimeout> | null = null;
    /** Debounce timer: delays mountOSD so rapid clicks only trigger one fetch */
    private selectSlideDebounce: ReturnType<typeof setTimeout> | null = null;
    /** Debounce timer for writeHashState — avoids calling replaceState on every animation frame */
    private writeHashTimer: ReturnType<typeof setTimeout> | null = null;

    /** Stable per-instance ID prefix for OSD custom nav button elements */
    private navId = `wsi-nav-${Math.random()
        .toString(36)
        .slice(2, 9)}`;

    /** Number of gunicorn workers on the tile server (used to fire warmup N times) */
    private nWorkers = 4;

    // ---- stable callbacks (prevent prop-equality churn on child components) ----
    private readonly handleFilterChange = action((f: 'all' | 'hne' | 'ihc') => {
        this.stainFilter = f;
    });
    private readonly handleSelectSlide = (slide: Slide, sample: Sample) =>
        this.selectSlide(slide, sample);
    private readonly handleChangeX = action((v: string) => {
        this.coordInputX = v;
    });
    private readonly handleChangeY = action((v: string) => {
        this.coordInputY = v;
    });
    private readonly handleCopyLink = () => this.copyViewLink();
    private readonly handleDownload = () => this.downloadView();
    constructor(props: Props) {
        super(props);
        makeObservable(this);
    }

    // ---- URL state helpers ----

    /**
     * Encode current viewer state into the URL hash so the view can be shared.
     * Hash format: #wsi:slide=<imageId>&x=<px>&y=<py>&z=<zoom>
     * Does not clobber unrelated hash fragments since we namespace with "wsi:".
     */
    /**
     * Encode current viewer state into the URL hash so the view can be shared.
     * Hash format: #wsi:slide=<imageId>&x=<px>&y=<py>&z=<zoom>
     * Does not clobber unrelated hash fragments since we namespace with "wsi:".
     * Debounced to 80ms so pan/zoom animations don't hammer replaceState.
     */
    private writeHashState() {
        if (this.writeHashTimer !== null) clearTimeout(this.writeHashTimer);
        this.writeHashTimer = setTimeout(() => {
            this.writeHashTimer = null;
            if (
                typeof window === 'undefined' ||
                !this.osdViewer?.viewport ||
                !this.selectedSlide
            )
                return;
            try {
                const vp = this.osdViewer.viewport;
                const center = vp.viewportToImageCoordinates(vp.getCenter());
                const zoom = vp.getZoom();
                const params = new URLSearchParams({
                    slide: this.selectedSlide.image_id,
                    x: Math.round(center.x).toString(),
                    y: Math.round(center.y).toString(),
                    z: zoom.toFixed(6),
                });
                // Use replaceState so we don't fire a hashchange event (which could
                // interfere with cBioPortal's own hash-based navigation) and don't
                // pollute the browser history on every pan/zoom.
                const url = new URL(window.location.href);
                url.hash = `wsi:${params.toString()}`;
                window.history.replaceState(null, '', url.toString());
            } catch (_) {
                /* viewport not ready */
            }
        }, 80);
    }

    /** Parse the #wsi:... hash; returns null if not present or malformed. */
    private static readHashState(): {
        slideId: string;
        x: number;
        y: number;
        z: number;
    } | null {
        if (typeof window === 'undefined') return null;
        const hash = window.location.hash;
        const prefix = '#wsi:';
        if (!hash.startsWith(prefix)) return null;
        try {
            const params = new URLSearchParams(hash.slice(prefix.length));
            const slideId = params.get('slide') ?? '';
            const x = parseFloat(params.get('x') ?? 'NaN');
            const y = parseFloat(params.get('y') ?? 'NaN');
            const z = parseFloat(params.get('z') ?? 'NaN');
            if (!slideId || !isFinite(x) || !isFinite(y) || !isFinite(z))
                return null;
            return { slideId, x, y, z };
        } catch (_) {
            return null;
        }
    }

    componentDidMount() {
        void this.loadHierarchy();
        document.addEventListener('keydown', this.handleKeyDown);
    }

    componentDidUpdate(prev: Props) {
        if (prev.url !== this.props.url) {
            this.destroyViewer();
            void this.loadHierarchy();
        }
    }

    componentWillUnmount() {
        this.hierarchy = null; // stops the prefetchSlideMetadata loop
        document.removeEventListener('keydown', this.handleKeyDown);
        if (this.selectSlideDebounce !== null) {
            clearTimeout(this.selectSlideDebounce);
            this.selectSlideDebounce = null;
        }
        if (this.writeHashTimer !== null) {
            clearTimeout(this.writeHashTimer);
            this.writeHashTimer = null;
        }
        if (this.spinnerTimer !== null) {
            clearTimeout(this.spinnerTimer);
            this.spinnerTimer = null;
        }
        this.destroyViewer();
    }

    // ---- data loading ----

    @action.bound
    private async loadHierarchy() {
        this.loading = true;
        this.error = null;
        this.hierarchy = null;
        this.selectedSlide = null;
        this.selectedSample = null;
        this.selectedMeta = null;
        this.viewerReady = false;
        this.spinnerVisible = false;
        this.metaCache.clear();
        // Invalidate any in-flight mountOSD from a previous patient.
        this.mountSeq++;

        try {
            const base = this.tileServerBase;
            fetch(`${base}/health`)
                .then(r => (r.ok ? r.json() : null))
                .then((d: any) => {
                    if (d?.n_workers) this.nWorkers = d.n_workers;
                })
                .catch(() => {
                    /* leave default of 4 */
                });

            const resp = await fetch(this.props.url);
            if (!resp.ok) {
                throw new Error(`Server returned ${resp.status}`);
            }
            const data: PatientHierarchy = await resp.json();

            // Set loading=false BEFORE selectSlide so the viewer container div
            // is rendered into the DOM before mountOSD runs.
            action(() => {
                this.hierarchy = data;
                this.loading = false;
            })();

            // Enrich sample metadata from cBioPortal in the background.
            // Overwrites Databricks-sourced clinical/sequencing fields (TMB, MSI,
            // tumor purity, oncogenic mutations, …) with authoritative cBioPortal
            // values.  Runs fire-and-forget; tile-server data is the fallback.
            if (this.props.studyId) {
                void this.enrichSamplesFromCbioportal();
            }

            // Auto-select first servable H&E slide, else first servable slide.
            // If the URL hash encodes a prior view, honour that slide instead.
            const allSlides = this.servableSlides;
            const hashState = WSIViewer.readHashState();
            const fromHash = hashState
                ? allSlides.find(s => s.slide.image_id === hashState.slideId)
                : undefined;
            const first =
                fromHash ?? allSlides.find(s => s.slide.is_hne) ?? allSlides[0];
            if (first) {
                await this.selectSlide(first.slide, first.sample);
            }

            // Prefetch metadata for remaining slides in the background so
            // subsequent slide selections don't pay the S3 cold-open cost (~4s).
            void this.prefetchSlideMetadata(first?.slide.image_id);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            action(() => {
                this.error = msg;
                this.loading = false;
            })();
        }
    }

    /**
     * Background prefetch: for each servable slide (except the already-loaded
     * first one), fetch metadata + thumbnail. Both endpoints cache results in
     * Redis so every subsequent user click is served instantly.
     *
     * Thumbnails are fired all at once (the server queues them across its workers)
     * so the Redis cache is populated as fast as possible. Metadata is fetched
     * serially to avoid overwhelming the S3/SVS pipeline. Warmup calls are
     * intentionally omitted — they load each SVS into every worker's in-process
     * cache simultaneously which causes OOM kills under the default 4 GiB limit.
     */
    private async prefetchSlideMetadata(skipImageId?: string) {
        const slides = this.servableSlides
            .map(s => s.slide)
            .filter(
                sl =>
                    sl.image_id !== skipImageId &&
                    !this.metaCache.has(sl.image_id)
            );

        if (slides.length === 0) return;
        const base = this.tileServerBase;

        // Fire thumbnail fetches in small batches to avoid overwhelming the tile server.
        // Generates thumbnails in advance so the sidebar loads instantly on first click.
        // Batch size matches n_workers (4) so every worker handles exactly one thumbnail
        // at a time — enough to parallelize without creating a pile-up.
        const THUMB_BATCH = 4;
        for (let i = 0; i < slides.length; i += THUMB_BATCH) {
            if (!this.hierarchy) return;
            for (const sl of slides.slice(i, i + THUMB_BATCH)) {
                fetch(`${base}/tiles/${sl.image_id}/thumbnail`).catch(() => {});
            }
            if (i + THUMB_BATCH < slides.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        // Fetch metadata serially to keep the SVS pipeline pressure manageable.
        for (const sl of slides) {
            if (!this.hierarchy) return;
            const base = this.tileServerBase;
            const encId = encodeURIComponent(sl.image_id);
            const warmupCalls = Array.from({ length: this.nWorkers }, () =>
                fetch(`${base}/tiles/${encId}/warmup`).catch(() => {})
            );
            await Promise.allSettled([
                fetch(`${base}/tiles/${encId}/metadata`)
                    .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
                    .then((meta: TileMetadata) => {
                        this.metaCache.set(sl.image_id, meta);
                    }),
                // Thumbnail fetch warms the Redis cache so the sidebar img is
                // served from Redis (no SVS open) on the first user click.
                fetch(`${base}/tiles/${encId}/thumbnail`),
                ...warmupCalls,
            ]);
            // Brief pause between slides to avoid S3 connection pile-up.
            await new Promise(r => setTimeout(r, 200));
        }
    }

    @computed get servableSlides(): Array<{ slide: Slide; sample: Sample }> {
        if (!this.hierarchy) return [];
        const result: Array<{ slide: Slide; sample: Sample }> = [];
        for (const sample of this.hierarchy.samples) {
            for (const part of sample.parts) {
                for (const block of part.blocks) {
                    for (const slide of block.slides) {
                        if (slide.can_serve_tiles)
                            result.push({ slide, sample });
                    }
                }
            }
        }
        return result;
    }

    @computed get tileServerBase(): string {
        return this.props.url.replace(/\/patient\/[^/]+\/?$/, '');
    }

    /**
     * Base URL for cBioPortal API calls.
     * When the viewer is embedded inside cBioPortal (PatientViewPageTabs), relative
     * paths work natively.  When the resource URL carries a `cbioUrl` query param
     * (ResourceTab / dev-test setup), we use that value instead.
     */
    @computed private get cbioApiBase(): string {
        try {
            const cbioUrl = new URL(this.props.url).searchParams.get('cbioUrl');
            if (cbioUrl) return cbioUrl;
        } catch {
            // props.url may not be a full URL in some test setups
        }
        return '';
    }

    /**
     * Enrich sample metadata (TMB, MSI, tumor purity, oncogenic mutations, …) from
     * cBioPortal's REST API so the sidebar reflects the same data shown elsewhere in
     * cBioPortal rather than a potentially-stale Databricks snapshot.
     *
     * Runs as a fire-and-forget background task after the tile-server hierarchy is
     * loaded.  If cBioPortal is unavailable, the tile-server data remains as-is.
     */
    @action.bound
    private async enrichSamplesFromCbioportal(): Promise<void> {
        const { studyId } = this.props;
        const hier = this.hierarchy;
        if (!studyId || !hier?.samples.length) return;

        const base = this.cbioApiBase;
        const sampleIdentifiers = hier.samples
            .filter(s => s.sample_id)
            .map(s => ({ studyId, sampleId: s.sample_id }));
        if (!sampleIdentifiers.length) return;

        try {
            // Run sequentially: clinical data must populate oncogenic_mutations first
            // so that fetchAndMergeMutations can attach type/VAF details to the
            // correct token list when building oncogenic_mutation_details.
            await this.fetchAndMergeClinicalData(
                base,
                studyId,
                sampleIdentifiers
            );
            await this.fetchAndMergeMutations(base, studyId, sampleIdentifiers);
            // OncoKB annotations run after mutations so mutation details are ready.
            // Errors are swallowed — the tooltip simply won't appear if OncoKB is unreachable.
            void this.fetchAndMergeOncoKbAnnotations();
            void this.fetchAndMergeMutationFrequency(base, studyId);
            await this.fetchAndMergeCNA(base, studyId, sampleIdentifiers);
        } catch {
            // Silently fall back to tile-server data
        }
    }

    /**
     * Fetch sample-level clinical attributes from cBioPortal and merge them into
     * the in-memory hierarchy samples.  Only attributes present in the response
     * are updated; missing attributes keep their tile-server values.
     */
    private async fetchAndMergeClinicalData(
        base: string,
        studyId: string,
        sampleIdentifiers: Array<{ studyId: string; sampleId: string }>
    ): Promise<void> {
        // cBioPortal v7+ uses "identifiers"/"entityId"; older versions used
        // "sampleIdentifiers"/"sampleId". Try v7 format first.
        const identifiers = sampleIdentifiers.map(s => ({
            studyId: s.studyId,
            entityId: s.sampleId,
        }));
        const resp = await fetch(
            `${base}/api/clinical-data/fetch?clinicalDataType=SAMPLE&projection=SUMMARY`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifiers }),
            }
        );
        if (!resp.ok) return;

        const text = await resp.text();
        if (!text) return;
        const data: Array<{
            sampleId: string;
            clinicalAttributeId: string;
            value: string;
        }> = JSON.parse(text);

        // Build lookup: sampleId → Map<attributeId, value>
        const byId = new Map<string, Map<string, string>>();
        for (const item of data) {
            if (!byId.has(item.sampleId)) byId.set(item.sampleId, new Map());
            byId.get(item.sampleId)!.set(item.clinicalAttributeId, item.value);
        }

        // Helper: try multiple attribute IDs and return first match
        const get = (
            attrs: Map<string, string>,
            ids: string[]
        ): string | undefined =>
            ids.map(id => attrs.get(id)).find(v => v != null && v !== '');

        action(() => {
            for (const sample of this.hierarchy!.samples) {
                const attrs = byId.get(sample.sample_id);
                if (!attrs) continue;
                const set = <K extends keyof Sample>(
                    key: K,
                    ids: string[]
                ): void => {
                    const v = get(attrs, ids);
                    if (v !== undefined)
                        (sample as Sample)[key] = v as Sample[K];
                };
                set('cancer_type', ['CANCER_TYPE']);
                set('cancer_type_detailed', ['CANCER_TYPE_DETAILED']);
                set('oncotree_code', ['ONCOTREE_CODE']);
                set('primary_site', ['PRIMARY_SITE']);
                set('sample_type', ['SAMPLE_TYPE']);
                set('metastatic_site', ['METASTATIC_SITE']);
                set('tumor_purity', ['TUMOR_PURITY', 'CVR_TUMOR_PURITY']);
                set('tmb_score', [
                    'CVR_TMB_SCORE',
                    'TMB_NONSYNONYMOUS',
                    'TMB_SCORE',
                ]);
                set('msi_type', ['MSI_TYPE', 'MSI_SCORE', 'MSI_STATUS']);
                set('oncogenic_mutations', [
                    'ONCOGENIC_MUTATIONS',
                    'CVR_ONCOGENIC_MUTATIONS',
                ]);
                set('num_oncogenic_mutations', [
                    'NUM_ONCOGENIC_MUTATIONS',
                    'CVR_NUM_ONCOGENIC_MUTATIONS',
                ]);
            }
        })();
    }

    /**
     * Fetch somatic mutations from cBioPortal mutations API.
     * Populates `oncogenic_mutations` (the display list) from ALL mutations returned by the
     * API — matching what cBioPortal's patient page shows — and sets `oncogenic_mutation_details`
     * (type, VAF per mutation) for tooltip display.  If the API returns no data, falls back to
     * whatever `fetchAndMergeClinicalData` already placed in `oncogenic_mutations`.
     */
    private async fetchAndMergeMutations(
        base: string,
        studyId: string,
        sampleIdentifiers: Array<{ studyId: string; sampleId: string }>
    ): Promise<void> {
        // Declare maps here so the finally block can always mark details as ready,
        // even when the function returns early due to an error or missing data.
        const allMutsBySample = new Map<
            string,
            Array<{ token: string; vaf: number }>
        >();
        const detailsBySample = new Map<string, Map<string, MutationDetail>>();
        try {
            // Find the MUTATION_EXTENDED molecular profile for this study
            const molecularProfileId = await getFirstMolecularProfileId(
                base,
                studyId,
                'MUTATION_EXTENDED'
            );
            if (!molecularProfileId) return;

            const sampleMolecularIdentifiers = sampleIdentifiers.map(s => ({
                molecularProfileId,
                sampleId: s.sampleId,
            }));

            const mutations: Array<{
                sampleId: string;
                entrezGeneId?: number;
                gene?: { hugoGeneSymbol: string; entrezGeneId?: number } | null;
                proteinChange: string;
                mutationType?: string;
                driverFilter?: string;
                driverFilterAnnotation?: string;
                tumorAltCount?: number;
                tumorRefCount?: number;
                proteinPosStart?: number;
                proteinPosEnd?: number;
            }> | null = await postJson(
                `${base}/api/mutations/fetch?projection=DETAILED`,
                { sampleMolecularIdentifiers }
            );
            if (!mutations) return;

            // Build per-sample detail maps and mutation lists from ALL returned mutations.
            // Tokens use "GENE p.Variant" format (OncoKB convention); the API returns
            // proteinChange without the "p." prefix (e.g. "G13D"), so we normalise here.
            for (const m of mutations) {
                const geneSymbol = m.gene?.hugoGeneSymbol;
                if (!geneSymbol) continue;

                const pc = m.proteinChange.startsWith('p.')
                    ? m.proteinChange
                    : `p.${m.proteinChange}`;
                const token = `${geneSymbol} ${pc}`;
                const total = (m.tumorAltCount ?? 0) + (m.tumorRefCount ?? 0);
                const vaf =
                    total > 0
                        ? Math.round((m.tumorAltCount! / total) * 100)
                        : 0;

                if (!detailsBySample.has(m.sampleId))
                    detailsBySample.set(m.sampleId, new Map());
                const detail: MutationDetail = {
                    token,
                    type: formatMutationType(m.mutationType ?? ''),
                    vaf: total > 0 ? vaf : undefined,
                    annotation: m.driverFilterAnnotation || undefined,
                    entrezGeneId: m.gene?.entrezGeneId ?? m.entrezGeneId,
                    consequence: m.mutationType,
                    proteinStart: m.proteinPosStart,
                    proteinEnd: m.proteinPosEnd,
                };
                detailsBySample.get(m.sampleId)!.set(token, detail);

                if (!allMutsBySample.has(m.sampleId))
                    allMutsBySample.set(m.sampleId, []);
                allMutsBySample.get(m.sampleId)!.push({ token, vaf });
            }

            // Sort each sample's list by VAF descending so the most clonal mutations appear first.
            for (const muts of allMutsBySample.values()) {
                muts.sort((a, b) => b.vaf - a.vaf);
            }
        } catch (e) {
            console.error('[WSIViewer] fetchAndMergeMutations failed:', e);
        } finally {
            // Always set oncogenic_mutation_details so buildSeqRows knows the fetch
            // completed and can safely render links (with or without tooltip data).
            action(() => {
                for (const sample of this.hierarchy!.samples) {
                    const apiMuts = allMutsBySample.get(sample.sample_id);
                    if (apiMuts?.length) {
                        // Use the full API list as the source of truth, matching cBioPortal's
                        // patient page.  CVR_ONCOGENIC_MUTATIONS (set by fetchAndMergeClinicalData)
                        // may be a curated subset; override it with the complete picture.
                        sample.oncogenic_mutations = apiMuts
                            .map(m => m.token)
                            .join('; ');
                    }
                    if (sample.oncogenic_mutations) {
                        const sampleDetails = detailsBySample.get(
                            sample.sample_id
                        );
                        const tokens = parseMutationTokens(
                            sample.oncogenic_mutations
                        );
                        // Build detail list; fall back to token-only entry if API returned no data.
                        sample.oncogenic_mutation_details = tokens.map(
                            t => sampleDetails?.get(t) ?? { token: t }
                        );
                    }
                }
            })();
        }
    }

    /**
     * Fetch OncoKB annotations for all mutations collected by fetchAndMergeMutations and
     * merge oncogenic / mutationEffect / hotspot / geneSummary / variantSummary into each
     * MutationDetail object in-place so that MutationTable can show rich tooltips.
     *
     * Routes through the tile server's /api/oncokb/annotate endpoint (same origin as the
     * viewer) to avoid CORS restrictions when calling the OncoKB API directly.
     *
     * Silently no-ops when the tile server doesn't have an OncoKB token configured
     * (endpoint returns 503) or when the hierarchy has no mutations with entrezGeneId.
     */
    private async fetchAndMergeOncoKbAnnotations(): Promise<void> {
        // Collect all MutationDetail objects that have enough data for an OncoKB query
        const allDetails: MutationDetail[] = [];
        for (const sample of this.hierarchy?.samples ?? []) {
            for (const d of sample.oncogenic_mutation_details ?? []) {
                if (d.entrezGeneId) allDetails.push(d);
            }
        }
        if (!allDetails.length) return;

        // Build the batch request body — one item per unique mutation id
        interface OncoKbItem {
            id: string;
            alteration: string;
            consequence?: string;
            gene: { entrezGeneId: number };
            proteinStart?: number;
            proteinEnd?: number;
            tumorType: null;
        }
        const seen = new Set<string>();
        const items: OncoKbItem[] = [];
        for (const d of allDetails) {
            // Strip the "p." prefix to get raw alteration (e.g. "G13D")
            const { variant: variantRaw } = parseMutationToken(d.token);
            const alteration = variantRaw.startsWith('p.')
                ? variantRaw.slice(2)
                : variantRaw;
            const id = `${d.entrezGeneId}_${alteration}_${d.consequence ?? ''}`;
            if (seen.has(id)) continue;
            seen.add(id);
            items.push({
                id,
                alteration,
                consequence: d.consequence,
                gene: { entrezGeneId: d.entrezGeneId! },
                proteinStart: d.proteinStart,
                proteinEnd: d.proteinEnd,
                tumorType: null,
            });
        }

        // Use origin (strip path/query) so we hit the tile server root, not a sub-path
        let tileOrigin: string;
        try {
            tileOrigin = new URL(this.props.url).origin;
        } catch {
            tileOrigin = this.tileServerBase;
        }
        if (!tileOrigin) return;

        let annotations: Array<{
            query: { id: string };
            oncogenic?: string;
            mutationEffect?: { knownEffect?: string };
            hotspot?: boolean;
            geneSummary?: string;
            variantSummary?: string;
            variantExist?: boolean;
        }>;
        try {
            annotations =
                (await postJson<typeof annotations[0][]>(
                    `${tileOrigin}/api/oncokb/annotate`,
                    items
                )) ?? [];
            if (!annotations.length) return;
        } catch {
            return; // Network error — tooltip will simply not appear
        }

        const byId = new Map(annotations.map(a => [a.query.id, a]));

        action(() => {
            for (const d of allDetails) {
                const { variant: variantRaw2 } = parseMutationToken(d.token);
                const alteration = variantRaw2.startsWith('p.')
                    ? variantRaw2.slice(2)
                    : variantRaw2;
                const id = `${d.entrezGeneId}_${alteration}_${d.consequence ??
                    ''}`;
                const ann = byId.get(id);
                if (!ann) return;
                d.oncogenic = ann.oncogenic;
                d.mutationEffect = ann.mutationEffect?.knownEffect;
                d.hotspot = ann.hotspot;
                d.geneSummary = ann.geneSummary;
                d.variantSummary = ann.variantSummary;
                d.hasCivic = ann.variantExist === true;
            }
        })();
    }

    /**
     * Fetch significant discrete copy-number alterations (value ≠ 0) from cBioPortal
     * and merge them into each sample's `cna_alterations` field.
     */
    private async fetchAndMergeCNA(
        base: string,
        studyId: string,
        sampleIdentifiers: Array<{ studyId: string; sampleId: string }>
    ): Promise<void> {
        const profileId = await getFirstMolecularProfileId(
            base,
            studyId,
            'COPY_NUMBER_ALTERATION'
        );
        if (!profileId) return;

        const sampleIds = sampleIdentifiers.map(s => s.sampleId);
        const data: Array<{
            sampleId: string;
            value: number;
            gene?: { hugoGeneSymbol: string } | null;
        }> | null = await postJson(
            `${base}/api/molecular-profiles/${encodeURIComponent(
                profileId
            )}/molecular-data/fetch?projection=DETAILED`,
            { sampleIds }
        );
        if (!data) return;

        // Group by sample; keep only significant events (value ≠ 0)
        const bySample = new Map<string, CNADetail[]>();
        for (const d of data) {
            if (d.value === 0) continue;
            const gene = d.gene?.hugoGeneSymbol;
            if (!gene) continue;
            if (!bySample.has(d.sampleId)) bySample.set(d.sampleId, []);
            bySample.get(d.sampleId)!.push({ gene, cnaValue: d.value });
        }
        // Sort: deep events (|value| = 2) before shallow (|value| = 1); within tier by gene name
        for (const cnList of bySample.values()) {
            cnList.sort(
                (a, b) =>
                    Math.abs(b.cnaValue) - Math.abs(a.cnaValue) ||
                    a.gene.localeCompare(b.gene)
            );
        }

        action(() => {
            for (const sample of this.hierarchy!.samples) {
                const cnList = bySample.get(sample.sample_id);
                if (cnList?.length) sample.cna_alterations = cnList;
            }
        })();
    }

    /**
     * Fetch cohort mutation frequencies for all mutations and store as fraction (0–1)
     * in each MutationDetail's `cohortFrequency` field.
     * Uses /api/mutation-counts-by-position/fetch and the study's sequencedSampleCount.
     */
    private async fetchAndMergeMutationFrequency(
        base: string,
        studyId: string
    ): Promise<void> {
        // Collect unique positions across all samples
        interface PosKey {
            entrezGeneId: number;
            proteinPosStart: number;
            proteinPosEnd: number;
        }
        const posMap = new Map<string, PosKey>();
        for (const sample of this.hierarchy?.samples ?? []) {
            for (const d of sample.oncogenic_mutation_details ?? []) {
                if (
                    d.entrezGeneId &&
                    d.proteinStart != null &&
                    d.proteinEnd != null
                ) {
                    const key = `${d.entrezGeneId}_${d.proteinStart}_${d.proteinEnd}`;
                    posMap.set(key, {
                        entrezGeneId: d.entrezGeneId,
                        proteinPosStart: d.proteinStart,
                        proteinPosEnd: d.proteinEnd,
                    });
                }
            }
        }
        if (!posMap.size) return;

        try {
            const [studyResp, counts] = await Promise.all([
                fetch(`${base}/api/studies/${encodeURIComponent(studyId)}`),
                postJson<
                    Array<{
                        entrezGeneId: number;
                        proteinPosStart: number;
                        proteinPosEnd: number;
                        count: number;
                    }>
                >(`${base}/api/mutation-counts-by-position/fetch`, [
                    ...posMap.values(),
                ]),
            ]);
            if (!studyResp.ok || !counts) return;

            const study: {
                sequencedSampleCount?: number;
            } = await studyResp.json();
            const total = study.sequencedSampleCount ?? 0;
            if (!total) return;

            // Build lookup: posKey → fraction
            const freqByKey = new Map<string, number>();
            for (const c of counts) {
                const key = `${c.entrezGeneId}_${c.proteinPosStart}_${c.proteinPosEnd}`;
                freqByKey.set(key, c.count / total);
            }

            action(() => {
                for (const sample of this.hierarchy?.samples ?? []) {
                    for (const d of sample.oncogenic_mutation_details ?? []) {
                        if (
                            d.entrezGeneId &&
                            d.proteinStart != null &&
                            d.proteinEnd != null
                        ) {
                            const key = `${d.entrezGeneId}_${d.proteinStart}_${d.proteinEnd}`;
                            const freq = freqByKey.get(key);
                            if (freq !== undefined) d.cohortFrequency = freq;
                        }
                    }
                }
            })();
        } catch {
            // Non-critical — cohort % simply won't appear
        }
    }

    // ---- slide selection ----

    /** How long to wait after the last click before actually mounting OSD.
     *  Prevents N concurrent metadata fetches when clicking through slides quickly. */
    private static readonly SELECT_DEBOUNCE_MS = 150;

    @action.bound
    selectSlide(slide: Slide, sample: Sample) {
        // Update UI state immediately for instant visual feedback.
        this.selectedSlide = slide;
        this.selectedSample = sample;
        this.selectedMeta = null;
        this.viewerReady = false;
        this.tilesReady = false;
        this.spinnerVisible = true;
        this.error = null;
        this.annotations = [];
        this.annotationTooltip = null;
        this.loadingStart = Date.now();
        // Cancel any pending spinner-hide timer from the previous slide.
        if (this.spinnerTimer !== null) {
            clearTimeout(this.spinnerTimer);
            this.spinnerTimer = null;
        }
        // Bump the sequence so any in-flight mountOSD call can detect it's stale.
        const seq = ++this.mountSeq;
        // Debounce: if the user clicks another slide within SELECT_DEBOUNCE_MS,
        // cancel this pending mount. Only the last-clicked slide triggers a fetch.
        if (this.selectSlideDebounce !== null) {
            clearTimeout(this.selectSlideDebounce);
        }
        this.selectSlideDebounce = setTimeout(() => {
            this.selectSlideDebounce = null;
            void (async () => {
                await this.mountOSD(slide, seq);
                if (seq !== this.mountSeq) return;
                // Load annotations for the new slide after OSD is mounted but before the
                // first open event finishes painting.
                void this.loadAnnotations(slide.image_id);
                // NOTE: do NOT call writeHashState() here. mountOSD returns before the
                // OSD 'open' event fires, so the viewport has no tile source yet and
                // contentSize defaults to 1×1. The 'open' handler writes the hash once
                // the viewport is fully ready.
            })();
        }, WSIViewer.SELECT_DEBOUNCE_MS);
    }

    // ---- OpenSeadragon ----

    /** Navigate to image-pixel coordinates entered in the coordinate bar. */
    @action.bound
    goToCoordinates() {
        if (!this.osdViewer) return;
        let x = parseInt(this.coordInputX, 10);
        let y = parseInt(this.coordInputY, 10);
        if (!isFinite(x) || !isFinite(y)) return;
        // Clamp to image boundaries so the view stays within the slide.
        const dim = this.selectedMeta?.dimensions;
        if (dim) {
            x = Math.max(0, Math.min(x, dim.width - 1));
            y = Math.max(0, Math.min(y, dim.height - 1));
            this.coordInputX = String(x);
            this.coordInputY = String(y);
        }
        const imgPoint = new (OpenSeadragon as any).Point(x, y);
        const vpPoint = this.osdViewer.viewport.imageToViewportCoordinates(
            imgPoint
        );
        this.osdViewer.viewport.panTo(vpPoint, false);
    }

    /** Download the current viewport as a JPEG image. */
    downloadView() {
        // OSD renders into drawer.canvas (CanvasDrawer) or a WebGL canvas.
        const canvas: HTMLCanvasElement | null =
            this.osdViewer?.drawer?.canvas ?? this.osdViewer?.canvas ?? null;
        if (!canvas) return;

        try {
            const vp = this.osdViewer.viewport;
            const center = vp.viewportToImageCoordinates(vp.getCenter());
            const x = Math.round(center.x);
            const y = Math.round(center.y);
            const patientId = this.hierarchy?.patient_id ?? 'patient';
            const slideId = this.selectedSlide?.image_id ?? 'slide';
            const filename = `wsi-${patientId}-${slideId}-x${x}-y${y}.jpg`;

            canvas.toBlob(
                blob => {
                    if (!blob) return;
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                },
                'image/jpeg',
                0.92
            );
        } catch (_) {
            /* canvas tainted or not ready */
        }
    }

    /** Write current view to URL hash then copy the full URL to clipboard. */
    async copyViewLink() {
        this.writeHashState();
        const url = window.location.href;
        try {
            await navigator.clipboard.writeText(url);
        } catch (_) {
            // Fallback for non-secure contexts (http, old browsers)
            const ta = document.createElement('textarea');
            ta.value = url;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
    }

    // ---- Annotation API helpers ----

    private get annotationApiBase(): string | null {
        return this.props.annotationApiUrl || null;
    }

    private annotationFetchHeaders(): HeadersInit {
        const h: HeadersInit = { 'Content-Type': 'application/json' };
        if (this.props.authToken) {
            (h as Record<string, string>)[
                'Authorization'
            ] = `Bearer ${this.props.authToken}`;
        }
        return h;
    }

    /**
     * Normalize an SVG selector value so Annotorious can parse it.
     * Converts <circle cx cy r> to <ellipse cx cy rx ry> because
     * Annotorious' SvgSelector parser only handles <ellipse>.
     */
    private static normalizeSvgSelector(svg: string): string {
        return svg.replace(
            /<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s*\/>/g,
            (_m, cx, cy, r) =>
                `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" />`
        );
    }

    /** Load annotations for the given slide from the annotation API. */
    @action.bound
    private async loadAnnotations(slideId: string) {
        const apiBase = this.annotationApiBase;
        if (!apiBase) return;
        const studyId = this.props.studyId ?? '';
        action(() => {
            this.annotationsLoading = true;
        })();
        try {
            const resp = await fetch(
                `${apiBase}/annotations?slide_id=${encodeURIComponent(
                    slideId
                )}&study_id=${encodeURIComponent(studyId)}`,
                { headers: this.annotationFetchHeaders() }
            );
            if (!resp.ok) throw new Error(`${resp.status}`);
            const raw: any[] = await resp.json();
            // Convert API response to W3CAnnotation shape for Annotorious.
            // Color derives from body.type (encoded as "name|#hex"); layer from body.comment.
            const anns: W3CAnnotation[] = raw.map((item: any) => {
                const { name: colorName, hex: color } = parseColorLabel(
                    item.body?.type
                );
                const layerName: string =
                    item.body?.comment || DEFAULT_LAYER_NAME;
                return {
                    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                    type: 'Annotation' as const,
                    id: item.id,
                    body: item.body?.label
                        ? [
                              {
                                  type: 'TextualBody' as const,
                                  value: item.body.label,
                                  purpose: 'commenting' as const,
                              },
                          ]
                        : [],
                    target: {
                        source: slideId,
                        selector: (() => {
                            const sel = item.target?.selector ?? item.target;
                            if (
                                sel?.type === 'SvgSelector' &&
                                typeof sel.value === 'string'
                            ) {
                                return {
                                    ...sel,
                                    value: WSIViewer.normalizeSvgSelector(
                                        sel.value
                                    ),
                                };
                            }
                            return sel;
                        })(),
                    },
                    created: item.created_at,
                    creator: item.created_by,
                    version: item.version,
                    colorName,
                    color,
                    layerName,
                };
            });
            // Populate color map for Annotorious style function
            this.annotationColorMap.clear();
            for (const ann of anns) {
                this.annotationColorMap.set(
                    ann.id,
                    ann.color ?? DEFAULT_NAMED_COLORS[0].hex
                );
            }
            // namedColors is @computed from this.annotations — just update annotations and it auto-updates.
            action(() => {
                this.annotations = anns;
                this.annotationsLoading = false;
            })();
            if (this.annotorious) {
                this.annotorious.setAnnotations(anns);
                this.refreshAnnotoriousStyle();
                // Re-apply any active layer filter so hidden layers stay hidden on slide change.
                if (this.hiddenLayerNames.size > 0) this.applyLayerFilter();
            }
        } catch (e) {
            action(() => {
                this.annotationsLoading = false;
            })();
            // eslint-disable-next-line no-console
            console.warn('[WSIViewer] Failed to load annotations:', e);
        }
    }

    /** POST a new annotation to the API and add it to local state. */
    private async saveNewAnnotation(ann: W3CAnnotation) {
        const apiBase = this.annotationApiBase;
        if (!apiBase) return;
        const slideId = this.selectedSlide?.image_id ?? '';
        const studyId = this.props.studyId ?? '';
        try {
            const body = {
                slide_id: slideId,
                study_id: studyId,
                // body.type = color encoding; body.comment = layer name for round-trip persistence.
                body: {
                    label: ann.body?.[0]?.value ?? '',
                    comment: (ann as any).layerName ?? DEFAULT_LAYER_NAME,
                    type: serializeColorLabel(
                        ann.colorName ?? '',
                        ann.color ?? DEFAULT_NAMED_COLORS[0].hex
                    ),
                },
                target: {
                    selector: (ann.target as any).selector ?? ann.target,
                },
                visible_to: [],
            };
            const resp = await fetch(`${apiBase}/annotations`, {
                method: 'POST',
                headers: this.annotationFetchHeaders(),
                body: JSON.stringify(body),
            });
            if (!resp.ok) throw new Error(`${resp.status}`);
            const created = await resp.json();
            const savedAnn = {
                ...ann,
                id: created.id,
                version: created.version,
            };
            this.annotationColorMap.set(
                savedAnn.id,
                savedAnn.color ?? DEFAULT_NAMED_COLORS[0].hex
            );
            // Swap the temp-ID annotation for the server-assigned ID in Annotorious.
            if (this.annotorious && ann.id !== savedAnn.id) {
                try {
                    this.annotorious.removeAnnotation(ann.id);
                } catch (_) {
                    /* ignore */
                }
                try {
                    this.annotorious.addAnnotation(savedAnn);
                } catch (_) {
                    /* ignore */
                }
            }
            action(() => {
                this.annotations = [...this.annotations, savedAnn];
            })();
            this.refreshAnnotoriousStyle();
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[WSIViewer] Failed to save annotation:', e);
        }
    }

    /** PUT an updated annotation to the API. */
    private async updateAnnotation(ann: W3CAnnotation) {
        const apiBase = this.annotationApiBase;
        if (!apiBase) return;
        try {
            const body = {
                body: {
                    label: ann.body?.[0]?.value ?? '',
                    comment: (ann as any).layerName ?? DEFAULT_LAYER_NAME,
                    type: serializeColorLabel(
                        ann.colorName ?? '',
                        ann.color ?? DEFAULT_NAMED_COLORS[0].hex
                    ),
                },
                target: {
                    selector: (ann.target as any).selector ?? ann.target,
                },
                version: ann.version ?? 1,
            };
            const resp = await fetch(
                `${apiBase}/annotations/${encodeURIComponent(ann.id)}`,
                {
                    method: 'PUT',
                    headers: this.annotationFetchHeaders(),
                    body: JSON.stringify(body),
                }
            );
            if (!resp.ok) throw new Error(`${resp.status}`);
            const updated = await resp.json();
            action(() => {
                this.annotations = this.annotations.map(a =>
                    a.id === ann.id ? { ...a, version: updated.version } : a
                );
            })();
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[WSIViewer] Failed to update annotation:', e);
        }
    }

    /** DELETE an annotation from the API and remove from local state. */
    private async deleteAnnotation(annId: string) {
        const apiBase = this.annotationApiBase;
        if (!apiBase) return;
        try {
            const resp = await fetch(
                `${apiBase}/annotations/${encodeURIComponent(annId)}`,
                {
                    method: 'DELETE',
                    headers: this.annotationFetchHeaders(),
                }
            );
            if (!resp.ok && resp.status !== 404)
                throw new Error(`${resp.status}`);
            action(() => {
                this.annotations = this.annotations.filter(a => a.id !== annId);
            })();
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[WSIViewer] Failed to delete annotation:', e);
        }
    }

    @action.bound
    toggleAnnotationsVisible() {
        this.annotationsVisible = !this.annotationsVisible;
        if (this.annotorious) {
            this.annotorious.setVisible(this.annotationsVisible);
        }
    }

    @action.bound
    setDrawingTool(
        tool: 'rectangle' | 'ellipse' | 'circle' | 'line' | 'polygon' | null
    ) {
        if (!this.annotorious) {
            return;
        }
        if (tool === null || tool === this.activeDrawingTool) {
            // Cancel any active drawing and deactivate.
            try {
                this.annotorious.cancelDrawing();
            } catch (_) {
                /* ignore */
            }
            this.annotorious.setDrawingEnabled(false);
            // Re-enable Annotorious for viewing/selecting annotations
            if (this.annotorious.setEnabled) {
                this.annotorious.setEnabled(true);
            }
            // Re-enable pointer-events on Annotorious canvas overlay
            if (this.osdViewer) {
                const annoCanvas = this.osdViewer.element.querySelector(
                    'canvas.a9s-gl-canvas'
                );
                if (annoCanvas && annoCanvas instanceof HTMLElement) {
                    annoCanvas.style.pointerEvents = 'auto';
                }
            }
            this.activeDrawingTool = null;
            this.customDrawState = null;
        } else if (tool === 'ellipse' || tool === 'circle' || tool === 'line') {
            // Annotorious doesn't bundle these shapes as drawing tools.
            // Custom pointer event handlers take over (see mountOSD).
            try {
                this.annotorious.cancelDrawing();
            } catch (_) {
                /* ignore */
            }
            this.annotorious.setDrawingEnabled(false);
            // Disable Annotorious so it doesn't intercept pointer events
            if (this.annotorious.setEnabled) {
                this.annotorious.setEnabled(false);
            }
            // Disable pointer-events on Annotorious canvas overlay
            if (
                this.customDrawTracker &&
                'disableAnnotoriousOverlay' in this.customDrawTracker
            ) {
                this.customDrawTracker.disableAnnotoriousOverlay();
            }
            this.activeDrawingTool = tool;
            if (!this.annotationsVisible) this.toggleAnnotationsVisible();
        } else {
            // Re-enable Annotorious if it was disabled
            if (this.annotorious.setEnabled) {
                this.annotorious.setEnabled(true);
            }
            this.annotorious.setDrawingTool(tool);
            // polygon uses click-to-add-points mode; all others use drag.
            this.annotorious.setDrawingMode(
                tool === 'polygon' ? 'click' : 'drag'
            );
            this.annotorious.setDrawingEnabled(true);
            this.activeDrawingTool = tool;
            // Ensure annotations overlay is visible while drawing.
            if (!this.annotationsVisible) this.toggleAnnotationsVisible();
        }
    }

    @action.bound
    private handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            if (this.activeDrawingTool !== null) this.setDrawingTool(null);
            if (this.editingAnnotationId !== null) this.cancelEditingLabel();
        }
    }

    /**
     * Finalize a custom-drawn shape (ellipse / circle / line) after the user
     * releases the mouse. Builds a W3C annotation with an SVG selector,
     * adds it to Annotorious for immediate display, then persists it to the API.
     */
    private async finalizeCustomShape(state: {
        tool: 'ellipse' | 'circle' | 'line';
        startImg: { x: number; y: number };
        currentImg: { x: number; y: number };
    }) {
        const { tool, startImg, currentImg } = state;
        const x1 = startImg.x,
            y1 = startImg.y;
        const x2 = currentImg.x,
            y2 = currentImg.y;

        let svgValue: string;
        if (tool === 'ellipse') {
            const cx = (x1 + x2) / 2,
                cy = (y1 + y2) / 2;
            const rx = Math.abs(x2 - x1) / 2,
                ry = Math.abs(y2 - y1) / 2;
            if (rx < 3 || ry < 3) return;
            svgValue = `<svg><ellipse cx="${cx.toFixed(2)}" cy="${cy.toFixed(
                2
            )}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" /></svg>`;
        } else if (tool === 'circle') {
            const cx = (x1 + x2) / 2,
                cy = (y1 + y2) / 2;
            const r = Math.min(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 2;
            if (r < 3) return;
            // Annotorious' SvgSelector parser (Iy) only handles <ellipse>, not <circle>.
            // A circle is an ellipse with rx = ry = r, so emit <ellipse> for compatibility.
            svgValue = `<svg><ellipse cx="${cx.toFixed(2)}" cy="${cy.toFixed(
                2
            )}" rx="${r.toFixed(2)}" ry="${r.toFixed(2)}" /></svg>`;
        } else {
            const len = Math.hypot(x2 - x1, y2 - y1);
            if (len < 3) return;
            svgValue = `<svg><line x1="${x1.toFixed(2)}" y1="${y1.toFixed(
                2
            )}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" /></svg>`;
        }

        const id = `ann-custom-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 9)}`;
        const autoLabel = this.nextAutoLabel();
        const ann: W3CAnnotation = {
            id,
            type: 'Annotation',
            body: [
                {
                    type: 'TextualBody' as const,
                    value: autoLabel,
                    purpose: 'commenting' as const,
                },
            ],
            target: {
                source: this.selectedSlide?.image_id ?? '',
                selector: { type: 'SvgSelector', value: svgValue },
            },
        } as any;
        (ann as any).colorName = this.activeColorName;
        (ann as any).color = this.activeColorHex;
        (ann as any).layerName = this.activeLayerName;
        this.annotationColorMap.set(id, this.activeColorHex);

        // Re-enable Annotorious (was disabled for custom tools) before adding the annotation,
        // otherwise setEnabled(false) prevents the shape from rendering.
        this.setDrawingTool(null);

        // Add to Annotorious so the shape renders immediately with a temp ID.
        try {
            this.annotorious?.addAnnotation(ann);
        } catch (_) {
            /* ignore */
        }

        void this.saveNewAnnotation(ann);
    }

    /**
     * Generate an auto-label for a new annotation.
     * Format: "{colorName} {N}" where N counts existing annotations with the same color name.
     */
    private nextAutoLabel(): string {
        const base = this.activeColorName.trim() || this.activeColorHex;
        const count =
            this.annotations.filter(
                a => (a.colorName ?? '') === this.activeColorName
            ).length + 1;
        return `${base} ${count}`;
    }

    /** Begin inline editing of an annotation label in the sidebar. */
    @action.bound
    startEditingLabel(id: string, currentLabel: string) {
        this.editingAnnotationId = id;
        this.editingLabelText = currentLabel;
    }

    /** Commit the edited label — PUT to API. */
    @action.bound
    confirmEditingLabel() {
        const id = this.editingAnnotationId;
        if (!id) return;
        const ann = this.annotations.find(a => a.id === id);
        if (!ann) {
            this.cancelEditingLabel();
            return;
        }
        const label = this.editingLabelText.trim();
        const updated: W3CAnnotation = {
            ...ann,
            body: label
                ? [
                      {
                          type: 'TextualBody' as const,
                          value: label,
                          purpose: 'commenting' as const,
                      },
                  ]
                : [],
        };
        // Optimistically update local state.
        action(() => {
            this.annotations = this.annotations.map(a =>
                a.id === id ? updated : a
            );
        })();
        void this.updateAnnotation(updated);
        // Also update the Annotorious overlay so the shape reflects the new body.
        try {
            this.annotorious?.updateAnnotation(updated);
        } catch (_) {}
        this.editingAnnotationId = null;
        this.editingLabelText = '';
    }

    @action.bound
    cancelEditingLabel() {
        this.editingAnnotationId = null;
        this.editingLabelText = '';
    }

    @action.bound
    setActiveColor(name: string, hex: string) {
        this.activeColorName = name;
        this.activeColorHex = hex;
        this.refreshAnnotoriousStyle();
    }

    @action.bound
    addNamedColor(name: string, hex: string) {
        if (!this.customColors.some(c => c.hex === hex && c.name === name)) {
            this.customColors = [...this.customColors, { name, hex }];
            saveNamedColors(this.customColors);
        }
        this.setActiveColor(name, hex);
    }

    @action.bound
    removeNamedColor(hex: string, name: string) {
        // Only allow removing from customColors; defaults and annotation-derived colors stay.
        this.customColors = this.customColors.filter(
            c => !(c.hex === hex && c.name === name)
        );
        saveNamedColors(this.customColors);
        // If removed color was active, switch to first remaining or default
        if (this.activeColorHex === hex && this.activeColorName === name) {
            const fallback = this.namedColors[0] ?? DEFAULT_NAMED_COLORS[0];
            this.activeColorHex = fallback.hex;
            this.activeColorName = fallback.name;
        }
        this.refreshAnnotoriousStyle();
    }

    // ---- Layer actions ----

    @action.bound
    addLayer(name: string) {
        const n = name.trim();
        if (!n || this.customLayerNames.includes(n)) return;
        this.customLayerNames = [...this.customLayerNames, n];
        saveCustomLayerNames(this.customLayerNames);
    }

    @action.bound
    setActiveLayer(name: string) {
        this.activeLayerName = name;
    }

    @action.bound
    toggleLayerVisibility(name: string) {
        const next = new Set(this.hiddenLayerNames);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        this.hiddenLayerNames = next;

        if (next.has(name)) {
            // Layer is being hidden.
            this.annotationTooltip = null;

            if (this.annotorious) {
                this.annotorious.cancelSelected();
                // The PixiJS stage's setFilter check is `s.has(id) || filter(ann)`
                // where `s` is its internal selected-set.  cancelSelected() triggers
                // a Svelte store update that clears `s` — but Svelte batches that
                // together with our setFilter call and processes setFilter FIRST
                // (lower dirty-bit index).  Result: selected annotations bypass the
                // filter even though our predicate returns false for them.
                // Delaying applyLayerFilter by one macrotask lets the Svelte flush
                // that clears `s` finish before we re-evaluate the filter.
                setTimeout(
                    action(() => {
                        if (this.annotorious) this.applyLayerFilter();
                    }),
                    0
                );
            }

            if (this.editingAnnotationId !== null) {
                const editingAnn = this.annotations.find(
                    a => a.id === this.editingAnnotationId
                );
                const editingLayer =
                    (editingAnn as any)?.layerName ?? DEFAULT_LAYER_NAME;
                if (editingLayer === name) this.cancelEditingLabel();
            }
        } else {
            // Layer is being shown — no pending selection to worry about.
            this.applyLayerFilter();
        }
    }

    private applyLayerFilter() {
        if (!this.annotorious) return;
        const hidden = this.hiddenLayerNames;
        this.annotorious.setFilter(
            hidden.size === 0
                ? undefined
                : (ann: any) => !hidden.has(ann.layerName ?? DEFAULT_LAYER_NAME)
        );
    }

    /** Push the per-annotation color function into Annotorious so shapes render with the right color. */
    private refreshAnnotoriousStyle() {
        if (!this.annotorious) return;
        const colorMap = this.annotationColorMap;
        const activeColor = this.activeColorHex;
        this.annotorious.setStyle((ann: { id: string }) => {
            const c = colorMap.get(ann.id) ?? activeColor;
            return { stroke: c, fill: c, fillOpacity: 0.2, strokeWidth: 2 };
        });
    }

    private destroyViewer() {
        // Clean up Annotorious before destroying OSD
        if (this.annotorious) {
            try {
                this.annotorious.destroy();
            } catch (_) {
                /* ignore */
            }
            this.annotorious = null;
        }
        if (this.customDrawTracker) {
            try {
                this.customDrawTracker.destroy();
            } catch (_) {
                /* ignore */
            }
            this.customDrawTracker = null;
        }
        if (this.osdMouseTracker) {
            try {
                this.osdMouseTracker.destroy();
            } catch (_) {
                /* ignore */
            }
            this.osdMouseTracker = null;
        }
        if (this.osdViewer) {
            try {
                this.osdViewer.destroy();
            } catch (_) {
                // ignore
            }
            this.osdViewer = null;
        }
        action(() => {
            this.cursorPos = null;
        })();
    }

    private async mountOSD(slide: Slide, seq: number) {
        // Use prefetched metadata if available, otherwise fetch now
        let meta = this.metaCache.get(slide.image_id);
        if (!meta) {
            const encImageId = encodeURIComponent(slide.image_id);
            const metaUrl = `${this.tileServerBase}/tiles/${encImageId}/metadata`;
            fetch(
                `${this.tileServerBase}/tiles/${encImageId}/thumbnail`
            ).catch(() => {});
            try {
                const resp = await fetch(metaUrl);
                if (!resp.ok)
                    throw new Error(`${resp.status} ${resp.statusText}`);
                meta = (await resp.json()) as TileMetadata;
                this.metaCache.set(slide.image_id, meta);
            } catch (err) {
                if (seq !== this.mountSeq) return; // superseded
                // eslint-disable-next-line no-console
                console.error('[WSIViewer] metadata fetch failed', err);
                action(() => {
                    this.error = `Failed to load slide metadata: ${err}`;
                })();
                return;
            }
        }

        // Bail if a newer selectSlide call has started while we were fetching.
        if (seq !== this.mountSeq) return;

        action(() => {
            this.selectedMeta = meta!;
        })();

        // Two animation frames: first lets MobX/React commit, second
        // confirms layout dimensions are set on the container div.
        await new Promise<void>(r =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
        );

        if (seq !== this.mountSeq) return;

        const containerEl = this.viewerContainerRef.current;
        if (!containerEl) return;

        this.destroyViewer();

        const baseUrl = this.tileServerBase;
        const imageId = slide.image_id;
        const maxZoom = meta.max_zoom;
        const tileSize = meta.tile_size;

        try {
            this.osdViewer = OpenSeadragon({
                element: containerEl,
                showNavigationControl: true,
                zoomInButton: `${this.navId}-zoom-in`,
                zoomOutButton: `${this.navId}-zoom-out`,
                homeButton: `${this.navId}-home`,
                showNavigator: true,
                navigatorPosition: 'BOTTOM_RIGHT',
                navigatorHeight: '120px',
                navigatorWidth: '160px',
                navigatorAutoResize: false,
                crossOriginPolicy: 'Anonymous',
                prefixUrl: '/reactapp/osd-images/',
                showFullPageControl: false,
                gestureSettingsMouse: { clickToZoom: false },
                timeout: 90000,
                imageLoaderLimit: 6,
                tileSources: {
                    // OSD level 0 = most zoomed out (1 tile covers whole image)
                    // OSD level maxZoom = full resolution
                    // Server /zxy/{z}/{x}/{y} uses the same convention
                    width: meta.dimensions.width,
                    height: meta.dimensions.height,
                    tileSize,
                    tileOverlap: 0,
                    maxLevel: maxZoom,
                    minLevel: 0,
                    getTileUrl(level: number, x: number, y: number): string {
                        return `${baseUrl}/tiles/${imageId}/zxy/${level}/${x}/${y}`;
                    },
                },
            });
        } catch (err) {
            if (seq !== this.mountSeq) return;
            // eslint-disable-next-line no-console
            console.error('[WSIViewer] OSD init error:', err);
            action(() => {
                this.error = `OSD init error: ${err}`;
            })();
            return;
        }

        if (seq !== this.mountSeq) {
            this.destroyViewer();
            return;
        }

        // Push navigator thumbnail above both the CoordBar (~40px) and DrawToolbar (~32px, bottom: 44)
        // that sit at the bottom of the viewer on this branch.
        // OSD v6 BOTTOM_RIGHT sets `bottom:0`; we override to clear both bars.
        const navEl = this.osdViewer.navigator?.element as HTMLElement | undefined;
        if (navEl) navEl.style.bottom = '84px';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.osdViewer.addOnceHandler('open', () => {
            if (seq !== this.mountSeq) return;
            action(() => {
                this.viewerReady = true;
            })();

            // Create custom drawing handlers using POINTER EVENTS (not mouse events!)
            // Annotorious uses the Pointer Events API
            const osdForDraw = this.osdViewer;
            const container = osdForDraw.element;
            const canvas = osdForDraw.canvas;

            const handlePointerDown = action((e: PointerEvent) => {
                const tool = this.activeDrawingTool;
                if (tool !== 'ellipse' && tool !== 'circle' && tool !== 'line')
                    return;

                const rect = canvas.getBoundingClientRect();
                const px = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                };
                const vpPoint = osdForDraw.viewport.pointFromPixel(
                    new (OpenSeadragon as any).Point(px.x, px.y)
                );
                const imgPoint = osdForDraw.viewport.viewportToImageCoordinates(
                    vpPoint
                );

                this.customDrawState = {
                    tool,
                    startPx: { x: px.x, y: px.y },
                    currentPx: { x: px.x, y: px.y },
                    startImg: { x: imgPoint.x, y: imgPoint.y },
                    currentImg: { x: imgPoint.x, y: imgPoint.y },
                };
                e.preventDefault();
                e.stopPropagation();
            });

            const handlePointerMove = action((e: PointerEvent) => {
                if (!this.customDrawState) return;

                const rect = canvas.getBoundingClientRect();
                const px = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                };
                const vpPoint = osdForDraw.viewport.pointFromPixel(
                    new (OpenSeadragon as any).Point(px.x, px.y)
                );
                const imgPoint = osdForDraw.viewport.viewportToImageCoordinates(
                    vpPoint
                );

                this.customDrawState = {
                    ...this.customDrawState,
                    currentPx: { x: px.x, y: px.y },
                    currentImg: { x: imgPoint.x, y: imgPoint.y },
                };
                e.preventDefault();
                e.stopPropagation();
            });

            const handlePointerUp = action((e: PointerEvent) => {
                if (!this.customDrawState) return;
                const state = this.customDrawState;
                this.customDrawState = null;
                void this.finalizeCustomShape(state);
                e.preventDefault();
                e.stopPropagation();
            });

            container.addEventListener(
                'pointerdown',
                handlePointerDown as EventListener,
                { capture: true }
            );
            container.addEventListener(
                'pointermove',
                handlePointerMove as EventListener,
                { capture: true }
            );
            container.addEventListener(
                'pointerup',
                handlePointerUp as EventListener,
                { capture: true }
            );

            // Disable pointer-events on Annotorious canvas overlay when custom tools are active
            const disableAnnotoriousCanvasPointerEvents = () => {
                const annoCanvas = container.querySelector(
                    'canvas.a9s-gl-canvas'
                );
                if (annoCanvas && annoCanvas instanceof HTMLElement) {
                    annoCanvas.style.pointerEvents = 'none';
                }
            };

            // Store cleanup function
            this.customDrawTracker = {
                destroy: () => {
                    container.removeEventListener(
                        'pointerdown',
                        handlePointerDown as EventListener,
                        { capture: true }
                    );
                    container.removeEventListener(
                        'pointermove',
                        handlePointerMove as EventListener,
                        { capture: true }
                    );
                    container.removeEventListener(
                        'pointerup',
                        handlePointerUp as EventListener,
                        { capture: true }
                    );
                },
                disableAnnotoriousOverlay: disableAnnotoriousCanvasPointerEvents,
            };

            // Mount Annotorious (read-write) on top of OSD if annotation API is configured
            if (this.annotationApiBase && this.osdViewer) {
                try {
                    // W3CImageFormat adapter enables addAnnotation() / setAnnotations() to
                    // accept W3C annotations with SvgSelector / FragmentSelector directly —
                    // without it the selector is stored as-is and skipped by the renderer.
                    this.annotorious = createOSDAnnotator(this.osdViewer, {
                        drawingEnabled: false,
                        drawingMode: 'drag',
                        adapter: W3CImageFormat(
                            this.selectedSlide?.image_id ?? ''
                        ),
                    });

                    this.annotorious.on(
                        'createAnnotation',
                        (ann: W3CAnnotation) => {
                            // Stamp color, layer, and auto-generate a sequential label, then save immediately.
                            ann.colorName = this.activeColorName;
                            ann.color = this.activeColorHex;
                            (ann as any).layerName = this.activeLayerName;
                            this.annotationColorMap.set(ann.id, ann.color);
                            const autoLabel = this.nextAutoLabel();
                            ann.body = [
                                {
                                    type: 'TextualBody' as const,
                                    value: autoLabel,
                                    purpose: 'commenting' as const,
                                },
                            ];
                            action(() => {
                                this.activeDrawingTool = null;
                            })();
                            this.annotorious.setDrawingEnabled(false);
                            this.refreshAnnotoriousStyle();
                            void this.saveNewAnnotation(ann);
                        }
                    );
                    this.annotorious.on(
                        'updateAnnotation',
                        (ann: W3CAnnotation) => {
                            void this.updateAnnotation(ann);
                        }
                    );
                    this.annotorious.on(
                        'deleteAnnotation',
                        (ann: W3CAnnotation) => {
                            void this.deleteAnnotation(ann.id);
                        }
                    );
                    this.annotorious.on(
                        'clickAnnotation',
                        (ann: W3CAnnotation, originalEvent: MouseEvent) => {
                            const label = ann.body?.[0]?.value ?? '';
                            if (label) {
                                action(() => {
                                    this.annotationTooltip = {
                                        x: originalEvent.clientX,
                                        y: originalEvent.clientY,
                                        text: label,
                                        layerName:
                                            (ann as any).layerName ||
                                            undefined,
                                    };
                                })();
                            }
                        }
                    );
                    // Expose a test hook so Playwright tests can simulate clickAnnotation.
                    (window as any).__wsiAnnotoriousClickHook = (
                        ann: W3CAnnotation,
                        originalEvent: { clientX: number; clientY: number }
                    ) => {
                        const label = ann.body?.[0]?.value ?? '';
                        if (label) {
                            action(() => {
                                this.annotationTooltip = {
                                    x: originalEvent.clientX,
                                    y: originalEvent.clientY,
                                    text: label,
                                    layerName:
                                        (ann as any).layerName || undefined,
                                };
                            })();
                        }
                    };

                    // Push any already-loaded annotations into Annotorious
                    if (this.annotations.length > 0) {
                        this.annotorious.setAnnotations(this.annotations);
                    }
                    this.refreshAnnotoriousStyle();
                    if (!this.annotationsVisible) {
                        this.annotorious.setVisible(false);
                    }
                } catch (e) {
                    // eslint-disable-next-line no-console
                    console.warn('[WSIViewer] Annotorious init failed:', e);
                }
            }

            // Restore viewport position from URL hash if present for this slide,
            // otherwise center on the middle of the image.
            //
            // IMPORTANT: read the hash BEFORE registering animation-finish, because
            // OSD may fire animation-finish for its initial fit animation, which would
            // overwrite the shared-link hash before we restore from it.
            const hashState = WSIViewer.readHashState();
            try {
                const vp = this.osdViewer.viewport;
                if (hashState && hashState.slideId === slide.image_id) {
                    const imgPt = new (OpenSeadragon as any).Point(
                        hashState.x,
                        hashState.y
                    );
                    const vpPt = vp.imageToViewportCoordinates(imgPt);
                    vp.panTo(vpPt, true); // immediately (no animation)
                    vp.zoomTo(hashState.z, undefined, true);
                } else {
                    // Pan to image center immediately so we don't start at (0,0).
                    // goHome() snaps to zoom-to-fit centered — pass true for no animation.
                    vp.goHome(true);
                }
                // Write hash now so the URL reflects the opened slide and position
                // (for fresh opens this writes the home position; for restores it
                // writes the restored position).
                this.writeHashState();
            } catch (_) {
                /* ignore — viewport not ready */
            }

            // Register ongoing hash write AFTER the initial viewport setup so that
            // OSD's own initial-fit animation-finish event (if any) doesn't
            // overwrite the shared-link coordinates before we restore them.
            this.osdViewer.addHandler('animation-finish', () => {
                this.writeHashState();
            });

            // Keep the spinner visible until the first tile image is received from the
            // server (tile-loaded).  OSD 6 uses WebGL which does not fire tile-drawn,
            // but tile-loaded fires in all drawer backends as soon as the network
            // response arrives — which is the earliest signal that the slide is ready.
            // MIN_SPINNER_MS is still respected.  20s fallback covers tile errors.
            const hideSpinner = action(() => {
                if (seq !== this.mountSeq) return;
                if (this.spinnerTimer !== null) {
                    clearTimeout(this.spinnerTimer);
                    this.spinnerTimer = null;
                }
                this.spinnerVisible = false;
                this.tilesReady = true;
            });
            // Fallback: hide after 20s in case tile-loaded never fires (tile errors,
            // slow server).  open-failed is handled separately below.
            if (this.spinnerTimer !== null) clearTimeout(this.spinnerTimer);
            this.spinnerTimer = setTimeout(hideSpinner, 20_000);

            this.osdViewer.addOnceHandler('tile-loaded', () => {
                const remaining = Math.max(
                    0,
                    WSIViewer.MIN_SPINNER_MS - (Date.now() - this.loadingStart)
                );
                if (remaining > 0) {
                    if (this.spinnerTimer !== null)
                        clearTimeout(this.spinnerTimer);
                    this.spinnerTimer = setTimeout(hideSpinner, remaining);
                } else {
                    hideSpinner();
                }
            });
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.osdViewer.addOnceHandler('open-failed', (e: any) => {
            if (seq !== this.mountSeq) return;
            // eslint-disable-next-line no-console
            console.error('[WSIViewer] OSD open-failed', e);
            action(() => {
                this.error = `OSD open failed: ${e?.message ??
                    JSON.stringify(e)}`;
                this.viewerReady = false;
            })();
        });
        this.osdViewer.addHandler('tile-load-failed', (e: any) => {
            // eslint-disable-next-line no-console
            console.warn('[WSIViewer] tile-load-failed', e?.tile?.url);
        });

        // Track cursor position and convert to image coordinates for the coord bar.
        const viewer = this.osdViewer;
        this.osdMouseTracker = new (OpenSeadragon as any).MouseTracker({
            element: containerEl,
            moveHandler: action((event: any) => {
                if (!viewer.viewport) return;
                try {
                    const vpPoint = viewer.viewport.pointFromPixel(
                        event.position
                    );
                    const imgPoint = viewer.viewport.viewportToImageCoordinates(
                        vpPoint
                    );
                    const nx = Math.round(imgPoint.x);
                    const ny = Math.round(imgPoint.y);
                    // Only write observable when values actually change to avoid
                    // triggering MobX reactions on every pixel of mouse movement.
                    if (
                        !this.cursorPos ||
                        this.cursorPos.x !== nx ||
                        this.cursorPos.y !== ny
                    ) {
                        this.cursorPos = { x: nx, y: ny };
                    }
                } catch (_) {
                    /* ignore during init */
                }
            }),
            exitHandler: action(() => {
                this.cursorPos = null;
            }),
        });
    }

    // ---- render ----

    render() {
        const { height } = this.props;
        const {
            loading,
            error,
            hierarchy,
            selectedSlide,
            selectedSample,
            selectedMeta,
            stainFilter,
        } = this;

        if (loading) {
            return (
                <div
                    style={{
                        height,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <LoadingIndicator
                        isLoading={true}
                        center={true}
                        size="big"
                    />
                </div>
            );
        }

        if (error || !hierarchy) {
            return (
                <div
                    style={{
                        height,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#c00',
                    }}
                >
                    {error || 'No data'}
                </div>
            );
        }

        return (
            <div
                style={{
                    display: 'flex',
                    height,
                    overflow: 'hidden',
                    fontFamily: '"Helvetica Neue",Helvetica,Arial,sans-serif',
                    fontSize: 13,
                    color: C.text,
                }}
            >
                {/* Left nav panel */}
                <NavPanel
                    hierarchy={hierarchy}
                    selectedSlide={selectedSlide}
                    stainFilter={stainFilter}
                    onFilterChange={this.handleFilterChange}
                    onSelectSlide={this.handleSelectSlide}
                />

                {/* OSD viewer */}
                <div
                    style={{
                        flex: 1,
                        position: 'relative',
                        background: '#e8e8e8',
                    }}
                >
                    <div
                        ref={this.viewerContainerRef}
                        style={{ width: '100%', height: '100%' }}
                    />
                    <div
                        style={{
                            position: 'absolute',
                            top: 8,
                            left: 8,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                            zIndex: 100,
                        }}
                    >
                        <button
                            id={`${this.navId}-zoom-in`}
                            className="btn btn-default btn-sm"
                            title="Zoom in"
                            aria-label="Zoom in"
                            style={{
                                width: 28,
                                padding: '3px 0',
                                lineHeight: 1,
                            }}
                        >
                            <i className="fa fa-plus" />
                        </button>
                        <button
                            id={`${this.navId}-zoom-out`}
                            className="btn btn-default btn-sm"
                            title="Zoom out"
                            aria-label="Zoom out"
                            style={{
                                width: 28,
                                padding: '3px 0',
                                lineHeight: 1,
                            }}
                        >
                            <i className="fa fa-minus" />
                        </button>
                        <button
                            id={`${this.navId}-home`}
                            className="btn btn-default btn-sm"
                            title="Fit to view"
                            aria-label="Fit to view"
                            style={{
                                width: 28,
                                padding: '3px 0',
                                lineHeight: 1,
                            }}
                        >
                            <i className="fa fa-home" />
                        </button>
                    </div>
                    {/* SVG overlay: live preview while drawing ellipse / circle / line */}
                    {this.customDrawState &&
                        (() => {
                            const s = this.customDrawState!;
                            const x1 = s.startPx.x,
                                y1 = s.startPx.y;
                            const x2 = s.currentPx.x,
                                y2 = s.currentPx.y;
                            const stroke = this.activeColorHex;
                            let shapeEl: React.ReactNode;
                            if (s.tool === 'ellipse') {
                                shapeEl = (
                                    <ellipse
                                        cx={(x1 + x2) / 2}
                                        cy={(y1 + y2) / 2}
                                        rx={Math.abs(x2 - x1) / 2}
                                        ry={Math.abs(y2 - y1) / 2}
                                        fill="none"
                                        stroke={stroke}
                                        strokeWidth={2}
                                        strokeDasharray="6 3"
                                    />
                                );
                            } else if (s.tool === 'circle') {
                                shapeEl = (
                                    <circle
                                        cx={(x1 + x2) / 2}
                                        cy={(y1 + y2) / 2}
                                        r={
                                            Math.min(
                                                Math.abs(x2 - x1),
                                                Math.abs(y2 - y1)
                                            ) / 2
                                        }
                                        fill="none"
                                        stroke={stroke}
                                        strokeWidth={2}
                                        strokeDasharray="6 3"
                                    />
                                );
                            } else {
                                shapeEl = (
                                    <line
                                        x1={x1}
                                        y1={y1}
                                        x2={x2}
                                        y2={y2}
                                        stroke={stroke}
                                        strokeWidth={2}
                                        strokeDasharray="6 3"
                                    />
                                );
                            }
                            return (
                                <svg
                                    style={{
                                        position: 'absolute',
                                        left: 0,
                                        top: 0,
                                        width: '100%',
                                        height: '100%',
                                        pointerEvents: 'none',
                                        zIndex: 10,
                                    }}
                                >
                                    {shapeEl}
                                </svg>
                            );
                        })()}
                    {this.spinnerVisible && selectedSlide && (
                        <div
                            data-testid="wsi-loading-spinner"
                            style={{
                                ...overlayStyle,
                                background: 'rgba(232,232,232,0.75)',
                            }}
                        >
                            <i
                                className="fa fa-spinner fa-spin fa-3x"
                                style={{ color: '#888' }}
                            />
                        </div>
                    )}
                    {!selectedSlide && (
                        <div style={overlayStyle}>
                            <span style={{ color: C.muted, fontSize: 13 }}>
                                No servable slides for this patient
                            </span>
                        </div>
                    )}
                    {this.viewerReady &&
                        !!this.annotationApiBase &&
                        this.annotationsVisible && (
                            <DrawToolbar
                                drawingTool={this.activeDrawingTool}
                                onSetDrawingTool={this.setDrawingTool}
                                namedColors={this.namedColors}
                                activeColorHex={this.activeColorHex}
                                activeColorName={this.activeColorName}
                                onSetActiveColor={this.setActiveColor}
                                onAddNamedColor={this.addNamedColor}
                                onRemoveNamedColor={this.removeNamedColor}
                            />
                        )}
                    {this.tilesReady && (
                        <CoordBar
                            inputX={this.coordInputX}
                            inputY={this.coordInputY}
                            cursorPos={this.cursorPos}
                            mpp={selectedMeta?.mpp}
                            onChangeX={this.handleChangeX}
                            onChangeY={this.handleChangeY}
                            onGo={this.goToCoordinates}
                            onCopyLink={this.handleCopyLink}
                            onDownload={this.handleDownload}
                            annotationEnabled={!!this.annotationApiBase}
                            annotationsVisible={this.annotationsVisible}
                            onToggleAnnotations={this.toggleAnnotationsVisible}
                        />
                    )}
                    {this.annotationTooltip && (
                        <div
                            data-testid="annotation-tooltip"
                            onClick={action(() => {
                                this.annotationTooltip = null;
                            })}
                            style={{
                                position: 'fixed',
                                left: this.annotationTooltip.x + 12,
                                top: this.annotationTooltip.y - 8,
                                background: 'rgba(30,30,30,0.9)',
                                color: '#fff',
                                borderRadius: 4,
                                padding: '4px 10px',
                                fontSize: 12,
                                pointerEvents: 'auto',
                                cursor: 'pointer',
                                zIndex: 9999,
                                maxWidth: 260,
                            }}
                        >
                            {this.annotationTooltip.text}
                            {this.annotationTooltip.layerName && (
                                <div
                                    style={{
                                        marginTop: 2,
                                        fontSize: 10,
                                        opacity: 0.7,
                                    }}
                                >
                                    Layer: {this.annotationTooltip.layerName}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Right metadata sidebar */}
                <MetaSidebar
                    slide={selectedSlide}
                    sample={selectedSample}
                    meta={selectedMeta}
                    tileServerBase={this.tileServerBase}
                    studyId={this.props.studyId}
                    annotations={this.annotations}
                    annotationsLoading={this.annotationsLoading}
                    annotationEnabled={!!this.annotationApiBase}
                    onDeleteAnnotation={id => {
                        void this.deleteAnnotation(id);
                        if (this.annotorious)
                            this.annotorious.removeAnnotation(id);
                    }}
                    editingAnnotationId={this.editingAnnotationId}
                    editingLabelText={this.editingLabelText}
                    onStartEditAnnotation={this.startEditingLabel}
                    onChangeEditLabel={action((v: string) => {
                        this.editingLabelText = v;
                    })}
                    onConfirmEditLabel={this.confirmEditingLabel}
                    onCancelEditLabel={this.cancelEditingLabel}
                    layerNames={this.layerNames}
                    hiddenLayerNames={this.hiddenLayerNames}
                    onToggleLayerVisibility={this.toggleLayerVisibility}
                    activeLayerName={this.activeLayerName}
                    onSetActiveLayer={this.setActiveLayer}
                    onAddLayer={this.addLayer}
                />
            </div>
        );
    }
}

// ---- helpers ----

const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
};

// ---- LabelPrompt ----

interface LabelPromptProps {
    labelText: string;
    onChangeLabel: (v: string) => void;
    onConfirm: () => void;
    onCancel: () => void;
}

/** Floating card that appears after drawing a shape to add an optional label before saving. */
export function LabelPrompt({
    labelText,
    onChangeLabel,
    onConfirm,
    onCancel,
}: LabelPromptProps) {
    return (
        <div
            data-testid="annotation-label-prompt"
            style={{
                position: 'absolute',
                bottom: 42,
                left: '50%',
                transform: 'translateX(-50%)',
                background: '#fff',
                border: '1px solid #c2d9f5',
                borderRadius: 6,
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                padding: '10px 14px',
                zIndex: 50,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                minWidth: 260,
            }}
        >
            <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>
                Add a label (optional)
            </div>
            <input
                data-testid="annotation-label-input"
                autoFocus
                type="text"
                value={labelText}
                placeholder="e.g. Tumor region"
                onChange={e => onChangeLabel(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Enter') onConfirm();
                    if (e.key === 'Escape') onCancel();
                }}
                style={{
                    fontSize: 12,
                    padding: '4px 8px',
                    border: `1px solid ${C.blue}`,
                    borderRadius: 4,
                    outline: 'none',
                    width: '100%',
                    boxSizing: 'border-box',
                }}
            />
            <div
                style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}
            >
                <button
                    onClick={onCancel}
                    title="Discard this annotation (Esc)"
                    style={{
                        fontSize: 11,
                        padding: '3px 10px',
                        borderRadius: 3,
                        border: `1px solid ${C.border}`,
                        background: '#fff',
                        color: C.muted,
                        cursor: 'pointer',
                    }}
                >
                    Discard
                </button>
                <button
                    data-testid="annotation-label-save"
                    onClick={onConfirm}
                    title="Save annotation (Enter)"
                    style={{
                        fontSize: 11,
                        padding: '3px 10px',
                        borderRadius: 3,
                        border: `1px solid ${C.blue}`,
                        background: C.blue,
                        color: '#fff',
                        cursor: 'pointer',
                    }}
                >
                    Save
                </button>
            </div>
        </div>
    );
}

// ---- CoordBar ----

export interface CoordBarProps {
    inputX: string;
    inputY: string;
    cursorPos: { x: number; y: number } | null;
    mpp?: { x: number; y: number };
    onChangeX: (v: string) => void;
    onChangeY: (v: string) => void;
    onGo: () => void;
    onCopyLink: () => void;
    onDownload: () => void;
    annotationEnabled?: boolean;
    annotationsVisible?: boolean;
    onToggleAnnotations?: () => void;
}

export function CoordBar({
    inputX,
    inputY,
    cursorPos,
    mpp,
    onChangeX,
    onChangeY,
    onGo,
    onCopyLink,
    onDownload,
    annotationEnabled,
    annotationsVisible,
    onToggleAnnotations,
}: CoordBarProps) {
    const handleKey = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') onGo();
    };
    const [copied, setCopied] = React.useState(false);
    const handleCopy = () => {
        onCopyLink();
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    let cursorLabel = '';
    if (cursorPos) {
        cursorLabel = `${cursorPos.x.toLocaleString()} × ${cursorPos.y.toLocaleString()} px`;
        if (mpp) {
            const umX = (cursorPos.x * mpp.x).toFixed(1);
            const umY = (cursorPos.y * mpp.y).toFixed(1);
            cursorLabel += `  (${umX} × ${umY} μm)`;
        }
    }

    const inputStyle: React.CSSProperties = {
        width: 72,
        padding: '2px 5px',
        fontSize: 11,
        border: `1px solid ${C.border}`,
        borderRadius: 3,
        background: '#fff',
        color: C.text,
        outline: 'none',
    };

    const btnStyle: React.CSSProperties = {
        padding: '2px 9px',
        fontSize: 11,
        cursor: 'pointer',
        borderRadius: 3,
        lineHeight: '18px',
    };

    return (
        <div
            style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 40,
                display: 'flex',
                flexWrap: 'nowrap',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                background: 'rgba(250,250,250,0.92)',
                borderTop: `1px solid ${C.border}`,
                fontSize: 11,
                color: C.muted,
                backdropFilter: 'blur(2px)',
                zIndex: 10,
                overflow: 'hidden',
            }}
        >
            <span style={{ fontWeight: 600, color: C.text, marginRight: 2 }}>
                Go to:
            </span>
            <div
                className="input-group input-group-sm"
                style={{
                    width: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                }}
            >
                <span style={{ color: C.muted }}>X</span>
                <input
                    type="number"
                    value={inputX}
                    placeholder="px"
                    className="form-control input-sm"
                    style={{ width: 88 }}
                    onChange={e => onChangeX(e.target.value)}
                    onKeyDown={handleKey}
                />
                <span style={{ color: C.muted }}>Y</span>
                <input
                    type="number"
                    value={inputY}
                    placeholder="px"
                    className="form-control input-sm"
                    style={{ width: 88 }}
                    onChange={e => onChangeY(e.target.value)}
                    onKeyDown={handleKey}
                />
            </div>
            <button className="btn btn-primary btn-sm" onClick={onGo}>
                Go
            </button>
            <DefaultTooltip
                trigger={['hover']}
                placement="top"
                overlay={
                    <span>
                        Copy a link to this exact view (slide, position, zoom)
                    </span>
                }
            >
                <button
                    data-testid="share-view-button"
                    aria-label={copied ? 'Copied' : 'Share view'}
                    title="Share view"
                    className="btn btn-default btn-sm"
                    onClick={handleCopy}
                    style={{
                        ...btnStyle,
                        border: `1px solid ${copied ? '#3a8a3a' : C.border}`,
                        background: copied ? '#edfaed' : '#fff',
                        color: copied ? '#3a8a3a' : C.muted,
                    }}
                >
                    <i
                        className={`fa ${copied ? 'fa-check' : 'fa-clipboard'}`}
                    />
                </button>
            </DefaultTooltip>
            <DefaultTooltip
                trigger={['hover']}
                placement="top"
                overlay={<span>Download current viewport as JPEG</span>}
            >
                <button
                    data-testid="download-view-button"
                    aria-label="Download view"
                    title="Download view"
                    className="btn btn-default btn-sm"
                    onClick={onDownload}
                    style={{
                        ...btnStyle,
                        border: `1px solid ${C.border}`,
                        background: '#fff',
                        color: C.muted,
                    }}
                >
                    <i className="fa fa-cloud-download" />
                </button>
            </DefaultTooltip>
            {annotationEnabled && (
                <button
                    onClick={onToggleAnnotations}
                    title={
                        annotationsVisible
                            ? 'Hide annotations'
                            : 'Show annotations'
                    }
                    style={{
                        ...btnStyle,
                        border: `1px solid ${
                            annotationsVisible ? C.blue : C.border
                        }`,
                        background: annotationsVisible ? '#e8f2ff' : '#fff',
                        color: annotationsVisible ? C.blue : C.muted,
                    }}
                >
                    {annotationsVisible ? '🔵 Annotations' : '○ Annotations'}
                </button>
            )}
            {cursorPos && (
                <span
                    style={{
                        marginLeft: 'auto',
                        color: C.muted,
                        fontFamily: 'monospace',
                        fontSize: 11,
                        lineHeight: '18px',
                        whiteSpace: 'nowrap',
                    }}
                >
                    @ {cursorLabel}
                </span>
            )}
        </div>
    );
}

function cleanStain(name: string): string {
    return (name || '').replace(/^DM\s+/i, '') || '—';
}

/**
 * Parse the section identifier out of a pathology barcode.
 * Barcode format: "<accession>;<section>;<lab>"  e.g. "S13-57848;S1;msk"
 * Returns the section field (e.g. "S1") or null if not parseable.
 */
function barcodeSection(barcode: string | null | undefined): string | null {
    if (!barcode) return null;
    const parts = barcode.split(';');
    return parts.length >= 2 ? parts[1].trim() || null : null;
}

/** Extract the surgical accession number from a barcode (the part before the first ";"). */
function barcodeAccession(barcode: string | null | undefined): string | null {
    if (!barcode) return null;
    const acc = barcode.split(';')[0].trim();
    return acc || null;
}

/**
 * Abbreviate a part_description to fit in the narrow sidebar label.
 * Truncates at the first "(", ";", comma-followed-by-whitespace, or at
 * MAX_LEN characters, whichever comes first.
 */
function abbreviatePartDesc(desc: string | null | undefined): string | null {
    if (!desc) return null;
    const MAX_LEN = 28;
    // Strip everything from the first parenthesis (e.g. "(fs)", "(MSK:...)")
    let s = desc.replace(/\s*[(\[;].*$/, '').trim();
    if (s.length <= MAX_LEN) return s || null;
    // Hard-truncate at a word boundary
    const cut = s.lastIndexOf(' ', MAX_LEN);
    return (cut > 10 ? s.slice(0, cut) : s.slice(0, MAX_LEN)).trim() + '…';
}

function fmtMB(bytes: string | number | null | undefined): string {
    const n = Number(bytes);
    if (!n) return '—';
    return n >= 1e9
        ? (n / 1e9).toFixed(1) + ' GB'
        : (n / 1e6).toFixed(0) + ' MB';
}

/** Common pathology block letter codes → human-readable meaning. */
const BLOCK_CODE_MAP: Record<string, string> = {
    // Single-letter tissue region codes
    A: 'Apical',
    B: 'Basal',
    C: 'Central',
    D: 'Distal',
    E: 'External',
    F: 'Fragment',
    I: 'Inked Margin',
    M: 'Margin',
    N: 'Normal',
    P: 'Proximal',
    R: 'Representative',
    S: 'Section',
    T: 'Tumor',
    U: 'Uninvolved',
    // Two-letter anatomical codes
    AC: 'Anterior/Caudal',
    BM: 'Bronchial Margin',
    DL: 'Distal Level',
    DM: 'Deep Margin',
    GU: 'Genitourinary',
    ML: 'Mesenteric Level',
    OM: 'Omental',
    PL: 'Proximal Level',
    RM: 'Resection Margin',
    RS: 'Rep. Section',
    SM: 'Surgical Margin',
    ST: 'Stromal',
    TU: 'Tumor',
    // MSK pathology subspecialty/department codes
    // (block label uses dept code when tissue type is unambiguous within the case)
    BST: 'Bone/Soft Tissue',
    BRST: 'Breast',
    DERM: 'Dermatologic',
    GI: 'Gastrointestinal',
    GYN: 'Gynecologic',
    HEME: 'Hematologic',
    HN: 'Head & Neck',
    NEURO: 'Neurologic',
    THOR: 'Thoracic',
    // Special processing codes
    ADD: 'Additional Section',
    FSC: 'Frozen Section',
    INK: 'Inked Margin',
    // Lymph node codes — spell out "Lymph Node" in full
    LN: 'Lymph Node',
    ALN: 'Axillary Lymph Node',
    BLN: 'Bench Lymph Node',
    CLN: 'Central Lymph Node',
    DLN: 'Distal Lymph Node',
    ILN: 'Inguinal Lymph Node',
    LLN: 'Left Lymph Node',
    MLN: 'Mesenteric Lymph Node',
    NTLN: 'Non-Tumor Lymph Node',
    PLN: 'Pelvic Lymph Node',
    RLN: 'Right Lymph Node',
    SLN: 'Sentinel Lymph Node',
    SSLN: 'Sub-Site Lymph Node',
    TLN: 'Thoracic Lymph Node',
    // Other codes seen in MSK multi-site specimens
    RBL: 'Right Bowel Lumen',
};

/**
 * Decode the letter-code portion of a block label (e.g. "11 PL1" → "Proximal Level",
 * "9 M" → "Margin", "16 RLN" → "Right Lymph Node"). Returns null when unknown.
 */
function decodeBlockCode(label: string | null | undefined): string | null {
    if (!label) return null;
    const m = label.match(/^\d+\s+([A-Z]+)\d*$/);
    if (!m) return null;
    return BLOCK_CODE_MAP[m[1]] || null;
}

const BLOCK_LABEL_TIP =
    'Block label: number = block within case; letter code = tissue region (P=Proximal, D=Distal, M=Margin, RS=Rep. Section, LN=Lymph Node, RLN=Right Lymph Node, …)';

// ---- NavPanel ----

interface NavPanelProps {
    hierarchy: PatientHierarchy;
    selectedSlide: Slide | null;
    stainFilter: 'all' | 'hne' | 'ihc';
    onFilterChange: (f: 'all' | 'hne' | 'ihc') => void;
    onSelectSlide: (slide: Slide, sample: Sample) => void;
}

function NavPanel({
    hierarchy,
    selectedSlide,
    stainFilter,
    onFilterChange,
    onSelectSlide,
}: NavPanelProps) {
    const allSlides = React.useMemo(
        () =>
            hierarchy.samples.flatMap(s =>
                s.parts.flatMap(p => p.blocks.flatMap(b => b.slides))
            ),
        [hierarchy]
    );
    const counts = React.useMemo(
        () => ({
            all: allSlides.length,
            hne: allSlides.filter(s => s.is_hne).length,
            ihc: allSlides.filter(s => s.is_ihc).length,
        }),
        [allSlides]
    );
    const chips: Array<{
        key: 'all' | 'hne' | 'ihc';
        label: string;
        color?: string;
    }> = [
        { key: 'all', label: 'All' },
        { key: 'hne', label: '● H&E', color: C.blue },
        { key: 'ihc', label: '● IHC', color: C.orange },
    ];

    return (
        <div
            style={{
                width: NAV_W,
                minWidth: NAV_W,
                display: 'flex',
                flexDirection: 'column',
                background: C.navBg,
                borderRight: `1px solid ${C.border}`,
                overflow: 'hidden',
            }}
        >
            {/* Header */}
            <div
                style={{
                    padding: '9px 12px 7px',
                    borderBottom: `1px solid ${C.border}`,
                    flexShrink: 0,
                }}
            >
                <div style={sectionTitleStyle}>Slides</div>
                <div
                    className="btn-group btn-group-xs"
                    style={{ marginTop: 7 }}
                >
                    {chips.map(chip => {
                        const count = counts[chip.key];
                        const disabled = chip.key !== 'all' && count === 0;
                        const active = stainFilter === chip.key;
                        return (
                            <button
                                key={chip.key}
                                className={`btn btn-xs ${
                                    active ? 'btn-primary' : 'btn-default'
                                }`}
                                disabled={disabled}
                                onClick={() => onFilterChange(chip.key)}
                                style={disabled ? { color: '#aaa' } : undefined}
                            >
                                {chip.key !== 'all' && (
                                    <i
                                        className="fa fa-circle"
                                        style={{
                                            fontSize: 8,
                                            marginRight: 3,
                                            color: active
                                                ? undefined
                                                : chip.color,
                                            verticalAlign: 'middle',
                                        }}
                                    />
                                )}
                                {chip.key === 'hne'
                                    ? 'H&E'
                                    : chip.key === 'ihc'
                                    ? 'IHC'
                                    : 'All'}
                                {chip.key !== 'all' && (
                                    <span
                                        style={{ marginLeft: 4, opacity: 0.8 }}
                                    >
                                        {count}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>
            {/* Tree */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
                {hierarchy.samples.map(sample => (
                    <SampleNode
                        key={sample.sample_id}
                        sample={sample}
                        selectedSlide={selectedSlide}
                        stainFilter={stainFilter}
                        onSelectSlide={onSelectSlide}
                    />
                ))}
            </div>
        </div>
    );
}

// ---- SampleNode ----

interface SampleNodeProps {
    sample: Sample;
    selectedSlide: Slide | null;
    stainFilter: 'all' | 'hne' | 'ihc';
    onSelectSlide: (slide: Slide, sample: Sample) => void;
}

function SampleNode({
    sample,
    selectedSlide,
    stainFilter,
    onSelectSlide,
}: SampleNodeProps) {
    const [open, setOpen] = React.useState(true);

    const allSlides = React.useMemo(
        () => sample.parts.flatMap(p => p.blocks.flatMap(b => b.slides)),
        [sample]
    );
    const totSlides = allSlides.length;
    const servableSlides = allSlides.filter(s => s.can_serve_tiles).length;

    const stLower = (sample.sample_type || '').toLowerCase();
    const stClass =
        stLower === 'primary'
            ? C.blue
            : stLower.includes('metastas') || stLower === 'local recurrence'
            ? '#c05000'
            : C.muted;
    const stBg =
        stLower === 'primary'
            ? C.blueLight
            : stLower.includes('metastas') || stLower === 'local recurrence'
            ? '#fef0e8'
            : '#f0f0f0';

    const DUMMY = new Set(['0', '']);
    const blockId = (b: { block_label: string; block_number: string }) =>
        normalizeBlockLabel(b.block_label, b.block_number);

    // Detect multi-part patient (part_description varies → show anatomical site per slide)
    const allPartDescs = React.useMemo(
        () =>
            new Set(
                sample.parts
                    .flatMap(p =>
                        p.blocks.flatMap(b =>
                            b.slides.map(sl => sl.part_description || '')
                        )
                    )
                    .filter(Boolean)
            ),
        [sample]
    );
    const multiPart = allPartDescs.size > 1;

    // Flatten + sort slides — block label is now the primary label for H&E, not a badge
    const sortedSlides = React.useMemo(() => {
        const result: Array<{ slide: Slide; blockLabel: string | null }> = [];
        for (const part of sample.parts) {
            for (const b of part.blocks) {
                const lbl = blockId(b);
                const blockLabel = DUMMY.has(lbl) ? null : lbl;
                for (const sl of b.slides)
                    result.push({ slide: sl, blockLabel });
            }
        }
        // Sort purely chronologically by block_number
        result.sort((a, b) => {
            const na = Number(a.slide.block_number) || 0;
            const nb = Number(b.slide.block_number) || 0;
            if (na !== nb) return na - nb;
            return (a.slide.stain_name || '').localeCompare(
                b.slide.stain_name || ''
            );
        });
        return result;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sample]);

    return (
        <div style={{ borderBottom: `1px solid ${C.border}` }}>
            {/* Sample header */}
            <div
                onClick={() => setOpen(o => !o)}
                style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 6,
                    padding: '8px 12px 7px',
                    cursor: 'pointer',
                    userSelect: 'none',
                }}
            >
                <span
                    style={{
                        fontSize: 10,
                        color: C.muted,
                        marginTop: 2,
                        flexShrink: 0,
                        width: 10,
                    }}
                >
                    {open ? '▾' : '▸'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                        style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: C.blue,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {sample.sample_id || '—'}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>
                        {sample.sample_type && (
                            <span
                                style={{
                                    display: 'inline-block',
                                    fontSize: 9,
                                    fontWeight: 700,
                                    textTransform: 'uppercase',
                                    letterSpacing: '.4px',
                                    padding: '1px 5px',
                                    borderRadius: 3,
                                    background: stBg,
                                    color: stClass,
                                    marginRight: 4,
                                }}
                            >
                                {sample.sample_type}
                            </span>
                        )}
                        {sample.oncotree_code && (
                            <a
                                href="https://oncotree.mskcc.org/"
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`${sample.oncotree_code}${
                                    sample.cancer_type_detailed
                                        ? ` — ${sample.cancer_type_detailed}`
                                        : ''
                                }\nView OncoTree`}
                                onClick={e => e.stopPropagation()}
                                style={{
                                    display: 'inline-block',
                                    background: '#f0f0f0',
                                    border: `1px solid ${C.border}`,
                                    borderRadius: 3,
                                    fontSize: 9,
                                    fontWeight: 700,
                                    padding: '0 4px',
                                    color: C.text,
                                    marginRight: 4,
                                    textDecoration: 'none',
                                }}
                            >
                                {sample.oncotree_code}
                            </a>
                        )}
                        {sample.cancer_type_detailed ||
                            sample.cancer_type ||
                            ''}
                    </div>
                    {sample.primary_site && (
                        <div style={{ fontSize: 10, color: '#aaa' }}>
                            {sample.primary_site}
                        </div>
                    )}
                </div>
                <div
                    title="Tile-servable slides / total slides"
                    style={{
                        fontSize: 9,
                        color: '#bbb',
                        flexShrink: 0,
                        textAlign: 'right',
                        lineHeight: 1.4,
                        cursor: 'help',
                    }}
                >
                    <span style={{ color: C.blue, fontWeight: 600 }}>
                        {servableSlides}
                    </span>
                    /{totSlides}
                </div>
            </div>

            {/* Slide list */}
            {open && (
                <div style={{ paddingBottom: 4 }}>
                    {sortedSlides.map(({ slide, blockLabel }) => {
                        const dc = getStainKind(slide);
                        const visible =
                            stainFilter === 'all' || dc === stainFilter;
                        if (!visible) return null;
                        return (
                            <SlideItem
                                key={slide.image_id}
                                slide={slide}
                                sample={sample}
                                blockLabel={blockLabel}
                                multiPart={multiPart}
                                selected={
                                    selectedSlide?.image_id === slide.image_id
                                }
                                onSelectSlide={onSelectSlide}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ---- SlideItem ----

interface SlideItemProps {
    slide: Slide;
    sample: Sample;
    blockLabel: string | null;
    multiPart: boolean;
    selected: boolean;
    onSelectSlide: (slide: Slide, sample: Sample) => void;
}

/**
 * Short stain label for the sub-line of H&E slides.
 * Always returns something so the stain type is always visible.
 */
function stainQualifier(group: string | null | undefined): string {
    const g = (group || '').toLowerCase();
    if (g.includes('frozen')) return 'frozen';
    if (g.includes('initial')) return 'H&E';
    return 'H&E recut';
}

function SlideItem({
    slide,
    sample,
    blockLabel,
    multiPart,
    selected,
    onSelectSlide,
}: SlideItemProps) {
    const [hovered, setHovered] = React.useState(false);
    const isHE =
        slide.is_hne ||
        (slide.stain_group || '').toLowerCase().startsWith('h&e');
    const dotColor = getStainDotColor(slide);
    const mag = slide.magnification || '';
    const sz = fmtMB(slide.file_size_bytes);
    const section = barcodeSection(slide.barcode);
    const partDesc = multiPart
        ? abbreviatePartDesc(slide.part_description)
        : null;
    // Decoded block region meaning ("Proximal", "Margin", etc.) — shown when block code is known.
    const blockMeaning = !partDesc ? decodeBlockCode(blockLabel) : null;

    // Primary label: block region for H&E, stain name for IHC/special stains.
    const primaryLabel = isHE
        ? blockLabel || section || cleanStain(slide.stain_name)
        : cleanStain(slide.stain_name);

    // LHS sub-label: section only for H&E (stain moves to RHS); block·section for IHC.
    const subTokens: string[] = [];
    if (!isHE && blockLabel) subTokens.push(blockLabel);
    if (section) subTokens.push(section);

    // RHS: stain qualifier (H&E slides only) / mag / size — gives the stain type back
    // without it dominating the primary label.
    const rhsStain = isHE ? stainQualifier(slide.stain_group) : null;

    // Tooltip: full metadata for pathologist context.
    const tooltipLines: string[] = [];
    if (!slide.can_serve_tiles) tooltipLines.push('⚠ Tiles not yet available');
    if (slide.barcode) tooltipLines.push(`Barcode: ${slide.barcode}`);
    if (slide.stain_name) tooltipLines.push(`Stain: ${slide.stain_name}`);
    if (blockLabel) tooltipLines.push(`Block: ${blockLabel}`);
    if (slide.part_description)
        tooltipLines.push(`Part: ${slide.part_description}`);
    if (section) tooltipLines.push(`Section: ${section}`);
    if (mag) tooltipLines.push(`Magnification: ${mag}`);
    if (sz !== '—') tooltipLines.push(`Size: ${sz}`);
    tooltipLines.push(`Image ID: ${slide.image_id}`);

    const bg = selected ? C.blueLight : hovered ? C.blueLight : 'transparent';
    const borderLeft = selected
        ? `2px solid ${C.blue}`
        : '2px solid transparent';

    return (
        <div
            data-testid={`wsi-slide-item-${slide.image_id}`}
            onClick={() =>
                slide.can_serve_tiles && onSelectSlide(slide, sample)
            }
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            title={tooltipLines.join('\n')}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 8px',
                margin: '1px 4px',
                borderRadius: 3,
                borderLeft,
                background: bg,
                cursor: slide.can_serve_tiles ? 'pointer' : 'help',
                opacity: slide.can_serve_tiles ? 1 : 0.55,
            }}
        >
            <span
                style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: dotColor,
                    flexShrink: 0,
                    display: 'inline-block',
                }}
            />
            {/* LHS: primary label + decoded block meaning + section */}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div
                    style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: C.text,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {primaryLabel}
                </div>
                {partDesc && (
                    <div
                        style={{
                            fontSize: 10,
                            color: C.blue,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            fontStyle: 'italic',
                        }}
                    >
                        {partDesc}
                    </div>
                )}
                {blockMeaning && (
                    <div
                        style={{
                            fontSize: 10,
                            color: C.blue,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {blockMeaning}
                    </div>
                )}
                {subTokens.length > 0 && (
                    <div
                        style={{
                            fontSize: 10,
                            color: C.muted,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {subTokens.join(' · ')}
                    </div>
                )}
            </div>
            {/* RHS: stain type (H&E slides) / mag / size */}
            <div style={{ flexShrink: 0, textAlign: 'right', lineHeight: 1.5 }}>
                {rhsStain && (
                    <div
                        style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: dotColor,
                        }}
                    >
                        {rhsStain}
                    </div>
                )}
                {mag && (
                    <div style={{ fontSize: 10, color: C.muted }}>{mag}</div>
                )}
                <div style={{ fontSize: 10, color: C.muted }}>{sz}</div>
            </div>
        </div>
    );
}

// ---- MetaSidebar ----

/** Initial timeout before first auto-retry. Subsequent failure shows manual retry UI. */
const THUMBNAIL_TIMEOUT_MS = 30_000;
const THUMBNAIL_MAX_AUTO_RETRIES = 1;

function SlideThumbnail({ src }: { src: string | null }) {
    const [status, setStatus] = React.useState<'loading' | 'loaded' | 'error'>(
        'loading'
    );
    // retryKey forces a fresh <img> mount (new network request) on retry.
    const [retryKey, setRetryKey] = React.useState(0);
    const autoRetriesRef = React.useRef(0);
    const imgRef = React.useRef<HTMLImageElement>(null);

    // useLayoutEffect runs synchronously after DOM mutations, before the browser
    // paints. When the image is in the browser HTTP cache the load event fires
    // synchronously DURING DOM insertion — before React attaches onLoad — so
    // onLoad never fires. By the time useLayoutEffect runs the img.complete flag
    // is already true, so we can transition immediately without waiting for the
    // event. The component is keyed by src in MetaSidebar so this effect only
    // needs to run once on mount (and again on retry).
    React.useLayoutEffect(() => {
        autoRetriesRef.current = 0;
        const img = imgRef.current;
        if (!img) return;
        if (img.complete) {
            setStatus(img.naturalWidth > 0 ? 'loaded' : 'error');
            return;
        }
        // If the tile server is busy or a worker was restarted, the request may
        // hang indefinitely. Auto-retry once before surfacing the error UI, since
        // the first attempt may have hit a cold-start queue and Redis is now warm.
        const timer = window.setTimeout(() => {
            if (autoRetriesRef.current < THUMBNAIL_MAX_AUTO_RETRIES) {
                autoRetriesRef.current += 1;
                setStatus('loading');
                setRetryKey(k => k + 1);
            } else {
                setStatus('error');
            }
        }, THUMBNAIL_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
    }, [retryKey]);

    if (!src) {
        return (
            <span
                style={{
                    color: '#bbb',
                    fontSize: 11,
                    padding: 20,
                    textAlign: 'center',
                }}
            >
                No slide selected
            </span>
        );
    }

    return (
        <>
            {status === 'loading' && (
                <span style={{ color: '#888', fontSize: 12 }}>
                    <i
                        className="fa fa-spinner fa-spin"
                        style={{ marginRight: 4 }}
                    />
                    Loading…
                </span>
            )}
            <img
                key={retryKey}
                ref={imgRef}
                src={src}
                alt="slide thumbnail"
                style={{
                    maxWidth: '100%',
                    maxHeight: 160,
                    display: status === 'loaded' ? 'block' : 'none',
                }}
                onLoad={() => setStatus('loaded')}
                onError={() => setStatus('error')}
            />
            {status === 'error' && (
                <span style={{ color: '#bbb', fontSize: 11 }}>
                    Thumbnail unavailable{' '}
                    <button
                        className="btn btn-link btn-sm"
                        style={{
                            padding: 0,
                            fontSize: 11,
                            verticalAlign: 'baseline',
                        }}
                        onClick={() => {
                            setStatus('loading');
                            setRetryKey(k => k + 1);
                        }}
                    >
                        Retry
                    </button>
                </span>
            )}
        </>
    );
}

export interface MetaSidebarProps {
    slide: Slide | null;
    sample: Sample | null;
    meta: TileMetadata | null;
    tileServerBase: string;
    studyId?: string;
    annotations?: W3CAnnotation[];
    annotationsLoading?: boolean;
    annotationEnabled?: boolean;
    onDeleteAnnotation?: (id: string) => void;
    /** ID of the annotation whose label is currently being edited inline. */
    editingAnnotationId?: string | null;
    /** Current value of the inline label editor. */
    editingLabelText?: string;
    /** Begin editing the label for the given annotation ID. */
    onStartEditAnnotation?: (id: string, currentLabel: string) => void;
    onChangeEditLabel?: (v: string) => void;
    onConfirmEditLabel?: () => void;
    onCancelEditLabel?: () => void;
    /** Layer names to show in the Layers panel. */
    layerNames?: string[];
    /** Currently hidden layer names. */
    hiddenLayerNames?: Set<string>;
    onToggleLayerVisibility?: (name: string) => void;
    /** The layer currently selected for drawing. */
    activeLayerName?: string;
    onSetActiveLayer?: (name: string) => void;
    onAddLayer?: (name: string) => void;
}

export function MetaSidebar({
    slide,
    sample,
    meta,
    tileServerBase,
    studyId,
    annotations = [],
    annotationsLoading = false,
    annotationEnabled = false,
    onDeleteAnnotation,
    editingAnnotationId,
    editingLabelText = '',
    onStartEditAnnotation,
    onChangeEditLabel,
    onConfirmEditLabel,
    onCancelEditLabel,
    layerNames = [],
    hiddenLayerNames = new Set(),
    onToggleLayerVisibility,
    activeLayerName,
    onSetActiveLayer,
    onAddLayer,
}: MetaSidebarProps) {
    const thumbSrc = slide
        ? `${tileServerBase}/tiles/${encodeURIComponent(
              slide.image_id
          )}/thumbnail`
        : null;
    const sampleUrl =
        studyId && sample?.sample_id
            ? buildSampleUrl(studyId, sample.sample_id)
            : undefined;
    const seqRows = React.useMemo(
        () => (slide && sample ? buildSeqRows(sample, sampleUrl) : []),
        [slide, sample, sampleUrl]
    );
    const wsiRows = React.useMemo(
        () => (meta ? buildWsiRows(slide, meta) : []),
        [slide, meta]
    );
    const pathRows = React.useMemo(
        () => (slide && sample ? buildPathRows(slide, sample, studyId) : []),
        [slide, sample, studyId]
    );
    const [showAddLayerForm, setShowAddLayerForm] = React.useState(false);
    const [newLayerName, setNewLayerName] = React.useState('');

    return (
        <div
            style={{
                width: SIDEBAR_W,
                minWidth: SIDEBAR_W,
                background: C.sidebarBg,
                borderLeft: `1px solid ${C.border}`,
                display: 'flex',
                flexDirection: 'column',
                overflowY: 'auto',
                flexShrink: 0,
            }}
        >
            {/* Thumbnail */}
            <SbSection title="Thumbnail">
                <div
                    style={{
                        background: '#fff',
                        border: `1px solid ${C.border}`,
                        borderRadius: 3,
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minHeight: 90,
                        marginTop: 8,
                    }}
                >
                    <SlideThumbnail key={thumbSrc ?? 'none'} src={thumbSrc} />
                </div>
            </SbSection>

            {/* Image Properties */}
            <SbSection title="Image Properties">
                {meta ? (
                    <MetaTable rows={wsiRows} />
                ) : (
                    <span style={{ color: '#bbb', fontSize: 11 }}>—</span>
                )}
            </SbSection>

            {/* Pathology */}
            <SbSection title="Pathology">
                {slide && sample ? (
                    <MetaTable rows={pathRows} />
                ) : (
                    <span style={{ color: '#bbb', fontSize: 11 }}>—</span>
                )}
            </SbSection>

            {/* Layers panel */}
            {annotationEnabled && (
                <SbSection title="Layers">
                    <div style={{ marginTop: 6 }}>
                        {layerNames.map(name => {
                            const isHidden = hiddenLayerNames.has(name);
                            const isActive = activeLayerName === name;
                            const count = annotations.filter(
                                a =>
                                    ((a as any).layerName ??
                                        DEFAULT_LAYER_NAME) === name
                            ).length;
                            return (
                                <div
                                    key={name}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        padding: '3px 0',
                                    }}
                                >
                                    <button
                                        data-testid={`layer-toggle-${name}`}
                                        onClick={() =>
                                            onToggleLayerVisibility?.(name)
                                        }
                                        title={
                                            isHidden
                                                ? `Show layer "${name}"`
                                                : `Hide layer "${name}"`
                                        }
                                        style={{
                                            border: 'none',
                                            background: 'transparent',
                                            cursor: 'pointer',
                                            padding: '0 2px',
                                            color: isHidden ? C.muted : C.blue,
                                            lineHeight: 1,
                                            flexShrink: 0,
                                            display: 'flex',
                                            alignItems: 'center',
                                        }}
                                    >
                                        {isHidden ? (
                                            /* eye-off */
                                            <svg
                                                viewBox="0 0 24 24"
                                                width="14"
                                                height="14"
                                                fill="currentColor"
                                                aria-hidden="true"
                                            >
                                                <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75C21.27 7.61 17 4.5 12 4.5c-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
                                            </svg>
                                        ) : (
                                            /* eye */
                                            <svg
                                                viewBox="0 0 24 24"
                                                width="14"
                                                height="14"
                                                fill="currentColor"
                                                aria-hidden="true"
                                            >
                                                <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                                            </svg>
                                        )}
                                    </button>
                                    <button
                                        data-testid={`layer-select-${name}`}
                                        onClick={() => onSetActiveLayer?.(name)}
                                        title={`Draw on layer "${name}"${
                                            isHidden
                                                ? ' (currently hidden)'
                                                : ''
                                        }`}
                                        aria-pressed={isActive}
                                        style={{
                                            flex: 1,
                                            textAlign: 'left',
                                            fontSize: 11,
                                            padding: '1px 6px',
                                            borderRadius: 3,
                                            cursor: 'pointer',
                                            border: `1.5px solid ${
                                                isActive ? C.blue : C.border
                                            }`,
                                            background: isActive
                                                ? C.blue
                                                : 'transparent',
                                            color: isActive
                                                ? '#fff'
                                                : isHidden
                                                ? C.muted
                                                : C.text,
                                            fontWeight: isActive ? 700 : 400,
                                            textDecoration: isHidden
                                                ? 'line-through'
                                                : 'none',
                                            opacity: isHidden ? 0.55 : 1,
                                        }}
                                    >
                                        {name}
                                    </button>
                                    <span
                                        style={{
                                            fontSize: 10,
                                            color: C.muted,
                                            flexShrink: 0,
                                            minWidth: 14,
                                            textAlign: 'right',
                                        }}
                                    >
                                        {count}
                                    </span>
                                </div>
                            );
                        })}
                        <div style={{ marginTop: 4 }}>
                            {!showAddLayerForm ? (
                                <button
                                    data-testid="add-layer-btn"
                                    title="Add new annotation layer"
                                    onClick={() => setShowAddLayerForm(true)}
                                    style={{
                                        fontSize: 11,
                                        padding: '1px 8px',
                                        border: `1px dashed ${C.border}`,
                                        background: 'transparent',
                                        color: C.muted,
                                        borderRadius: 3,
                                        cursor: 'pointer',
                                        width: '100%',
                                    }}
                                >
                                    + Add layer
                                </button>
                            ) : (
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 3,
                                    }}
                                >
                                    <input
                                        data-testid="add-layer-input"
                                        type="text"
                                        value={newLayerName}
                                        placeholder="Layer name"
                                        maxLength={30}
                                        autoFocus
                                        onChange={e =>
                                            setNewLayerName(e.target.value)
                                        }
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                                onAddLayer?.(newLayerName);
                                                setShowAddLayerForm(false);
                                                setNewLayerName('');
                                            }
                                            if (e.key === 'Escape') {
                                                setShowAddLayerForm(false);
                                                setNewLayerName('');
                                            }
                                        }}
                                        style={{
                                            flex: 1,
                                            fontSize: 11,
                                            border: `1px solid ${C.border}`,
                                            borderRadius: 3,
                                            padding: '1px 5px',
                                            outline: 'none',
                                            color: C.text,
                                            background: '#fff',
                                        }}
                                    />
                                    <button
                                        data-testid="add-layer-confirm"
                                        onClick={() => {
                                            onAddLayer?.(newLayerName);
                                            setShowAddLayerForm(false);
                                            setNewLayerName('');
                                        }}
                                        style={{
                                            fontSize: 11,
                                            padding: '1px 6px',
                                            border: `1px solid ${C.blue}`,
                                            background: C.blue,
                                            color: '#fff',
                                            borderRadius: 3,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        Add
                                    </button>
                                    <button
                                        onClick={() => {
                                            setShowAddLayerForm(false);
                                            setNewLayerName('');
                                        }}
                                        style={{
                                            fontSize: 11,
                                            padding: '1px 4px',
                                            border: 'none',
                                            background: 'transparent',
                                            color: C.muted,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        ✕
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </SbSection>
            )}

            {/* Annotations panel */}
            {annotationEnabled && (
                <SbSection
                    title={`Annotations (${
                        annotations.filter(
                            a =>
                                !hiddenLayerNames.has(
                                    (a as any).layerName ?? DEFAULT_LAYER_NAME
                                )
                        ).length
                    })`}
                >
                    {annotationsLoading ? (
                        <span style={{ color: '#bbb', fontSize: 11 }}>
                            Loading…
                        </span>
                    ) : annotations.length === 0 ? (
                        <span style={{ color: '#bbb', fontSize: 11 }}>
                            No annotations yet. Draw on the slide to create one.
                        </span>
                    ) : (
                        <div
                            style={{
                                maxHeight: 260,
                                overflowY: 'auto',
                                marginTop: 6,
                            }}
                        >
                            {annotations.map(ann => {
                                const rawLabel = ann.body?.[0]?.value ?? '';
                                const displayLabel = rawLabel || '(unlabeled)';
                                const rawCreator = (ann as any).creator;
                                const creator =
                                    typeof rawCreator === 'string'
                                        ? rawCreator
                                        : rawCreator?.id ??
                                          rawCreator?.name ??
                                          '';
                                const created = (ann as any).created ?? '';
                                const dateStr = created
                                    ? new Date(created).toLocaleDateString()
                                    : '';
                                const dotColor =
                                    ann.color ?? DEFAULT_NAMED_COLORS[0].hex;
                                const colorName = ann.colorName ?? '';
                                const annLayerName: string =
                                    (ann as any).layerName ??
                                    DEFAULT_LAYER_NAME;
                                const isEditing =
                                    editingAnnotationId === ann.id;
                                // Hide annotations whose layer is currently hidden
                                if (hiddenLayerNames.has(annLayerName))
                                    return null;
                                return (
                                    <div
                                        key={ann.id}
                                        style={{
                                            padding: '4px 0',
                                            borderBottom: `1px solid ${C.border}`,
                                            display: 'flex',
                                            alignItems: 'flex-start',
                                            gap: 4,
                                        }}
                                    >
                                        {/* Colored dot */}
                                        <span
                                            data-annotation-color={dotColor}
                                            data-annotation-layer={annLayerName}
                                            title={colorName || 'No color name'}
                                            style={{
                                                display: 'inline-block',
                                                width: 8,
                                                height: 8,
                                                borderRadius: '50%',
                                                background: dotColor,
                                                flexShrink: 0,
                                                marginTop: 4,
                                            }}
                                        />
                                        <div
                                            style={{
                                                flex: 1,
                                                overflow: 'hidden',
                                            }}
                                        >
                                            {isEditing ? (
                                                <div
                                                    style={{
                                                        display: 'flex',
                                                        gap: 3,
                                                        alignItems: 'center',
                                                    }}
                                                >
                                                    <input
                                                        data-testid="annotation-label-edit-input"
                                                        autoFocus
                                                        type="text"
                                                        maxLength={200}
                                                        value={editingLabelText}
                                                        onChange={e =>
                                                            onChangeEditLabel?.(
                                                                e.target.value
                                                            )
                                                        }
                                                        onKeyDown={e => {
                                                            if (
                                                                e.key ===
                                                                'Enter'
                                                            )
                                                                onConfirmEditLabel?.();
                                                            if (
                                                                e.key ===
                                                                'Escape'
                                                            )
                                                                onCancelEditLabel?.();
                                                        }}
                                                        style={{
                                                            flex: 1,
                                                            fontSize: 11,
                                                            padding: '1px 4px',
                                                            border: `1px solid ${C.blue}`,
                                                            borderRadius: 3,
                                                            outline: 'none',
                                                        }}
                                                    />
                                                    <button
                                                        onClick={
                                                            onConfirmEditLabel
                                                        }
                                                        title="Save label (Enter)"
                                                        style={{
                                                            border: 'none',
                                                            background:
                                                                'transparent',
                                                            cursor: 'pointer',
                                                            color: '#2a7a2a',
                                                            fontSize: 12,
                                                            padding: '0 2px',
                                                        }}
                                                    >
                                                        ✓
                                                    </button>
                                                    <button
                                                        onClick={
                                                            onCancelEditLabel
                                                        }
                                                        title="Cancel (Esc)"
                                                        style={{
                                                            border: 'none',
                                                            background:
                                                                'transparent',
                                                            cursor: 'pointer',
                                                            color: C.muted,
                                                            fontSize: 12,
                                                            padding: '0 2px',
                                                        }}
                                                    >
                                                        ✕
                                                    </button>
                                                </div>
                                            ) : (
                                                <>
                                                    <div
                                                        style={{
                                                            fontSize: 12,
                                                            fontWeight: 500,
                                                            color: C.text,
                                                            whiteSpace:
                                                                'nowrap',
                                                            overflow: 'hidden',
                                                            textOverflow:
                                                                'ellipsis',
                                                        }}
                                                        title={displayLabel}
                                                    >
                                                        {displayLabel}
                                                    </div>
                                                    <div
                                                        style={{
                                                            display: 'flex',
                                                            gap: 3,
                                                            marginTop: 1,
                                                            flexWrap: 'wrap',
                                                        }}
                                                    >
                                                        {annLayerName && (
                                                            <span
                                                                style={{
                                                                    fontSize: 9,
                                                                    fontWeight: 600,
                                                                    padding:
                                                                        '0 4px',
                                                                    borderRadius: 8,
                                                                    background:
                                                                        '#e8e8e8',
                                                                    color:
                                                                        '#555',
                                                                    display:
                                                                        'inline-block',
                                                                }}
                                                            >
                                                                {annLayerName}
                                                            </span>
                                                        )}
                                                        {colorName && (
                                                            <span
                                                                style={{
                                                                    fontSize: 9,
                                                                    fontWeight: 600,
                                                                    padding:
                                                                        '0 4px',
                                                                    borderRadius: 8,
                                                                    background: dotColor,
                                                                    color:
                                                                        '#fff',
                                                                    display:
                                                                        'inline-block',
                                                                }}
                                                            >
                                                                {colorName}
                                                            </span>
                                                        )}
                                                    </div>
                                                </>
                                            )}
                                            {!isEditing &&
                                                (creator || dateStr) && (
                                                    <div
                                                        style={{
                                                            fontSize: 10,
                                                            color: C.muted,
                                                        }}
                                                    >
                                                        {creator}
                                                        {creator && dateStr
                                                            ? ' · '
                                                            : ''}
                                                        {dateStr}
                                                    </div>
                                                )}
                                        </div>
                                        {!isEditing && onStartEditAnnotation && (
                                            <button
                                                onClick={() =>
                                                    onStartEditAnnotation(
                                                        ann.id,
                                                        rawLabel
                                                    )
                                                }
                                                title="Edit label"
                                                data-testid={`edit-label-${ann.id}`}
                                                style={{
                                                    border: 'none',
                                                    background: 'transparent',
                                                    cursor: 'pointer',
                                                    color: C.muted,
                                                    fontSize: 12,
                                                    padding: '0 2px',
                                                    flexShrink: 0,
                                                }}
                                            >
                                                ✎
                                            </button>
                                        )}
                                        {onDeleteAnnotation && (
                                            <button
                                                onClick={() =>
                                                    onDeleteAnnotation(ann.id)
                                                }
                                                title="Delete annotation"
                                                style={{
                                                    border: 'none',
                                                    background: 'transparent',
                                                    cursor: 'pointer',
                                                    color: '#c0392b',
                                                    fontSize: 13,
                                                    padding: '0 2px',
                                                    flexShrink: 0,
                                                }}
                                            >
                                                ✕
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </SbSection>
            )}

            {/* MSK-IMPACT Sequencing — only when data is available */}
            {(seqRows.length > 0 ||
                (sample?.oncogenic_mutations &&
                    sample?.oncogenic_mutation_details !== undefined) ||
                sample?.cna_alterations?.length) && (
                <SbSection title="MSK-IMPACT">
                    {seqRows.length > 0 && <MetaTable rows={seqRows} />}
                    {sample && <MutationTable sample={sample} />}
                    {sample?.cna_alterations?.length ? (
                        <CnaTable sample={sample} />
                    ) : null}
                </SbSection>
            )}
        </div>
    );
}

// ---- DrawToolbar ----
// Second toolbar row rendered below CoordBar; shown only when annotations are active.

export type DrawingToolId =
    | 'rectangle'
    | 'ellipse'
    | 'circle'
    | 'line'
    | 'polygon';

const DRAW_TOOLS: {
    id: DrawingToolId;
    label: string;
    icon: string;
    hint: string;
}[] = [
    {
        id: 'rectangle',
        icon: '◻',
        label: 'Rect',
        hint: 'Draw a rectangle — click and drag on the slide',
    },
    {
        id: 'ellipse',
        icon: '⬭',
        label: 'Ellipse',
        hint: 'Draw an ellipse — click and drag on the slide',
    },
    {
        id: 'circle',
        icon: '○',
        label: 'Circle',
        hint: 'Draw a circle — click and drag from center',
    },
    {
        id: 'line',
        icon: '╱',
        label: 'Line',
        hint: 'Draw a line — click and drag on the slide',
    },
    {
        id: 'polygon',
        icon: '⬡',
        label: 'Poly',
        hint: 'Draw a polygon — click to add points, double-click to close',
    },
];

export interface DrawToolbarProps {
    drawingTool: DrawingToolId | null;
    onSetDrawingTool: (tool: DrawingToolId | null) => void;
    namedColors: NamedColor[];
    activeColorHex: string;
    activeColorName: string;
    onSetActiveColor: (name: string, hex: string) => void;
    onAddNamedColor: (name: string, hex: string) => void;
    onRemoveNamedColor: (hex: string, name: string) => void;
}

export function DrawToolbar({
    drawingTool,
    onSetDrawingTool,
    namedColors,
    activeColorHex,
    activeColorName,
    onSetActiveColor,
    onAddNamedColor,
    onRemoveNamedColor,
}: DrawToolbarProps) {
    const [showAddColorForm, setShowAddColorForm] = React.useState(false);
    const [newHex, setNewHex] = React.useState('#ff0000');
    const [newColorName, setNewColorName] = React.useState('');

    const handleAddColor = () => {
        if (newHex) onAddNamedColor(newColorName.trim() || newHex, newHex);
        setShowAddColorForm(false);
        setNewColorName('');
    };

    return (
        <div
            style={{
                position: 'absolute',
                bottom: 44,
                left: 0,
                right: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                padding: '4px 10px',
                background: 'rgba(250,250,250,0.92)',
                borderTop: `1px solid ${C.border}`,
                fontSize: 11,
                backdropFilter: 'blur(2px)',
                zIndex: 10,
            }}
        >
            {/* Draw shape buttons */}
            {DRAW_TOOLS.map(({ id, icon, label, hint }) => {
                const isActive = drawingTool === id;
                return (
                    <button
                        key={id}
                        onClick={() => onSetDrawingTool(isActive ? null : id)}
                        title={isActive ? 'Cancel drawing (Esc)' : hint}
                        style={{
                            padding: '2px 9px',
                            fontSize: 11,
                            cursor: 'pointer',
                            borderRadius: 3,
                            lineHeight: '18px',
                            border: `1px solid ${
                                isActive ? '#c0392b' : C.border
                            }`,
                            background: isActive ? '#fde8e8' : '#fff',
                            color: isActive ? '#c0392b' : C.muted,
                            fontWeight: isActive ? 600 : 400,
                        }}
                    >
                        {isActive ? '✕ Cancel draw' : `${icon} ${label}`}
                    </button>
                );
            })}

            <span
                style={{
                    width: 1,
                    height: 16,
                    background: C.border,
                    margin: '0 2px',
                }}
            />

            {/* Color palette */}
            <span
                style={{ fontSize: 10, color: C.muted, whiteSpace: 'nowrap' }}
            >
                Color:
            </span>
            {namedColors.map(({ name, hex }) => {
                const isActive =
                    activeColorHex === hex && activeColorName === name;
                return (
                    <span
                        key={`${name}|${hex}`}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 1,
                        }}
                    >
                        <button
                            title={`Color: ${name || hex}`}
                            aria-pressed={isActive}
                            onClick={() => onSetActiveColor(name, hex)}
                            style={{
                                fontSize: 10,
                                padding: '1px 7px',
                                borderRadius: 10,
                                cursor: 'pointer',
                                background: isActive ? hex : '#fff',
                                color: isActive ? '#fff' : hex,
                                border: `1.5px solid ${hex}`,
                                fontWeight: isActive ? 700 : 400,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {name || hex}
                        </button>
                        <button
                            title={`Remove "${name || hex}" from palette`}
                            onClick={() => onRemoveNamedColor(hex, name)}
                            style={{
                                fontSize: 8,
                                padding: '0 2px',
                                border: 'none',
                                background: 'transparent',
                                cursor: 'pointer',
                                color: '#bbb',
                                lineHeight: 1,
                            }}
                        >
                            ×
                        </button>
                    </span>
                );
            })}
            {!showAddColorForm ? (
                <button
                    title="Add new named color to palette"
                    onClick={() => setShowAddColorForm(true)}
                    style={{
                        fontSize: 12,
                        padding: '0 5px',
                        border: `1px dashed ${C.border}`,
                        background: '#fff',
                        color: C.muted,
                        borderRadius: 10,
                        cursor: 'pointer',
                    }}
                >
                    +
                </button>
            ) : (
                <span
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        padding: '1px 5px',
                        border: `1px solid ${C.border}`,
                        borderRadius: 10,
                        background: '#fff',
                    }}
                >
                    <input
                        type="color"
                        value={newHex}
                        title="Pick color"
                        onChange={e => setNewHex(e.target.value)}
                        style={{
                            width: 20,
                            height: 16,
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            background: 'transparent',
                        }}
                    />
                    <input
                        type="text"
                        value={newColorName}
                        placeholder="Name (optional)"
                        maxLength={20}
                        autoFocus
                        onChange={e => setNewColorName(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') handleAddColor();
                            if (e.key === 'Escape') setShowAddColorForm(false);
                        }}
                        style={{
                            fontSize: 10,
                            border: 'none',
                            outline: 'none',
                            width: 90,
                            background: 'transparent',
                            color: C.text,
                        }}
                    />
                    <button
                        title="Add color to palette"
                        onClick={handleAddColor}
                        style={{
                            fontSize: 10,
                            padding: '1px 5px',
                            border: `1px solid ${C.blue}`,
                            background: C.blue,
                            color: '#fff',
                            borderRadius: 8,
                            cursor: 'pointer',
                        }}
                    >
                        Add
                    </button>
                    <button
                        title="Cancel"
                        onClick={() => setShowAddColorForm(false)}
                        style={{
                            fontSize: 10,
                            padding: '1px 4px',
                            border: 'none',
                            background: 'transparent',
                            color: C.muted,
                            cursor: 'pointer',
                        }}
                    >
                        ✕
                    </button>
                </span>
            )}
        </div>
    );
}

function SbSection({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}) {
    return (
        <div
            style={{
                padding: '10px 12px',
                borderBottom: `1px solid ${C.border}`,
            }}
        >
            <div style={sectionTitleStyle}>{title}</div>
            {children}
        </div>
    );
}

function MetaTable({ rows }: { rows: MetaRow[] }) {
    return (
        <table
            style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}
        >
            <tbody>
                {rows.map(row => (
                    <tr key={row.label}>
                        <td
                            title={row.labelTip}
                            style={{
                                fontSize: 11,
                                color: C.muted,
                                width: '50%',
                                paddingRight: 5,
                                paddingTop: 2,
                                paddingBottom: 2,
                                verticalAlign: 'top',
                                lineHeight: 1.5,
                                cursor: row.labelTip ? 'help' : undefined,
                                borderBottom: row.labelTip
                                    ? `1px dotted ${C.border}`
                                    : undefined,
                            }}
                        >
                            {row.label}
                        </td>
                        <td
                            title={row.valueTip}
                            style={{
                                fontSize: 11,
                                color: C.text,
                                fontWeight: 500,
                                wordBreak: 'break-word',
                                verticalAlign: 'top',
                                lineHeight: 1.5,
                                cursor: row.valueTip ? 'help' : undefined,
                            }}
                        >
                            {row.href ? (
                                <a
                                    href={row.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                        color: C.blue,
                                        textDecoration: 'none',
                                    }}
                                    onMouseEnter={e => {
                                        (e.currentTarget as HTMLAnchorElement).style.textDecoration =
                                            'underline';
                                    }}
                                    onMouseLeave={e => {
                                        (e.currentTarget as HTMLAnchorElement).style.textDecoration =
                                            'none';
                                    }}
                                >
                                    {row.value || '—'}
                                </a>
                            ) : (
                                row.value || '—'
                            )}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

interface MetaRow {
    label: string;
    labelTip?: string;
    value: React.ReactNode;
    href?: string;
    /** Tooltip shown on the value cell (plain text). */
    valueTip?: string;
}

function buildWsiRows(slide: Slide | null, meta: TileMetadata): MetaRow[] {
    const w = meta.dimensions.width,
        h = meta.dimensions.height;
    const mppX = meta.mpp?.x || 0,
        mppY = meta.mpp?.y || 0;
    const mpp = mppX && mppY ? (mppX + mppY) / 2 : 0;
    const objNum = meta.objective_power || (mpp ? Math.round(10 / mpp) : 0);

    // Build a tooltip with technical scanner details for the Dimensions row.
    const techParts: string[] = [];
    if (mpp) techParts.push(`MPP: ${mpp.toFixed(4)} µm/px`);
    if (objNum) techParts.push(`Objective: ${objNum}×`);
    techParts.push(`Zoom levels: ${meta.max_zoom + 1}`);
    techParts.push(`Tile size: ${meta.tile_size} px`);
    const dimTip = techParts.join('\n');

    const rows: MetaRow[] = [
        {
            label: 'Dimensions',
            labelTip: 'Width × height in pixels at full resolution',
            value: `${w.toLocaleString()} × ${h.toLocaleString()} px`,
            valueTip: dimTip,
        },
    ];
    if (mpp)
        rows.push({
            label: 'MPP',
            labelTip:
                'Microns per pixel — physical size of one pixel at full resolution',
            value: `${mpp.toFixed(4)} µm/px`,
        });
    if (objNum)
        rows.push({
            label: 'Objective',
            labelTip: 'Objective lens magnification used to capture the slide',
            value: `${objNum}×`,
        });
    rows.push({
        label: 'Zoom levels',
        labelTip: 'Number of resolution tiers in the pyramidal image',
        value: String(meta.max_zoom + 1),
    });
    rows.push({
        label: 'Tile size',
        labelTip: 'Tile dimensions (px) streamed to the viewer',
        value: `${meta.tile_size} px`,
    });
    if (slide?.file_size_bytes)
        rows.push({ label: 'File size', value: fmtMB(slide.file_size_bytes) });
    return rows;
}

function buildPathRows(
    slide: Slide,
    sample: Sample,
    studyId?: string
): MetaRow[] {
    const stainBadge = getStainBadge(slide);
    const oncotreeUrl = sample.oncotree_code
        ? 'https://oncotree.mskcc.org/'
        : undefined;
    const patientUrl =
        studyId && sample.sample_id
            ? buildPatientUrl(studyId, sample.sample_id)
            : undefined;
    const sampleUrl =
        studyId && sample.sample_id
            ? buildSampleUrl(studyId, sample.sample_id)
            : undefined;
    const studyUrl = studyId
        ? `/study/summary?id=${encodeURIComponent(studyId)}`
        : undefined;
    const cancerTypeUrl =
        studyId && (sample.cancer_type_detailed || sample.cancer_type)
            ? `/results?cancer_study_list=${encodeURIComponent(
                  studyId
              )}&cancer_type=${encodeURIComponent(
                  (sample.cancer_type_detailed || sample.cancer_type || '')
                      .toLowerCase()
                      .replace(/\s+/g, '_')
              )}`
            : undefined;
    const accession = barcodeAccession(slide.barcode);
    const blockLbl = normalizeBlockLabel(slide.block_label, slide.block_number);
    const sampleTipParts: string[] = [];
    if (accession) sampleTipParts.push(`Accession: ${accession}`);
    if (blockLbl) sampleTipParts.push(`Block: ${blockLbl}`);
    if (sample.sample_type) sampleTipParts.push(`Type: ${sample.sample_type}`);
    const sampleTip = sampleTipParts.length
        ? sampleTipParts.join('\n')
        : undefined;

    const pathDxTitle = slide.path_dx_title
        ? slide.path_dx_title.charAt(0).toUpperCase() +
          slide.path_dx_title.slice(1).toLowerCase()
        : null;
    const partDesc = slide.part_description || null;

    const rows: MetaRow[] = [
        {
            label: 'Stain',
            labelTip: 'Staining protocol used for this slide',
            value: stainBadge
                ? `${stainBadge} — ${cleanStain(slide.stain_name)}`
                : cleanStain(slide.stain_name),
        },
        {
            label: 'Patient',
            labelTip: 'Click to open cBioPortal patient page',
            value: getPatientId(sample.sample_id) || '—',
            href: patientUrl,
        },
        {
            label: 'Sample',
            labelTip: sampleTip
                ? 'Click for cBioPortal sample view — hover for accession/block info'
                : 'Tumor sample identifier',
            value: sample.sample_id || '—',
            href: sampleUrl,
            valueTip: sampleTip,
        },
    ];
    if (studyId)
        rows.push({
            label: 'Study',
            labelTip: 'Click to open cBioPortal study summary',
            value: studyId,
            href: studyUrl,
        });
    if (sample.cancer_type_detailed || sample.cancer_type)
        rows.push({
            label: 'Cancer type',
            value: sample.cancer_type_detailed || sample.cancer_type || '',
            href: cancerTypeUrl,
        });
    if (sample.oncotree_code)
        rows.push({
            label: 'OncoTree',
            labelTip:
                'OncoTree cancer classification code — click to view on oncotree.mskcc.org',
            value: sample.oncotree_code,
            href: oncotreeUrl,
        });
    if (sample.primary_site)
        rows.push({ label: 'Primary site', value: sample.primary_site });
    if (partDesc)
        rows.push({
            label: 'Anatomical site',
            labelTip:
                'Pathology part description — which anatomical specimen this slide was cut from',
            value: partDesc,
        });
    if (
        pathDxTitle &&
        pathDxTitle.toLowerCase() !== (partDesc || '').toLowerCase()
    ) {
        rows.push({
            label: 'Path Dx',
            labelTip: 'Pathological diagnosis title for this anatomical part',
            value: pathDxTitle,
        });
    }
    if (slide.magnification)
        rows.push({
            label: 'Magnification',
            labelTip: 'Objective lens magnification',
            value: slide.magnification,
        });
    if (blockLbl)
        rows.push({
            label: 'Block',
            labelTip: BLOCK_LABEL_TIP,
            value: blockLbl,
        });
    return rows;
}

/**
 * Convert cBioPortal mutation type string to a short human-readable label.
 * e.g. "Missense_Mutation" → "Missense", "Frame_Shift_Del" → "Frameshift del"
 */
const MUTATION_TYPE_MAP: Record<string, string> = {
    Missense_Mutation: 'Missense',
    Nonsense_Mutation: 'Nonsense',
    Frame_Shift_Del: 'Frameshift del',
    Frame_Shift_Ins: 'Frameshift ins',
    In_Frame_Del: 'In-frame del',
    In_Frame_Ins: 'In-frame ins',
    Splice_Site: 'Splice site',
    Translation_Start_Site: 'Start site',
    Nonstop_Mutation: 'Nonstop',
    Silent: 'Silent',
};

function formatMutationType(t: string): string {
    if (!t) return '';
    return MUTATION_TYPE_MAP[t] ?? t.replace(/_/g, ' ');
}

function shortMutationType(type: string | undefined): string {
    if (!type) return '—';
    if (type === 'Missense') return 'MS';
    if (type === 'Nonsense') return 'NS';
    if (type === 'Frameshift del') return 'FSdel';
    if (type === 'Frameshift ins') return 'FSins';
    if (type === 'In-frame del') return 'IFdel';
    if (type === 'In-frame ins') return 'IFins';
    if (type === 'Splice site') return 'Splice';
    if (type === 'Start site') return 'Start';
    return type.slice(0, 6);
}

/**
 * Compact table rendering mutations — one row per variant with columns:
 * Gene | Variant (hover: VAF, copy #, cohort %) | Annot (icons) | Type.
 * Only rendered after `oncogenic_mutation_details` is populated so that
 * all cells have data on first paint.
 */
/** Map oncogenicity string → circle color (matches oncokb-styles icons.svg sprite). */
function oncokbCircleColor(
    oncogenic?: string
): { stroke: string; rings: 3 | 1 } {
    const level = (oncogenic || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-');
    if (['oncogenic', 'likely-oncogenic', 'resistance'].includes(level))
        return { stroke: '#0968C3', rings: 3 };
    if (['neutral', 'likely-neutral'].includes(level))
        return { stroke: '#696969', rings: 3 };
    if (level === 'inconclusive') return { stroke: '#aaa', rings: 3 };
    if (level === 'vus') return { stroke: '#696969', rings: 1 };
    return { stroke: '#ccc', rings: 1 };
}

/**
 * OncoKB concentric-circles icon — color reflects oncogenicity level,
 * exactly matching cBioPortal's oncokb-styles icons.svg sprite.
 */
const OncoKbIcon = ({ oncogenic }: { oncogenic?: string }) => {
    const { stroke, rings } = oncokbCircleColor(oncogenic);
    return (
        <svg
            width="14"
            height="14"
            viewBox="-9 -9 18 18"
            style={inlineIconStyle}
        >
            <circle r="7" fill="none" strokeWidth="2" stroke={stroke} />
            {rings === 3 && (
                <>
                    <circle r="4" fill="none" strokeWidth="2" stroke={stroke} />
                    <circle r="2" fill={stroke} />
                </>
            )}
        </svg>
    );
};

/** CIViC logo image — matches cBioPortal's annotation column CIViC badge. */
const CivicIcon = () => (
    <img
        src={require('../../../rootImages/civic-logo.png')}
        width={14}
        height={14}
        style={inlineIconStyle}
        alt="CIViC"
    />
);

/**
 * Cancer Hotspots flame icon — exact path from rootImages/cancer-hotspots.svg,
 * matching cBioPortal's hotspot annotation icon.
 */
const HotspotIcon = () => (
    <svg width="12" height="12" viewBox="0 0 1024 1024" style={inlineIconStyle}>
        <path
            fill="#ff9900"
            d="M321.008 1045.333c-68.245-142.008-31.901-223.379 20.551-300.044 57.44-83.956 72.244-167.065 72.244-167.065s45.153 58.7 27.092 150.508c79.772-88.8 94.824-230.28 82.783-284.464 180.315 126.012 257.376 398.856 153.523 601.065 552.372-312.532 137.399-780.172 65.155-832.851 24.081 52.676 28.648 141.851-20 185.127-82.352-312.276-285.972-376.276-285.972-376.276 24.083 161.044-87.296 337.144-194.696 468.731-3.775-64.216-7.783-108.528-41.549-169.98-7.58 116.656-96.732 211.748-120.873 328.628-32.701 158.287 24.496 274.18 241.748 396.623z"
        />
    </svg>
);

function MutationTable({
    sample,
}: {
    sample: Sample;
}): React.ReactElement | null {
    const muts = parseMutationTokens(sample.oncogenic_mutations);
    const details = sample.oncogenic_mutation_details;
    if (!muts.length || details === undefined) return null;

    const [tooltip, setTooltip] = React.useState<{
        idx: number;
        x: number;
        y: number;
    } | null>(null);
    const hideTooltip = () => setTooltip(null);

    const thStyle = compactThStyle;
    const tdBase = compactTdBase;

    function oncogenicStyle(level: string | undefined): React.CSSProperties {
        if (!level) return {};
        const l = level.toLowerCase();
        if (l.includes('likely neutral') || l.includes('inconclusive'))
            return { color: '#888' };
        if (l.includes('oncogenic') || l === 'resistance')
            return { color: '#007bff', fontWeight: 700 };
        return { color: '#555' };
    }

    return (
        <div style={{ position: 'relative' }}>
            <table style={compactTableStyle}>
                <colgroup>
                    <col style={{ width: '28%' }} />
                    <col style={{ width: '28%' }} />
                    <col style={{ width: '26%' }} />
                    <col style={{ width: '18%' }} />
                </colgroup>
                <thead>
                    <tr>
                        <th style={thStyle}>Gene</th>
                        <th style={thStyle}>Variant ⓘ</th>
                        <th style={thStyle}>Annot</th>
                        <th style={thStyle}>Type</th>
                    </tr>
                </thead>
                <tbody>
                    {muts.map((mut, i) => {
                        const { gene, variant } = parseMutationToken(mut);
                        const oncoKbUrl = buildOncoKbUrl(gene, variant);
                        const civicUrl = `https://civicdb.org/genes/${encodeURIComponent(
                            gene
                        )}/summary`;
                        const d = details?.[i];
                        const shortType = shortMutationType(d?.type);
                        const isHotspot =
                            d?.hotspot === true ||
                            !!d?.annotation?.toLowerCase().includes('hotspot');
                        const hasOncoKbData = !!(
                            d?.oncogenic || d?.mutationEffect
                        );
                        const cnaForGene = sample.cna_alterations?.find(
                            c => c.gene === gene
                        );
                        const variantTitleParts: string[] = [];
                        if (d?.vaf != null)
                            variantTitleParts.push(`VAF: ${d.vaf}%`);
                        if (cnaForGene)
                            variantTitleParts.push(
                                `Copy #: ${cnaLabel(cnaForGene.cnaValue)}`
                            );
                        if (d?.cohortFrequency != null)
                            variantTitleParts.push(
                                `Cohort: ${(d.cohortFrequency * 100).toFixed(
                                    1
                                )}%`
                            );
                        const variantTitle =
                            variantTitleParts.join(' | ') || undefined;
                        return (
                            <tr
                                key={mut}
                                style={{ borderTop: `1px solid ${C.border}` }}
                            >
                                <td
                                    style={{
                                        ...tdBase,
                                        paddingRight: 4,
                                        ...ellipsisStyle,
                                        fontWeight: 600,
                                        color: C.text,
                                    }}
                                >
                                    {gene}
                                </td>
                                <td
                                    title={variantTitle}
                                    style={{
                                        ...tdBase,
                                        paddingRight: 4,
                                        ...ellipsisStyle,
                                        fontFamily: 'monospace',
                                        fontSize: 10.5,
                                        cursor: variantTitle
                                            ? 'help'
                                            : undefined,
                                    }}
                                >
                                    {(variant.startsWith('p.')
                                        ? variant.slice(2)
                                        : variant) || '—'}
                                </td>
                                <td
                                    style={{
                                        ...tdBase,
                                        paddingRight: 2,
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    <a
                                        href={oncoKbUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{
                                            marginRight: 3,
                                            textDecoration: 'none',
                                            display: 'inline-block',
                                            cursor: hasOncoKbData
                                                ? 'pointer'
                                                : 'pointer',
                                        }}
                                        onMouseEnter={e => {
                                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                            setTooltip({
                                                idx: i,
                                                x: r.left,
                                                y: r.bottom + 4,
                                            });
                                        }}
                                        onMouseLeave={hideTooltip}
                                        onClick={e => e.stopPropagation()}
                                    >
                                        <OncoKbIcon oncogenic={d?.oncogenic} />
                                    </a>
                                    {d?.hasCivic && (
                                        <a
                                            href={civicUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title={`CIViC: ${gene}`}
                                            style={{
                                                marginRight: isHotspot ? 3 : 0,
                                                textDecoration: 'none',
                                                display: 'inline-block',
                                            }}
                                        >
                                            <CivicIcon />
                                        </a>
                                    )}
                                    {isHotspot && (
                                        <a
                                            href={`https://www.cancerhotspots.org/#/gene/${encodeURIComponent(
                                                gene
                                            )}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title="Recurrent hotspot"
                                            style={{
                                                textDecoration: 'none',
                                                display: 'inline-block',
                                            }}
                                        >
                                            <HotspotIcon />
                                        </a>
                                    )}
                                </td>
                                <td
                                    title={d?.type}
                                    style={{
                                        ...tdBase,
                                        paddingRight: 4,
                                        ...ellipsisStyle,
                                        color: C.muted,
                                    }}
                                >
                                    {shortType}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            {tooltip !== null &&
                (() => {
                    const d = details?.[tooltip.idx];
                    if (
                        !d?.oncogenic &&
                        !d?.mutationEffect &&
                        !d?.geneSummary &&
                        !d?.variantSummary
                    )
                        return null;
                    const { gene, variant } = parseMutationToken(
                        muts[tooltip.idx] ?? ''
                    );
                    const oncoKbUrl = buildOncoKbUrl(
                        gene,
                        variant || undefined
                    );
                    return (
                        <div
                            onMouseEnter={() => setTooltip(t => t)}
                            onMouseLeave={hideTooltip}
                            style={{
                                position: 'fixed',
                                left: Math.min(
                                    tooltip.x,
                                    window.innerWidth - 340
                                ),
                                top: tooltip.y,
                                zIndex: 9999,
                                background: '#fff',
                                border: '1px solid #d4d4d4',
                                borderRadius: 4,
                                boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
                                padding: '10px 14px',
                                maxWidth: 320,
                                fontSize: 11.5,
                                fontFamily: 'Arial, sans-serif',
                                lineHeight: 1.45,
                                color: '#333',
                                pointerEvents: 'auto',
                            }}
                        >
                            <div
                                style={{
                                    fontWeight: 700,
                                    fontSize: 12.5,
                                    marginBottom: 5,
                                }}
                            >
                                <span>{gene}</span>
                                {variant && (
                                    <span
                                        style={{
                                            fontFamily: 'monospace',
                                            marginLeft: 4,
                                        }}
                                    >
                                        {variant}
                                    </span>
                                )}
                            </div>
                            {(d.oncogenic || d.mutationEffect) && (
                                <div
                                    style={{
                                        display: 'flex',
                                        gap: 8,
                                        marginBottom: 6,
                                        flexWrap: 'wrap',
                                    }}
                                >
                                    {d.oncogenic && (
                                        <span
                                            style={{
                                                display: 'inline-block',
                                                fontSize: 10.5,
                                                fontWeight: 700,
                                                padding: '1px 6px',
                                                borderRadius: 3,
                                                background: d.oncogenic
                                                    .toLowerCase()
                                                    .includes('oncogenic')
                                                    ? '#e6f0ff'
                                                    : '#f5f5f5',
                                                ...oncogenicStyle(d.oncogenic),
                                            }}
                                        >
                                            {d.oncogenic}
                                        </span>
                                    )}
                                    {d.mutationEffect && (
                                        <span
                                            style={{
                                                display: 'inline-block',
                                                fontSize: 10.5,
                                                padding: '1px 6px',
                                                borderRadius: 3,
                                                background: '#f9f2e8',
                                                color: '#7a5c00',
                                            }}
                                        >
                                            {d.mutationEffect}
                                        </span>
                                    )}
                                </div>
                            )}
                            {d.geneSummary && (
                                <p
                                    style={{
                                        margin: '0 0 5px',
                                        color: '#444',
                                        fontSize: 11,
                                    }}
                                >
                                    {d.geneSummary}
                                </p>
                            )}
                            {d.variantSummary && (
                                <p
                                    style={{
                                        margin: '0 0 5px',
                                        color: '#555',
                                        fontSize: 11,
                                        fontStyle: 'italic',
                                    }}
                                >
                                    {d.variantSummary}
                                </p>
                            )}
                            <div
                                style={{
                                    marginTop: 6,
                                    borderTop: '1px solid #eee',
                                    paddingTop: 5,
                                }}
                            >
                                <a
                                    href={oncoKbUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                        color: '#0968C3',
                                        fontSize: 10.5,
                                        textDecoration: 'none',
                                    }}
                                >
                                    View on OncoKB →
                                </a>
                            </div>
                        </div>
                    );
                })()}
        </div>
    );
}

/** Rows derived from MSK-IMPACT sequencing — shown in their own sidebar section. */
function buildSeqRows(sample: Sample, sampleUrl?: string): MetaRow[] {
    const rows: MetaRow[] = [];
    if (sample.tumor_purity)
        rows.push({
            label: 'Tumor purity',
            labelTip: 'Estimated fraction of tumor cells in this sample',
            value: `${sample.tumor_purity}%`,
        });
    if (sample.tmb_score)
        rows.push({
            label: 'TMB',
            labelTip:
                'Tumor mutational burden — click to view mutations in cBioPortal',
            value: `${sample.tmb_score} mut/Mb`,
            href: sampleUrl,
        });
    if (sample.msi_type)
        rows.push({
            label: 'MSI',
            labelTip: 'Microsatellite instability status',
            value: sample.msi_type,
        });
    if (
        sample.metastatic_site &&
        sample.metastatic_site.toLowerCase() !== 'not applicable'
    ) {
        rows.push({
            label: 'Metastatic site',
            value: sample.metastatic_site,
        });
    }
    return rows;
}

/** Labels for discrete CNA values (GISTIC encoding). */
function cnaLabel(value: number): string {
    if (value === -2) return 'Deep del';
    if (value === -1) return 'Shallow del';
    if (value === 1) return 'Gain';
    if (value === 2) return 'Amplification';
    return String(value);
}

/**
 * Compact table of copy-number alterations — one row per gene with columns:
 * Gene (OncoKB link) | CNA type.
 */
function CnaTable({ sample }: { sample: Sample }): React.ReactElement | null {
    const cnas = sample.cna_alterations;
    if (!cnas?.length) return null;

    const thStyle = compactThStyle;
    const tdBase = compactTdBase;

    return (
        <table style={compactTableStyle}>
            <colgroup>
                <col style={{ width: '45%' }} />
                <col style={{ width: '55%' }} />
            </colgroup>
            <thead>
                <tr>
                    <th style={thStyle}>Gene</th>
                    <th style={thStyle}>CNA</th>
                </tr>
            </thead>
            <tbody>
                {cnas.map(cna => {
                    const href = buildOncoKbUrl(cna.gene);
                    const label = cnaLabel(cna.cnaValue);
                    const color =
                        cna.cnaValue <= -2
                            ? '#b22222'
                            : cna.cnaValue === -1
                            ? '#cc6600'
                            : cna.cnaValue >= 2
                            ? '#1a5c1a'
                            : C.muted;
                    return (
                        <tr
                            key={cna.gene}
                            style={{ borderTop: `1px solid ${C.border}` }}
                        >
                            <td
                                style={{
                                    ...tdBase,
                                    paddingRight: 4,
                                    ...ellipsisStyle,
                                }}
                            >
                                <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                        color: C.blue,
                                        fontWeight: 600,
                                        textDecoration: 'none',
                                    }}
                                    onMouseEnter={e => {
                                        (e.currentTarget as HTMLAnchorElement).style.textDecoration =
                                            'underline';
                                    }}
                                    onMouseLeave={e => {
                                        (e.currentTarget as HTMLAnchorElement).style.textDecoration =
                                            'none';
                                    }}
                                >
                                    {cna.gene}
                                </a>
                            </td>
                            <td
                                style={{
                                    ...tdBase,
                                    color,
                                    fontWeight: 500,
                                }}
                            >
                                {label}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}
