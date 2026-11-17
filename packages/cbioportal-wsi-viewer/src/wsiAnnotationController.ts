import { action, computed, makeObservable, observable } from 'mobx';
import { WsiAnnotation } from './wsiViewerTypes';
import {
    brushWidthInImagePixels,
    formatMeasurement,
    measureShape,
    normalizeSvgSelector,
    parseAnnotationShape,
    polygonArea,
    shapeBounds,
    simplifyPath,
    strokeOutline,
    WsiAnnotationShape,
    WsiMeasurement,
    WsiMpp,
} from './wsiAnnotationGeometryUtils';
import {
    acceptedProvenance,
    aiOriginDescription,
    isAiProvenance,
    isRejectedAi,
    isUnreviewedAi,
    readLayerAndNote,
    serviceColor,
    WsiAnnotationApiBody,
} from './wsiAnnotationBody';
import {
    WsiServiceAccessIssue,
    wsiServiceAccessIssue,
    wsiServiceFetch,
} from './wsiServiceRequest';
import {
    AnnotoriousModule,
    getLoadedAnnotorious,
    loadAnnotorious,
} from './wsiAnnotoriousLoader';
import { WsiPointLayer } from './wsiAnnotationPointLayer';
import { getWsiViewerRuntime } from './wsiViewerConfig';
import {
    parseGeoJsonImport,
    toGeoJsonFeatureCollection,
    WsiExportItem,
    WsiGeoJsonFeatureCollection,
    WsiImportDraft,
} from './wsiAnnotationGeoJson';

export type WsiAnnotationTool =
    | 'rectangle'
    | 'ellipse'
    | 'circle'
    | 'line'
    | 'polygon'
    | 'point'
    | 'freehand'
    | 'brush'
    | null;

type WsiPointerAnnotationTool = Exclude<WsiAnnotationTool, null>;

function isPointerAnnotationTool(
    tool: WsiAnnotationTool
): tool is WsiPointerAnnotationTool {
    return tool !== null;
}

export interface NamedColor {
    name: string;
    hex: string;
}

export const DEFAULT_COLOR = '#3b82f6';
export const DEFAULT_LAYER = 'Default';
export const DEFAULT_NAMED_COLORS: NamedColor[] = [
    { name: DEFAULT_LAYER, hex: DEFAULT_COLOR },
];

const LOCALSTORAGE_COLORS_KEY = 'wsi_annotation_colors_v2';
const LOCALSTORAGE_LAYERS_KEY = 'wsi_annotation_layers_v1';
const LOCALSTORAGE_DEFAULT_SHARED_KEY = 'wsi_annotation_default_shared_v1';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function loadNamedColors(): NamedColor[] {
    if (typeof localStorage === 'undefined') return [...DEFAULT_NAMED_COLORS];
    try {
        const parsed = JSON.parse(
            localStorage.getItem(LOCALSTORAGE_COLORS_KEY) || 'null'
        ) as NamedColor[] | null;
        if (
            Array.isArray(parsed) &&
            parsed.length > 0 &&
            parsed.every(
                color =>
                    typeof color?.name === 'string' &&
                    typeof color.hex === 'string' &&
                    HEX_COLOR_RE.test(color.hex)
            )
        ) {
            return parsed;
        }
    } catch (_) {
        // Ignore malformed or unavailable local storage.
    }
    return [...DEFAULT_NAMED_COLORS];
}

function saveNamedColors(colors: NamedColor[]) {
    try {
        localStorage.setItem(LOCALSTORAGE_COLORS_KEY, JSON.stringify(colors));
    } catch (_) {
        // Ignore unavailable local storage.
    }
}

function loadLayerNames(): string[] {
    if (typeof localStorage === 'undefined') return [DEFAULT_LAYER];
    try {
        const parsed = JSON.parse(
            localStorage.getItem(LOCALSTORAGE_LAYERS_KEY) || 'null'
        ) as string[] | null;
        if (
            Array.isArray(parsed) &&
            parsed.length > 0 &&
            parsed.every(layer => typeof layer === 'string' && layer.trim())
        ) {
            return parsed;
        }
    } catch (_) {
        // Ignore malformed or unavailable local storage.
    }
    return [DEFAULT_LAYER];
}

/** New annotations are shared with the study unless the user chose private. */
function loadDefaultShared(): boolean {
    try {
        return (
            localStorage.getItem(LOCALSTORAGE_DEFAULT_SHARED_KEY) !== 'false'
        );
    } catch (_) {
        return true;
    }
}

function saveDefaultShared(shared: boolean) {
    try {
        localStorage.setItem(LOCALSTORAGE_DEFAULT_SHARED_KEY, String(shared));
    } catch (_) {
        // Ignore unavailable local storage.
    }
}

/**
 * The service's `visible_to`: null keeps an annotation private to its
 * creator, [] shares it with everyone who can read the study. Group lists
 * are accepted by the service but not used: the proxy sends no groups.
 */
export type WsiAnnotationVisibility = 'private' | 'shared' | 'groups';

export function annotationVisibility(
    visibleTo: string[] | null | undefined
): WsiAnnotationVisibility | null {
    if (visibleTo === null) return 'private';
    if (Array.isArray(visibleTo)) {
        return visibleTo.length ? 'groups' : 'shared';
    }
    return null;
}

function saveLayerNames(layers: string[]) {
    try {
        localStorage.setItem(LOCALSTORAGE_LAYERS_KEY, JSON.stringify(layers));
    } catch (_) {
        // Ignore unavailable local storage.
    }
}

export function parseColorLabel(value: unknown): { name: string; hex: string } {
    const fallback = DEFAULT_COLOR;
    if (typeof value !== 'string' || !value) {
        return { name: DEFAULT_LAYER, hex: fallback };
    }
    const separator = value.indexOf('|');
    if (separator >= 0) {
        const name = value.slice(0, separator).trim();
        const hex = value.slice(separator + 1);
        return {
            name,
            hex: HEX_COLOR_RE.test(hex) ? hex : fallback,
        };
    }
    if (value.startsWith('#')) {
        return {
            name: '',
            hex: HEX_COLOR_RE.test(value) ? value : fallback,
        };
    }
    const legacy: Record<string, string> = {
        general: DEFAULT_COLOR,
        tumor: '#ef4444',
        stroma: '#22c55e',
        normal: '#14b8a6',
        tils: '#8b5cf6',
        necrosis: '#f97316',
    };
    return { name: value, hex: legacy[value] || fallback };
}

export function serializeColorLabel(name: string, hex: string): string {
    const safeName = name.trim().replace(/\|/g, '');
    const safeHex = HEX_COLOR_RE.test(hex) ? hex : DEFAULT_COLOR;
    return safeName ? `${safeName}|${safeHex}` : safeHex;
}

function parseColor(value: unknown): { name: string; color: string } {
    const parsed = parseColorLabel(value);
    return { name: parsed.name, color: parsed.hex };
}

export const WSI_ANNOTATION_ACCESS_MESSAGES: Record<
    WsiServiceAccessIssue,
    string
> = {
    signedOut: 'Sign in to view and edit annotations.',
    forbidden:
        'Annotations are read-only: you do not have access to this study.',
};

/**
 * Which annotations the list shows by origin: AI (the research assistant or
 * a model) or manual.
 */
export type WsiAnnotationAiFilter = 'all' | 'ai' | 'unreviewed' | 'human';

/** The annotation list's filters; empty strings match everything. */
export interface WsiAnnotationListFilter {
    layer: string;
    author: string;
    text: string;
    ai: WsiAnnotationAiFilter;
}

const EMPTY_LIST_FILTER: WsiAnnotationListFilter = {
    layer: '',
    author: '',
    text: '',
    ai: 'all',
};

/**
 * The term a label counts under. A viewer auto-label, one of
 * `autoLabelBases` (a color's name or hex) and a number as `nextAutoLabel`
 * makes it, counts under its base: "Tumor 1" and "Tumor 2" count as
 * "Tumor". Any other label, and any `vocabulary` term, is its own term, so
 * "Grade 1" and "Grade 2" stay apart.
 */
export function labelTerm(
    label: string,
    autoLabelBases: Iterable<string> = [],
    vocabulary: string[] = []
): string {
    const trimmed = label.trim();
    if (vocabulary.includes(trimmed)) return trimmed;
    const match = /^(.*\S)\s+\d+$/.exec(trimmed);
    if (match && new Set(autoLabelBases).has(match[1])) return match[1];
    return trimmed;
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
    const counts = new Map<string, number>();
    items.forEach(item => {
        const name = key(item);
        counts.set(name, (counts.get(name) || 0) + 1);
    });
    return counts;
}

/** Point annotations counted by layer and label term. */
export interface WsiPointTallyRow {
    layer: string;
    label: string;
    color: string;
    count: number;
}

/** A point's SVG selector: a circle of radius 0, in image pixels. */
export function pointSelectorSvg(point: { x: number; y: number }): string {
    const round = (value: number) => Math.round(value * 100) / 100;
    return `<svg><circle cx="${round(point.x)}" cy="${round(
        point.y
    )}" r="0" /></svg>`;
}

/**
 * A change undo can reverse: annotations created (deleted on undo), an edit
 * (its previous version saved again) or annotations deleted (created again).
 */
export type WsiUndoEntry =
    | { kind: 'create'; ids: string[] }
    | { kind: 'update'; before: WsiAnnotation }
    | { kind: 'delete'; before: WsiAnnotation[] };

/**
 * Shown when the annotation service has no review route: reviews then fall
 * back to the creator-only update and delete.
 */
export const WSI_REVIEW_UNSUPPORTED_MESSAGE =
    "This annotation service cannot record reviews: only an AI annotation's creator can accept it or reject it, and Reject deletes it.";

/** How many changes undo remembers. */
const MAX_UNDO = 50;

/** An import read and validated, waiting for the user to confirm it. */
export interface WsiAnnotationImportPreview {
    fileName: string;
    drafts: WsiImportDraft[];
    counts: { point: number; line: number; polygon: number };
    skipped: Array<{ index: number; reason: string }>;
}

function readFileText(file: Blob): Promise<string> {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });
}

/** Single saves run this many at a time when the service has no batch route. */
const SINGLE_SAVE_CONCURRENCY = 4;
/** The most annotations the service's batch route takes in one request. */
export const BATCH_MAX_ITEMS = 100;
/** Batch request bodies stay below the service's 4 MiB cap. */
const BATCH_MAX_BYTES = 3 * 1024 * 1024;
/** `keepalive` requests may carry 64 KiB in all; stay below it. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;
/** Points dropped within this many milliseconds are saved together. */
export const POINT_SAVE_DELAY_MS = 500;

/** The service's body for creating one annotation. */
interface WsiCreatePayload {
    slide_id: string;
    study_id: string;
    body: WsiAnnotationApiBody;
    target: { selector: unknown };
    visible_to: string[] | null;
}

/** One annotation's save: the saved annotation, or why it was not saved. */
export type WsiSaveResult =
    | { annotation: WsiAnnotation; reason?: undefined }
    | { annotation?: undefined; reason: string };

/**
 * Splits items, given each one's serialized size, into consecutive groups
 * of at most `maxItems` and about `maxBytes`; an item larger than
 * `maxBytes` goes alone.
 */
export function chunkBySize(
    sizes: number[],
    maxItems: number,
    maxBytes: number
): number[][] {
    const chunks: number[][] = [];
    let current: number[] = [];
    let bytes = 0;
    sizes.forEach((size, index) => {
        if (
            current.length &&
            (current.length >= maxItems || bytes + size + 1 > maxBytes)
        ) {
            chunks.push(current);
            current = [];
            bytes = 0;
        }
        current.push(index);
        bytes += size + 1;
    });
    if (current.length) chunks.push(current);
    return chunks;
}

/**
 * The batch items a 422 names, by position in the request, with the first
 * message for each; empty when the refusal names no item.
 */
export function batchItemErrors(detail: unknown): Map<number, string> {
    const errors = new Map<number, string>();
    if (!Array.isArray(detail)) return errors;
    detail.forEach(error => {
        const loc = error?.loc;
        const at = Array.isArray(loc) ? loc.indexOf('annotations') : -1;
        const index = at >= 0 ? loc[at + 1] : undefined;
        if (typeof index === 'number' && !errors.has(index)) {
            const field = loc
                .slice(at + 2)
                .filter((part: unknown) => typeof part === 'string')
                .filter((part: string) => !/^Annotation/.test(part))
                .join('.');
            const message =
                typeof error.msg === 'string' ? error.msg : 'invalid';
            errors.set(index, field ? `${field}: ${message}` : message);
        }
    });
    return errors;
}

/** Pointer travel, in screen pixels, below which a press is a click. */
const CLICK_TOLERANCE = 5;
/** Freehand and brush strokes record a point per this many screen pixels. */
const STROKE_SAMPLE_SPACING = 2;
/** Douglas–Peucker tolerance for freehand and brush strokes, screen pixels. */
const STROKE_SIMPLIFY_TOLERANCE = 1.5;
/** Brush widths offered on a slide with a scale, in µm of tissue. */
export const BRUSH_WIDTHS_UM = [10, 25, 50, 100, 250, 500];
export const DEFAULT_BRUSH_WIDTH_UM = 50;
/**
 * Brush widths offered on a slide without a scale, in screen pixels at the
 * zoom the stroke is drawn.
 */
