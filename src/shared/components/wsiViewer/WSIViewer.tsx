import * as React from 'react';
import { observer } from 'mobx-react';
import { observable, action, computed, makeObservable } from 'mobx';
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

export interface NamedColor { name: string; hex: string; }

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
    } catch (_) { /* ignore */ }
    return [DEFAULT_LAYER_NAME];
}

function saveCustomLayerNames(names: string[]) {
    try { localStorage.setItem(LOCALSTORAGE_LAYERS_KEY, JSON.stringify(names)); } catch (_) { /* ignore */ }
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

export function parseColorLabel(bodyType: string | undefined): { name: string; hex: string } {
    const fallback = DEFAULT_NAMED_COLORS[0].hex;
    if (!bodyType) return { name: '', hex: fallback };
    if (bodyType.includes('|')) {
        const idx = bodyType.indexOf('|');
        const rawHex = bodyType.slice(idx + 1) || fallback;
        // Validate hex so an API-controlled value cannot inject CSS (e.g. url(...)).
        return { name: bodyType.slice(0, idx), hex: sanitizeHex(rawHex, fallback) };
    }
    if (bodyType.startsWith('#')) return { name: '', hex: sanitizeHex(bodyType, fallback) };
    // Legacy layer names from the previous implementation.
    const LEGACY: Record<string, string> = {
        general: '#3b82f6', tumor: '#ef4444', stroma: '#22c55e',
        normal: '#14b8a6', tils: '#8b5cf6', necrosis: '#f97316',
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
    } catch (_) { /* ignore */ }
    return [...DEFAULT_NAMED_COLORS];
}

function saveNamedColors(colors: NamedColor[]) {
    try { localStorage.setItem(LOCALSTORAGE_COLORS_KEY, JSON.stringify(colors)); } catch (_) { /* ignore */ }
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
    @observable private annotationTooltip: { x: number; y: number; text: string } | null = null;
    /** Active Annotorious drawing tool, or null when not drawing. */
    @observable private activeDrawingTool: 'rectangle' | 'ellipse' | 'circle' | 'line' | 'polygon' | null = null;
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
            if (!seen.has(key)) { seen.add(key); result.push({ name, hex }); }
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
    @observable private activeColorHex: string = loadNamedColors()[0]?.hex ?? DEFAULT_NAMED_COLORS[0].hex;
    /** Name associated with the active color (may be empty for ad-hoc colors). */
    @observable private activeColorName: string = loadNamedColors()[0]?.name ?? DEFAULT_NAMED_COLORS[0].name;

    // ---- Layer state ----
    /** User-created layer names (persisted to localStorage). */
    @observable private customLayerNames: string[] = loadCustomLayerNames();
    /** Layer new annotations are assigned to. */
    @observable private activeLayerName: string = loadCustomLayerNames()[0] ?? DEFAULT_LAYER_NAME;
    /** Layer names currently hidden from the Annotorious overlay. */
    @observable private hiddenLayerNames: Set<string> = new Set();
    /**
     * All unique layer names = custom ∪ annotation-derived (same reactive pattern as namedColors).
     */
    @computed get layerNames(): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        const add = (n: string) => { if (!seen.has(n)) { seen.add(n); result.push(n); } };
        for (const name of this.customLayerNames) add(name);
        for (const ann of this.annotations) add((ann as any).layerName ?? DEFAULT_LAYER_NAME);
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

    /** Number of gunicorn workers on the tile server (used to fire warmup N times) */
    private nWorkers = 4;

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
    private writeHashState() {
        if (typeof window === 'undefined' || !this.osdViewer?.viewport || !this.selectedSlide) return;
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
        } catch (_) { /* viewport not ready */ }
    }

    /** Parse the #wsi:... hash; returns null if not present or malformed. */
    private static readHashState(): { slideId: string; x: number; y: number; z: number } | null {
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
            if (!slideId || !isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
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
        this.metaCache.clear();
        // Invalidate any in-flight mountOSD from a previous patient.
        this.mountSeq++;

        try {
            // Read n_workers from the health endpoint so warmup fires the right
            // number of times to prime every gunicorn worker's SlideCache.
            const base = this.tileServerBase;
            fetch(`${base}/health`)
                .then(r => r.ok ? r.json() : null)
                .then((d: any) => { if (d?.n_workers) this.nWorkers = d.n_workers; })
                .catch(() => { /* leave default of 4 */ });

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

            // Auto-select first servable H&E slide, else first servable slide.
            // If the URL hash encodes a prior view, honour that slide instead.
            const allSlides = this.servableSlides;
            const hashState = WSIViewer.readHashState();
            const fromHash = hashState
                ? allSlides.find(s => s.slide.image_id === hashState.slideId)
                : undefined;
            const first = fromHash ?? allSlides.find(s => s.slide.is_hne) ?? allSlides[0];
            if (first) {
                await this.selectSlide(first.slide, first.sample);
            }

            // Prefetch metadata for remaining slides in the background so
            // subsequent slide selections don't pay the S3 cold-open cost (~4s).
            void this.prefetchSlideMetadata(first?.slide.image_id);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            action(() => {
                this.error = msg;
                this.loading = false;
            })();
        }
    }

    /**
     * Background prefetch: for each servable slide (except the already-loaded
     * first one), fetch metadata + thumbnail concurrently. Both endpoints cache
     * results in Redis so every subsequent user click is served instantly.
     *
     * Also fires the /warmup endpoint nWorkers times per slide so every gunicorn
     * worker's SlideCache gets primed (round-robin routing means N calls ≈ N workers).
     * Runs serially (one slide at a time) to keep workers free for user requests.
     */
    private async prefetchSlideMetadata(skipImageId?: string) {
        const slides = this.servableSlides
            .map(s => s.slide)
            .filter(sl => sl.image_id !== skipImageId && !this.metaCache.has(sl.image_id));

        for (const sl of slides) {
            if (!this.hierarchy) return;
            const base = this.tileServerBase;
            const encId = encodeURIComponent(sl.image_id);
            const warmupCalls = Array.from({ length: this.nWorkers }, () =>
                fetch(`${base}/tiles/${encId}/warmup`).catch(() => {})
            );
            await Promise.allSettled([
                fetch(`${base}/tiles/${encId}/metadata`)
                    .then(r => r.ok ? r.json() : Promise.reject(r.status))
                    .then((meta: TileMetadata) => { this.metaCache.set(sl.image_id, meta); }),
                // Thumbnail fetch warms the Redis cache so the sidebar img is
                // served from Redis (no SVS open) on the first user click.
                fetch(`${base}/tiles/${encId}/thumbnail`),
                ...warmupCalls,
            ]);
            // Brief pause between slides to avoid S3 connection pile-up.
            await new Promise(r => setTimeout(r, 200));
        }
    }

    @computed get servableSlides(): Array<{ slide: Slide; sample: Sample }> {        if (!this.hierarchy) return [];
        const result: Array<{ slide: Slide; sample: Sample }> = [];
        for (const sample of this.hierarchy.samples) {
            for (const part of sample.parts) {
                for (const block of part.blocks) {
                    for (const slide of block.slides) {
                        if (slide.can_serve_tiles) result.push({ slide, sample });
                    }
                }
            }
        }
        return result;
    }

    @computed get tileServerBase(): string {
        return this.props.url.replace(/\/patient\/[^/]+\/?$/, '');
    }

    // ---- slide selection ----

    @action.bound
    async selectSlide(slide: Slide, sample: Sample) {
        this.selectedSlide = slide;
        this.selectedSample = sample;
        this.selectedMeta = null;
        this.viewerReady = false;
        this.error = null;
        this.annotations = [];
        this.annotationTooltip = null;
        // Bump the sequence so any in-flight mountOSD call can detect it's stale.
        const seq = ++this.mountSeq;
        await this.mountOSD(slide, seq);
        // Load annotations for the new slide (fires after OSD is mounted but before 'open').
        void this.loadAnnotations(slide.image_id);
        // NOTE: do NOT call writeHashState() here. mountOSD returns before the
        // OSD 'open' event fires, so the viewport has no tile source yet and
        // contentSize defaults to 1×1.  Writing at this point would clobber any
        // incoming shared-link hash with garbage coordinates (x≈1, y≈1, z=1).
        // The 'open' handler writes the hash once the viewport is fully ready.
    }

    // ---- OpenSeadragon ----

    /** Navigate to image-pixel coordinates entered in the coordinate bar. */
    @action.bound
    goToCoordinates() {
        if (!this.osdViewer) return;
        const x = parseInt(this.coordInputX, 10);
        const y = parseInt(this.coordInputY, 10);
        if (!isFinite(x) || !isFinite(y)) return;
        const imgPoint = new (OpenSeadragon as any).Point(x, y);
        const vpPoint = this.osdViewer.viewport.imageToViewportCoordinates(imgPoint);
        this.osdViewer.viewport.panTo(vpPoint, false);
    }

    /** Download the current viewport as a JPEG image. */
    downloadView() {
        // OSD renders into drawer.canvas (CanvasDrawer) or a WebGL canvas.
        const canvas: HTMLCanvasElement | null =
            this.osdViewer?.drawer?.canvas ??
            this.osdViewer?.canvas ??
            null;
        if (!canvas) return;

        try {
            const vp = this.osdViewer.viewport;
            const center = vp.viewportToImageCoordinates(vp.getCenter());
            const x = Math.round(center.x);
            const y = Math.round(center.y);
            const patientId = this.hierarchy?.patient_id ?? 'patient';
            const slideId = this.selectedSlide?.image_id ?? 'slide';
            const filename = `wsi-${patientId}-${slideId}-x${x}-y${y}.jpg`;

            canvas.toBlob(blob => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 'image/jpeg', 0.92);
        } catch (_) { /* canvas tainted or not ready */ }
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
            (h as Record<string, string>)['Authorization'] = `Bearer ${this.props.authToken}`;
        }
        return h;
    }

    /** Load annotations for the given slide from the annotation API. */
    @action.bound
    private async loadAnnotations(slideId: string) {
        const apiBase = this.annotationApiBase;
        if (!apiBase) return;
        const studyId = this.props.studyId ?? '';
        action(() => { this.annotationsLoading = true; })();
        try {
            const resp = await fetch(
                `${apiBase}/annotations?slide_id=${encodeURIComponent(slideId)}&study_id=${encodeURIComponent(studyId)}`,
                { headers: this.annotationFetchHeaders() }
            );
            if (!resp.ok) throw new Error(`${resp.status}`);
            const raw: any[] = await resp.json();
            // Convert API response to W3CAnnotation shape for Annotorious.
            // Color derives from body.type (encoded as "name|#hex"); layer from body.comment.
            const anns: W3CAnnotation[] = raw.map((item: any) => {
                const { name: colorName, hex: color } = parseColorLabel(item.body?.type);
                const layerName: string = item.body?.comment || DEFAULT_LAYER_NAME;
                return {
                    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                    type: 'Annotation' as const,
                    id: item.id,
                    body: item.body?.label
                        ? [{ type: 'TextualBody' as const, value: item.body.label, purpose: 'commenting' as const }]
                        : [],
                    target: { source: slideId, selector: item.target?.selector ?? item.target },
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
                this.annotationColorMap.set(ann.id, ann.color ?? DEFAULT_NAMED_COLORS[0].hex);
            }
            // namedColors is @computed from this.annotations — just update annotations and it auto-updates.
            action(() => {
                this.annotations = anns;
                this.annotationsLoading = false;
            })();
            if (this.annotorious) {
                this.annotorious.setAnnotations(anns);
                this.refreshAnnotoriousStyle();
            }
        } catch (e) {
            action(() => { this.annotationsLoading = false; })();
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
                body: { label: ann.body?.[0]?.value ?? '', comment: (ann as any).layerName ?? DEFAULT_LAYER_NAME, type: serializeColorLabel(ann.colorName ?? '', ann.color ?? DEFAULT_NAMED_COLORS[0].hex) },
                target: { selector: (ann.target as any).selector ?? ann.target },
                visible_to: [],
            };
            const resp = await fetch(`${apiBase}/annotations`, {
                method: 'POST',
                headers: this.annotationFetchHeaders(),
                body: JSON.stringify(body),
            });
            if (!resp.ok) throw new Error(`${resp.status}`);
            const created = await resp.json();
            const savedAnn = { ...ann, id: created.id, version: created.version };
            this.annotationColorMap.set(savedAnn.id, savedAnn.color ?? DEFAULT_NAMED_COLORS[0].hex);
            // Swap the temp-ID annotation for the server-assigned ID in Annotorious.
            if (this.annotorious && ann.id !== savedAnn.id) {
                try { this.annotorious.removeAnnotation(ann.id); } catch (_) { /* ignore */ }
                try { this.annotorious.addAnnotation(savedAnn); } catch (_) { /* ignore */ }
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
                body: { label: ann.body?.[0]?.value ?? '', comment: (ann as any).layerName ?? DEFAULT_LAYER_NAME, type: serializeColorLabel(ann.colorName ?? '', ann.color ?? DEFAULT_NAMED_COLORS[0].hex) },
                target: { selector: (ann.target as any).selector ?? ann.target },
                version: ann.version ?? 1,
            };
            const resp = await fetch(`${apiBase}/annotations/${encodeURIComponent(ann.id)}`, {
                method: 'PUT',
                headers: this.annotationFetchHeaders(),
                body: JSON.stringify(body),
            });
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
            const resp = await fetch(`${apiBase}/annotations/${encodeURIComponent(annId)}`, {
                method: 'DELETE',
                headers: this.annotationFetchHeaders(),
            });
            if (!resp.ok && resp.status !== 404) throw new Error(`${resp.status}`);
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
    setDrawingTool(tool: 'rectangle' | 'ellipse' | 'circle' | 'line' | 'polygon' | null) {
        if (!this.annotorious) {
            return;
        }
        if (tool === null || tool === this.activeDrawingTool) {
            // Cancel any active drawing and deactivate.
            try { this.annotorious.cancelDrawing(); } catch (_) { /* ignore */ }
            this.annotorious.setDrawingEnabled(false);
            // Re-enable Annotorious for viewing/selecting annotations
            if (this.annotorious.setEnabled) {
                this.annotorious.setEnabled(true);
            }
            // Re-enable pointer-events on Annotorious canvas overlay
            if (this.osdViewer) {
                const annoCanvas = this.osdViewer.element.querySelector('canvas.a9s-gl-canvas');
                if (annoCanvas && annoCanvas instanceof HTMLElement) {
                    annoCanvas.style.pointerEvents = 'auto';
                }
            }
            this.activeDrawingTool = null;
            this.customDrawState = null;
        } else if (tool === 'ellipse' || tool === 'circle' || tool === 'line') {
            // Annotorious doesn't bundle these shapes as drawing tools.
            // Custom pointer event handlers take over (see mountOSD).
            try { this.annotorious.cancelDrawing(); } catch (_) { /* ignore */ }
            this.annotorious.setDrawingEnabled(false);
            // Disable Annotorious so it doesn't intercept pointer events
            if (this.annotorious.setEnabled) {
                this.annotorious.setEnabled(false);
            }
            // Disable pointer-events on Annotorious canvas overlay
            if (this.customDrawTracker && 'disableAnnotoriousOverlay' in this.customDrawTracker) {
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
            this.annotorious.setDrawingMode(tool === 'polygon' ? 'click' : 'drag');
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
        const x1 = startImg.x, y1 = startImg.y;
        const x2 = currentImg.x, y2 = currentImg.y;

        let svgValue: string;
        if (tool === 'ellipse') {
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
            const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
            if (rx < 3 || ry < 3) return;
            svgValue = `<svg><ellipse cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" /></svg>`;
        } else if (tool === 'circle') {
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
            const r = Math.min(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 2;
            if (r < 3) return;
            svgValue = `<svg><circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" /></svg>`;
        } else {
            const len = Math.hypot(x2 - x1, y2 - y1);
            if (len < 3) return;
            svgValue = `<svg><line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" /></svg>`;
        }

        const id = `ann-custom-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const autoLabel = this.nextAutoLabel();
        const ann: W3CAnnotation = {
            id,
            type: 'Annotation',
            body: [{ type: 'TextualBody' as const, value: autoLabel, purpose: 'commenting' as const }],
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
        try { this.annotorious?.addAnnotation(ann); } catch (_) { /* ignore */ }

        void this.saveNewAnnotation(ann);
    }

    /**
     * Generate an auto-label for a new annotation.
     * Format: "{colorName} {N}" where N counts existing annotations with the same color name.
     */
    private nextAutoLabel(): string {
        const base = this.activeColorName.trim() || this.activeColorHex;
        const count = this.annotations.filter(a => (a.colorName ?? '') === this.activeColorName).length + 1;
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
        if (!ann) { this.cancelEditingLabel(); return; }
        const label = this.editingLabelText.trim();
        const updated: W3CAnnotation = {
            ...ann,
            body: label
                ? [{ type: 'TextualBody' as const, value: label, purpose: 'commenting' as const }]
                : [],
        };
        // Optimistically update local state.
        action(() => {
            this.annotations = this.annotations.map(a => a.id === id ? updated : a);
        })();
        void this.updateAnnotation(updated);
        // Also update the Annotorious overlay so the shape reflects the new body.
        try { this.annotorious?.updateAnnotation(updated); } catch (_) {}
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
        this.customColors = this.customColors.filter(c => !(c.hex === hex && c.name === name));
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
        if (next.has(name)) next.delete(name); else next.add(name);
        this.hiddenLayerNames = next;
        this.applyLayerFilter();
        // Deselect any annotation whose layer is now hidden — a hidden annotation
        // should not remain in a selected/editable state on the canvas.
        if (next.has(name) && this.annotorious) {
            const selected = this.annotorious.getSelected();
            const hasHiddenSelected = selected.some(
                (ann: any) => (ann.layerName ?? DEFAULT_LAYER_NAME) === name
            );
            if (hasHiddenSelected) this.annotorious.cancelSelected();
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
            try { this.annotorious.destroy(); } catch (_) { /* ignore */ }
            this.annotorious = null;
        }
        if (this.customDrawTracker) {
            try { this.customDrawTracker.destroy(); } catch (_) { /* ignore */ }
            this.customDrawTracker = null;
        }
        if (this.osdMouseTracker) {
            try { this.osdMouseTracker.destroy(); } catch (_) { /* ignore */ }
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
        action(() => { this.cursorPos = null; })();
    }

    private async mountOSD(slide: Slide, seq: number) {
        // Use prefetched metadata if available, otherwise fetch now
        let meta = this.metaCache.get(slide.image_id);
        if (!meta) {
            const metaUrl = `${this.tileServerBase}/tiles/${encodeURIComponent(slide.image_id)}/metadata`;
            try {
                const resp = await fetch(metaUrl);
                if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
                meta = await resp.json() as TileMetadata;
                this.metaCache.set(slide.image_id, meta);
            } catch (err) {
                if (seq !== this.mountSeq) return; // superseded
                // eslint-disable-next-line no-console
                console.error('[WSIViewer] metadata fetch failed', err);
                action(() => { this.error = `Failed to load slide metadata: ${err}`; })();
                return;
            }
        }

        // Bail if a newer selectSlide call has started while we were fetching.
        if (seq !== this.mountSeq) return;

        action(() => { this.selectedMeta = meta!; })();

        // Two animation frames: first lets MobX/React commit, second
        // confirms layout dimensions are set on the container div.
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

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
                showNavigator: true,
                navigatorPosition: 'BOTTOM_RIGHT',
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
            action(() => { this.error = `OSD init error: ${err}`; })();
            return;
        }

        if (seq !== this.mountSeq) {
            this.destroyViewer();
            return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.osdViewer.addOnceHandler('open', () => {
            if (seq !== this.mountSeq) return;
            action(() => { this.viewerReady = true; })();

            // Create custom drawing handlers using POINTER EVENTS (not mouse events!)
            // Annotorious uses the Pointer Events API
            const osdForDraw = this.osdViewer;
            const container = osdForDraw.element;
            const canvas = osdForDraw.canvas;
            
            const handlePointerDown = action((e: PointerEvent) => {
                const tool = this.activeDrawingTool;
                if (tool !== 'ellipse' && tool !== 'circle' && tool !== 'line') return;
                
                const rect = canvas.getBoundingClientRect();
                const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                const vpPoint = osdForDraw.viewport.pointFromPixel(new (OpenSeadragon as any).Point(px.x, px.y));
                const imgPoint = osdForDraw.viewport.viewportToImageCoordinates(vpPoint);
                
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
                const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                const vpPoint = osdForDraw.viewport.pointFromPixel(new (OpenSeadragon as any).Point(px.x, px.y));
                const imgPoint = osdForDraw.viewport.viewportToImageCoordinates(vpPoint);
                
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
            
            container.addEventListener('pointerdown', handlePointerDown as EventListener, { capture: true });
            container.addEventListener('pointermove', handlePointerMove as EventListener, { capture: true });
            container.addEventListener('pointerup', handlePointerUp as EventListener, { capture: true });
            
            // Disable pointer-events on Annotorious canvas overlay when custom tools are active
            const disableAnnotoriousCanvasPointerEvents = () => {
                const annoCanvas = container.querySelector('canvas.a9s-gl-canvas');
                if (annoCanvas && annoCanvas instanceof HTMLElement) {
                    annoCanvas.style.pointerEvents = 'none';
                }
            };
            
            // Store cleanup function
            this.customDrawTracker = {
                destroy: () => {
                    container.removeEventListener('pointerdown', handlePointerDown as EventListener, { capture: true });
                    container.removeEventListener('pointermove', handlePointerMove as EventListener, { capture: true });
                    container.removeEventListener('pointerup', handlePointerUp as EventListener, { capture: true });
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
                        adapter: W3CImageFormat(this.selectedSlide?.image_id ?? ''),
                    });

                    this.annotorious.on('createAnnotation', (ann: W3CAnnotation) => {
                        // Stamp color, layer, and auto-generate a sequential label, then save immediately.
                        ann.colorName = this.activeColorName;
                        ann.color = this.activeColorHex;
                        (ann as any).layerName = this.activeLayerName;
                        this.annotationColorMap.set(ann.id, ann.color);
                        const autoLabel = this.nextAutoLabel();
                        ann.body = [{ type: 'TextualBody' as const, value: autoLabel, purpose: 'commenting' as const }];
                        action(() => { this.activeDrawingTool = null; })();
                        this.annotorious.setDrawingEnabled(false);
                        this.refreshAnnotoriousStyle();
                        void this.saveNewAnnotation(ann);
                    });
                    this.annotorious.on('updateAnnotation', (ann: W3CAnnotation) => {
                        void this.updateAnnotation(ann);
                    });
                    this.annotorious.on('deleteAnnotation', (ann: W3CAnnotation) => {
                        void this.deleteAnnotation(ann.id);
                    });
                    this.annotorious.on('clickAnnotation', (ann: W3CAnnotation, originalEvent: MouseEvent) => {
                        const label = ann.body?.[0]?.value ?? '';
                        if (label) {
                            action(() => {
                                this.annotationTooltip = {
                                    x: originalEvent.clientX,
                                    y: originalEvent.clientY,
                                    text: label,
                                };
                            })();
                        }
                    });

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
                    const imgPt = new (OpenSeadragon as any).Point(hashState.x, hashState.y);
                    const vpPt = vp.imageToViewportCoordinates(imgPt);
                    vp.panTo(vpPt, true);   // immediately (no animation)
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
            } catch (_) { /* ignore — viewport not ready */ }

            // Register ongoing hash write AFTER the initial viewport setup so that
            // OSD's own initial-fit animation-finish event (if any) doesn't
            // overwrite the shared-link coordinates before we restore them.
            this.osdViewer.addHandler('animation-finish', () => {
                this.writeHashState();
            });
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.osdViewer.addOnceHandler('open-failed', (e: any) => {
            if (seq !== this.mountSeq) return;
            // eslint-disable-next-line no-console
            console.error('[WSIViewer] OSD open-failed', e);
            action(() => {
                this.error = `OSD open failed: ${e?.message ?? JSON.stringify(e)}`;
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
                    const vpPoint = viewer.viewport.pointFromPixel(event.position);
                    const imgPoint = viewer.viewport.viewportToImageCoordinates(vpPoint);
                    this.cursorPos = { x: Math.round(imgPoint.x), y: Math.round(imgPoint.y) };
                } catch (_) { /* ignore during init */ }
            }),
            exitHandler: action(() => { this.cursorPos = null; }),
        });
    }

    // ---- render ----

    render() {
        const { height } = this.props;
        const { loading, error, hierarchy, selectedSlide, selectedSample, selectedMeta, stainFilter } = this;

        if (loading) {
            return (
                <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <LoadingIndicator isLoading={true} center={true} size="big" />
                </div>
            );
        }

        if (error || !hierarchy) {
            return (
                <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c00' }}>
                    {error || 'No data'}
                </div>
            );
        }

        return (
            <div style={{ display: 'flex', height, overflow: 'hidden', fontFamily: '"Helvetica Neue",Helvetica,Arial,sans-serif', fontSize: 13, color: C.text }}>
                {/* Left nav panel */}
                <NavPanel
                    hierarchy={hierarchy}
                    selectedSlide={selectedSlide}
                    stainFilter={stainFilter}
                    onFilterChange={action((f: 'all'|'hne'|'ihc') => { this.stainFilter = f; })}
                    onSelectSlide={(slide, sample) => this.selectSlide(slide, sample)}
                />

                {/* OSD viewer */}
                <div style={{ flex: 1, position: 'relative', background: '#e8e8e8' }}>
                    <div ref={this.viewerContainerRef} style={{ width: '100%', height: '100%' }} />
                    {/* SVG overlay: live preview while drawing ellipse / circle / line */}
                    {this.customDrawState && (() => {
                        const s = this.customDrawState!;
                        const x1 = s.startPx.x, y1 = s.startPx.y;
                        const x2 = s.currentPx.x, y2 = s.currentPx.y;
                        const stroke = this.activeColorHex;
                        let shapeEl: React.ReactNode;
                        if (s.tool === 'ellipse') {
                            shapeEl = <ellipse cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} rx={Math.abs(x2 - x1) / 2} ry={Math.abs(y2 - y1) / 2} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray="6 3" />;
                        } else if (s.tool === 'circle') {
                            shapeEl = <circle cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} r={Math.min(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 2} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray="6 3" />;
                        } else {
                            shapeEl = <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={2} strokeDasharray="6 3" />;
                        }
                        return (
                            <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 10 }}>
                                {shapeEl}
                            </svg>
                        );
                    })()}
                    {!this.viewerReady && selectedSlide && (
                        <div style={overlayStyle}>
                            <LoadingIndicator isLoading={true} center={true} size="big" />
                        </div>
                    )}
                    {!selectedSlide && (
                        <div style={overlayStyle}>
                            <span style={{ color: C.muted, fontSize: 13 }}>No servable slides for this patient</span>
                        </div>
                    )}
                    {this.viewerReady && !!this.annotationApiBase && this.annotationsVisible && (
                        <DrawToolbar
                            drawingTool={this.activeDrawingTool}
                            onSetDrawingTool={this.setDrawingTool}
                            namedColors={this.namedColors}
                            activeColorHex={this.activeColorHex}
                            activeColorName={this.activeColorName}
                            onSetActiveColor={this.setActiveColor}
                            onAddNamedColor={this.addNamedColor}
                            onRemoveNamedColor={this.removeNamedColor}
                            layerNames={this.layerNames}
                            activeLayerName={this.activeLayerName}
                            hiddenLayerNames={this.hiddenLayerNames}
                            onSetActiveLayer={this.setActiveLayer}
                            onAddLayer={this.addLayer}
                            onToggleLayerVisibility={this.toggleLayerVisibility}
                        />
                    )}
                    {this.viewerReady && (
                        <CoordBar
                            inputX={this.coordInputX}
                            inputY={this.coordInputY}
                            cursorPos={this.cursorPos}
                            mpp={selectedMeta?.mpp}
                            onChangeX={action((v: string) => { this.coordInputX = v; })}
                            onChangeY={action((v: string) => { this.coordInputY = v; })}
                            onGo={this.goToCoordinates}
                            onCopyLink={() => this.copyViewLink()}
                            onDownload={() => this.downloadView()}
                            annotationEnabled={!!this.annotationApiBase}
                            annotationsVisible={this.annotationsVisible}
                            onToggleAnnotations={this.toggleAnnotationsVisible}
                        />
                    )}
                    {this.annotationTooltip && (
                        <div
                            onClick={action(() => { this.annotationTooltip = null; })}
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
                    onDeleteAnnotation={(id) => { void this.deleteAnnotation(id); if (this.annotorious) this.annotorious.removeAnnotation(id); }}
                    editingAnnotationId={this.editingAnnotationId}
                    editingLabelText={this.editingLabelText}
                    onStartEditAnnotation={this.startEditingLabel}
                    onChangeEditLabel={action((v: string) => { this.editingLabelText = v; })}
                    onConfirmEditLabel={this.confirmEditingLabel}
                    onCancelEditLabel={this.cancelEditingLabel}
                    layerNames={this.layerNames}
                    hiddenLayerNames={this.hiddenLayerNames}
                    onToggleLayerVisibility={this.toggleLayerVisibility}
                />
            </div>
        );
    }
}

// ---- helpers ----

const overlayStyle: React.CSSProperties = {
    position: 'absolute', inset: 0, display: 'flex',
    alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
};

// ---- LabelPrompt ----

interface LabelPromptProps {
    labelText: string;
    onChangeLabel: (v: string) => void;
    onConfirm: () => void;
    onCancel: () => void;
}

/** Floating card that appears after drawing a shape to add an optional label before saving. */
export function LabelPrompt({ labelText, onChangeLabel, onConfirm, onCancel }: LabelPromptProps) {
    return (
        <div
            data-testid="annotation-label-prompt"
            style={{
                position: 'absolute', bottom: 42, left: '50%', transform: 'translateX(-50%)',
                background: '#fff', border: '1px solid #c2d9f5',
                borderRadius: 6, boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                padding: '10px 14px', zIndex: 50,
                display: 'flex', flexDirection: 'column', gap: 8, minWidth: 260,
            }}
        >
            <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Add a label (optional)</div>
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
                    fontSize: 12, padding: '4px 8px',
                    border: `1px solid ${C.blue}`, borderRadius: 4, outline: 'none',
                    width: '100%', boxSizing: 'border-box',
                }}
            />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                    onClick={onCancel}
                    title="Discard this annotation (Esc)"
                    style={{
                        fontSize: 11, padding: '3px 10px', borderRadius: 3,
                        border: `1px solid ${C.border}`, background: '#fff', color: C.muted, cursor: 'pointer',
                    }}
                >
                    Discard
                </button>
                <button
                    data-testid="annotation-label-save"
                    onClick={onConfirm}
                    title="Save annotation (Enter)"
                    style={{
                        fontSize: 11, padding: '3px 10px', borderRadius: 3,
                        border: `1px solid ${C.blue}`, background: C.blue, color: '#fff', cursor: 'pointer',
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
    inputX, inputY, cursorPos, mpp, onChangeX, onChangeY, onGo, onCopyLink, onDownload,
    annotationEnabled, annotationsVisible, onToggleAnnotations,
}: CoordBarProps) {
    const handleKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') onGo(); };
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
        width: 72, padding: '2px 5px', fontSize: 11, border: `1px solid ${C.border}`,
        borderRadius: 3, background: '#fff', color: C.text, outline: 'none',
    };

    const btnStyle: React.CSSProperties = {
        padding: '2px 9px', fontSize: 11, cursor: 'pointer',
        borderRadius: 3, lineHeight: '18px',
    };

    return (
        <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px',
            background: 'rgba(250,250,250,0.92)',
            borderTop: `1px solid ${C.border}`,
            fontSize: 11, color: C.muted,
            backdropFilter: 'blur(2px)',
            zIndex: 10,
        }}>
            <span style={{ fontWeight: 600, color: C.text, marginRight: 2 }}>Go to:</span>
            <span style={{ color: C.muted }}>X</span>
            <input
                type="number"
                value={inputX}
                placeholder="px"
                style={inputStyle}
                onChange={e => onChangeX(e.target.value)}
                onKeyDown={handleKey}
            />
            <span style={{ color: C.muted }}>Y</span>
            <input
                type="number"
                value={inputY}
                placeholder="px"
                style={inputStyle}
                onChange={e => onChangeY(e.target.value)}
                onKeyDown={handleKey}
            />
            <button
                onClick={onGo}
                style={{ ...btnStyle, border: `1px solid ${C.blue}`, background: C.blue, color: '#fff' }}
            >
                Go
            </button>
            <button
                onClick={handleCopy}
                title="Copy a link to this exact view (slide, position, zoom)"
                style={{
                    ...btnStyle,
                    border: `1px solid ${copied ? '#3a8a3a' : C.border}`,
                    background: copied ? '#edfaed' : '#fff',
                    color: copied ? '#3a8a3a' : C.muted,
                }}
            >
                {copied ? '✓ Copied' : '🔗 Share view'}
            </button>
            <button
                onClick={onDownload}
                title="Download the current viewport as a JPEG image"
                style={{
                    ...btnStyle,
                    border: `1px solid ${C.border}`,
                    background: '#fff',
                    color: C.muted,
                }}
            >
                ⬇ Download
            </button>
            {annotationEnabled && (
                <button
                    onClick={onToggleAnnotations}
                    title={annotationsVisible ? 'Hide annotations' : 'Show annotations'}
                    style={{
                        ...btnStyle,
                        border: `1px solid ${annotationsVisible ? C.blue : C.border}`,
                        background: annotationsVisible ? '#e8f2ff' : '#fff',
                        color: annotationsVisible ? C.blue : C.muted,
                    }}
                >
                    {annotationsVisible ? '🔵 Annotations' : '○ Annotations'}
                </button>
            )}
            {cursorPos && (
                <span style={{ marginLeft: 'auto', color: C.muted, fontFamily: 'monospace', fontSize: 11 }}>
                    📍 {cursorLabel}
                </span>
            )}
        </div>
    );
}

function cleanStain(name: string): string {
    return (name || '').replace(/^DM\s+/i, '') || '—';
}

function fmtMB(bytes: string | number | null | undefined): string {
    const n = Number(bytes);
    if (!n) return '—';
    return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(0) + ' MB';
}

const BLOCK_LABEL_TIP =
    'Block label: number = block within case; T\u202f=\u202ftumor, N\u202f=\u202funinvolved, L\u202f=\u202flymph node';


// ---- NavPanel ----

interface NavPanelProps {
    hierarchy: PatientHierarchy;
    selectedSlide: Slide | null;
    stainFilter: 'all' | 'hne' | 'ihc';
    onFilterChange: (f: 'all' | 'hne' | 'ihc') => void;
    onSelectSlide: (slide: Slide, sample: Sample) => void;
}

function NavPanel({ hierarchy, selectedSlide, stainFilter, onFilterChange, onSelectSlide }: NavPanelProps) {
    const chips: Array<{ key: 'all' | 'hne' | 'ihc'; label: string; color?: string }> = [
        { key: 'all', label: 'All' },
        { key: 'hne', label: '● H&E', color: C.blue },
        { key: 'ihc', label: '● IHC', color: C.orange },
    ];

    return (
        <div style={{
            width: NAV_W, minWidth: NAV_W, display: 'flex', flexDirection: 'column',
            background: C.navBg, borderRight: `1px solid ${C.border}`, overflow: 'hidden',
        }}>
            {/* Header */}
            <div style={{ padding: '9px 12px 7px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.8px' }}>
                    Slides
                </div>
                <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
                    {chips.map(chip => (
                        <span
                            key={chip.key}
                            onClick={() => onFilterChange(chip.key)}
                            style={{
                                fontSize: 11, padding: '2px 8px', borderRadius: 10,
                                border: `1px solid ${stainFilter === chip.key ? '#c2d9f5' : C.border}`,
                                background: stainFilter === chip.key ? C.blueLight : '#fff',
                                color: stainFilter === chip.key ? C.blue : (chip.color || C.muted),
                                fontWeight: stainFilter === chip.key ? 600 : 400,
                                cursor: 'pointer', userSelect: 'none',
                            }}
                        >
                            {chip.label}
                        </span>
                    ))}
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

function SampleNode({ sample, selectedSlide, stainFilter, onSelectSlide }: SampleNodeProps) {
    const [open, setOpen] = React.useState(true);

    const allSlides = sample.parts.flatMap(p => p.blocks.flatMap(b => b.slides));
    const totSlides = allSlides.length;
    const servableSlides = allSlides.filter(s => s.can_serve_tiles).length;

    const stLower = (sample.sample_type || '').toLowerCase();
    const stClass = stLower === 'primary' ? C.blue
        : (stLower.includes('metastas') || stLower === 'local recurrence') ? '#c05000'
        : C.muted;
    const stBg = stLower === 'primary' ? C.blueLight
        : (stLower.includes('metastas') || stLower === 'local recurrence') ? '#fef0e8'
        : '#f0f0f0';

    // Determine block badge visibility
    const DUMMY = new Set(['0', '']);
    const blockId = (b: { block_label: string; block_number: string }) =>
        (b.block_label || '').trim() || String(b.block_number ?? '');
    const allLabels = new Set(
        sample.parts.flatMap(p => p.blocks.map(b => {
            const l = blockId(b); return DUMMY.has(l) ? null : l;
        }).filter(Boolean))
    );
    const showBlock = allLabels.size > 1;

    // Flatten + sort slides
    const sortedSlides: Array<{ slide: Slide; badge: string | null }> = [];
    for (const part of sample.parts) {
        for (const b of part.blocks) {
            const lbl = blockId(b);
            const badge = (showBlock && !DUMMY.has(lbl)) ? lbl : null;
            for (const sl of b.slides) sortedSlides.push({ slide: sl, badge });
        }
    }
    // Sort purely chronologically by block_number
    sortedSlides.sort((a, b) => {
        const na = Number(a.slide.block_number) || 0;
        const nb = Number(b.slide.block_number) || 0;
        if (na !== nb) return na - nb;
        return (a.slide.stain_name || '').localeCompare(b.slide.stain_name || '');
    });

    return (
        <div style={{ borderBottom: `1px solid ${C.border}` }}>
            {/* Sample header */}
            <div
                onClick={() => setOpen(o => !o)}
                style={{
                    display: 'flex', alignItems: 'flex-start', gap: 6,
                    padding: '8px 12px 7px', cursor: 'pointer', userSelect: 'none',
                }}
            >
                <span style={{ fontSize: 10, color: C.muted, marginTop: 2, flexShrink: 0, width: 10 }}>
                    {open ? '▾' : '▸'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {sample.sample_id || '—'}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>
                        {sample.sample_type && (
                            <span style={{ display: 'inline-block', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', padding: '1px 5px', borderRadius: 3, background: stBg, color: stClass, marginRight: 4 }}>
                                {sample.sample_type}
                            </span>
                        )}
                        {sample.oncotree_code && (
                            <a
                                href="https://oncotree.mskcc.org/"
                                target="_blank" rel="noopener noreferrer"
                                title={`${sample.oncotree_code}${sample.cancer_type_detailed ? ` — ${sample.cancer_type_detailed}` : ''}\nView OncoTree`}
                                onClick={e => e.stopPropagation()}
                                style={{ display: 'inline-block', background: '#f0f0f0', border: `1px solid ${C.border}`, borderRadius: 3, fontSize: 9, fontWeight: 700, padding: '0 4px', color: C.text, marginRight: 4, textDecoration: 'none' }}
                            >
                                {sample.oncotree_code}
                            </a>
                        )}
                        {sample.cancer_type_detailed || sample.cancer_type || ''}
                    </div>
                    {sample.primary_site && (
                        <div style={{ fontSize: 10, color: '#aaa' }}>{sample.primary_site}</div>
                    )}
                </div>
                <div title="Tile-servable slides / total slides" style={{ fontSize: 9, color: '#bbb', flexShrink: 0, textAlign: 'right', lineHeight: 1.4, cursor: 'help' }}>
                    <span style={{ color: C.blue, fontWeight: 600 }}>{servableSlides}</span>/{totSlides}
                </div>
            </div>

            {/* Slide list */}
            {open && (
                <div style={{ paddingBottom: 4 }}>
                    {sortedSlides.map(({ slide, badge }) => {
                        const dc = slide.is_hne ? 'hne' : (slide.is_ihc ? 'ihc' : 'other');
                        const visible = stainFilter === 'all' || dc === stainFilter;
                        if (!visible) return null;
                        return (
                            <SlideItem
                                key={slide.image_id}
                                slide={slide}
                                sample={sample}
                                blockBadge={badge}
                                selected={selectedSlide?.image_id === slide.image_id}
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
    blockBadge: string | null;
    selected: boolean;
    onSelectSlide: (slide: Slide, sample: Sample) => void;
}

function SlideItem({ slide, sample, blockBadge, selected, onSelectSlide }: SlideItemProps) {
    const [hovered, setHovered] = React.useState(false);
    const dc = slide.is_hne ? 'hne' : (slide.is_ihc ? 'ihc' : 'other');
    const dotColor = dc === 'hne' ? C.blue : (dc === 'ihc' ? C.orange : '#aaa');
    const mag = slide.magnification || '';
    const sz = fmtMB(slide.file_size_bytes);

    const bg = selected ? C.blueLight : hovered ? C.blueLight : 'transparent';
    const borderLeft = selected ? `2px solid ${C.blue}` : '2px solid transparent';

    return (
        <div
            onClick={() => slide.can_serve_tiles && onSelectSlide(slide, sample)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            title={slide.can_serve_tiles ? undefined : 'Tiles not yet available'}
            style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 10px 4px 8px', margin: '1px 4px',
                borderRadius: 3, borderLeft,
                background: bg,
                cursor: slide.can_serve_tiles ? 'pointer' : 'help',
                opacity: slide.can_serve_tiles ? 1 : 0.55,
            }}
        >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0, display: 'inline-block' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {cleanStain(slide.stain_name)}
                    {blockBadge && (
                        <span title={BLOCK_LABEL_TIP} style={{ fontSize: 9, color: C.muted, background: '#f0f0f0', borderRadius: 3, padding: '0 4px', marginLeft: 4 }}>
                            {blockBadge}
                        </span>
                    )}
                </div>
                <div style={{ fontSize: 9, color: C.muted, whiteSpace: 'nowrap' }}>
                    {mag && <span title="Objective lens magnification">{mag} · </span>}
                    <span title="File size on disk">{sz}</span>
                    {slide.can_serve_tiles ? '' : ' · no tiles'}
                </div>
            </div>
        </div>
    );
}

// ---- MetaSidebar ----

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
}

export function MetaSidebar({ slide, sample, meta, tileServerBase, studyId, annotations = [], annotationsLoading = false, annotationEnabled = false, onDeleteAnnotation, editingAnnotationId, editingLabelText = '', onStartEditAnnotation, onChangeEditLabel, onConfirmEditLabel, onCancelEditLabel, layerNames = [], hiddenLayerNames = new Set(), onToggleLayerVisibility }: MetaSidebarProps) {
    const thumbSrc = slide ? `${tileServerBase}/tiles/${encodeURIComponent(slide.image_id)}/thumbnail` : null;

    return (
        <div style={{
            width: SIDEBAR_W, minWidth: SIDEBAR_W, background: C.sidebarBg,
            borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column',
            overflowY: 'auto', flexShrink: 0,
        }}>
            {/* Thumbnail */}
            <SbSection title="Thumbnail">
                <div style={{
                    background: '#fff', border: `1px solid ${C.border}`, borderRadius: 3,
                    overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    minHeight: 90, marginTop: 8,
                }}>
                    {thumbSrc ? (
                        <img
                            key={thumbSrc}
                            src={thumbSrc}
                            alt="slide thumbnail"
                            style={{ maxWidth: '100%', maxHeight: 160, display: 'block' }}
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                    ) : (
                        <span style={{ color: '#bbb', fontSize: 11, padding: 20, textAlign: 'center' }}>No slide selected</span>
                    )}
                </div>
            </SbSection>

            {/* Image Properties */}
            <SbSection title="Image Properties">
                {meta ? (
                    <MetaTable rows={buildWsiRows(slide, meta)} />
                ) : (
                    <span style={{ color: '#bbb', fontSize: 11 }}>—</span>
                )}
            </SbSection>

            {/* Pathology */}
            <SbSection title="Pathology">
                {slide && sample ? (
                    <MetaTable rows={buildPathRows(slide, sample, studyId)} />
                ) : (
                    <span style={{ color: '#bbb', fontSize: 11 }}>—</span>
                )}
            </SbSection>

            {/* Layers panel */}
            {annotationEnabled && layerNames.length > 0 && (
                <SbSection title="Layers">
                    <div style={{ marginTop: 6 }}>
                        {layerNames.map(name => {
                            const isHidden = hiddenLayerNames.has(name);
                            const count = annotations.filter(a => ((a as any).layerName ?? DEFAULT_LAYER_NAME) === name).length;
                            return (
                                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0' }}>
                                    <button
                                        data-testid={`sidebar-layer-toggle-${name}`}
                                        onClick={() => onToggleLayerVisibility?.(name)}
                                        title={isHidden ? `Show layer "${name}"` : `Hide layer "${name}"`}
                                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, padding: '0 2px', color: isHidden ? '#e74c3c' : C.blue, lineHeight: 1 }}
                                    >
                                        {isHidden ? '○' : '●'}
                                    </button>
                                    <span style={{ fontSize: 12, color: isHidden ? C.muted : C.text, flex: 1, textDecoration: isHidden ? 'line-through' : 'none' }}>
                                        {name}
                                    </span>
                                    <span style={{ fontSize: 10, color: C.muted }}>{count}</span>
                                </div>
                            );
                        })}
                    </div>
                </SbSection>
            )}

            {/* Annotations panel */}
            {annotationEnabled && (
                <SbSection title={`Annotations (${annotations.length})`}>
                    {annotationsLoading ? (
                        <span style={{ color: '#bbb', fontSize: 11 }}>Loading…</span>
                    ) : annotations.length === 0 ? (
                        <span style={{ color: '#bbb', fontSize: 11 }}>No annotations yet. Draw on the slide to create one.</span>
                    ) : (
                        <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 6 }}>
                            {annotations.map(ann => {
                                const rawLabel = ann.body?.[0]?.value ?? '';
                                const displayLabel = rawLabel || '(unlabeled)';
                                const rawCreator = (ann as any).creator;
                                const creator = typeof rawCreator === 'string'
                                    ? rawCreator
                                    : (rawCreator?.id ?? rawCreator?.name ?? '');
                                const created = (ann as any).created ?? '';
                                const dateStr = created ? new Date(created).toLocaleDateString() : '';
                                const dotColor = ann.color ?? DEFAULT_NAMED_COLORS[0].hex;
                                const colorName = ann.colorName ?? '';
                                const annLayerName: string = (ann as any).layerName ?? DEFAULT_LAYER_NAME;
                                const isEditing = editingAnnotationId === ann.id;
                                return (
                                    <div key={ann.id} style={{
                                        padding: '4px 0', borderBottom: `1px solid ${C.border}`,
                                        display: 'flex', alignItems: 'flex-start', gap: 4,
                                    }}>
                                        {/* Colored dot */}
                                        <span
                                            data-annotation-color={dotColor}
                                            data-annotation-layer={annLayerName}
                                            title={colorName || 'No color name'}
                                            style={{
                                                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                                background: dotColor, flexShrink: 0, marginTop: 4,
                                            }}
                                        />
                                        <div style={{ flex: 1, overflow: 'hidden' }}>
                                            {isEditing ? (
                                                <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                                                    <input
                                                        data-testid="annotation-label-edit-input"
                                                        autoFocus
                                                        type="text"
                                                        maxLength={200}
                                                        value={editingLabelText}
                                                        onChange={e => onChangeEditLabel?.(e.target.value)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') onConfirmEditLabel?.();
                                                            if (e.key === 'Escape') onCancelEditLabel?.();
                                                        }}
                                                        style={{
                                                            flex: 1, fontSize: 11, padding: '1px 4px',
                                                            border: `1px solid ${C.blue}`, borderRadius: 3, outline: 'none',
                                                        }}
                                                    />
                                                    <button
                                                        onClick={onConfirmEditLabel}
                                                        title="Save label (Enter)"
                                                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#2a7a2a', fontSize: 12, padding: '0 2px' }}
                                                    >✓</button>
                                                    <button
                                                        onClick={onCancelEditLabel}
                                                        title="Cancel (Esc)"
                                                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.muted, fontSize: 12, padding: '0 2px' }}
                                                    >✕</button>
                                                </div>
                                            ) : (
                                                <>
                                                    <div style={{ fontSize: 12, fontWeight: 500, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={displayLabel}>
                                                        {displayLabel}
                                                    </div>
                                                    <div style={{ display: 'flex', gap: 3, marginTop: 1, flexWrap: 'wrap' }}>
                                                        {annLayerName && (
                                                            <span style={{
                                                                fontSize: 9, fontWeight: 600, padding: '0 4px', borderRadius: 8,
                                                                background: '#e8e8e8', color: '#555', display: 'inline-block',
                                                            }}>
                                                                {annLayerName}
                                                            </span>
                                                        )}
                                                        {colorName && (
                                                            <span style={{
                                                                fontSize: 9, fontWeight: 600, padding: '0 4px', borderRadius: 8,
                                                                background: dotColor, color: '#fff', display: 'inline-block',
                                                            }}>
                                                                {colorName}
                                                            </span>
                                                        )}
                                                    </div>
                                                </>
                                            )}
                                            {!isEditing && (creator || dateStr) && (
                                                <div style={{ fontSize: 10, color: C.muted }}>
                                                    {creator}{creator && dateStr ? ' · ' : ''}{dateStr}
                                                </div>
                                            )}
                                        </div>
                                        {!isEditing && onStartEditAnnotation && (
                                            <button
                                                onClick={() => onStartEditAnnotation(ann.id, rawLabel)}
                                                title="Edit label"
                                                data-testid={`edit-label-${ann.id}`}
                                                style={{
                                                    border: 'none', background: 'transparent',
                                                    cursor: 'pointer', color: C.muted, fontSize: 12, padding: '0 2px',
                                                    flexShrink: 0,
                                                }}
                                            >
                                                ✎
                                            </button>
                                        )}
                                        {onDeleteAnnotation && (
                                            <button
                                                onClick={() => onDeleteAnnotation(ann.id)}
                                                title="Delete annotation"
                                                style={{
                                                    border: 'none', background: 'transparent',
                                                    cursor: 'pointer', color: '#c0392b', fontSize: 13, padding: '0 2px',
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
        </div>
    );
}

// ---- DrawToolbar ----
// Second toolbar row rendered below CoordBar; shown only when annotations are active.

export type DrawingToolId = 'rectangle' | 'ellipse' | 'circle' | 'line' | 'polygon';

const DRAW_TOOLS: { id: DrawingToolId; label: string; icon: string; hint: string }[] = [
    { id: 'rectangle', icon: '◻', label: 'Rect',    hint: 'Draw a rectangle — click and drag on the slide' },
    { id: 'ellipse',   icon: '⬭', label: 'Ellipse', hint: 'Draw an ellipse — click and drag on the slide' },
    { id: 'circle',    icon: '○', label: 'Circle',  hint: 'Draw a circle — click and drag from center' },
    { id: 'line',      icon: '╱', label: 'Line',    hint: 'Draw a line — click and drag on the slide' },
    { id: 'polygon',   icon: '⬡', label: 'Poly',    hint: 'Draw a polygon — click to add points, double-click to close' },
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
    layerNames: string[];
    activeLayerName: string;
    hiddenLayerNames: Set<string>;
    onSetActiveLayer: (name: string) => void;
    onAddLayer: (name: string) => void;
    onToggleLayerVisibility: (name: string) => void;
}

export function DrawToolbar({
    drawingTool, onSetDrawingTool,
    namedColors, activeColorHex, activeColorName,
    onSetActiveColor, onAddNamedColor, onRemoveNamedColor,
    layerNames, activeLayerName, hiddenLayerNames,
    onSetActiveLayer, onAddLayer, onToggleLayerVisibility,
}: DrawToolbarProps) {
    const [showAddColorForm, setShowAddColorForm] = React.useState(false);
    const [newHex, setNewHex] = React.useState('#ff0000');
    const [newColorName, setNewColorName] = React.useState('');
    const [showAddLayerForm, setShowAddLayerForm] = React.useState(false);
    const [newLayerName, setNewLayerName] = React.useState('');

    const handleAddColor = () => {
        if (newHex) onAddNamedColor(newColorName.trim() || newHex, newHex);
        setShowAddColorForm(false);
        setNewColorName('');
    };

    return (
        <div style={{
            position: 'absolute', bottom: 32, left: 0, right: 0,
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            padding: '4px 10px',
            background: 'rgba(250,250,250,0.92)',
            borderTop: `1px solid ${C.border}`,
            fontSize: 11, backdropFilter: 'blur(2px)', zIndex: 10,
        }}>
            {/* Draw shape buttons */}
            {DRAW_TOOLS.map(({ id, icon, label, hint }) => {
                const isActive = drawingTool === id;
                return (
                    <button key={id}
                        onClick={() => onSetDrawingTool(isActive ? null : id)}
                        title={isActive ? 'Cancel drawing (Esc)' : hint}
                        style={{
                            padding: '2px 9px', fontSize: 11, cursor: 'pointer', borderRadius: 3, lineHeight: '18px',
                            border: `1px solid ${isActive ? '#c0392b' : C.border}`,
                            background: isActive ? '#fde8e8' : '#fff',
                            color: isActive ? '#c0392b' : C.muted,
                            fontWeight: isActive ? 600 : 400,
                        }}
                    >
                        {isActive ? '✕ Cancel draw' : `${icon} ${label}`}
                    </button>
                );
            })}

            <span style={{ width: 1, height: 16, background: C.border, margin: '0 2px' }} />

            {/* Layer selector */}
            <span style={{ fontSize: 10, color: C.muted, whiteSpace: 'nowrap' }}>Layer:</span>
            {layerNames.map(name => {
                const isActive = activeLayerName === name;
                const isHidden = hiddenLayerNames.has(name);
                return (
                    <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                        <button
                            data-testid={`layer-select-${name}`}
                            title={`Draw on layer "${name}"${isHidden ? ' (currently hidden)' : ''}`}
                            aria-pressed={isActive}
                            onClick={() => onSetActiveLayer(name)}
                            style={{
                                fontSize: 10, padding: '1px 7px', borderRadius: 10, cursor: 'pointer',
                                background: isActive ? C.blue : '#fff',
                                color: isActive ? '#fff' : C.text,
                                border: `1.5px solid ${isActive ? C.blue : C.border}`,
                                fontWeight: isActive ? 700 : 400,
                                opacity: isHidden ? 0.45 : 1,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {name}
                        </button>
                        <button
                            data-testid={`layer-toggle-${name}`}
                            title={isHidden ? `Show layer "${name}"` : `Hide layer "${name}"`}
                            onClick={() => onToggleLayerVisibility(name)}
                            style={{ fontSize: 10, padding: '0 2px', border: 'none', background: 'transparent', cursor: 'pointer', color: isHidden ? '#e74c3c' : '#bbb', lineHeight: 1 }}
                        >
                            {isHidden ? '○' : '●'}
                        </button>
                    </span>
                );
            })}
            {!showAddLayerForm ? (
                <button
                    data-testid="add-layer-btn"
                    title="Add new annotation layer"
                    onClick={() => setShowAddLayerForm(true)}
                    style={{ fontSize: 12, padding: '0 5px', border: `1px dashed ${C.border}`, background: '#fff', color: C.muted, borderRadius: 10, cursor: 'pointer' }}
                >+</button>
            ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 5px', border: `1px solid ${C.border}`, borderRadius: 10, background: '#fff' }}>
                    <input
                        data-testid="add-layer-input"
                        type="text" value={newLayerName} placeholder="Layer name" maxLength={30} autoFocus
                        onChange={e => setNewLayerName(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') { onAddLayer(newLayerName); setShowAddLayerForm(false); setNewLayerName(''); }
                            if (e.key === 'Escape') { setShowAddLayerForm(false); setNewLayerName(''); }
                        }}
                        style={{ fontSize: 10, border: 'none', outline: 'none', width: 90, background: 'transparent', color: C.text }}
                    />
                    <button
                        data-testid="add-layer-confirm"
                        title="Add layer"
                        onClick={() => { onAddLayer(newLayerName); setShowAddLayerForm(false); setNewLayerName(''); }}
                        style={{ fontSize: 10, padding: '1px 5px', border: `1px solid ${C.blue}`, background: C.blue, color: '#fff', borderRadius: 8, cursor: 'pointer' }}
                    >Add</button>
                    <button title="Cancel" onClick={() => { setShowAddLayerForm(false); setNewLayerName(''); }}
                        style={{ fontSize: 10, padding: '1px 4px', border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer' }}
                    >✕</button>
                </span>
            )}

            <span style={{ width: 1, height: 16, background: C.border, margin: '0 2px' }} />

            {/* Color palette */}
            <span style={{ fontSize: 10, color: C.muted, whiteSpace: 'nowrap' }}>Color:</span>
            {namedColors.map(({ name, hex }) => {
                const isActive = activeColorHex === hex && activeColorName === name;
                return (
                    <span key={`${name}|${hex}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                        <button
                            title={`Color: ${name || hex}`}
                            aria-pressed={isActive}
                            onClick={() => onSetActiveColor(name, hex)}
                            style={{
                                fontSize: 10, padding: '1px 7px', borderRadius: 10, cursor: 'pointer',
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
                            style={{ fontSize: 8, padding: '0 2px', border: 'none', background: 'transparent', cursor: 'pointer', color: '#bbb', lineHeight: 1 }}
                        >×</button>
                    </span>
                );
            })}
            {!showAddColorForm ? (
                <button
                    title="Add new named color to palette"
                    onClick={() => setShowAddColorForm(true)}
                    style={{ fontSize: 12, padding: '0 5px', border: `1px dashed ${C.border}`, background: '#fff', color: C.muted, borderRadius: 10, cursor: 'pointer' }}
                >+</button>
            ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 5px', border: `1px solid ${C.border}`, borderRadius: 10, background: '#fff' }}>
                    <input type="color" value={newHex} title="Pick color" onChange={e => setNewHex(e.target.value)}
                        style={{ width: 20, height: 16, border: 'none', padding: 0, cursor: 'pointer', background: 'transparent' }} />
                    <input type="text" value={newColorName} placeholder="Name (optional)" maxLength={20} autoFocus
                        onChange={e => setNewColorName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAddColor(); if (e.key === 'Escape') setShowAddColorForm(false); }}
                        style={{ fontSize: 10, border: 'none', outline: 'none', width: 90, background: 'transparent', color: C.text }} />
                    <button title="Add color to palette" onClick={handleAddColor}
                        style={{ fontSize: 10, padding: '1px 5px', border: `1px solid ${C.blue}`, background: C.blue, color: '#fff', borderRadius: 8, cursor: 'pointer' }}
                    >Add</button>
                    <button title="Cancel" onClick={() => setShowAddColorForm(false)}
                        style={{ fontSize: 10, padding: '1px 4px', border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer' }}
                    >✕</button>
                </span>
            )}
        </div>
    );
}

function SbSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.8px' }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function MetaTable({ rows }: { rows: MetaRow[] }) {
    return (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
            <tbody>
                {rows.map(row => (
                    <tr key={row.label}>
                        <td title={row.labelTip} style={{
                            fontSize: 11, color: C.muted, width: '50%', paddingRight: 5, paddingTop: 2,
                            paddingBottom: 2, verticalAlign: 'top', lineHeight: 1.5,
                            cursor: row.labelTip ? 'help' : undefined,
                            borderBottom: row.labelTip ? `1px dotted ${C.border}` : undefined,
                        }}>
                            {row.label}
                        </td>
                        <td style={{ fontSize: 11, color: C.text, fontWeight: 500, wordBreak: 'break-word', verticalAlign: 'top', lineHeight: 1.5 }}>
                            {row.href ? (
                                <a href={row.href} target="_blank" rel="noopener noreferrer" style={{ color: C.blue, textDecoration: 'none' }}
                                   onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                                   onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}>
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
}

function buildWsiRows(slide: Slide | null, meta: TileMetadata): MetaRow[] {
    const w = meta.dimensions.width, h = meta.dimensions.height;
    const mppX = meta.mpp?.x || 0, mppY = meta.mpp?.y || 0;
    const mpp = (mppX && mppY) ? (mppX + mppY) / 2 : 0;
    const objNum = meta.objective_power || (mpp ? Math.round(10 / mpp) : 0);
    const rows: MetaRow[] = [
        { label: 'Dimensions', labelTip: 'Width × height in pixels at full resolution', value: `${w.toLocaleString()} × ${h.toLocaleString()} px` },
    ];
    if (mpp) rows.push({ label: 'MPP', labelTip: 'Microns per pixel — physical size of one pixel at full resolution', value: `${mpp.toFixed(4)} µm/px` });
    if (objNum) rows.push({ label: 'Objective', labelTip: 'Objective lens magnification used to capture the slide', value: `${objNum}×` });
    rows.push({ label: 'Zoom levels', labelTip: 'Number of resolution tiers in the pyramidal image', value: String(meta.max_zoom + 1) });
    rows.push({ label: 'Tile size', labelTip: 'Tile dimensions (px) streamed to the viewer', value: `${meta.tile_size} px` });
    if (slide?.file_size_bytes) rows.push({ label: 'File size', value: fmtMB(slide.file_size_bytes) });
    return rows;
}

function buildPathRows(slide: Slide, sample: Sample, studyId?: string): MetaRow[] {
    const stainBadge = slide.is_hne ? 'H&E' : (slide.is_ihc ? 'IHC' : '');
    const oncotreeUrl = sample.oncotree_code ? 'https://oncotree.mskcc.org/' : undefined;
    const sampleUrl = (studyId && sample.sample_id)
        ? `/patient?studyId=${encodeURIComponent(studyId)}&caseId=${encodeURIComponent(sample.sample_id.replace(/-T\d+.*$/i, ''))}&sampleId=${encodeURIComponent(sample.sample_id)}`
        : undefined;
    const rows: MetaRow[] = [
        { label: 'Stain', labelTip: 'Staining protocol used for this slide', value: stainBadge ? `${stainBadge} — ${cleanStain(slide.stain_name)}` : cleanStain(slide.stain_name) },
        { label: 'Sample', labelTip: 'Tumor sample identifier', value: sample.sample_id || '—', href: sampleUrl },
    ];
    if (sample.cancer_type_detailed || sample.cancer_type) rows.push({ label: 'Cancer type', value: sample.cancer_type_detailed || sample.cancer_type || '' });
    if (sample.oncotree_code) rows.push({ label: 'OncoTree', labelTip: 'OncoTree cancer classification code — click to view on oncotree.mskcc.org', value: sample.oncotree_code, href: oncotreeUrl });
    if (sample.primary_site) rows.push({ label: 'Primary site', value: sample.primary_site });
    if (slide.magnification) rows.push({ label: 'Magnification', labelTip: 'Objective lens magnification', value: slide.magnification });
    const blockLbl = (slide.block_label || '').trim() || (slide.block_number ? String(slide.block_number) : '');
    if (blockLbl) rows.push({ label: 'Block', labelTip: BLOCK_LABEL_TIP, value: blockLbl });
    return rows;
}

