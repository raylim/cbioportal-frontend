import * as React from 'react';
import { observer } from 'mobx-react';
import { observable, action, computed, makeObservable } from 'mobx';
import LoadingIndicator from 'shared/components/loadingIndicator/LoadingIndicator';
import * as OpenSeadragonLib from 'openseadragon';
import { createOSDAnnotator } from '@annotorious/openseadragon';
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

/** Preset annotation colors shown as swatches in the toolbar. */
export const ANNOTATION_COLORS = [
    { hex: '#3b82f6', label: 'Blue' },
    { hex: '#ef4444', label: 'Red' },
    { hex: '#22c55e', label: 'Green' },
    { hex: '#f97316', label: 'Orange' },
    { hex: '#a855f7', label: 'Purple' },
    { hex: '#eab308', label: 'Yellow' },
] as const;

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
    @observable private activeDrawingTool: 'rectangle' | 'polygon' | null = null;
    /** Color selected for the next drawn annotation. */
    @observable private activeColor: string = ANNOTATION_COLORS[0].hex;
    /** Maps annotation ID → hex color for live style lookup. */
    private annotationColorMap = new Map<string, string>();

    private viewerContainerRef = React.createRef<HTMLDivElement>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private osdViewer: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private osdMouseTracker: any = null;
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
            const warmupCalls = Array.from({ length: this.nWorkers }, () =>
                fetch(`${base}/tiles/${sl.image_id}/warmup`).catch(() => {})
            );
            await Promise.allSettled([
                fetch(`${base}/tiles/${sl.image_id}/metadata`)
                    .then(r => r.ok ? r.json() : Promise.reject(r.status))
                    .then((meta: TileMetadata) => { this.metaCache.set(sl.image_id, meta); }),
                // Thumbnail fetch warms the Redis cache so the sidebar img is
                // served from Redis (no SVS open) on the first user click.
                fetch(`${base}/tiles/${sl.image_id}/thumbnail`),
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
            // Convert API response to W3CAnnotation shape for Annotorious
            const anns: W3CAnnotation[] = raw.map((item: any) => ({
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
                color: item.body?.color ?? undefined,
            }));
            // Populate color map for Annotorious style function
            this.annotationColorMap.clear();
            for (const ann of anns) {
                if (ann.color) this.annotationColorMap.set(ann.id, ann.color);
            }
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
                body: { label: ann.body?.[0]?.value ?? '', comment: '', type: '', color: ann.color ?? '' },
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
            if (savedAnn.color) this.annotationColorMap.set(savedAnn.id, savedAnn.color);
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
                body: { label: ann.body?.[0]?.value ?? '', comment: '', type: '', color: ann.color ?? '' },
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
    setDrawingTool(tool: 'rectangle' | 'polygon' | null) {
        if (!this.annotorious) return;
        if (tool === null || tool === this.activeDrawingTool) {
            // Cancel any active drawing and deactivate.
            try { this.annotorious.cancelDrawing(); } catch (_) { /* ignore */ }
            this.annotorious.setDrawingEnabled(false);
            this.activeDrawingTool = null;
        } else {
            this.annotorious.setDrawingTool(tool);
            // 'drag' mode: click-drag to draw shape; also disables OSD pan so events reach Annotorious.
            this.annotorious.setDrawingMode('drag');
            this.annotorious.setDrawingEnabled(true);
            this.activeDrawingTool = tool;
            // Ensure annotations overlay is visible while drawing.
            if (!this.annotationsVisible) this.toggleAnnotationsVisible();
        }
    }

    @action.bound
    private handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape' && this.activeDrawingTool !== null) {
            this.setDrawingTool(null);
        }
    }

    @action.bound
    setActiveColor(color: string) {
        this.activeColor = color;
        this.refreshAnnotoriousStyle();
    }

    /** Push the per-annotation color function into Annotorious so shapes render with the right color. */
    private refreshAnnotoriousStyle() {
        if (!this.annotorious) return;
        const colorMap = this.annotationColorMap;
        const activeColor = this.activeColor;
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
            const metaUrl = `${this.tileServerBase}/tiles/${slide.image_id}/metadata`;
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

            // Mount Annotorious (read-write) on top of OSD if annotation API is configured
            if (this.annotationApiBase && this.osdViewer) {
                try {
                    this.annotorious = createOSDAnnotator(this.osdViewer, { drawingEnabled: false, drawingMode: 'drag' });

                    this.annotorious.on('createAnnotation', (ann: W3CAnnotation) => {
                        // Stamp the active color onto the annotation before saving.
                        ann.color = this.activeColor;
                        this.annotationColorMap.set(ann.id, this.activeColor);
                        // Reset drawing mode after shape is completed.
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
                            drawingTool={this.activeDrawingTool}
                            onSetDrawingTool={this.setDrawingTool}
                            activeColor={this.activeColor}
                            onSetActiveColor={this.setActiveColor}
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
    drawingTool?: 'rectangle' | 'polygon' | null;
    onSetDrawingTool?: (tool: 'rectangle' | 'polygon' | null) => void;
    /** Currently selected draw color (hex string). */
    activeColor?: string;
    /** Called when user picks a new color swatch. */
    onSetActiveColor?: (color: string) => void;
}

export function CoordBar({ inputX, inputY, cursorPos, mpp, onChangeX, onChangeY, onGo, onCopyLink, onDownload, annotationEnabled, annotationsVisible, onToggleAnnotations, drawingTool, onSetDrawingTool, activeColor, onSetActiveColor }: CoordBarProps) {
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
            {annotationEnabled && onSetDrawingTool && (
                <>
                    <button
                        onClick={() => onSetDrawingTool(drawingTool === 'rectangle' ? null : 'rectangle')}
                        title={drawingTool === 'rectangle' ? 'Cancel drawing (Esc)' : 'Draw a rectangle annotation — click and drag on the slide'}
                        style={{
                            ...btnStyle,
                            border: `1px solid ${drawingTool === 'rectangle' ? '#c0392b' : C.border}`,
                            background: drawingTool === 'rectangle' ? '#fde8e8' : '#fff',
                            color: drawingTool === 'rectangle' ? '#c0392b' : C.muted,
                        }}
                    >
                        {drawingTool === 'rectangle' ? '✕ Cancel draw' : '◻ Draw rect'}
                    </button>
                    <button
                        onClick={() => onSetDrawingTool(drawingTool === 'polygon' ? null : 'polygon')}
                        title={drawingTool === 'polygon' ? 'Cancel drawing (Esc)' : 'Draw a polygon annotation — click to add points, double-click to close'}
                        style={{
                            ...btnStyle,
                            border: `1px solid ${drawingTool === 'polygon' ? '#c0392b' : C.border}`,
                            background: drawingTool === 'polygon' ? '#fde8e8' : '#fff',
                            color: drawingTool === 'polygon' ? '#c0392b' : C.muted,
                        }}
                    >
                        {drawingTool === 'polygon' ? '✕ Cancel draw' : '⬡ Draw poly'}
                    </button>
                    {/* Color swatches — pick annotation color before drawing */}
                    {onSetActiveColor && ANNOTATION_COLORS.map(({ hex, label }) => (
                        <button
                            key={hex}
                            title={`Draw color: ${label}`}
                            aria-pressed={activeColor === hex}
                            onClick={() => onSetActiveColor(hex)}
                            style={{
                                width: 18, height: 18, borderRadius: '50%', padding: 0, cursor: 'pointer',
                                background: hex,
                                border: activeColor === hex
                                    ? '2px solid #333'
                                    : '2px solid transparent',
                                outline: activeColor === hex ? `2px solid ${hex}` : 'none',
                                outlineOffset: 1,
                                flexShrink: 0,
                            }}
                        />
                    ))}
                </>
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
}

export function MetaSidebar({ slide, sample, meta, tileServerBase, studyId, annotations = [], annotationsLoading = false, annotationEnabled = false, onDeleteAnnotation }: MetaSidebarProps) {
    const thumbSrc = slide ? `${tileServerBase}/tiles/${slide.image_id}/thumbnail` : null;

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
                                const label = ann.body?.[0]?.value ?? '(unlabeled)';
                                const creator = (ann as any).creator ?? '';
                                const created = (ann as any).created ?? '';
                                const dateStr = created ? new Date(created).toLocaleDateString() : '';
                                const dotColor = ann.color ?? ANNOTATION_COLORS[0].hex;
                                return (
                                    <div key={ann.id} style={{
                                        padding: '4px 0', borderBottom: `1px solid ${C.border}`,
                                        display: 'flex', alignItems: 'flex-start', gap: 4,
                                    }}>
                                        {/* Colored dot indicates annotation color */}
                                        <span
                                            data-annotation-color={dotColor}
                                            style={{
                                                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                                background: dotColor, flexShrink: 0, marginTop: 4,
                                            }}
                                        />
                                        <div style={{ flex: 1, overflow: 'hidden' }}>
                                            <div style={{ fontSize: 12, fontWeight: 500, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={label}>
                                                {label}
                                            </div>
                                            {(creator || dateStr) && (
                                                <div style={{ fontSize: 10, color: C.muted }}>
                                                    {creator}{creator && dateStr ? ' · ' : ''}{dateStr}
                                                </div>
                                            )}
                                        </div>
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