export const BRUSH_WIDTHS_PX = [8, 16, 32, 64];
export const DEFAULT_BRUSH_WIDTH_PX = 16;

function isStrokeTool(tool: WsiAnnotationTool): tool is 'freehand' | 'brush' {
    return tool === 'freehand' || tool === 'brush';
}

/** The first few refused items, e.g. "#3: label: too long; #7: …". */
function describeFailures(results: WsiSaveResult[], limit = 3): string {
    const failures = results
        .map((result, index) =>
            result.reason ? `#${index + 1}: ${result.reason}` : null
        )
        .filter((item): item is string => item !== null);
    const shown = failures.slice(0, limit).join('; ');
    return failures.length > limit
        ? `${shown}; and ${failures.length - limit} more`
        : shown;
}

export class WsiAnnotationController {
    @observable annotations: WsiAnnotation[] = [];
    @observable loading = false;
    @observable error: string | null = null;
    /**
     * Set when the service refused this study (signed out, or no access).
     * Editing is then off until the slide or study changes.
     */
    @observable accessIssue: WsiServiceAccessIssue | null = null;
    @observable visible = true;
    @observable activeTool: WsiAnnotationTool = null;
    @observable activeColor = DEFAULT_COLOR;
    @observable activeColorName = DEFAULT_LAYER;
    @observable activeLayer = DEFAULT_LAYER;
    @observable private customLayers: string[] = loadLayerNames();
    @observable private customColors: NamedColor[] = loadNamedColors();
    @observable hiddenLayerNames = new Set<string>();
    /** Hides AI annotations no one has reviewed, on the slide and list. */
    @observable hideUnreviewedAi = false;
    @observable.ref listFilter: WsiAnnotationListFilter = EMPTY_LIST_FILTER;
    /**
     * The label new annotations get. Empty: an auto-label from the active
     * color's name and a number (only without a strict vocabulary).
     */
    @observable activeLabel = '';
    /** This session's changes on the open slide, the latest last. */
    @observable.ref undoStack: WsiUndoEntry[] = [];
    @observable undoing = false;
    @observable.ref importPreview: WsiAnnotationImportPreview | null = null;
    @observable.ref importProgress: {
        total: number;
        done: number;
        failed: number;
    } | null = null;
    @observable importError: string | null = null;
    /** Brush width in µm, used when the slide has a scale (`mpp`). */
    @observable brushWidthUm = DEFAULT_BRUSH_WIDTH_UM;
    /** Brush width in screen pixels, used when the slide has no scale. */
    @observable brushWidthPx = DEFAULT_BRUSH_WIDTH_PX;
    /**
     * The brush outline under the pointer while the brush is on, in screen
     * pixels: its centre and its diameter at the current zoom.
     */
    @observable.ref brushCursor: {
        x: number;
        y: number;
        diameter: number;
    } | null = null;
    /**
     * The signed-in user as the annotation service names creators, when the
     * host knows it. Unknown: every annotation offers edit and delete, and
     * the service refuses another user's.
     */
    @observable currentUser: string | null = null;
    /**
     * Whether the service has the review route (`POST
     * /annotations/{id}/review`): unknown until the first review.
     */
    @observable reviewRoute: boolean | null = null;
    /**
     * Whether the service has the batch route (`POST /annotations/batch`):
     * unknown until the first batch save.
     */
    @observable batchRoute: boolean | null = null;
    /**
     * Dropped points not saved on the slide or study last closed, because
     * the service refused them; reported once the next one opens.
     */
    @observable pointsLeftUnsaved = 0;
    /** Whether new annotations are shared with the study (else private). */
    @observable defaultShared = loadDefaultShared();
    @observable annotationTooltip: {
        x: number;
        y: number;
        text: string;
        layerName?: string;
        ai?: 'unreviewed' | 'accepted';
        /** Who made an AI annotation (see `aiOriginDescription`). */
        aiOrigin?: string;
        measurement?: string;
        note?: string;
    } | null = null;
    @observable.ref customDrawPreview: {
        tool: WsiPointerAnnotationTool;
        start: { x: number; y: number };
        current: { x: number; y: number };
        points?: Array<{ x: number; y: number }>;
        /** A brush stroke's width on screen, in pixels. */
        strokeWidth?: number;
        /** The start and current points in image pixels, for measuring. */
        imageStart?: { x: number; y: number };
        imageCurrent?: { x: number; y: number };
    } | null = null;

    private generation = 0;
    private loadGeneration = 0;
    private attachGeneration = 0;
    // Mutations are scoped to the slide session; loads can be restarted on
    // their own (e.g. after a conflict) without cancelling pending saves.
    private abortController: AbortController | null = null;
    private loadAbortController: AbortController | null = null;
    private annotorious: any = null;
    private osdViewer: any = null;
    private openSeadragon: any = null;
    private slideKey: string | null = null;
    private pointerCleanup: (() => void) | null = null;
    private keydownCleanup: (() => void) | null = null;
    private pointerDown: {
        tool: WsiPointerAnnotationTool;
        image: { x: number; y: number };
        client: { x: number; y: number };
    } | null = null;
    private polygonPoints: Array<{ x: number; y: number }> = [];
    /** Dropped points not yet sent, shown already; saved together. */
    private pointQueue: WsiAnnotation[] = [];
    private pointTimer: ReturnType<typeof setTimeout> | null = null;
    /** The point save in flight, which undo waits for. */
    private pointSave: Promise<void> | null = null;
    /**
     * Points sent and not yet answered, by their draft id: each resolves to
     * the saved point, or null when it was not saved. An edit or delete of
     * one waits for it and then applies to the saved id.
     */
    private readonly pointsInFlight = new Map<
        string,
        Promise<WsiAnnotation | null>
    >();
    private pageHideCleanup: (() => void) | null = null;
    /** The freehand or brush stroke being drawn, in image pixels. */
    private strokePoints: Array<{ x: number; y: number }> = [];
    private strokeScreenPoints: Array<{ x: number; y: number }> = [];
    private polygonScreenPoints: Array<{ x: number; y: number }> = [];
    private synchronizing = false;
    private pointLayer: WsiPointLayer | null = null;
    private canvasClickCleanup: (() => void) | null = null;
    /** The shapes last given to Annotorious, to skip unchanged updates. */
    private annotoriousShapes: WsiAnnotation[] = [];
    private readonly shapeCache = new WeakMap<
        object,
        WsiAnnotationShape | null
    >();
    @observable.ref private mppProvider: () => WsiMpp | null | undefined = () =>
        undefined;

    constructor(
        private apiUrl: string | null | undefined,
        private studyId: string | undefined
    ) {
        makeObservable(this);
    }

    /**
     * Supplies the open slide's microns-per-pixel, read when measuring; the
     * viewer reads it from the slide's tile metadata.
     */
    @action
    setMppProvider(provider: () => WsiMpp | null | undefined) {
        this.mppProvider = provider;
    }

    /** The open slide's microns-per-pixel, when it has a valid one. */
    @computed get mpp(): WsiMpp | undefined {
        const mpp = this.mppProvider();
        return mpp && mpp.x > 0 && mpp.y > 0 ? mpp : undefined;
    }

    /** An annotation's shape, or null for a selector the viewer cannot read. */
    shapeOf(annotation: WsiAnnotation): WsiAnnotationShape | null {
        const selector = annotation.target?.selector;
        if (!selector) return null;
        if (!this.shapeCache.has(selector)) {
            this.shapeCache.set(selector, parseAnnotationShape(selector));
        }
        return this.shapeCache.get(selector)!;
    }

    isPoint(annotation: WsiAnnotation): boolean {
        return this.shapeOf(annotation)?.kind === 'point';
    }

    /** Points on the slide per layer and label term, most first. */
    @computed get pointTally(): WsiPointTallyRow[] {
        const rows = new Map<string, WsiPointTallyRow>();
        this.shownAnnotations.forEach(annotation => {
            if (!this.isPoint(annotation)) return;
            const layer = annotation.layerName || DEFAULT_LAYER;
            const label = this.labelTerm(
                annotation.body?.[0]?.value || 'Point'
            );
            const key = `${layer}\u0000${label}`;
            const row = rows.get(key) || {
                layer,
                label,
                color: annotation.color || DEFAULT_COLOR,
                count: 0,
            };
            row.count += 1;
            rows.set(key, row);
        });
        return Array.from(rows.values()).sort(
            (a, b) =>
                b.count - a.count ||
                a.layer.localeCompare(b.layer) ||
                a.label.localeCompare(b.label)
        );
    }

    /** What auto-labels start with: the palette's color names and hexes. */
    @computed private get autoLabelBases(): Set<string> {
        const bases = new Set<string>();
        this.namedColors.forEach(color => {
            if (color.name.trim()) bases.add(color.name.trim());
            bases.add(color.hex);
        });
        return bases;
    }

    /** The term `label` counts under on this slide (see `labelTerm`). */
    labelTerm(label: string): string {
        return labelTerm(label, this.autoLabelBases, this.labelVocabulary);
    }

    /** The configured label terms, trimmed and without duplicates. */
    get labelVocabulary(): string[] {
        const terms = getWsiViewerRuntime().annotations?.labelVocabulary || [];
        return Array.from(
            new Set(
                terms
                    .map(term => (typeof term === 'string' ? term.trim() : ''))
                    .filter(Boolean)
            )
        );
    }

    /** Whether labels must come from the vocabulary. */
    get strictLabels(): boolean {
        return (
            !!getWsiViewerRuntime().annotations?.labelVocabularyStrict &&
            this.labelVocabulary.length > 0
        );
    }

    /**
     * Labels the label fields offer: the vocabulary, then (unless labels are
     * strict) the label terms already used on this slide.
     */
    @computed get labelSuggestions(): string[] {
        const suggestions = new Set(this.labelVocabulary);
        if (!this.strictLabels) {
            this.annotations
                .map(annotation =>
                    this.labelTerm(annotation.body?.[0]?.value || '')
                )
                .filter(Boolean)
                .sort((a, b) => a.localeCompare(b))
                .forEach(term => suggestions.add(term));
        }
        return Array.from(suggestions);
    }

    /** Whether `label` may be saved. */
    isAllowedLabel(label: string): boolean {
        return (
            !this.strictLabels || this.labelVocabulary.includes(label.trim())
        );
    }

    @action.bound
    setActiveLabel(label: string) {
        this.activeLabel = label.replace(/\s+/g, ' ').slice(0, 200);
    }

    /** The label new shapes get (see `activeLabel`). */
    private newShapeLabel(): string {
        const label = this.activeLabel.trim();
        if (label && this.isAllowedLabel(label)) return label;
        return this.strictLabels
            ? this.labelVocabulary[0]
            : this.nextAutoLabel();
    }

    /** The label a new point gets: the active label, else the color's name. */
    @computed get activePointLabel(): string {
        const label = this.activeLabel.trim();
        if (label && this.isAllowedLabel(label)) return label;
        if (this.strictLabels) return this.labelVocabulary[0];
        return this.activeColorName.trim() || 'Point';
    }

    /** Points with the active layer and point label, for the toolbar. */
    @computed get activePointCount(): number {
        return (
            this.pointTally.find(
                row =>
                    row.layer === this.activeLayer &&
                    row.label === this.labelTerm(this.activePointLabel)
            )?.count || 0
        );
    }

    /** An annotation's size, in microns, or in pixels without an mpp. */
    measurementOf(annotation: WsiAnnotation): WsiMeasurement | null {
        const shape = this.shapeOf(annotation);
        return shape ? measureShape(shape, this.mpp) : null;
    }

    /** The size of the shape being drawn, for a live readout. */
    @computed get drawPreviewMeasurement(): string | null {
        const preview = this.customDrawPreview;
        if (!preview?.imageStart || !preview.imageCurrent) return null;
        const a = preview.imageStart;
        const b = preview.imageCurrent;
        let shape: WsiAnnotationShape | null = null;
        if (preview.tool === 'line') {
            shape = { kind: 'line', points: [a, b] };
        } else if (preview.tool === 'rectangle') {
            shape = {
                kind: 'rectangle',
                x: Math.min(a.x, b.x),
                y: Math.min(a.y, b.y),
                width: Math.abs(b.x - a.x),
                height: Math.abs(b.y - a.y),
            };
        } else if (preview.tool === 'ellipse' || preview.tool === 'circle') {
            const rx = Math.abs(b.x - a.x) / 2;
            const ry = Math.abs(b.y - a.y) / 2;
            const r = Math.min(rx, ry);
            shape = {
                kind: 'ellipse',
                cx: (a.x + b.x) / 2,
                cy: (a.y + b.y) / 2,
                rx: preview.tool === 'circle' ? r : rx,
                ry: preview.tool === 'circle' ? r : ry,
            };
        }
        const measurement = shape && measureShape(shape, this.mpp);
        if (!measurement) return null;
        return preview.tool === 'line'
            ? formatMeasurement(measurement)
            : formatMeasurement({ ...measurement, perimeter: undefined });
    }

    @action.bound
    setCurrentUser(user: string | null | undefined) {
        this.currentUser = user && user.trim() ? user.trim() : null;
        this.applySelectAction();
    }

    /**
     * Whether the user may edit or delete `annotation`: only its creator may.
     * With the user or the creator unknown, the service decides.
     */
    canModify(annotation: WsiAnnotation): boolean {
        return (
            this.canEdit &&
            (!this.currentUser ||
                !annotation.creator ||
                annotation.creator === this.currentUser)
        );
    }

    /**
     * Whether the user may accept or reject `annotation`: anyone who can
     * edit in the study may review an unreviewed AI annotation, unless the
     * service has no review route, when only its creator may.
     */
    canReview(annotation: WsiAnnotation): boolean {
        return (
            this.canEdit &&
            isUnreviewedAi(annotation.provenance) &&
            (this.reviewRoute !== false || this.canModify(annotation))
        );
    }

    /** Whether the user may draw, edit or delete annotations. */
    @computed get canEdit(): boolean {
        return this.canWrite;
    }

    /** Whether writes may be sent: a service, and no refusal of the study. */
    private get canWrite(): boolean {
        return Boolean(this.apiUrl) && this.accessIssue === null;
    }

    /** Dropped points the service refused to save (see `unsaved`). */
    @computed get unsavedPointCount(): number {
        return this.annotations.filter(annotation => annotation.unsaved).length;
    }

    /**
     * "3 points were not saved.", while this slide has unsaved points, or
     * the count left unsaved on the slide or study last closed.
     */
    @computed get unsavedPointMessage(): string | null {
        const describe = (n: number) =>
            `${n} point${n === 1 ? ' was' : 's were'} not saved`;
        const here = this.unsavedPointCount;
        if (here) return `${describe(here)}.`;
        return this.pointsLeftUnsaved
            ? `${describe(this.pointsLeftUnsaved)} on the previous slide.`
            : null;
    }

    @action.bound
    dismissPointsLeftUnsaved() {
        this.pointsLeftUnsaved = 0;
    }

    /**
     * Sends the unsaved points again, e.g. after signing in again in
     * another tab; a new refusal keeps them unsaved.
     */
    @action.bound
    retryUnsavedPoints(): Promise<void> {
        const unsaved = this.annotations.filter(
            annotation => annotation.unsaved
        );
        if (!unsaved.length || !this.apiUrl) return Promise.resolve();
        this.accessIssue = null;
        this.error = null;
        const drafts = unsaved.map(({ unsaved: _unsaved, ...draft }) => draft);
        const byId = new Map(drafts.map(draft => [draft.id, draft]));
        this.annotations = this.annotations.map(
            annotation => byId.get(annotation.id) || annotation
        );
        this.pointQueue.push(...drafts);
        this.applySelectAction();
        return this.flushPoints();
    }

    /** The sign-in or read-only notice, when the service refused the study. */
    @computed get accessMessage(): string | null {
        return this.accessIssue
            ? WSI_ANNOTATION_ACCESS_MESSAGES[this.accessIssue]
            : null;
    }

    @computed get layerNames(): string[] {
        const names = new Set(this.customLayers);
        this.annotations.forEach(annotation =>
            names.add(annotation.layerName || DEFAULT_LAYER)
        );
        return Array.from(names);
    }

    @computed get namedColors(): NamedColor[] {
        const colors = new Map<string, NamedColor>();
        [...DEFAULT_NAMED_COLORS, ...this.customColors].forEach(color =>
            colors.set(`${color.name}|${color.hex}`, color)
        );
        this.annotations.forEach(annotation => {
            if (annotation.color) {
                colors.set(
                    `${annotation.colorName || ''}|${annotation.color}`,
                    {
                        name: annotation.colorName || '',
                        hex: annotation.color,
                    }
                );
            }
        });
        return Array.from(colors.values());
    }

    @computed get visibleAnnotationCount(): number {
        return this.shownAnnotations.length;
    }

    /** The annotations drawn on the slide: visible layers, and filters. */
    @computed get shownAnnotations(): WsiAnnotation[] {
        return this.annotations.filter(annotation => this.isShown(annotation));
    }

    /** The annotations the list shows: those on the slide, filtered. */
    @computed get listedAnnotations(): WsiAnnotation[] {
        const { layer, author, text, ai } = this.listFilter;
        const needle = text.trim().toLowerCase();
        return this.shownAnnotations.filter(annotation => {
            if (layer && (annotation.layerName || DEFAULT_LAYER) !== layer) {
                return false;
            }
            if (author && (annotation.creator || '') !== author) return false;
            if (
                needle &&
                !(annotation.body?.[0]?.value || '')
                    .toLowerCase()
                    .includes(needle) &&
                !(annotation.note || '').toLowerCase().includes(needle)
            ) {
                return false;
            }
            const isAi = isAiProvenance(annotation.provenance);
            if (ai === 'ai' && !isAi) return false;
            if (ai === 'human' && isAi) return false;
            if (ai === 'unreviewed' && !isUnreviewedAi(annotation.provenance)) {
                return false;
            }
            return true;
        });
    }

    /** The creators of the slide's annotations, sorted. */
    @computed get authors(): string[] {
        return Array.from(
            new Set(
                this.annotations
                    .map(annotation => annotation.creator || '')
                    .filter(Boolean)
            )
        ).sort();
    }

    /** Listed annotations per layer. */
    @computed get listedLayerCounts(): Map<string, number> {
        return countBy(
            this.listedAnnotations,
            annotation => annotation.layerName || DEFAULT_LAYER
        );
    }

    /** Listed annotations per label term (see `labelTerm`). */
    @computed get listedLabelCounts(): Map<string, number> {
        return countBy(this.listedAnnotations, annotation =>
            this.labelTerm(annotation.body?.[0]?.value || '(unlabeled)')
        );
    }

    @action.bound
    setListFilter(filter: Partial<WsiAnnotationListFilter>) {
        this.listFilter = { ...this.listFilter, ...filter };
    }

    @action.bound
    clearListFilter() {
        this.listFilter = EMPTY_LIST_FILTER;
    }

    /**
     * Pans and zooms the slide to fit an annotation with a margin around it;
     * returns whether it could.
     */
    zoomToAnnotation(id: string): boolean {
        const annotation = this.annotations.find(item => item.id === id);
        const shape = annotation && this.shapeOf(annotation);
        const viewport = this.osdViewer?.viewport;
        if (!shape || !viewport || !this.openSeadragon?.Rect) return false;
        const bounds = shapeBounds(shape);
        const width = bounds.maxX - bounds.minX;
        const height = bounds.maxY - bounds.minY;
        // Points and thin shapes still get a readable field of view.
        const margin = Math.max(width, height, 128) * 0.5;
        const rect = new this.openSeadragon.Rect(
            bounds.minX - margin,
            bounds.minY - margin,
            width + 2 * margin,
            height + 2 * margin
        );
        viewport.fitBounds(viewport.imageToViewportRectangle(rect));
        return true;
    }

    /**
     * The slide's annotations as a QuPath-compatible GeoJSON
     * FeatureCollection: all of them, or those on the slide now (visible
     * layers and filters). Named by the opaque slide key only.
     */
    exportGeoJson(scope: 'all' | 'visible'): WsiGeoJsonFeatureCollection {
        const annotations =
            scope === 'all' ? this.annotations : this.shownAnnotations;
        const items: WsiExportItem[] = [];
        annotations.forEach(annotation => {
            const shape = this.shapeOf(annotation);
            if (!shape) return;
            const label = annotation.body?.[0]?.value || '';
            const layer = annotation.layerName || DEFAULT_LAYER;
            items.push({
                id: annotation.id,
                shape,
                label,
                classification: this.labelTerm(label) || layer,
                color: annotation.color || DEFAULT_COLOR,
                layer,
                note: annotation.note,
                measurement: measureShape(shape, this.mpp),
                aiReviewStatus: isAiProvenance(annotation.provenance)
                    ? isUnreviewedAi(annotation.provenance)
                        ? 'unreviewed'
                        : 'accepted'
                    : undefined,
            });
        });
        return toGeoJsonFeatureCollection(items, this.slideKey || '', this.mpp);
    }

    /** Downloads `exportGeoJson(scope)` as a .geojson file. */
    downloadGeoJson(scope: 'all' | 'visible') {
        const collection = this.exportGeoJson(scope);
        const blob = new Blob([JSON.stringify(collection, null, 1)], {
            type: 'application/geo+json',
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `slide-${this.slideKey || 'annotations'}${
            scope === 'visible' ? '-visible' : ''
        }.geojson`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    /** The open slide's level-0 size, when the viewer knows it. */
    private slideSize(): { width: number; height: number } | null {
        const size = this.osdViewer?.world?.getItemAt?.(0)?.getContentSize?.();
        return size && size.x > 0 && size.y > 0
            ? { width: size.x, height: size.y }
            : null;
    }

    /** The label an imported annotation gets. */
    private importLabel(draft: WsiImportDraft): string {
        return draft.label || draft.className || this.newShapeLabel();
    }

    /**
     * Reads and validates a GeoJSON file, and holds the annotations it would
     * create for the user to confirm. Nothing is saved yet.
     */
    @action.bound
    async previewImport(file: File) {
        this.importError = null;
        this.importPreview = null;
        try {
            const raw = await readFileText(file);
            const result = parseGeoJsonImport(
                JSON.parse(raw),
                this.slideSize()
            );
            const drafts: WsiImportDraft[] = [];
            const skipped = [...result.skipped];
            result.drafts.forEach((draft, index) => {
                if (this.isAllowedLabel(this.importLabel(draft))) {
                    drafts.push(draft);
                } else {
                    skipped.push({
                        index,
                        reason: 'label not in the vocabulary',
                    });
                }
            });
            const counts = { point: 0, line: 0, polygon: 0 };
            drafts.forEach(draft => (counts[draft.kind] += 1));
            action(() => {
                this.importPreview = {
                    fileName: file.name,
                    drafts,
                    counts,
                    skipped,
                };
            })();
        } catch (error) {
            action(() => {
                this.importError =
                    error instanceof SyntaxError
                        ? 'The file is not valid JSON.'
                        : (error as Error).message;
            })();
        }
    }

    @action.bound
    cancelImport() {
        this.importPreview = null;
        this.importError = null;
    }

    /**
     * Creates the previewed annotations with batch saves (up to
     * `BATCH_MAX_ITEMS` per request). Each keeps its file's label, class
     * color, layer and note, else the active ones. The ones saved undo as one
     * step; the ones refused are reported by feature number.
     */
    @action.bound
    async confirmImport(): Promise<WsiAnnotation[]> {
        const preview = this.importPreview;
        if (!preview || !this.canEdit || !this.slideKey) return [];
        this.importPreview = null;
        const total = preview.drafts.length;
        this.importProgress = { total, done: 0, failed: 0 };
        const drafts = preview.drafts.map(draft => {
            const annotation = this.draftAnnotation(
                draft.svg,
                this.importLabel(draft)
            );
            if (draft.color) {
                annotation.color = draft.color;
                annotation.colorName = draft.className || '';
            }
            if (draft.layer) annotation.layerName = draft.layer;
            if (draft.note) annotation.note = draft.note;
            return annotation;
        });
        const generation = this.generation;
        const slideKey = this.slideKey;
        const results = await this.saveAnnotations(drafts, {
            onProgress: (done, failed) =>
                action(() => {
                    this.importProgress = { total, done, failed };
                })(),
        });
        if (generation !== this.generation || slideKey !== this.slideKey) {
            action(() => {
                this.importProgress = null;
            })();
            return [];
        }
        const saved = this.addSaved(results);
        if (saved.length) {
            this.pushUndo({ kind: 'create', ids: saved.map(item => item.id) });
        }
        action(() => {
            this.importProgress = null;
            const failed = total - saved.length;
            if (failed && this.accessIssue === null) {
                this.error = `Imported ${
                    saved.length
                } of ${total} annotations; ${failed} could not be saved (${describeFailures(
                    results
                )}).`;
            }
        })();
        return saved;
    }

    @computed get canUndo(): boolean {
        return this.canEdit && !this.undoing && this.undoStack.length > 0;
    }

    /** What undo would reverse, e.g. "Undo delete". */
    @computed get undoLabel(): string | null {
        const entry = this.undoStack[this.undoStack.length - 1];
        if (!entry) return null;
        const what =
            entry.kind === 'create'
                ? 'create'
                : entry.kind === 'update'
                ? 'edit'
                : 'delete';
        const n =
            entry.kind === 'create'
                ? entry.ids.length
                : entry.kind === 'delete'
                ? entry.before.length
                : 1;
        return `Undo ${what}${n > 1 ? ` of ${n} annotations` : ''}`;
    }

    @action
    private pushUndo(entry: WsiUndoEntry) {
        this.undoStack = [...this.undoStack, entry].slice(-MAX_UNDO);
    }

    /** Points the undo history at an annotation's new id after it was re-created. */
    @action
    private renameInUndo(oldId: string, newId: string) {
        this.undoStack = this.undoStack.map(entry =>
            entry.kind === 'create'
                ? {
                      ...entry,
                      ids: entry.ids.map(id => (id === oldId ? newId : id)),
                  }
                : entry.kind === 'update' && entry.before.id === oldId
                ? { ...entry, before: { ...entry.before, id: newId } }
                : entry
        );
    }

    /**
     * Reverses this session's last create, edit or delete on the slide: a
     * created annotation is deleted, an edit is undone by saving the previous
     * version over the current one (with the current `version`), and a
     * deleted annotation is created again, with a new id.
     */
    @action.bound
    async undo(): Promise<boolean> {
        await this.flushPoints();
        if (!this.canUndo) return false;
        const entry = this.undoStack[this.undoStack.length - 1];
        this.undoStack = this.undoStack.slice(0, -1);
        this.undoing = true;
        try {
            if (entry.kind === 'create') {
                for (const id of entry.ids) {
                    if (this.annotations.some(item => item.id === id)) {
                        await this.deleteAnnotation(id, false);
                    }
                }
            } else if (entry.kind === 'update') {
                const current = this.annotations.find(
                    item => item.id === entry.before.id
                );
                if (!current) {
                    action(() => {
                        this.error = 'Cannot undo: the annotation was deleted.';
                    })();
                    return false;
                }
                await this.updateAnnotation(
                    { ...entry.before, version: current.version },
                    false
                );
            } else {
                for (const before of entry.before) {
                    const saved = await this.createAnnotation(
                        {
                            ...before,
                            id: `client-undo-${Date.now()}-${Math.random()
                                .toString(36)
                                .slice(2)}`,
                        },
                        false
                    );
                    if (saved) this.renameInUndo(before.id, saved.id);
                }
            }
            return true;
        } finally {
            action(() => {
                this.undoing = false;
            })();
        }
    }

    /** AI annotations that no one has reviewed yet. */
    @computed get unreviewedAiCount(): number {
        return this.annotations.filter(annotation =>
            isUnreviewedAi(annotation.provenance)
        ).length;
    }

    private isShown(annotation: WsiAnnotation): boolean {
        return (
            !this.hiddenLayerNames.has(annotation.layerName || DEFAULT_LAYER) &&
            !(this.hideUnreviewedAi && isUnreviewedAi(annotation.provenance))
        );
    }

    @computed get annotationsByLayer(): Map<string, WsiAnnotation[]> {
        const grouped = new Map<string, WsiAnnotation[]>();
        this.annotations.forEach(annotation => {
            const layer = annotation.layerName || DEFAULT_LAYER;
            const entries = grouped.get(layer) || [];
            entries.push(annotation);
            grouped.set(layer, entries);
        });
        return grouped;
    }

    @action.bound
    beginSlide(slideKey: string) {
        const leftUnsaved = this.flushPointsDetached();
        this.restartRequests();
        this.slideKey = slideKey;
        this.annotations = [];
        this.listFilter = EMPTY_LIST_FILTER;
        this.undoStack = [];
        this.importPreview = null;
        this.importError = null;
        this.error = null;
        this.accessIssue = null;
        this.pointsLeftUnsaved = leftUnsaved;
        this.loading = Boolean(this.apiUrl);
        this.destroyAnnotorious();
        if (this.apiUrl) {
            void this.loadAnnotations(slideKey, this.loadGeneration);
        }
    }

    /**
     * Points the controller at a new annotation API or study. Pending requests
     * for the previous context are dropped and the current slide, if any, is
     * reloaded against the new one.
     */
    @action.bound
    setContext(apiUrl: string | null | undefined, studyId: string | undefined) {
        const leftUnsaved = this.flushPointsDetached();
        if (apiUrl !== this.apiUrl) {
            this.reviewRoute = null;
            this.batchRoute = null;
        }
        this.apiUrl = apiUrl;
        this.studyId = studyId;
        this.undoStack = [];
        this.restartRequests();
        this.cancelDrawing();
        this.annotations = [];
        this.error = null;
        this.accessIssue = null;
        this.pointsLeftUnsaved = leftUnsaved;
        this.annotationTooltip = null;
        this.applyLayerFilter();
        const slideKey = this.slideKey;
        this.loading = Boolean(this.apiUrl && slideKey);
        if (this.apiUrl && slideKey) {
            void this.loadAnnotations(slideKey, this.loadGeneration);
        }
    }

    private restartRequests() {
        this.generation += 1;
        this.loadGeneration += 1;
        this.abortController?.abort();
        this.loadAbortController?.abort();
        this.abortController = new AbortController();
        this.loadAbortController = new AbortController();
    }

    @action.bound
    attachViewer(viewer: any, openSeadragon: any, slideKey: string) {
        if (!this.apiUrl || this.slideKey !== slideKey) return;
        this.destroyAnnotorious();
        const loaded = getLoadedAnnotorious();
        if (loaded) {
            this.createAnnotator(loaded, viewer, openSeadragon, slideKey);
            return;
        }
        // Annotorious is its own async chunk, fetched on the first slide
        // opened with annotations enabled.
        const attachGeneration = this.attachGeneration;
        loadAnnotorious().then(
            annotorious => {
                if (
                    attachGeneration !== this.attachGeneration ||
                    this.slideKey !== slideKey
                ) {
                    return;
                }
                this.createAnnotator(
                    annotorious,
                    viewer,
                    openSeadragon,
                    slideKey
                );
            },
            () => {
                if (
                    attachGeneration !== this.attachGeneration ||
                    this.slideKey !== slideKey
                ) {
                    return;
                }
                action(() => {
                    this.error = 'Annotation tools failed to load';
                })();
            }
        );
    }

    @action
    private createAnnotator(
        annotorious: AnnotoriousModule,
        viewer: any,
        openSeadragon: any,
        slideKey: string
    ) {
        this.osdViewer = viewer;
        this.openSeadragon = openSeadragon;
        this.annotorious = annotorious.createOSDAnnotator(viewer, {
            drawingEnabled: false,
            drawingMode: 'drag',
            adapter: annotorious.W3CImageFormat(slideKey),
        });
        this.annotorious.on('createAnnotation', (annotation: WsiAnnotation) => {
            if (this.synchronizing) return;
            annotation.color = this.activeColor;
            annotation.colorName = this.activeColorName;
            annotation.layerName = this.activeLayer;
            if (!annotation.body?.[0]?.value) {
                annotation.body = [
                    {
                        type: 'TextualBody',
                        value: this.newShapeLabel(),
                        purpose: 'commenting',
                    },
                ];
            }
            this.activeTool = null;
            this.annotorious?.setDrawingEnabled?.(false);
            void this.createAnnotation(annotation);
        });
        // A shape or its vertices were dragged: keep everything but the
        // geometry as stored.
        this.annotorious.on('updateAnnotation', (annotation: WsiAnnotation) => {
            if (this.synchronizing) return;
            const stored = this.annotations.find(
                item => item.id === annotation.id
            );
            void this.updateAnnotation(
                stored
                    ? {
                          ...stored,
                          target: {
                              ...stored.target,
                              selector: annotation.target.selector,
                          },
                      }
                    : annotation
            );
        });
        this.annotorious.on('deleteAnnotation', (annotation: WsiAnnotation) => {
            if (!this.synchronizing) void this.deleteAnnotation(annotation.id);
        });
        this.annotorious.on(
            'clickAnnotation',
            (annotation: WsiAnnotation, event: MouseEvent) => {
                this.showAnnotationTooltip(annotation, event);
            }
        );
        this.annotorious.setVisible(this.visible);
        this.pointLayer = new WsiPointLayer(viewer, openSeadragon);
        this.pointLayer.setVisible(this.visible);
        if (viewer.addHandler) {
            viewer.addHandler('canvas-click', this.handleCanvasClick);
            this.canvasClickCleanup = () =>
                viewer.removeHandler?.('canvas-click', this.handleCanvasClick);
        }
        this.applySelectAction();
        this.applyLayerFilter();
        this.refreshStyle();
        this.installCustomDrawingHandlers();
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', this.handleKeyDown);
            this.keydownCleanup = () =>
                document.removeEventListener('keydown', this.handleKeyDown);
            document.addEventListener(
                'visibilitychange',
                this.handleVisibilityChange
            );
            window.addEventListener('pagehide', this.handlePageHide);
            this.pageHideCleanup = () => {
                document.removeEventListener(
                    'visibilitychange',
                    this.handleVisibilityChange
                );
                window.removeEventListener('pagehide', this.handlePageHide);
            };
        }
    }

    /**
     * Lets Annotorious edit only the shapes the user may change; others can
     * be selected, for their tooltip, but not moved.
     */
    private applySelectAction() {
        if (!this.annotorious) return;
        if (!this.canEdit) {
            this.annotorious.setUserSelectAction?.('SELECT');
        } else if (this.currentUser) {
            this.annotorious.setUserSelectAction?.(
                (annotation: WsiAnnotation) => {
                    const stored = this.annotations.find(
                        item => item.id === annotation.id
                    );
                    return this.canModify(stored || annotation)
                        ? 'EDIT'
                        : 'SELECT';
                }
            );
        } else {
            this.annotorious.setUserSelectAction?.('EDIT');
        }
    }

    @action.bound
    detachViewer() {
        void this.flushPoints();
        this.destroyAnnotorious();
    }

    @action.bound
    invalidatePendingRequests() {
        this.flushPointsDetached();
        this.generation += 1;
        this.loadGeneration += 1;
        this.abortController?.abort();
        this.loadAbortController?.abort();
        this.abortController = null;
        this.loadAbortController = null;
        this.slideKey = null;
        this.annotations = [];
        this.undoStack = [];
        this.error = null;
        this.annotationTooltip = null;
        this.loading = false;
        this.destroyAnnotorious();
    }

    @action.bound
    setTool(tool: WsiAnnotationTool) {
        if (tool !== null && !this.canEdit) return;
        void this.flushPoints();
        this.activeTool = tool;
        this.customDrawPreview = null;
        this.brushCursor = null;
        this.pointerDown = null;
        this.strokePoints = [];
        this.strokeScreenPoints = [];
        this.polygonPoints = [];
        this.polygonScreenPoints = [];
        if (!this.annotorious) return;
        const pointerDrawing = isPointerAnnotationTool(tool);
        this.annotorious.cancelDrawing?.();
        this.annotorious.setDrawingEnabled?.(false);
        this.setAnnotoriousOverlayPointerEvents(!pointerDrawing);
        this.setCustomPointerEvents(pointerDrawing);
    }

    /** Whether the brush width is in µm (the slide has a scale). */
    @computed get brushInMicrons(): boolean {
        return !!this.mpp;
    }

    /** The brush width in its unit: µm, or screen pixels without a scale. */
    @computed get brushWidth(): number {
        return this.brushInMicrons ? this.brushWidthUm : this.brushWidthPx;
    }

    /** Sets the brush width in its current unit (see `brushWidth`). */
    @action.bound
    setBrushWidth(width: number) {
        if (!(width > 0)) return;
        if (this.brushInMicrons) this.brushWidthUm = width;
        else this.brushWidthPx = width;
    }

    /** The brush width in image pixels, with `imagePerScreen` at this zoom. */
    private brushImageWidth(imagePerScreen: number): number {
        return brushWidthInImagePixels(
            { microns: this.brushWidthUm, screenPixels: this.brushWidthPx },
            this.mpp,
            imagePerScreen
        );
    }

    /** The brush width on screen at the current zoom, in pixels. */
    private brushScreenWidth(): number {
        const imagePerScreen = this.imagePixelsPerScreenPixel();
        return this.brushImageWidth(imagePerScreen) / imagePerScreen;
    }

    @action.bound
    cancelDrawing() {
        void this.flushPoints();
        this.strokePoints = [];
        this.strokeScreenPoints = [];
        this.activeTool = null;
        this.brushCursor = null;
        this.annotorious?.cancelDrawing?.();
        this.annotorious?.setDrawingEnabled?.(false);
        this.setAnnotoriousOverlayPointerEvents(true);
        this.setCustomPointerEvents(false);
        this.customDrawPreview = null;
        this.pointerDown = null;
        this.polygonPoints = [];
        this.polygonScreenPoints = [];
    }

    @action.bound
    toggleVisible() {
        this.visible = !this.visible;
        this.annotorious?.setVisible?.(this.visible);
        this.pointLayer?.setVisible(this.visible);
        if (!this.visible) this.annotationTooltip = null;
    }

    @action.bound
    dismissAnnotationTooltip() {
        this.annotationTooltip = null;
    }

    @action.bound
    setActiveColor(color: string) {
        this.activeColor = color || DEFAULT_COLOR;
    }

    @action.bound
    setActiveNamedColor(name: string, hex: string) {
        this.activeColorName = name;
        this.activeColor = HEX_COLOR_RE.test(hex) ? hex : DEFAULT_COLOR;
        this.refreshStyle();
    }

    @action.bound
    addNamedColor(name: string, hex: string) {
        const normalizedName = name.trim().replace(/\|/g, '');
        if (!normalizedName || !HEX_COLOR_RE.test(hex)) return;
        if (
            !this.customColors.some(
                color => color.name === normalizedName && color.hex === hex
            )
        ) {
            this.customColors = [
                ...this.customColors,
                { name: normalizedName, hex },
            ];
            saveNamedColors(this.customColors);
        }
        this.setActiveNamedColor(normalizedName, hex);
    }

    /** Only user-added colors that no annotation uses can be removed. */
    canRemoveNamedColor(name: string, hex: string): boolean {
        const matches = (color: NamedColor) =>
            color.name === name && color.hex === hex;
        return (
            this.customColors.some(matches) &&
            !DEFAULT_NAMED_COLORS.some(matches) &&
            !this.annotations.some(
                annotation =>
                    (annotation.colorName || '') === name &&
                    annotation.color === hex
            )
        );
    }

    @action.bound
    removeNamedColor(name: string, hex: string) {
        this.customColors = this.customColors.filter(
            color => color.name !== name || color.hex !== hex
        );
        saveNamedColors(this.customColors);
        if (this.activeColorName === name && this.activeColor === hex) {
            const fallback = this.namedColors[0] || DEFAULT_NAMED_COLORS[0];
            this.setActiveNamedColor(fallback.name, fallback.hex);
        }
    }

    @action.bound
    setActiveLayer(layer: string) {
        this.activeLayer = layer;
        if (!this.customLayers.includes(layer)) {
            this.customLayers = [...this.customLayers, layer];
            saveLayerNames(this.customLayers);
        }
    }

    @action.bound
    addLayer(layer: string) {
        const normalized = layer.replace(/\|/g, '').trim();
        if (!normalized || this.customLayers.includes(normalized)) return;
        this.customLayers = [...this.customLayers, normalized];
        saveLayerNames(this.customLayers);
        this.activeLayer = normalized;
    }

    @action.bound
    toggleLayerVisibility(layer: string) {
        const hidden = new Set(this.hiddenLayerNames);
        if (hidden.has(layer)) {
            hidden.delete(layer);
        } else {
            hidden.add(layer);
            this.annotorious?.cancelSelected?.();
            if (this.annotationTooltip?.layerName === layer) {
                this.annotationTooltip = null;
            }
        }
        this.hiddenLayerNames = hidden;
        this.applyLayerFilter();
    }

    @action.bound
    async deleteLayer(layer: string) {
        if (layer === DEFAULT_LAYER) return;
        const annotations = this.annotations.filter(
            annotation =>
                (annotation.layerName || DEFAULT_LAYER) === layer &&
                this.canModify(annotation)
        );
        const deleted: WsiAnnotation[] = [];
        for (const annotation of annotations) {
            if (await this.deleteAnnotation(annotation.id, false)) {
                deleted.push(annotation);
            }
        }
        if (deleted.length) this.pushUndo({ kind: 'delete', before: deleted });
        this.customLayers = this.customLayers.filter(item => item !== layer);
        saveLayerNames(this.customLayers);
        const hidden = new Set(this.hiddenLayerNames);
        hidden.delete(layer);
        this.hiddenLayerNames = hidden;
        if (this.activeLayer === layer) {
            this.activeLayer = this.layerNames[0] || DEFAULT_LAYER;
        }
        this.applyLayerFilter();
    }

    @action.bound
    async renameAnnotation(id: string, label: string) {
        const annotation = this.annotations.find(item => item.id === id);
        if (!annotation || !this.isAllowedLabel(label)) return;
        const updated = {
            ...annotation,
            body: [
                {
                    type: 'TextualBody' as const,
                    value: label,
                    purpose: 'commenting' as const,
                },
            ],
        };
        await this.updateAnnotation(updated);
    }

    /** Saves the user's free-text note (`body.comment`). */
    @action.bound
    async setAnnotationNote(id: string, note: string) {
        const annotation = this.annotations.find(item => item.id === id);
        if (!annotation || (annotation.note || '') === note) return;
        await this.updateAnnotation({
            ...annotation,
            note,
            legacyComment: undefined,
        });
    }

    @action.bound
    async removeAnnotation(id: string) {
        await this.deleteAnnotation(id);
    }

    /** Accepts an AI annotation (see `reviewAnnotation`). */
    @action.bound
    async acceptAnnotation(id: string) {
        await this.reviewAnnotation(id, 'accept');
    }

    /** Rejects an AI annotation (see `reviewAnnotation`). */
    @action.bound
    async rejectAnnotation(id: string) {
        await this.reviewAnnotation(id, 'reject');
    }

    /**
     * Records a review of an unreviewed AI annotation with the service's
     * review route, which any user of the study may use: accepted, it stays
     * and shows as accepted; rejected, the service keeps it for its audit
     * trail and the viewer stops showing it. Reviews are not undone by Undo.
     *
     * A service without the route (404 or 405 not about the annotation)
     * falls back to the creator-only update (accept) and delete (reject).
     */
    @action.bound
    async reviewAnnotation(
        id: string,
        decision: 'accept' | 'reject'
    ): Promise<boolean> {
        const annotation = this.annotations.find(item => item.id === id);
        if (!annotation || !this.canReview(annotation)) return false;
        if (this.reviewRoute === false) {
            return this.reviewWithoutRoute(annotation, decision);
        }
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        try {
            const response = await this.request(
                `/annotations/${encodeURIComponent(id)}/review`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        decision,
                        version: annotation.version || 1,
                    }),
                },
                context.signal
            );
            if (!this.isCurrent(context)) return false;
            if (
                (response.status === 404 || response.status === 405) &&
                !(await this.isMissingAnnotation(response))
            ) {
                action(() => {
                    this.reviewRoute = false;
                })();
                return this.reviewWithoutRoute(annotation, decision);
            }
            if (await this.refuseNonCreator(response)) return false;
            if (this.refuseAccess(response)) return false;
            if (response.status === 404) {
                await this.reloadCurrentSlide(
                    'The annotation was deleted elsewhere; reloaded latest data.'
                );
                return false;
            }
            if (response.status === 409) {
                await this.reloadCurrentSlide(
                    'Annotation changed elsewhere; reloaded latest data.'
                );
                return false;
            }
            if (!response.ok) {
                throw new Error(
                    `Annotation review failed (${response.status})`
                );
            }
            const saved = this.fromApi(
                await response.json(),
                this.slideKey || ''
            );
            if (!this.isCurrent(context)) return false;
            action(() => {
                this.reviewRoute = true;
                if (isRejectedAi(saved.provenance)) {
                    this.removeAnnotationLocally(id);
                } else {
                    this.replaceAnnotation(id, saved);
                }
            })();
            return true;
        } catch (_) {
            if (!this.isCurrent(context)) return false;
            await this.reloadCurrentSlide('Unable to save the review.');
            return false;
        }
    }

    /** Whether a 404 says the annotation is missing, not the route. */
    private async isMissingAnnotation(response: Response): Promise<boolean> {
        if (response.status !== 404 || typeof response.clone !== 'function') {
            return false;
        }
        try {
            const detail = (await response.clone().json())?.detail;
            return typeof detail === 'string' && /annotation/i.test(detail);
        } catch (_) {
            return false;
        }
    }

    /**
     * A review against a service without the review route: its creator
     * accepts with a versioned update and rejects by deleting.
     */
    private async reviewWithoutRoute(
        annotation: WsiAnnotation,
        decision: 'accept' | 'reject'
    ): Promise<boolean> {
        if (!this.canModify(annotation)) {
            action(() => {
                this.error = WSI_REVIEW_UNSUPPORTED_MESSAGE;
            })();
            return false;
        }
        const done =
            decision === 'accept'
                ? !!(await this.updateAnnotation({
                      ...annotation,
                      provenance: acceptedProvenance(annotation.provenance),
                  }))
                : await this.deleteAnnotation(annotation.id);
        action(() => {
            this.error = WSI_REVIEW_UNSUPPORTED_MESSAGE;
        })();
        return done;
    }

    @action.bound
    setDefaultShared(shared: boolean) {
        this.defaultShared = shared;
        saveDefaultShared(shared);
    }

    /** Shares an annotation with the study, or makes it private. */
    @action.bound
    async setAnnotationShared(id: string, shared: boolean) {
        const annotation = this.annotations.find(item => item.id === id);
        if (!annotation) return;
        await this.updateAnnotation({
            ...annotation,
            visibleTo: shared ? [] : null,
        });
    }

    @action.bound
    toggleHideUnreviewedAi() {
        this.hideUnreviewedAi = !this.hideUnreviewedAi;
        if (this.hideUnreviewedAi) this.annotorious?.cancelSelected?.();
        this.applyLayerFilter();
    }

    private request(
        path: string,
        init: RequestInit = {},
        signal: AbortSignal | undefined = this.abortController?.signal
    ) {
        return wsiServiceFetch(this.apiUrl || '', path, this.studyId, {
            ...init,
            signal,
        });
    }

    /**
     * Records a 401 or 403 from the service and turns editing off; returns
     * whether the response was one. The request is not retried.
     */
    @action
    private refuseAccess(response: Response): boolean {
        const issue = wsiServiceAccessIssue(response.status);
        if (!issue) return false;
        this.accessIssue = issue;
        this.error = WSI_ANNOTATION_ACCESS_MESSAGES[issue];
        this.loading = false;
        this.cancelDrawing();
        this.annotorious?.setUserSelectAction?.('SELECT');
        return true;
    }

    /**
     * Records the service's refusal to change another user's annotation, or
     * to review one that is not AI-made; returns whether `response` was one.
     * The study stays editable.
     */
    private async refuseNonCreator(response: Response): Promise<boolean> {
        if (response.status !== 403 || typeof response.clone !== 'function') {
            return false;
        }
        try {
            const detail = (await response.clone().json())?.detail;
            if (
                typeof detail === 'string' &&
                /only the creator/i.test(detail)
            ) {
                action(() => {
                    this.error = 'Only its creator can change this annotation.';
                })();
                return true;
            }
            if (
                typeof detail === 'string' &&
                /only machine-made/i.test(detail)
            ) {
                action(() => {
                    this.error = 'Only AI annotations can be reviewed.';
                })();
                return true;
            }
        } catch (_) {
            // Not the service's JSON refusal: the proxy refused the study.
        }
        return false;
    }

    // The annotation service's slide_id field carries the opaque slide key
    // (contract wsi-serving-v5); the browser never holds the image ID. The
    // list is scoped to the request's studyId (added by wsiServiceFetch),
    // the study the proxy authorizes; the service ignores a study_id query.
    private async loadAnnotations(slideKey: string, loadGeneration: number) {
        try {
            const response = await this.request(
                `/annotations?slide_id=${encodeURIComponent(slideKey)}`,
                {},
                this.loadAbortController?.signal
            );
            if (
                loadGeneration === this.loadGeneration &&
                this.slideKey === slideKey &&
                this.refuseAccess(response)
            ) {
                return;
            }
            if (!response.ok)
                throw new Error(`Annotation load failed (${response.status})`);
            const raw = (await response.json()) as any[];
            if (
                loadGeneration !== this.loadGeneration ||
                this.slideKey !== slideKey
            )
                return;
            // A rejected AI annotation is kept by the service for its audit
            // trail; the viewer does not show it.
            const annotations = raw
                .map(item => this.fromApi(item, slideKey))
                .filter(annotation => !isRejectedAi(annotation.provenance));
            action(() => {
                this.annotations = annotations;
                this.loading = false;
                this.error = null;
                this.applyLayerFilter();
            })();
        } catch (error) {
            if (
                loadGeneration !== this.loadGeneration ||
                (error as Error).name === 'AbortError'
            )
                return;
            action(() => {
                this.loading = false;
                this.error = 'Unable to load annotations.';
            })();
        }
    }

    /** Saves a new annotation; resolves to the saved one, or null. */
    private async createAnnotation(
        annotation: WsiAnnotation,
        record = true
    ): Promise<WsiAnnotation | null> {
        if (!this.slideKey) return null;
        if (!this.canEdit) {
            this.removeAnnotationLocally(annotation.id);
            return null;
        }
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        const slideKey = context.slideKey;
        const payload = this.createPayload(annotation, slideKey);
        try {
            const response = await this.request(
                '/annotations',
                {
                    method: 'POST',
                    body: JSON.stringify(payload),
                },
                context.signal
            );
            if (this.isCurrent(context) && this.refuseAccess(response)) {
                this.removeAnnotationLocally(annotation.id);
                return null;
            }
            if (!response.ok)
                throw new Error(
                    `Annotation create failed (${response.status})`
                );
            if (
                context.generation !== this.generation ||
                context.slideKey !== this.slideKey ||
                context.signal?.aborted
            ) {
                return null;
            }
            const saved = this.fromApi(await response.json(), slideKey);
            this.synchronizing = true;
            try {
                // A reload may already have brought in the saved annotation.
                this.annotations = [
                    ...this.annotations.filter(
                        item =>
                            item.id !== annotation.id && item.id !== saved.id
                    ),
                    saved,
                ];
                this.applyLayerFilter(!this.isPoint(saved));
                if (!this.isPoint(saved)) this.refreshStyle();
            } finally {
                this.synchronizing = false;
            }
            if (record) this.pushUndo({ kind: 'create', ids: [saved.id] });
            return saved;
        } catch (_) {
            if (
                context.generation !== this.generation ||
                context.slideKey !== this.slideKey ||
                context.signal?.aborted
            ) {
                return null;
            }
            this.removeAnnotationLocally(annotation.id);
            this.error = 'Unable to save annotation.';
            return null;
        }
    }

    /**
     * Saves an edit with the annotation's version; resolves to the saved
     * annotation, or null. With `record`, undo can put the old one back.
     */
    private async updateAnnotation(
        annotation: WsiAnnotation,
        record = true
    ): Promise<WsiAnnotation | null> {
        const before = this.annotations.find(item => item.id === annotation.id);
        if (!this.canEdit) {
            this.applyLayerFilter();
            return null;
        }
        const queued = this.pointQueue.findIndex(
            item => item.id === annotation.id
        );
        if (queued >= 0) {
            // Not sent yet: the save sends the edited point.
            this.pointQueue[queued] = annotation;
            this.replaceAnnotation(annotation.id, annotation);
            return annotation;
        }
        const inFlight = this.pointsInFlight.get(annotation.id);
        if (inFlight) {
            // Being saved: show the edit now, then save it on the saved id.
            this.replaceAnnotation(annotation.id, annotation);
            const saved = await inFlight;
            if (!saved) return null;
            return this.updateAnnotation(
                {
                    ...annotation,
                    id: saved.id,
                    version: saved.version,
                    creator: saved.creator,
                    created: saved.created,
                },
                record
            );
        }
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        try {
            const response = await this.request(
                `/annotations/${encodeURIComponent(annotation.id)}`,
                {
                    method: 'PUT',
                    body: JSON.stringify({
                        body: this.toApiBody(annotation),
                        target: { selector: annotation.target.selector },
                        // Sent only when known: the service keeps the
                        // stored value when the field is absent.
                        ...(annotation.visibleTo !== undefined
                            ? { visible_to: annotation.visibleTo }
                            : {}),
                        version: annotation.version || 1,
                    }),
                },
                context.signal
            );
            if (
                this.isCurrent(context) &&
                (await this.refuseNonCreator(response))
            ) {
                this.applyLayerFilter();
                return null;
            }
            if (this.isCurrent(context) && this.refuseAccess(response)) {
                // Put the edited shape back as it is saved.
                this.applyLayerFilter();
                return null;
            }
            if (response.status === 409) {
                if (
                    context.generation !== this.generation ||
                    context.slideKey !== this.slideKey ||
                    context.signal?.aborted
                ) {
                    return null;
                }
                await this.reloadCurrentSlide(
                    'Annotation changed elsewhere; reloaded latest data.'
                );
                return null;
            }
            if (!response.ok)
                throw new Error(
                    `Annotation update failed (${response.status})`
                );
            if (
                context.generation !== this.generation ||
                context.slideKey !== this.slideKey ||
                context.signal?.aborted
            ) {
                return null;
            }
            const saved = this.fromApi(
                await response.json(),
                this.slideKey || ''
            );
            this.replaceAnnotation(annotation.id, saved);
            if (record && before) this.pushUndo({ kind: 'update', before });
            return saved;
        } catch (_) {
            if (
                context.generation !== this.generation ||
                context.slideKey !== this.slideKey ||
                context.signal?.aborted
            ) {
                return null;
            }
            await this.reloadCurrentSlide('Unable to update annotation.');
            return null;
        }
    }

    /**
     * Deletes an annotation; resolves to whether it is gone. With `record`,
     * undo can create it again.
     */
    private async deleteAnnotation(
        id: string,
        record = true
    ): Promise<boolean> {
        const before = this.annotations.find(item => item.id === id);
        if (!this.canEdit) {
            this.applyLayerFilter();
            return false;
        }
        const queued = this.pointQueue.findIndex(item => item.id === id);
        if (queued >= 0) {
            // Not sent yet: drop it from the save.
            this.pointQueue.splice(queued, 1);
            this.removeAnnotationLocally(id);
            return true;
        }
        const inFlight = this.pointsInFlight.get(id);
        if (inFlight) {
            // Being saved: delete it once it has its saved id.
            const saved = await inFlight;
            if (!saved) {
                this.removeAnnotationLocally(id);
                return true;
            }
            return this.deleteAnnotation(saved.id, record);
        }
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        try {
            const response = await this.request(
                `/annotations/${encodeURIComponent(id)}`,
                {
                    method: 'DELETE',
                },
                context.signal
            );
            if (
                this.isCurrent(context) &&
                (await this.refuseNonCreator(response))
            ) {
                this.applyLayerFilter();
                return false;
            }
            if (this.isCurrent(context) && this.refuseAccess(response)) {
                // Put the deleted shape back.
                this.applyLayerFilter();
                return false;
            }
            if (!response.ok && response.status !== 404)
                throw new Error(
                    `Annotation delete failed (${response.status})`
                );
            if (
                context.generation !== this.generation ||
                context.slideKey !== this.slideKey ||
                context.signal?.aborted
            ) {
                return false;
            }
            this.removeAnnotationLocally(id);
            if (record && before) {
                this.pushUndo({ kind: 'delete', before: [before] });
            }
            return true;
        } catch (_) {
            if (
                context.generation !== this.generation ||
                context.slideKey !== this.slideKey ||
                context.signal?.aborted
            ) {
                return false;
            }
            await this.reloadCurrentSlide('Unable to delete annotation.');
            return false;
        }
    }

    /** The service's create body for `annotation` on `slideKey`. */
    private createPayload(
        annotation: WsiAnnotation,
        slideKey: string
    ): WsiCreatePayload {
        return {
            slide_id: slideKey,
            study_id: this.studyId || '',
            body: this.toApiBody(annotation),
            target: { selector: annotation.target.selector },
            visible_to:
                annotation.visibleTo !== undefined
                    ? annotation.visibleTo
                    : this.defaultShared
                    ? []
                    : null,
        };
    }

    /**
     * Saves new annotations with the service's batch route, in requests of at
     * most `BATCH_MAX_ITEMS` and about 3 MiB (60 KiB with `keepalive`).
     * Resolves to one result per annotation, in order. Nothing changes in
     * `annotations`; see `addSaved`.
     *
     * The service saves a batch whole or not at all. A 422 that names items
     * marks those refused and sends the rest again, once; a 413 halves the
     * request. A service without the route (404 or 405) gets single POSTs
     * from then on.
     */
    private async saveAnnotations(
        annotations: WsiAnnotation[],
        options: {
            keepalive?: boolean;
            onProgress?: (done: number, failed: number) => void;
        } = {}
    ): Promise<WsiSaveResult[]> {
        const results: WsiSaveResult[] = annotations.map(() => ({
            reason: 'not saved',
        }));
        const slideKey = this.slideKey;
        if (!slideKey || !this.canWrite) return results;
        const context = {
            generation: this.generation,
            slideKey,
            signal: this.abortController?.signal,
        };
        const payloads = annotations.map(annotation =>
            this.createPayload(annotation, slideKey)
        );
        const sizes = payloads.map(payload => JSON.stringify(payload).length);
        const chunks = chunkBySize(
            sizes,
            BATCH_MAX_ITEMS,
            options.keepalive ? KEEPALIVE_MAX_BYTES : BATCH_MAX_BYTES
        );
        let done = 0;
        let failed = 0;
        for (const chunk of chunks) {
            if (!this.isCurrent(context)) break;
            await this.saveChunk(chunk, payloads, results, context, {
                keepalive: !!options.keepalive,
                retry: true,
            });
            done += chunk.length;
            failed += chunk.filter(index => results[index].reason).length;
            options.onProgress?.(done, failed);
        }
        return results;
    }

    private async saveChunk(
        indices: number[],
        payloads: WsiCreatePayload[],
        results: WsiSaveResult[],
        context: {
            generation: number;
            slideKey: string;
            signal?: AbortSignal;
        },
        options: { keepalive: boolean; retry: boolean }
    ): Promise<void> {
        const fail = (index: number, reason: string) => {
            results[index] = { reason };
        };
        // A `keepalive` save may be the page's last request, with no chance
        // to fall back on a 404: it uses the batch route only when known.
        if (
            this.batchRoute === false ||
            (options.keepalive && this.batchRoute !== true)
        ) {
            await this.saveSingles(
                indices,
                payloads,
                results,
                context,
                options
            );
            return;
        }
        let response: Response;
        try {
            response = await this.request(
                '/annotations/batch',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        annotations: indices.map(index => payloads[index]),
                    }),
                    keepalive: options.keepalive || undefined,
                },
                context.signal
            );
        } catch (_) {
            indices.forEach(index => fail(index, 'network error'));
            return;
        }
        if (!this.isCurrent(context)) return;
        if (response.status === 404 || response.status === 405) {
            action(() => {
                this.batchRoute = false;
            })();
            await this.saveSingles(
                indices,
                payloads,
                results,
                context,
                options
            );
            return;
        }
        if (this.refuseAccess(response)) {
            indices.forEach(index => fail(index, 'no access'));
            return;
        }
        if (response.status === 413 && indices.length > 1) {
            const half = Math.ceil(indices.length / 2);
            for (const part of [indices.slice(0, half), indices.slice(half)]) {
                await this.saveChunk(part, payloads, results, context, options);
            }
            return;
        }
        if (response.status === 422) {
            let detail: unknown;
            try {
                detail = (await response.json())?.detail;
            } catch (_) {
                detail = undefined;
            }
            const errors = batchItemErrors(detail);
            if (!errors.size || !options.retry) {
                const reason = typeof detail === 'string' ? detail : 'refused';
                indices.forEach(index => fail(index, reason));
                return;
            }
            indices.forEach((index, position) => {
                const reason = errors.get(position);
                if (reason) fail(index, reason);
            });
            const rest = indices.filter((_, position) => !errors.has(position));
            if (rest.length) {
                await this.saveChunk(rest, payloads, results, context, {
                    ...options,
                    retry: false,
                });
            }
            return;
        }
        if (!response.ok) {
            indices.forEach(index =>
                fail(index, `save failed (${response.status})`)
            );
            return;
        }
        let rows: unknown;
        try {
            rows = await response.json();
        } catch (_) {
            rows = null;
        }
        if (!Array.isArray(rows) || rows.length !== indices.length) {
            indices.forEach(index => fail(index, 'unexpected response'));
            return;
        }
        action(() => {
            this.batchRoute = true;
        })();
        rows.forEach((row, position) => {
            results[indices[position]] = {
                annotation: this.fromApi(row, context.slideKey),
            };
        });
    }

    /**
     * Saves annotations one POST each, a few at a time; with `keepalive`
     * (the page may be going away), all at once.
     */
    private async saveSingles(
        indices: number[],
        payloads: WsiCreatePayload[],
        results: WsiSaveResult[],
        context: {
            generation: number;
            slideKey: string;
            signal?: AbortSignal;
        },
        options: { keepalive: boolean }
    ): Promise<void> {
        const queue = indices.slice();
        const worker = async () => {
            while (queue.length && this.isCurrent(context)) {
                const index = queue.shift()!;
                try {
                    const response = await this.request(
                        '/annotations',
                        {
                            method: 'POST',
                            body: JSON.stringify(payloads[index]),
                            keepalive: options.keepalive || undefined,
                        },
                        context.signal
                    );
                    if (!this.isCurrent(context)) return;
                    if (this.refuseAccess(response)) {
                        results[index] = { reason: 'no access' };
                    } else if (!response.ok) {
                        results[index] = {
                            reason: `save failed (${response.status})`,
                        };
                    } else {
                        results[index] = {
                            annotation: this.fromApi(
                                await response.json(),
                                context.slideKey
                            ),
                        };
                    }
                } catch (_) {
                    results[index] = { reason: 'network error' };
                }
            }
        };
        const workers = options.keepalive
            ? indices.length
            : SINGLE_SAVE_CONCURRENCY;
        await Promise.all(Array.from({ length: workers }, () => worker()));
    }

    /**
     * Puts saved annotations in `annotations`, in place of their `drafts`
     * when those are shown, and removes the drafts that were not saved;
     * returns the saved ones. A reload may already have brought one in.
     */
    private addSaved(
        results: WsiSaveResult[],
        drafts: WsiAnnotation[] = []
    ): WsiAnnotation[] {
        const saved = results
            .map(result => result.annotation)
            .filter((item): item is WsiAnnotation => !!item);
        if (!drafts.length && !saved.length) return saved;
        const draftIds = new Set(drafts.map(draft => draft.id));
        const savedIds = new Set(saved.map(item => item.id));
        action(() => {
            this.synchronizing = true;
            try {
                this.annotations = [
                    ...this.annotations.filter(
                        item => !draftIds.has(item.id) && !savedIds.has(item.id)
                    ),
                    ...saved,
                ];
                const shapes = saved.some(item => !this.isPoint(item));
                this.applyLayerFilter(shapes);
                if (shapes) this.refreshStyle();
            } finally {
                this.synchronizing = false;
            }
        })();
        return saved;
    }

    private isCurrent(context: {
        generation: number;
        slideKey: string | null;
        signal?: AbortSignal;
    }): boolean {
        return (
            context.generation === this.generation &&
            context.slideKey === this.slideKey &&
            !context.signal?.aborted
        );
    }

    private async reloadCurrentSlide(message: string) {
        if (!this.slideKey) return;
        const slideKey = this.slideKey;
        const loadGeneration = ++this.loadGeneration;
        this.loadAbortController?.abort();
        this.loadAbortController = new AbortController();
        await this.loadAnnotations(slideKey, loadGeneration);
        if (
            loadGeneration === this.loadGeneration &&
            this.slideKey === slideKey &&
            this.accessIssue === null
        ) {
            this.error = message;
        }
    }

    private replaceAnnotation(oldId: string, replacement: WsiAnnotation) {
        const next = this.annotations.map(item =>
            item.id === oldId ? replacement : item
        );
        this.annotations = next;
        this.applyLayerFilter();
    }

    private removeAnnotationLocally(id: string) {
        this.annotations = this.annotations.filter(item => item.id !== id);
        this.applyLayerFilter();
        this.refreshStyle();
    }

    /**
     * The service body for `annotation`: the layer in `layer_name`, the
     * user's note in `comment` (a legacy row's stored comment until the note
     * is edited), and the stored provenance unchanged.
     */
    private toApiBody(annotation: WsiAnnotation): WsiAnnotationApiBody {
        const colorName = annotation.colorName ?? this.activeColorName;
        const color = annotation.color || this.activeColor;
        return {
            label: annotation.body?.[0]?.value || '',
            comment: annotation.note || annotation.legacyComment || '',
            type: serializeColorLabel(colorName, color),
            layer_name: annotation.layerName || this.activeLayer,
            color: serviceColor(
                HEX_COLOR_RE.test(color) ? color : DEFAULT_COLOR
            ),
            provenance: annotation.provenance ?? null,
        };
    }

    private fromApi(item: any, slideKey: string): WsiAnnotation {
        // `type` holds the named color; a body without one has only `color`.
        const parsedColor =
            !item.body?.type &&
            typeof item.body?.color === 'string' &&
            HEX_COLOR_RE.test(item.body.color)
                ? { name: '', color: item.body.color.toLowerCase() }
                : parseColor(item.body?.type);
        const { layerName, note, legacyComment } = readLayerAndNote(item.body);
        return {
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            type: 'Annotation',
            id: item.id,
            body: item.body?.label
                ? [
                      {
                          type: 'TextualBody',
                          value: item.body.label,
                          purpose: 'commenting',
                      },
                  ]
                : [],
            target: {
                source: slideKey,
                selector: (() => {
                    const selector = item.target?.selector || item.target;
                    if (
                        selector?.type === 'SvgSelector' &&
                        typeof selector.value === 'string'
                    ) {
                        return {
                            ...selector,
                            value: normalizeSvgSelector(selector.value),
                        };
                    }
                    return selector;
                })(),
            },
            created: item.created_at,
            creator: item.created_by,
            version: item.version,
            color: parsedColor.color,
            colorName: parsedColor.name,
            layerName,
            note,
            ...(legacyComment !== undefined ? { legacyComment } : {}),
            visibleTo: Array.isArray(item.visible_to)
                ? item.visible_to
                : item.visible_to === null
                ? null
                : undefined,
            provenance:
                item.body?.provenance &&
                typeof item.body.provenance === 'object'
                    ? item.body.provenance
                    : null,
        };
    }

    private installCustomDrawingHandlers() {
        const element = this.osdViewer?.element as HTMLElement | undefined;
        if (!element) return;
        const down = (event: PointerEvent) => {
            const tool = this.activeTool;
            if (!isPointerAnnotationTool(tool) || event.button !== 0) return;
            const rect = element.getBoundingClientRect();
            const image = this.imagePoint(
                event.clientX - rect.left,
                event.clientY - rect.top
            );
            if (!image) return;
            this.pointerDown = {
                tool,
                image,
                client: { x: event.clientX, y: event.clientY },
            };
            // A point drops on click; a drag still pans the slide.
            if (tool === 'point') return;
            const screenPoint = {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
            };
            if (isStrokeTool(tool)) {
                this.strokePoints = [image];
                this.strokeScreenPoints = [screenPoint];
                this.customDrawPreview = {
                    tool,
                    start: screenPoint,
                    current: screenPoint,
                    points: this.strokeScreenPoints,
                    strokeWidth:
                        tool === 'brush' ? this.brushScreenWidth() : undefined,
                };
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            const previewPoints =
                tool === 'polygon' ? this.polygonScreenPoints : undefined;
            this.customDrawPreview = {
                tool,
                start: {
                    x:
                        tool === 'polygon'
                            ? this.polygonScreenPoints[0]?.x ?? screenPoint.x
                            : screenPoint.x,
                    y:
                        tool === 'polygon'
                            ? this.polygonScreenPoints[0]?.y ?? screenPoint.y
                            : screenPoint.y,
                },
                current: screenPoint,
                points: previewPoints,
                imageStart: tool === 'polygon' ? undefined : image,
                imageCurrent: tool === 'polygon' ? undefined : image,
            };
            event.preventDefault();
            event.stopPropagation();
        };
        const move = (event: PointerEvent) => {
            const tool = this.activeTool;
            if (tool === 'brush') {
                const rect = element.getBoundingClientRect();
                this.brushCursor = {
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                    diameter: this.brushScreenWidth(),
                };
            }
            if (!isPointerAnnotationTool(tool) || !this.customDrawPreview)
                return;
            const rect = element.getBoundingClientRect();
            const current = {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
            };
            if (isStrokeTool(tool)) {
                const last = this.strokeScreenPoints[
                    this.strokeScreenPoints.length - 1
                ];
                const image =
                    !last ||
                    Math.hypot(current.x - last.x, current.y - last.y) >=
                        STROKE_SAMPLE_SPACING
                        ? this.imagePoint(current.x, current.y)
                        : null;
                if (image) {
                    this.strokePoints.push(image);
                    this.strokeScreenPoints = [
                        ...this.strokeScreenPoints,
                        current,
                    ];
                }
                this.customDrawPreview = {
                    ...this.customDrawPreview,
                    current,
                    points: this.strokeScreenPoints,
                };
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            this.customDrawPreview = {
                ...this.customDrawPreview,
                current,
                imageCurrent:
                    tool === 'polygon'
                        ? undefined
                        : this.imagePoint(current.x, current.y) || undefined,
            };
            event.preventDefault();
            event.stopPropagation();
        };
        const up = (event: PointerEvent) => {
            const start = this.pointerDown;
            if (!start || this.activeTool !== start.tool) return;
            this.pointerDown = null;
            const rect = element.getBoundingClientRect();
            const endPoint = this.imagePoint(
                event.clientX - rect.left,
                event.clientY - rect.top
            );
            if (!endPoint) return;

            if (isStrokeTool(start.tool)) {
                const points = [...this.strokePoints, endPoint];
                const scale = this.imagePixelsPerScreenPixel();
                this.strokePoints = [];
                this.strokeScreenPoints = [];
                this.customDrawPreview = null;
                void this.createStrokeShape(start.tool, points, scale);
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            if (start.tool === 'point') {
                const moved = Math.hypot(
                    event.clientX - start.client.x,
                    event.clientY - start.client.y
                );
                if (moved <= CLICK_TOLERANCE) this.createPoint(endPoint);
                return;
            }

            if (start.tool === 'polygon') {
                const moved = Math.hypot(
                    event.clientX - start.client.x,
                    event.clientY - start.client.y
                );
                if (moved > 15) {
                    // A drag is not a vertex; keep showing the polygon so far.
                    this.customDrawPreview = this.polygonScreenPoints.length
                        ? {
                              tool: 'polygon',
                              start: this.polygonScreenPoints[0],
                              current: this.polygonScreenPoints[
                                  this.polygonScreenPoints.length - 1
                              ],
                              points: this.polygonScreenPoints,
                          }
                        : null;
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                const screenPoint = {
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                };
                const first = this.polygonScreenPoints[0];
                const last = this.polygonScreenPoints[
                    this.polygonScreenPoints.length - 1
                ];
                // The clicks of a closing double-click land on the last vertex.
                const repeatsLast =
                    !!last &&
                    Math.hypot(
                        screenPoint.x - last.x,
                        screenPoint.y - last.y
                    ) <= 4;
                const closes =
                    this.polygonPoints.length >= 3 &&
                    first &&
                    Math.hypot(
                        screenPoint.x - first.x,
                        screenPoint.y - first.y
                    ) <= 20;
                if (closes) {
                    const points = this.polygonPoints;
                    this.polygonPoints = [];
                    this.polygonScreenPoints = [];
                    this.customDrawPreview = null;
                    void this.createPolygonShape(points);
                } else if (!repeatsLast) {
                    this.polygonPoints = [...this.polygonPoints, endPoint];
                    this.polygonScreenPoints = [
                        ...this.polygonScreenPoints,
                        screenPoint,
                    ];
                    this.customDrawPreview = {
                        tool: 'polygon',
                        start: this.polygonScreenPoints[0],
                        current: screenPoint,
                        points: this.polygonScreenPoints,
                    };
                }
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            this.customDrawPreview = null;
            void this.createCustomShape(start.image, endPoint, start.tool);
            event.preventDefault();
            event.stopPropagation();
        };
        const doubleClick = (event: MouseEvent) => {
            if (this.activeTool !== 'polygon' || this.polygonPoints.length < 3)
                return;
            const points = this.polygonPoints;
            this.polygonPoints = [];
            this.polygonScreenPoints = [];
            this.customDrawPreview = null;
            void this.createPolygonShape(points);
            event.preventDefault();
            event.stopPropagation();
        };
        element.addEventListener('pointerdown', down, true);
        element.addEventListener('pointermove', move, true);
        element.addEventListener('pointerup', up, true);
        element.addEventListener('dblclick', doubleClick, true);
        const leave = () => {
            this.brushCursor = null;
        };
        element.addEventListener('pointerleave', leave, true);
        this.pointerCleanup = () => {
            element.removeEventListener('pointerleave', leave, true);
            element.removeEventListener('pointerdown', down, true);
            element.removeEventListener('pointermove', move, true);
            element.removeEventListener('pointerup', up, true);
            element.removeEventListener('dblclick', doubleClick, true);
        };
    }

    private setCustomPointerEvents(enabled: boolean) {
        const element = this.osdViewer?.element as HTMLElement | undefined;
        if (element) element.style.cursor = enabled ? 'crosshair' : '';
    }

    private setAnnotoriousOverlayPointerEvents(enabled: boolean) {
        const canvas = this.osdViewer?.element?.querySelector?.(
            'canvas.a9s-gl-canvas'
        ) as HTMLElement | null | undefined;
        if (canvas) canvas.style.pointerEvents = enabled ? 'auto' : 'none';
    }

    private readonly handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && this.activeTool) {
            this.cancelDrawing();
            return;
        }
        // Ctrl+Z / Cmd+Z, unless the user is typing in a field.
        const target = event.target as HTMLElement | null;
        if (
            (event.ctrlKey || event.metaKey) &&
            !event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === 'z' &&
            !(
                target &&
                (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
                    target.isContentEditable)
            ) &&
            this.canUndo
        ) {
            event.preventDefault();
            void this.undo();
        }
    };

    private imagePoint(x: number, y: number): { x: number; y: number } | null {
        if (!this.osdViewer?.viewport || !this.openSeadragon) return null;
        const point = this.osdViewer.viewport.pointFromPixel(
            new this.openSeadragon.Point(x, y)
        );
        const imagePoint = this.osdViewer.viewport.viewportToImageCoordinates(
            point
        );
        return { x: imagePoint.x, y: imagePoint.y };
    }

    private async createCustomShape(
        start: { x: number; y: number },
        end: { x: number; y: number },
        tool: WsiPointerAnnotationTool
    ) {
        const cx = (start.x + end.x) / 2;
        const cy = (start.y + end.y) / 2;
        const rx = Math.abs(end.x - start.x) / 2;
        const ry = Math.abs(end.y - start.y) / 2;
        if (
            (tool === 'line' &&
                Math.hypot(end.x - start.x, end.y - start.y) < 3) ||
            (tool !== 'line' && (rx < 3 || ry < 3))
        ) {
            return;
        }
        const radius = Math.min(rx, ry);
        const selector =
            tool === 'rectangle'
                ? `<svg><rect x="${Math.min(start.x, end.x)}" y="${Math.min(
                      start.y,
                      end.y
                  )}" width="${Math.abs(end.x - start.x)}" height="${Math.abs(
                      end.y - start.y
                  )}" /></svg>`
                : tool === 'line'
                ? `<svg><line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" /></svg>`
                : `<svg><ellipse cx="${cx}" cy="${cy}" rx="${
                      tool === 'circle' ? radius : rx
                  }" ry="${tool === 'circle' ? radius : ry}" /></svg>`;
        const annotation = this.draftAnnotation(selector, this.newShapeLabel());
        // Release the tool before saving so a slow save cannot cut short
        // the next shape.
        this.cancelDrawing();
        await this.createAnnotation(annotation);
    }

    /** Image pixels per screen pixel at the current zoom. */
    private imagePixelsPerScreenPixel(): number {
        const a = this.imagePoint(0, 0);
        const b = this.imagePoint(100, 0);
        return a && b ? Math.hypot(b.x - a.x, b.y - a.y) / 100 || 1 : 1;
    }

    /**
     * Saves a freehand stroke as the polygon it encloses, or a brush stroke
     * as the outline of a band `brushWidth` wide along it (µm of tissue, or
     * screen pixels at the stroke's zoom without a scale). Either is
     * simplified with Douglas–Peucker first.
     */
    private async createStrokeShape(
        tool: 'freehand' | 'brush',
        points: Array<{ x: number; y: number }>,
        imagePerScreen: number
    ) {
        const path = simplifyPath(
            points,
            STROKE_SIMPLIFY_TOLERANCE * imagePerScreen
        );
        this.cancelDrawing();
        if (tool === 'freehand') {
            // The polygon closes itself; drop an end that returns to the start.
            const first = path[0];
            const last = path[path.length - 1];
            if (
                path.length > 3 &&
                Math.hypot(last.x - first.x, last.y - first.y) <=
                    STROKE_SIMPLIFY_TOLERANCE * imagePerScreen
            ) {
                path.pop();
            }
            // A scribble that encloses almost nothing is not a shape.
            const minimum = 9 * imagePerScreen * imagePerScreen;
            if (path.length >= 3 && polygonArea(path) >= minimum) {
                await this.createPolygonShape(path);
            }
            return;
        }
        const outline = simplifyPath(
            strokeOutline(path, this.brushImageWidth(imagePerScreen) / 2),
            (STROKE_SIMPLIFY_TOLERANCE / 3) * imagePerScreen
        );
        await this.createPolygonShape(outline);
    }

    private async createPolygonShape(points: Array<{ x: number; y: number }>) {
        if (points.length < 3) return;
        const round = (value: number) => Math.round(value * 100) / 100;
        const selector = `<svg><polygon points="${points
            .map(point => `${round(point.x)},${round(point.y)}`)
            .join(' ')}" /></svg>`;
        const annotation = this.draftAnnotation(selector, this.newShapeLabel());
        this.cancelDrawing();
        await this.createAnnotation(annotation);
    }

    /** A new, unsaved annotation of an SVG shape on the active layer. */
    private draftAnnotation(svg: string, label: string): WsiAnnotation {
        return {
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            type: 'Annotation',
            id: `client-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2)}`,
            body: [
                {
                    type: 'TextualBody',
                    value: label,
                    purpose: 'commenting',
                },
            ],
            target: {
                source: this.slideKey || '',
                selector: { type: 'SvgSelector', value: svg },
            },
            color: this.activeColor,
            colorName: this.activeColorName,
            layerName: this.activeLayer,
        };
    }

    /**
     * Drops a point. It shows and counts at once, before the save returns;
     * the point tool stays on for the next click.
     */
    @action
    private createPoint(point: { x: number; y: number }) {
        if (!this.canEdit || !this.slideKey) return;
        const annotation = this.draftAnnotation(
            pointSelectorSvg(point),
            this.activePointLabel
        );
        this.annotations = [...this.annotations, annotation];
        this.applyLayerFilter(false);
        this.pointQueue.push(annotation);
        if (this.pointTimer) clearTimeout(this.pointTimer);
        this.pointTimer = null;
        if (this.pointQueue.length >= BATCH_MAX_ITEMS) {
            void this.flushPoints();
        } else {
            this.pointTimer = setTimeout(
                () => void this.flushPoints(),
                POINT_SAVE_DELAY_MS
            );
        }
    }

    /**
     * Saves the dropped points not yet sent, in batch saves; resolves once
     * they and any save in flight are done. Each saved point undoes on its
     * own; a refused one is removed and reported.
     */
    flushPoints(options: { keepalive?: boolean } = {}): Promise<void> {
        if (this.pointTimer) clearTimeout(this.pointTimer);
        this.pointTimer = null;
        const drafts = this.pointQueue.splice(0);
        const previous = this.pointSave;
        if (!drafts.length) return previous || Promise.resolve();
        const generation = this.generation;
        const slideKey = this.slideKey;
        const settle = new Map<string, (saved: WsiAnnotation | null) => void>();
        drafts.forEach(draft =>
            this.pointsInFlight.set(
                draft.id,
                new Promise(resolve => settle.set(draft.id, resolve))
            )
        );
        const settleAll = (results: WsiSaveResult[]) =>
            drafts.forEach((draft, index) => {
                this.pointsInFlight.delete(draft.id);
                settle.get(draft.id)!(results[index]?.annotation || null);
            });
        const save = (async () => {
            let results: WsiSaveResult[] = [];
            try {
                results = await this.saveAnnotations(drafts, options);
                if (
                    generation !== this.generation ||
                    slideKey !== this.slideKey
                ) {
                    return;
                }
                // Refused for access: keep the points, marked unsaved.
                const refused =
                    this.accessIssue !== null
                        ? new Set(
                              drafts
                                  .filter((_, i) => !results[i]?.annotation)
                                  .map(draft => draft.id)
                          )
                        : new Set<string>();
                const saved = this.addSaved(
                    results,
                    drafts.filter(draft => !refused.has(draft.id))
                );
                if (refused.size) {
                    action(() => {
                        this.annotations = this.annotations.map(item =>
                            refused.has(item.id)
                                ? { ...item, unsaved: true }
                                : item
                        );
                    })();
                }
                settleAll(results);
                saved.forEach(item =>
                    this.pushUndo({ kind: 'create', ids: [item.id] })
                );
                const failed = results.filter(result => result.reason);
                if (failed.length && this.accessIssue === null) {
                    action(() => {
                        this.error = `${failed.length} point${
                            failed.length === 1 ? '' : 's'
                        } could not be saved (${failed[0].reason}).`;
                    })();
                }
            } finally {
                // Edits and deletes waiting on these points go to the saved
                // ids, even after the slide changed.
                settleAll(results);
                await previous;
            }
        })();
        const tracked = save.finally(() => {
            if (this.pointSave === tracked) this.pointSave = null;
        });
        this.pointSave = tracked;
        return tracked;
    }

    /**
     * Sends the unsent points before the slide or study changes or the page
     * goes away: `keepalive`, not cancelled with the slide's requests, and
     * without waiting for the answer. The batch route is used only when it
     * is known to exist; otherwise every point gets its own POST, all sent
     * at once, since no answer is read to fall back on.
     */
    private flushPointsDetached(): number {
        if (this.pointTimer) clearTimeout(this.pointTimer);
        this.pointTimer = null;
        const drafts = this.pointQueue.splice(0);
        const unsaved = this.unsavedPointCount;
        if (!drafts.length || !this.slideKey) return unsaved;
        if (!this.canWrite) return unsaved + drafts.length;
        const slideKey = this.slideKey;
        const payloads = drafts.map(draft =>
            this.createPayload(draft, slideKey)
        );
        const sizes = payloads.map(payload => JSON.stringify(payload).length);
        chunkBySize(sizes, BATCH_MAX_ITEMS, KEEPALIVE_MAX_BYTES).forEach(
            chunk => {
                const send =
                    this.batchRoute !== true
                        ? chunk.map(index =>
                              this.request(
                                  '/annotations',
                                  {
                                      method: 'POST',
                                      body: JSON.stringify(payloads[index]),
                                      keepalive: true,
                                  },
                                  undefined
                              )
                          )
                        : [
                              this.request(
                                  '/annotations/batch',
                                  {
                                      method: 'POST',
                                      body: JSON.stringify({
                                          annotations: chunk.map(
                                              index => payloads[index]
                                          ),
                                      }),
                                      keepalive: true,
                                  },
                                  undefined
                              ),
                          ];
                send.forEach(request => request.catch(() => undefined));
            }
        );
        return unsaved;
    }

    private readonly handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
            void this.flushPoints({ keepalive: true });
        }
    };

    private readonly handlePageHide = () => {
        void this.flushPoints({ keepalive: true });
    };

    private nextAutoLabel(): string {
        const base = this.activeColorName.trim() || this.activeColor;
        const count =
            this.annotations.filter(
                annotation =>
                    (annotation.colorName || '') === this.activeColorName
            ).length + 1;
        return `${base} ${count}`;
    }

    @action
    private showAnnotationTooltip(
        annotation: WsiAnnotation,
        event: MouseEvent
    ) {
        const text = annotation.body?.[0]?.value || '';
        const stored = this.annotations.find(item => item.id === annotation.id);
        const measurement = this.measurementOf(stored || annotation);
        const note = (stored || annotation).note || '';
        if (!text && !measurement && !note) return;
        this.annotationTooltip = {
            x: event.clientX,
            y: event.clientY,
            text,
            layerName: annotation.layerName || DEFAULT_LAYER,
            ai: isAiProvenance(annotation.provenance)
                ? isUnreviewedAi(annotation.provenance)
                    ? 'unreviewed'
                    : 'accepted'
                : undefined,
            aiOrigin: aiOriginDescription(annotation.provenance) || undefined,
            measurement: measurement
                ? formatMeasurement(measurement)
                : undefined,
            note: note || undefined,
        };
    }

    private destroyAnnotorious() {
        // Cancels an attach still waiting for the Annotorious chunk.
        this.attachGeneration += 1;
        this.canvasClickCleanup?.();
        this.canvasClickCleanup = null;
        this.pointLayer?.destroy();
        this.pointLayer = null;
        this.annotoriousShapes = [];
        this.pointerCleanup?.();
        this.pointerCleanup = null;
        this.keydownCleanup?.();
        this.keydownCleanup = null;
        this.pageHideCleanup?.();
        this.pageHideCleanup = null;
        this.setCustomPointerEvents(false);
        this.customDrawPreview = null;
        this.brushCursor = null;
        try {
            this.annotorious?.destroy?.();
        } catch (_) {
            /* best effort */
        }
        this.annotorious = null;
        this.osdViewer = null;
        this.openSeadragon = null;
        this.activeTool = null;
        this.pointerDown = null;
        this.polygonPoints = [];
        this.polygonScreenPoints = [];
    }

    /**
     * Puts the shown annotations on the slide: points on the point layer,
     * other shapes in Annotorious. Without `force`, Annotorious is left alone
     * when its shapes did not change, so adding points stays fast.
     */
    private applyLayerFilter(force = true) {
        const shown = this.shownAnnotations;
        const points: WsiAnnotation[] = [];
        const shapes: WsiAnnotation[] = [];
        shown.forEach(annotation =>
            (this.isPoint(annotation) ? points : shapes).push(annotation)
        );
        this.pointLayer?.setMarkers(
            points.map(annotation => {
                const shape = this.shapeOf(annotation) as {
                    x: number;
                    y: number;
                };
                return {
                    id: annotation.id,
                    x: shape.x,
                    y: shape.y,
                    color: annotation.color || DEFAULT_COLOR,
                };
            })
        );
        if (!this.annotorious) return;
        if (
            !force &&
            shapes.length === this.annotoriousShapes.length &&
            shapes.every((shape, i) => shape === this.annotoriousShapes[i])
        ) {
            return;
        }
        this.annotoriousShapes = shapes;
        this.synchronizing = true;
        try {
            this.annotorious.setAnnotations?.(shapes);
        } finally {
            this.synchronizing = false;
        }
    }

    /** A click on a point marker shows its tooltip. */
    private readonly handleCanvasClick = (event: any) => {
        if (this.activeTool || !event?.quick || !event.position) return;
        const marker = this.pointLayer?.hitTest(event.position);
        const annotation =
            marker && this.annotations.find(item => item.id === marker.id);
        if (annotation && event.originalEvent) {
            this.showAnnotationTooltip(annotation, event.originalEvent);
        }
    };

    private refreshStyle() {
        if (!this.annotorious) return;
        this.annotorious.setStyle?.((annotation: WsiAnnotation) => {
            const color = annotation.color || this.activeColor;
            return {
                stroke: color,
                fill: color,
                fillOpacity: 0.2,
                strokeWidth: 2,
            };
        });
    }
}
