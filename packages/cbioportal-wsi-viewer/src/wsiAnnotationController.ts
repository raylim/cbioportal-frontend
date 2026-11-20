import { action, computed, makeObservable, observable } from 'mobx';
import { WsiAnnotation } from './wsiViewerTypes';
import {
    brushWidthInImagePixels,
    formatMeasurement,
    formatRuler,
    measureRuler,
    measureShape,
    normalizeSvgSelector,
    isRegionShape,
    parseAnnotationShape,
    polygonArea,
    regionSelectorSvg,
    regionShape,
    shapeBounds,
    shapeRegion,
    simplifyPath,
    strokeOutline,
    WsiAnnotationShape,
    WsiBounds,
    WsiMeasurement,
    WsiMpp,
    WsiPoint,
    WsiRegion,
} from './wsiAnnotationGeometryUtils';
import {
    boundsOverlap,
    regionArea,
    regionBounds,
    regionParts,
} from './wsiRegionUtils';
import { loadShapeOps, WsiShapeOpsModule } from './wsiShapeOpsLoader';
import {
    acceptedProvenance,
    aiOriginDescription,
    derivedProvenance,
    editedProvenance,
    isAiProvenance,
    isEditedAi,
    isRejectedAi,
    isUnreviewedAi,
    readLayerAndNote,
    serviceColor,
    transferredProvenance,
    transferSource,
    verifiedProvenance,
    WsiAnnotationApiBody,
    WsiShapeOperation,
} from './wsiAnnotationBody';
import {
    WsiServiceAccessIssue,
    wsiServiceAccessIssue,
    wsiServiceFetch,
    readPage,
} from './wsiServiceRequest';
import {
    AnnotoriousModule,
    getLoadedAnnotorious,
    loadAnnotorious,
} from './wsiAnnotoriousLoader';
import { WsiPointLayer } from './wsiAnnotationPointLayer';
import {
    drawAnnotationScene,
    WsiAnnotationScene,
    WsiScreenAffine,
} from './wsiAnnotationSnapshot';
import { getWsiViewerRuntime } from './wsiViewerConfig';
import { loadTissueTools, WsiTissueModule } from './wsiTissueLoader';
import {
    DEFAULT_TISSUE_TOLERANCE,
    MAX_TISSUE_TOLERANCE,
    MIN_TISSUE_TOLERANCE,
} from './wsiTissueConstants';
// Types only: the tissue tools load in their own chunk (wsiTissueLoader).
import { WsiTissueSession, WsiTissueView } from './wsiTissueSelect';
import { WsiTissuePixelHost } from './wsiTissuePixels';
import { WsiSlideNotes, WsiSlideNotesHost } from './wsiSlideNotes';
import {
    MAX_IMPORT_BYTES,
    parseGeoJsonImport,
    toGeoJsonFeatureCollection,
    WsiExportItem,
    WsiGeoJsonFeatureCollection,
    WsiImportDraft,
} from './wsiAnnotationGeoJson';
import {
    boundsInside,
    placeSlideLabels,
    SLIDE_LABEL_MIN_SHAPE,
    runLimited,
    shapeContainsPoint,
    spatialOrder,
    WsiPlacedLabel,
    WsiScreenBox,
} from './wsiAnnotationSpatial';

export type WsiAnnotationTool =
    | 'rectangle'
    | 'ellipse'
    | 'circle'
    /** A high-power field: a circle of a set area, placed by a click. */
    | 'hpf'
    | 'line'
    | 'polygon'
    | 'point'
    | 'freehand'
    | 'brush'
    /** A brush that paints only tissue like the color under its start. */
    | 'smartBrush'
    /** The magic wand: outlines the region of similar color at a click. */
    | 'wand'
    /** A quick ruler: measures a length on the slide, never saved. */
    | 'measure'
    | null;

type WsiPointerAnnotationTool = Exclude<WsiAnnotationTool, null>;

/** The tools of the toolbar's Shape menu (Draw). */
export const SHAPE_TOOLS = ['rectangle', 'ellipse', 'circle'] as const;
export type WsiShapeTool = typeof SHAPE_TOOLS[number];
/** The tools of the toolbar's Outline menu (Draw). */
export const OUTLINE_TOOLS = [
    'polygon',
    'freehand',
    'brush',
    'smartBrush',
    'wand',
] as const;
export type WsiOutlineTool = typeof OUTLINE_TOOLS[number];

function isShapeTool(tool: WsiAnnotationTool): tool is WsiShapeTool {
    return (SHAPE_TOOLS as readonly WsiAnnotationTool[]).includes(tool);
}

function isOutlineTool(tool: WsiAnnotationTool): tool is WsiOutlineTool {
    return (OUTLINE_TOOLS as readonly WsiAnnotationTool[]).includes(tool);
}

/**
 * The toolbar's single-key shortcuts while Annotate is on: `select` is the
 * Select tool (no drawing tool). R is always the rectangle (never the
 * Shape menu's last tool), and C the point ("." always shows or hides the
 * details sidebar, so each key has one meaning).
 */
export const WSI_TOOL_SHORTCUTS: Record<
    string,
    'select' | WsiPointerAnnotationTool
> = {
    v: 'select',
    r: 'rectangle',
    // Measure: L keeps the line as an annotation, M is the quick ruler.
    l: 'line',
    m: 'measure',
    p: 'polygon',
    f: 'freehand',
    b: 'brush',
    w: 'wand',
    c: 'point',
};

/** Shift+B picks the smart brush (B alone is the brush). */
export const WSI_SMART_BRUSH_SHORTCUT = 'Shift+B';
/** Shift+C picks the HPF field (C alone is the point). */
export const WSI_HPF_SHORTCUT = 'Shift+C';

/**
 * High-power field areas offered, in mm², with the field diameter each
 * comes from (area = π·(d/2)²); 0.237 mm² (0.55 mm) is the default.
 */
export const HPF_AREA_PRESETS: ReadonlyArray<{
    areaMm2: number;
    diameterMm: number;
}> = [
    { areaMm2: 0.159, diameterMm: 0.45 },
    { areaMm2: 0.196, diameterMm: 0.5 },
    { areaMm2: 0.237, diameterMm: 0.55 },
    { areaMm2: 0.283, diameterMm: 0.6 },
    { areaMm2: 0.332, diameterMm: 0.65 },
    { areaMm2: 0.374, diameterMm: 0.69 },
];
export const DEFAULT_HPF_AREA_MM2 = 0.237;
/** The smallest and largest custom high-power field areas, in mm². */
export const HPF_AREA_MIN_MM2 = 0.01;
export const HPF_AREA_MAX_MM2 = 5;
/** A high-power field's label: "HPF" and its number on the slide. */
export const HPF_LABEL_RE = /^HPF (\d+)$/;

/** Points inside a region: how many, by label term, and per mm². */
export interface WsiRegionPointCount {
    total: number;
    /** Counts per label term, most first. */
    byLabel: Array<{ label: string; count: number }>;
    /** Points per mm² of the region; only on a slide with a scale. */
    densityPerMm2?: number;
}

/**
 * Whose high-power fields and points the HPF table counts: the user's own
 * (the default, so one reader's count is not mixed with another's), those
 * on the drawing layer, or all.
 */
export type WsiHpfScope = 'mine' | 'layer' | 'all';

/** A rate per 10 HPF from fewer fields than this is provisional. */
export const HPF_MIN_FIELDS = 10;

/** The high-power fields on the slide and the points counted in them. */
export interface WsiHpfSummary {
    fields: number;
    /** The fields' area, overlaps counted once, in mm². */
    areaMm2: number;
    total: number;
    /** Points per 10 fields (the count over the fields, times 10). */
    per10: number;
    byLabel: Array<{ label: string; count: number; per10: number }>;
    /** Fewer than `HPF_MIN_FIELDS` fields: the rate per 10 HPF is provisional. */
    provisional: boolean;
    /** Fields that overlap another; a point in an overlap counts once. */
    overlapping: number;
    /** Whose fields and points were counted. */
    scope: WsiHpfScope;
}

/** "12 (Mitosis 7, Lymphocyte 5) · 51 per mm²"; "0" with none inside. */
export function formatRegionCount(count: WsiRegionPointCount): string {
    const labels = count.byLabel
        .map(item => `${item.label} ${item.count}`)
        .join(', ');
    const density =
        count.densityPerMm2 !== undefined
            ? ` · ${formatDensity(count.densityPerMm2)}`
            : '';
    return `${count.total}${labels ? ` (${labels})` : ''}${density}`;
}

/** A density, e.g. "51 per mm²" or "4.2 per mm²". */
export function formatDensity(perMm2: number): string {
    const value =
        perMm2 >= 100
            ? Math.round(perMm2).toLocaleString('en-US')
            : perMm2.toLocaleString('en-US', {
                  maximumFractionDigits: 1,
                  minimumFractionDigits: perMm2 > 0 && perMm2 < 10 ? 1 : 0,
              });
    return `${value} per mm²`;
}

/**
 * Whether the user's changes are saved: `saving` counts the annotations
 * (and comments or notes) being sent or waiting to be sent, `unsaved` the
 * dropped points the service refused, which Retry sends again.
 */
export type WsiSaveStatus =
    | { state: 'idle' }
    | { state: 'saved' }
    | { state: 'saving'; count: number; unsaved: number }
    | { state: 'unsaved'; count: number };

/**
 * Who an annotation comes from: the user, other users, or a machine (the
 * assistant or a model).
 */
export type WsiAnnotationOrigin = 'mine' | 'others' | 'ai';

/**
 * The kinds the Show control shows or hides: the user's own, other users',
 * and AI annotations (machine-made) not yet reviewed or accepted.
 */
export type WsiAnnotationShowKind =
    | 'mine'
    | 'others'
    | 'aiUnreviewed'
    | 'aiAccepted';

export const WSI_SHOW_KINDS: readonly WsiAnnotationShowKind[] = [
    'mine',
    'others',
    'aiUnreviewed',
    'aiAccepted',
];

const ALL_KINDS_SHOWN: Record<WsiAnnotationShowKind, boolean> = {
    mine: true,
    others: true,
    aiUnreviewed: true,
    aiAccepted: true,
};

/** A comment in an annotation's thread. */
export interface WsiComment {
    id: string;
    author: string;
    body: string;
    created: string;
    updated: string;
}

/** An annotation's comment thread as loaded, and what is happening to it. */
export interface WsiCommentThread {
    loading: boolean;
    /** A comment is being saved. */
    busy: boolean;
    /** The comments loaded so far, oldest first. */
    comments: WsiComment[];
    error: string | null;
    /**
     * Where the next page starts, on a paged service with more to load
     * ("Show more"); null when all are loaded.
     */
    nextOffset?: number | null;
    /** The thread's comments in all, on a paged service. */
    total?: number;
}

/** The longest comment the service takes, in characters. */
export const COMMENT_MAX_LENGTH = 4000;

/**
 * A bulk action's batch route: `POST /annotations/batch-update`,
 * `-delete`, `-review` or `-restore`; `review-fallback` is a review
 * without the review route, which always goes one by one.
 */
export type WsiBulkKind =
    | 'update'
    | 'delete'
    | 'review'
    | 'restore'
    | 'review-fallback';

/** Steps to the next / previous annotation listed, Annotate on or off. */
export const WSI_NEXT_ANNOTATION_KEY = ']';
export const WSI_PREVIOUS_ANNOTATION_KEY = '[';

/** Where a link to one annotation points: the slide, by its opaque key. */
export interface WsiAnnotationLinkTarget {
    slideKey: string;
    annotationId: string;
}

/** Shown when a linked annotation is not on the slide that opened. */
export const WSI_LINKED_ANNOTATION_MISSING =
    'The linked annotation is not on this slide: it may have been deleted, rejected in review, or be private to its creator.';

/** Hides or shows all annotations on the slide, Annotate on or off. */
export const WSI_HIDE_ALL_KEY = 'h';

/** Inputs that take no text: the shortcuts still apply in them. */
const NON_TEXT_INPUTS = [
    'range',
    'checkbox',
    'radio',
    'button',
    'submit',
    'reset',
    'color',
];

/** Whether `target` is a field the user types in. */
export function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    // A slider or a checkbox takes no text: Enter, Esc and the shortcuts
    // still apply after the tolerance is dragged or a row is ticked.
    if (
        element?.tagName === 'INPUT' &&
        NON_TEXT_INPUTS.includes((element as HTMLInputElement).type)
    ) {
        return false;
    }
    return (
        !!element &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ||
            !!element.isContentEditable)
    );
}

/** A control Enter activates by itself: a button, link or menu item. */
function isActivatable(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    return !!element?.closest?.(
        'button, a[href], summary, [role="button"], [role^="menuitem"], [role="link"]'
    );
}

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
const LOCALSTORAGE_TOOLBAR_KEY = 'wsi_annotation_toolbar_v1';
const LOCALSTORAGE_LAYER_COLORS_KEY = 'wsi_annotation_layer_colors_v1';
const LOCALSTORAGE_DISPLAY_KEY = 'wsi_annotation_display_v1';
const LOCALSTORAGE_HPF_KEY = 'wsi_annotation_hpf_area_v1';

function loadHpfArea(): number {
    try {
        const value = Number(localStorage.getItem(LOCALSTORAGE_HPF_KEY));
        if (value >= HPF_AREA_MIN_MM2 && value <= HPF_AREA_MAX_MM2) {
            return value;
        }
    } catch (_) {
        // Ignore unavailable local storage.
    }
    return DEFAULT_HPF_AREA_MM2;
}
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

/**
 * The toolbar's remembered state: Annotate on or off, the menus' tools,
 * and whether Measure keeps its line as an annotation.
 */
interface WsiToolbarPrefs {
    annotating: boolean;
    shapeTool: WsiShapeTool;
    outlineTool: WsiOutlineTool;
    measureKeep: boolean;
}

function loadToolbarPrefs(): WsiToolbarPrefs {
    const prefs: WsiToolbarPrefs = {
        annotating: false,
        shapeTool: 'rectangle',
        outlineTool: 'polygon',
        measureKeep: false,
    };
    try {
        const parsed = JSON.parse(
            localStorage.getItem(LOCALSTORAGE_TOOLBAR_KEY) || 'null'
        );
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.annotating === 'boolean') {
                prefs.annotating = parsed.annotating;
            }
            if (isShapeTool(parsed.shapeTool)) {
                prefs.shapeTool = parsed.shapeTool;
            }
            if (isOutlineTool(parsed.outlineTool)) {
                prefs.outlineTool = parsed.outlineTool;
            }
            if (typeof parsed.measureKeep === 'boolean') {
                prefs.measureKeep = parsed.measureKeep;
            }
        }
    } catch (_) {
        // Ignore malformed or unavailable local storage.
    }
    return prefs;
}

function saveToolbarPrefs(prefs: WsiToolbarPrefs) {
    try {
        localStorage.setItem(LOCALSTORAGE_TOOLBAR_KEY, JSON.stringify(prefs));
    } catch (_) {
        // Ignore unavailable local storage.
    }
}

/** How annotations are drawn on the slide; remembered between visits. */
export interface WsiDisplayPrefs {
    /** Fill opacity of shapes, 0 to 1. */
    fillOpacity: number;
    /** Draw shapes' outlines only, without fill. */
    outlineOnly: boolean;
    /** Show labels on the slide, at the shapes. */
    showLabels: boolean;
}

export const DEFAULT_FILL_OPACITY = 0.2;

function loadDisplayPrefs(): WsiDisplayPrefs {
    const prefs: WsiDisplayPrefs = {
        fillOpacity: DEFAULT_FILL_OPACITY,
        outlineOnly: false,
        showLabels: false,
    };
    try {
        const parsed = JSON.parse(
            localStorage.getItem(LOCALSTORAGE_DISPLAY_KEY) || 'null'
        );
        if (parsed && typeof parsed === 'object') {
            if (
                typeof parsed.fillOpacity === 'number' &&
                parsed.fillOpacity >= 0 &&
                parsed.fillOpacity <= 1
            ) {
                prefs.fillOpacity = parsed.fillOpacity;
            }
            if (typeof parsed.outlineOnly === 'boolean') {
                prefs.outlineOnly = parsed.outlineOnly;
            }
            if (typeof parsed.showLabels === 'boolean') {
                prefs.showLabels = parsed.showLabels;
            }
        }
    } catch (_) {
        // Ignore malformed or unavailable local storage.
    }
    return prefs;
}

function saveDisplayPrefs(prefs: WsiDisplayPrefs) {
    try {
        localStorage.setItem(LOCALSTORAGE_DISPLAY_KEY, JSON.stringify(prefs));
    } catch (_) {
        // Ignore unavailable local storage.
    }
}

/** The colors the user gave layers, by layer name. */
function loadLayerColors(): Record<string, NamedColor> {
    try {
        const parsed = JSON.parse(
            localStorage.getItem(LOCALSTORAGE_LAYER_COLORS_KEY) || 'null'
        );
        if (!parsed || typeof parsed !== 'object') return {};
        const colors: Record<string, NamedColor> = {};
        Object.keys(parsed).forEach(layer => {
            const color = parsed[layer];
            if (
                typeof color?.name === 'string' &&
                typeof color.hex === 'string' &&
                HEX_COLOR_RE.test(color.hex)
            ) {
                colors[layer] = { name: color.name, hex: color.hex };
            }
        });
        return colors;
    } catch (_) {
        return {};
    }
}

function saveLayerColors(colors: Record<string, NamedColor>) {
    try {
        localStorage.setItem(
            LOCALSTORAGE_LAYER_COLORS_KEY,
            JSON.stringify(colors)
        );
    } catch (_) {
        // Ignore unavailable local storage.
    }
}

/** Colors new layers get in turn until the user picks one. */
const LAYER_COLOR_CYCLE = [
    '#ef4444',
    '#22c55e',
    '#f97316',
    '#8b5cf6',
    '#14b8a6',
    '#eab308',
    '#ec4899',
];

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
 * The annotation list's own filters, on top of what shows on the slide
 * (layers and Show); empty strings match everything.
 */
export interface WsiAnnotationListFilter {
    layer: string;
    author: string;
    text: string;
    /** A label group (see `labelGroup`), matched exactly. */
    label: string;
}

const EMPTY_LIST_FILTER: WsiAnnotationListFilter = {
    layer: '',
    author: '',
    text: '',
    label: '',
};

const UNLABELED = '(unlabeled)';

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

/**
 * A trailing parenthetical count, e.g. " (13 tiles)" or " (1 cell)": a
 * number and a unit word. A bare number in brackets is not a count.
 */
const PARENTHETICAL_COUNT_RE = /^(.*\S)\s*\(\s*\d[\d,]*\s+[A-Za-z][A-Za-z-]*\s*\)$/;

/**
 * The group a label is counted under in the list's "By label" counts: its
 * term (see `labelTerm`) without a trailing count such as " (13 tiles)",
 * so "Solid region (13 tiles)" and "Solid region (9 tiles)" group as
 * "Solid region". Vocabulary terms and labels such as "Grade 2" or
 * "Gleason pattern 4" stay as they are.
 */
export function labelGroup(
    label: string,
    autoLabelBases: Iterable<string> = [],
    vocabulary: string[] = []
): string {
    const trimmed = label.trim();
    if (vocabulary.includes(trimmed)) return trimmed;
    const match = PARENTHETICAL_COUNT_RE.exec(trimmed);
    return labelTerm(match ? match[1] : trimmed, autoLabelBases, vocabulary);
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

/** An AI annotation a review was recorded on, for undo and redo. */
export interface WsiReviewedItem {
    id: string;
    /** Its version after the review (or the reset). */
    version: number;
    label: string;
}

/**
 * A change undo can reverse: annotations created (deleted on undo), an edit
 * (its previous version saved again), annotations deleted (restored under
 * their ids, or created again where the service cannot restore), AI
 * annotations reviewed (the review reset) or reviews reset (reviewed
 * again).
 */
export type WsiUndoEntry =
    /** `pointRun` marks a run of dropped points (see `POINT_UNDO_GROUP_MS`). */
    | { kind: 'create'; ids: string[]; pointRun?: number }
    | { kind: 'update'; before: WsiAnnotation }
    | { kind: 'delete'; before: WsiAnnotation[]; pointRun?: number }
    | {
          kind: 'review';
          decision: 'accept' | 'reject';
          items: WsiReviewedItem[];
      }
    | {
          kind: 'reset';
          decision: 'accept' | 'reject';
          items: WsiReviewedItem[];
      }
    /**
     * Changes made together, e.g. a bulk relabel, or a shape operation
     * (`label`, e.g. "merge") that created, edited and deleted annotations.
     */
    | { kind: 'group'; entries: WsiUndoEntry[]; label?: string };

/** How undo and redo name a shape operation, e.g. "Undo merge". */
const SHAPE_OPERATION_NAMES: Record<WsiShapeOperation, string> = {
    merge: 'merge',
    subtract: 'subtract',
    intersect: 'intersect',
    cut: 'cut',
    split: 'split',
    separate: 'separate parts',
};

/**
 * The change an undo entry reverses, e.g. "delete of 2 annotations"; with
 * `redo`, the change a redo entry applies again (undoing a create left a
 * delete entry, which redoes the create).
 */
function describeChange(entry: WsiUndoEntry, redo = false): string {
    if (entry.kind === 'group') {
        if (entry.label) return entry.label;
        const n = entry.entries.length;
        return `edit${n > 1 ? ` of ${n} annotations` : ''}`;
    }
    if (entry.kind === 'review' || entry.kind === 'reset') {
        // Undo resets a review and redo applies it again: both name it.
        const n = entry.items.length;
        return `${entry.decision}${n > 1 ? ` of ${n} AI annotations` : ''}`;
    }
    const n =
        entry.kind === 'create'
            ? entry.ids.length
            : entry.kind === 'delete'
            ? entry.before.length
            : 1;
    const what =
        entry.kind === 'update'
            ? 'edit'
            : (entry.kind === 'create') !== redo
            ? 'create'
            : 'delete';
    const noun =
        entry.kind !== 'update' && entry.pointRun ? 'point' : 'annotation';
    return `${what}${n > 1 ? ` of ${n} ${noun}s` : ''}`;
}

/**
 * Shown when the annotation service has no review route: reviews then fall
 * back to the creator-only update and delete.
 */
export const WSI_REVIEW_UNSUPPORTED_MESSAGE =
    "This annotation service cannot record reviews: only an AI annotation's creator can accept it or reject it, and Reject deletes it.";

/** Why the review queue cannot open while Show or the layers hide them. */
export const WSI_REVIEW_HIDDEN_MESSAGE =
    'The unreviewed AI annotations are hidden: turn on "AI unreviewed" under Show, or show their layers.';

/** Shown after a creator's accept or reject without the review route. */
export const WSI_REVIEW_FALLBACK_NOTICE = {
    accept:
        'Accepted. This annotation service cannot record reviews, so the acceptance was saved as an edit.',
    reject:
        'Rejected. This annotation service cannot record reviews, so the annotation was deleted.',
} as const;

/**
 * The AI review queue: the unreviewed AI annotations of the slide when it
 * started, in review order (see `spatialOrder`), and the one shown.
 */
export interface WsiReviewQueue {
    ids: string[];
    /** The annotation under review; null once none is left. */
    currentId: string | null;
    /** A decision is being saved. */
    busy: boolean;
    /** What the last decision did, or why it was not saved. */
    message: string | null;
}

/**
 * The review queue's keys. While it is open they take priority over the
 * toolbar's tool shortcuts. X asks to reject and X (or Enter) again
 * confirms, so one stray key never rejects an annotation for everyone.
 */
export const WSI_REVIEW_KEYS: Record<
    string,
    'accept' | 'reject' | 'next' | 'previous' | 'exit'
> = {
    a: 'accept',
    enter: 'accept',
    x: 'reject',
    s: 'next',
    arrowright: 'next',
    arrowleft: 'previous',
    escape: 'exit',
};

/**
 * The confirmation asked before rejecting `what` ("Tumor 1" in quotes, or
 * "3 AI annotations"): what a reject does, and whether Undo can take it
 * back (`undoable`: the service can reset a review).
 */
export function rejectConfirmation(
    what: string,
    count: number,
    deletes: boolean,
    undoable = false
): string {
    const it = count === 1 ? 'It is' : 'They are';
    return `Reject ${what}? ${
        deletes
            ? `${it} deleted.`
            : `${it} hidden for everyone; the service keeps ${
                  count === 1 ? 'it' : 'them'
              } as a review record.`
    } ${
        undoable && !deletes
            ? 'Undo (Ctrl+Z) can take the reject back.'
            : "Reviews can't be undone."
    }`;
}

/**
 * Said when Undo follows a review the service cannot reset: such reviews
 * are not on the undo history.
 */
export const WSI_REVIEW_UNDO_NOTICE =
    "Reviews can't be undone. Press Undo again to undo your last edit before it.";

/** Said when an Undo finds that the service cannot reset a review. */
export const WSI_REVIEW_RESET_UNSUPPORTED =
    "This annotation service cannot undo reviews, so reviews can't be undone. Press Undo again to undo your last edit before it.";

/**
 * How long the service keeps a deleted annotation, with its comments, for
 * a restore, by default (`ANNOTATION_DELETED_RETENTION_DAYS`).
 */
export const WSI_DELETED_RETENTION_DAYS = 30;

/**
 * The area two circles share (µm² from µm), 0 when they do not overlap: the
 * lens of two high-power fields.
 */
export function circleOverlap(
    a: { x: number; y: number; r: number },
    b: { x: number; y: number; r: number }
): number {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d >= a.r + b.r - 1e-9) return 0;
    const small = Math.min(a.r, b.r);
    if (d <= Math.abs(a.r - b.r)) return Math.PI * small * small;
    const part = (r: number, other: number) =>
        r * r * Math.acos((d * d + r * r - other * other) / (2 * d * r));
    return (
        part(a.r, b.r) +
        part(b.r, a.r) -
        0.5 *
            Math.sqrt(
                (-d + a.r + b.r) *
                    (d + a.r - b.r) *
                    (d - a.r + b.r) *
                    (d + a.r + b.r)
            )
    );
}

/** OpenSeadragon keys kept off: rotate (r, R), flip (f) and pan up (w, W). */
const OSD_KEYS_OFF = ['r', 'R', 'f', 'F', 'w', 'W'];

/** Threads loaded at most to check whose comments a delete would remove. */
const THREAD_CHECK_LIMIT = 20;

/** The most selection frames drawn on the slide at once. */
const SELECTION_FRAME_LIMIT = 500;

/** How many changes undo remembers. */
const MAX_UNDO = 50;

/** An import read and validated, waiting for the user to confirm it. */
export interface WsiAnnotationImportPreview {
    fileName: string;
    drafts: WsiImportDraft[];
    counts: { point: number; line: number; polygon: number };
    skipped: Array<{ index: number; reason: string }>;
}

/** Copies `text` with a hidden text area, where the Clipboard API is not allowed. */
function copyWithTextarea(text: string): boolean {
    if (typeof document === 'undefined') return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
        copied = document.execCommand('copy');
    } catch (_) {
        copied = false;
    }
    area.remove();
    return copied;
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
/**
 * Points dropped one after another undo as one step: a run of drops in
 * one Point tool session, with no other change recorded in between and at
 * most this many milliseconds between two drops. Picking another tool (or
 * the Point tool again), Esc, any other change, undo or redo, or a longer
 * pause ends the run. Each point stays its own annotation.
 */
export const POINT_UNDO_GROUP_MS = 3000;

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
 * How one undo or redo write went: the saved row, the service unable to do
 * it (`unsupported`), or refused with a status and reason.
 */
type WsiItemOutcome =
    | { row: any }
    | { unsupported: true }
    | { status: number; reason: string };

/**
 * Whether a 422's `detail` refuses the request's `decision` as a value it
 * does not know: a service whose review route cannot reset reviews.
 */
export function isUnknownDecision(detail: unknown): boolean {
    return (
        Array.isArray(detail) &&
        detail.some(
            error =>
                Array.isArray(error?.loc) &&
                error.loc[error.loc.length - 1] === 'decision'
        )
    );
}

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
/** Said when the service refuses a shape's outline (its selector rules). */
export const WSI_SHAPE_REFUSED =
    "This shape can't be saved: the service does not accept its outline.";

/** Whether a 422's `detail` refuses the annotation's `target` (its shape). */
export function refusesTarget(detail: unknown): boolean {
    return (
        Array.isArray(detail) &&
        detail.some(
            error =>
                Array.isArray(error?.loc) &&
                error.loc.some((part: unknown) => part === 'target')
        )
    );
}

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
            errors.set(
                index,
                /^target\b/.test(field)
                    ? WSI_SHAPE_REFUSED
                    : field
                    ? `${field}: ${message}`
                    : message
            );
        }
    });
    return errors;
}

/** Pointer travel, in screen pixels, below which a press is a click. */
const CLICK_TOLERANCE = 5;
/** Freehand and brush strokes record a point per this many screen pixels. */
const STROKE_SAMPLE_SPACING = 2;
/**
 * Douglas–Peucker tolerance for freehand and brush strokes, in screen pixels
 * at the finest zoom the stroke was drawn at.
 */
const STROKE_SIMPLIFY_TOLERANCE = 1.5;
/** Brush widths offered on a slide with a scale, in µm of tissue. */
export const BRUSH_WIDTHS_UM = [10, 25, 50, 100, 250, 500];
export const DEFAULT_BRUSH_WIDTH_UM = 50;
/**
 * Brush widths offered on a slide without a scale, in screen pixels at the
 * zoom the stroke starts at (the width then stays fixed for the stroke).
 */
export const BRUSH_WIDTHS_PX = [8, 16, 32, 64];
export const DEFAULT_BRUSH_WIDTH_PX = 16;

function isStrokeTool(
    tool: WsiAnnotationTool
): tool is 'freehand' | 'brush' | 'smartBrush' {
    return tool === 'freehand' || tool === 'brush' || tool === 'smartBrush';
}

/** A brush tool: its width is chosen in the toolbar. */
function isBrushTool(tool: WsiAnnotationTool): tool is 'brush' | 'smartBrush' {
    return tool === 'brush' || tool === 'smartBrush';
}

/** Whether image point `point` is inside `region` (not in a hole). */
function regionContainsPoint(region: WsiRegion, point: WsiXY): boolean {
    const shape = region.length ? regionShape(region) : null;
    return !!shape && shapeContainsPoint(shape, point, 0);
}

/** Wand tolerance change per screen pixel of vertical drag. */
const TOLERANCE_PER_DRAG_PX = 0.5;

type WsiXY = { x: number; y: number };

/** A shape being drawn: in image pixels, but for the pointer. */
interface WsiDrawGesture {
    tool: WsiPointerAnnotationTool;
    /** Where a drag shape started. */
    imageStart?: WsiXY;
    /** A stroke's points, or a polygon's vertices. */
    imagePoints?: WsiXY[];
    /** The pointer, in screen pixels over the slide. */
    pointer: WsiXY;
    /** A brush stroke's width. */
    strokeImageWidth?: number;
}

/** The outline of the shape being drawn, in screen pixels at this zoom. */
export interface WsiDrawPreview {
    tool: WsiPointerAnnotationTool;
    start: WsiXY;
    current: WsiXY;
    points?: WsiXY[];
    /** A brush stroke's width on screen, in pixels. */
    strokeWidth?: number;
    /** The start and current points in image pixels, for measuring. */
    imageStart?: WsiXY;
    imageCurrent?: WsiXY;
}

/** The quick ruler's ends, in image pixels (see `ruler`). */
export interface WsiRuler {
    start: WsiXY;
    end: WsiXY;
}

/** The quick ruler on screen: its ends now, and its reading. */
export interface WsiRulerOnScreen {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    text: string;
}

/** OpenSeadragon events after which the slide sits elsewhere on screen. */
const VIEWPORT_EVENTS = [
    'animation',
    'update-viewport',
    'resize',
    'rotate',
    'flip',
];

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

export class WsiAnnotationController implements WsiSlideNotesHost {
    /**
     * The slide's annotations. A reference: the array is replaced on every
     * change and its items are plain objects, so nothing deep is observed
     * (thousands of annotations would otherwise be wrapped in proxies).
     */
    @observable.ref annotations: WsiAnnotation[] = [];
    @observable loading = false;
    /** The last load of the slide's annotations failed; see `retryLoad`. */
    @observable loadFailed = false;
    @observable error: string | null = null;
    /** An informational note, e.g. how a review was recorded. */
    @observable notice: string | null = null;
    /**
     * Set when the service refused this study (signed out, or no access).
     * Editing is then off until the slide or study changes.
     */
    @observable accessIssue: WsiServiceAccessIssue | null = null;
    @observable visible = true;
    @observable activeTool: WsiAnnotationTool = null;
    /**
     * Whether Annotate is on: the drawing tools show, and the user's own
     * shapes can be edited on the slide. Remembered between visits.
     */
    @observable annotating = loadToolbarPrefs().annotating;
    /** The Shape menu's last tool, which its button reuses. */
    @observable shapeTool: WsiShapeTool = loadToolbarPrefs().shapeTool;
    /** The Outline menu's last tool, which its button reuses. */
    @observable outlineTool: WsiOutlineTool = loadToolbarPrefs().outlineTool;
    /**
     * Measure keeps its line as an annotation (the Line tool, L) rather than
     * a quick ruler that is never saved (M); remembered.
     */
    @observable measureKeep = loadToolbarPrefs().measureKeep;
    @observable activeColor = DEFAULT_COLOR;
    @observable activeColorName = DEFAULT_LAYER;
    @observable activeLayer = DEFAULT_LAYER;
    @observable private customLayers: string[] = loadLayerNames();
    @observable private customColors: NamedColor[] = loadNamedColors();
    /** The colors the user gave layers (see `layerColor`). */
    @observable private layerColors: Record<
        string,
        NamedColor
    > = loadLayerColors();
    @observable hiddenLayerNames = new Set<string>();
    /** Fill opacity of shapes on the slide, 0 to 1 (see `outlineOnly`). */
    @observable fillOpacity = loadDisplayPrefs().fillOpacity;
    /** Shapes are drawn as outlines, without fill. */
    @observable outlineOnly = loadDisplayPrefs().outlineOnly;
    /** Labels show on the slide, at their shapes (see `slideLabels`). */
    @observable showSlideLabels = loadDisplayPrefs().showLabels;
    /**
     * Hides every annotation on the slide (H); the list and the tools stay.
     * Not remembered: a slide must not look empty on the next visit.
     */
    @observable hideAll = false;
    /**
     * The layer shown alone, with the other layers hidden; null when no
     * layer is. Showing all again restores the layers hidden before.
     */
    @observable soloLayer: string | null = null;
    private hiddenBeforeSolo: Set<string> | null = null;
    /**
     * Which kinds show (see `annotationKind`): with the layers' eyes and
     * solo, this decides what is drawn on the slide, listed, counted,
     * reviewed and exported as shown. For this visit only, like hiding all,
     * so a slide never opens looking empty.
     */
    @observable.ref shownKinds: Record<
        WsiAnnotationShowKind,
        boolean
    > = ALL_KINDS_SHOWN;
    @observable.ref listFilter: WsiAnnotationListFilter = EMPTY_LIST_FILTER;
    /**
     * The label new annotations get. Empty: an auto-label from the active
     * color's name and a number (only without a strict vocabulary).
     */
    @observable activeLabel = '';
    /** This session's changes on the open slide, the latest last. */
    @observable.ref undoStack: WsiUndoEntry[] = [];
    /**
     * Undone changes that Redo applies again, the next last: each entry is
     * what applying it does, as in `undoStack`. A new change clears it.
     */
    @observable.ref redoStack: WsiUndoEntry[] = [];
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
     * The area of a high-power field placed with the HPF tool, in mm²;
     * remembered between visits.
     */
    @observable hpfAreaMm2 = loadHpfArea();
    /**
     * Where the pointer is over the slide while the brush or HPF tool is
     * on, on screen.
     */
    @observable.ref private brushPointer: WsiXY | null = null;
    /** The magic wand's and smart brush's tolerance (a color distance). */
    @observable tissueTolerance = DEFAULT_TISSUE_TOLERANCE;
    /**
     * What the magic wand or smart brush shows: its selection (image
     * pixels), tolerance, pixel source and progress; null when idle.
     */
    @observable.ref tissueView: WsiTissueView | null = null;
    /** A message from the magic wand or smart brush, e.g. nothing selected. */
    @observable tissueMessage: string | null = null;
    private tissueSession: WsiTissueSession | null = null;
    private tissueSessionPromise: Promise<WsiTissueSession | null> | null = null;
    /** A wand press: dragging it up or down changes the tolerance. */
    private tissueDrag: {
        pointerId: number;
        startY: number;
        start: number;
        moved: boolean;
    } | null = null;
    /** The smart brush stroke being drawn and whether its session has it. */
    private smartStroke: {
        points: WsiXY[];
        started: boolean;
        handle?: object;
    } | null = null;
    private tissueHostFactory: (() => WsiTissuePixelHost) | null = null;
    private objectivePowerProvider: () => number | undefined = () => undefined;
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
     * Whether the review route takes `decision: "reset"` (undoing a
     * review): false once a reset is refused as an unknown decision (a 422
     * on `decision`) or its route is missing; unknown until the first undo
     * of a review.
     */
    @observable resetRoute: boolean | null = null;
    /**
     * Whether the service restores deleted annotations under their ids
     * (`POST /annotations/{id}/restore`), with their comments: false once
     * the route is missing (a 404 "Not Found" or a 405); unknown until the
     * first undo of a delete.
     */
    @observable restoreRoute: boolean | null = null;
    /**
     * Whether the service has the batch route (`POST /annotations/batch`):
     * unknown until the first batch save.
     */
    @observable batchRoute: boolean | null = null;
    /**
     * Whether the service has the bulk batch routes (`batch-update`,
     * `batch-delete`, `batch-review`, `batch-restore`): unknown until the
     * first bulk action (or undo) of the kind.
     */
    @observable.ref bulkRoutes: Record<WsiBulkKind, boolean | null> = {
        update: null,
        delete: null,
        review: null,
        restore: null,
        'review-fallback': false,
    };
    /**
     * Whether the service has comment threads: true once the annotation
     * list carries `comment_count`, false once the thread route answers 404
     * (the framework's "Not Found") or 405; unknown until then.
     */
    @observable commentRoute: boolean | null = null;
    /**
     * The comment threads opened on this slide, by annotation id. An
     * observable map: a row reads its own key, so a thread changing
     * re-renders only its row.
     */
    readonly threads = observable.map<string, WsiCommentThread>(
        {},
        { deep: false }
    );
    /** Comment counts changed on this slide since it loaded, by id. */
    private readonly commentCounts = observable.map<string, number>(
        {},
        { deep: false }
    );
    /**
     * Dropped points not saved on the slide or study last closed, because
     * the service refused them; reported once the next one opens.
     */
    @observable pointsLeftUnsaved = 0;
    /** Whether new annotations are shared with the study (else private). */
    @observable defaultShared = loadDefaultShared();
    @observable annotationTooltip: {
        /** The annotation it describes. */
        id?: string;
        x: number;
        y: number;
        text: string;
        layerName?: string;
        ai?: 'unreviewed' | 'accepted';
        /** An AI annotation a person changed (see `isEditedAi`). */
        aiEdited?: boolean;
        /** Who made an AI annotation (see `aiOriginDescription`). */
        aiOrigin?: string;
        measurement?: string;
        /** The points inside a region (see `pointsInside`). */
        pointsInside?: string;
        /** Who made it and its version, e.g. "By alice · version 3". */
        history?: string;
        /** "2 comments", when the annotation's thread has any. */
        comments?: string;
        note?: string;
    } | null = null;
    /**
     * The shape being drawn, kept in image pixels so that it stays on the
     * same tissue when the slide is panned or zoomed mid-gesture; only the
     * pointer is kept on screen. See `customDrawPreview` for its outline.
     */
    @observable.ref private drawGesture: WsiDrawGesture | null = null;
    /** The AI review queue while it is open (see `startReview`). */
    @observable.ref reviewQueue: WsiReviewQueue | null = null;
    /**
     * The annotation the slide is pointed at (under review, stepped to, or
     * opened by a link): highlighted on the slide.
     */
    @observable focusedAnnotationId: string | null = null;
    /** Bumped when the slide moves on screen, so previews follow it. */
    @observable private viewportRevision = 0;
    /**
     * The last quick measurement (Measure, M): shown until the next one or
     * Esc, never saved or exported; drawn in the downloaded view while it
     * shows.
     */
    @observable.ref ruler: WsiRuler | null = null;

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
    /** The press in progress: its tool, pointer and where it went down. */
    private pointerDown: {
        tool: WsiPointerAnnotationTool;
        pointerId: number | undefined;
        image: { x: number; y: number };
        client: { x: number; y: number };
    } | null = null;
    /** The polygon's vertices so far, in image pixels. */
    private polygonPoints: Array<{ x: number; y: number }> = [];
    /** Dropped points not yet sent, shown already; saved together. */
    private pointQueue: WsiAnnotation[] = [];
    /** `pointQueue.length`, observed by the save status. */
    @observable private queuedPointCount = 0;
    /**
     * The annotations (or comments or notes) in write requests sent and not
     * yet answered: a batch counts its items.
     */
    @observable private writesInFlight = 0;
    /** A write on the open slide was saved (see `saveStatus`). */
    @observable private savedOnSlide = false;
    private pointTimer: ReturnType<typeof setTimeout> | null = null;
    /** The point save in flight, which undo waits for. */
    private pointSave: Promise<void> | null = null;
    /** The run of point drops in progress (see `POINT_UNDO_GROUP_MS`). */
    private pointRun: { id: number; lastAt: number } | null = null;
    private nextPointRun = 1;
    /** The run each dropped point not yet saved belongs to, by draft id. */
    private readonly pointRunOf = new Map<string, number>();
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
    /**
     * The fewest image pixels per screen pixel while the stroke was drawn:
     * the finest zoom used, which sets how much detail simplifying keeps.
     */
    private strokeImagePerScreen = Infinity;
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
    /**
     * Told where the pointer is, in level-0 image pixels, while a drawing
     * gesture keeps pointer events from reaching the viewer (the status
     * bar's cursor position).
     */
    private cursorReporter: ((x: number, y: number) => void) | null = null;
    /** Makes a shareable link to an annotation; set by the host. */
    @observable.ref private linkBuilder:
        | ((target: WsiAnnotationLinkTarget) => string)
        | null = null;
    /** An annotation a link asked for, shown once the slide has loaded. */
    private requestedAnnotation: {
        id: string;
        slideKey: string | null;
    } | null = null;
    /** Told once a requested annotation was opened or found missing. */
    private requestedAnnotationUsed: (() => void) | null = null;
    /** The annotations selected for bulk actions (see `selectedAnnotations`). */
    /**
     * The selected annotations' ids. An observable map read per key
     * (`isSelected`), so a selection change re-renders only the rows it
     * changes; `selectedIds` gives them all.
     */
    private readonly selection = observable.map<string, true>(
        {},
        { deep: false }
    );

    /** The selected annotations' ids, in the order they were selected. */
    @computed get selectedIds(): ReadonlySet<string> {
        return new Set(this.selection.keys());
    }
    /** A Shift+drag selection box in progress, in image pixels. */
    @observable.ref selectionDrag: {
        pointerId: number | undefined;
        start: WsiXY;
        current: WsiXY;
        client: WsiXY;
    } | null = null;
    /** A bulk action is being saved. */
    @observable bulkBusy = false;
    /** What the last bulk action did, and what it skipped. */
    @observable bulkMessage: string | null = null;
    /**
     * Whether the last bulk action can be undone (`undoable`: Ctrl+Z takes
     * it back) or not (`final`: reviews); null when it changed nothing.
     */
    @observable bulkUndo: 'undoable' | 'final' | null = null;
    /**
     * A shape edit waiting for a shape to be drawn: `cut` cuts the next
     * closed shape out of the selected regions, `split` splits the selected
     * region along the next line.
     */
    @observable shapeEditMode: 'cut' | 'split' | null = null;
    /** Whether Alt was held as the last drawn shape ended (cuts it out). */
    private drawAlt = false;
    /** The link messages, e.g. "Link copied." */
    @observable linkMessage: string | null = null;

    /** The open slide's notes and tags. */
    readonly slideNotes: WsiSlideNotes;

    constructor(
        private apiUrl: string | null | undefined,
        private studyId: string | undefined
    ) {
        makeObservable(this);
        this.slideNotes = new WsiSlideNotes(this);
        const color = this.layerColor(this.activeLayer);
        this.activeColorName = color.name;
        this.activeColor = color.hex;
    }

    /**
     * Supplies the open slide's microns-per-pixel, read when measuring; the
     * viewer reads it from the slide's tile metadata.
     */
    @action
    setMppProvider(provider: () => WsiMpp | null | undefined) {
        this.mppProvider = provider;
    }

    /**
     * Supplies the open slide's objective power, from which the tissue
     * tools judge the magnification (as the status bar shows it).
     */
    setObjectivePowerProvider(provider: () => number | undefined) {
        this.objectivePowerProvider = provider;
    }

    /**
     * Replaces where the magic wand and smart brush read slide pixels; by
     * default the OpenSeadragon canvas and tiles (`createOsdTissueHost`).
     */
    setTissueHost(factory: (() => WsiTissuePixelHost) | null) {
        this.tissueHostFactory = factory;
        this.disposeTissue();
    }

    /** Sets how links to one annotation are made; null hides Copy link. */
    @action.bound
    setLinkBuilder(
        builder:
            | ((target: WsiAnnotationLinkTarget) => string)
            | null
            | undefined
    ) {
        this.linkBuilder = builder || null;
    }

    /** Whether annotations can be linked to (the host makes the links). */
    @computed get canLinkAnnotations(): boolean {
        return !!this.linkBuilder;
    }

    /** A shareable link that opens the slide at `id`, or null. */
    annotationLink(id: string): string | null {
        if (!this.linkBuilder || !this.slideKey) return null;
        if (!this.annotations.some(item => item.id === id && !item.unsaved)) {
            return null;
        }
        return this.linkBuilder({ slideKey: this.slideKey, annotationId: id });
    }

    /** Copies `annotationLink(id)` to the clipboard, saying how it went. */
    @action.bound
    async copyAnnotationLink(id: string): Promise<boolean> {
        const link = this.annotationLink(id);
        if (!link) return false;
        let copied = false;
        try {
            await navigator.clipboard.writeText(link);
            copied = true;
        } catch (_) {
            copied = copyWithTextarea(link);
        }
        action(() => {
            this.linkMessage = copied
                ? 'Link to the annotation copied.'
                : `Copy this link: ${link}`;
        })();
        return copied;
    }

    @action.bound
    dismissLinkMessage() {
        this.linkMessage = null;
    }

    /**
     * Opens annotation `id` once the slide's annotations have loaded, as a
     * link asks: it is shown (its layer too), fitted in the view and
     * highlighted. Asked once; a missing one is reported.
     */
    @action.bound
    requestAnnotation(
        id: string | null | undefined,
        slideKey?: string | null,
        onUsed?: () => void
    ) {
        this.requestedAnnotation = id
            ? { id, slideKey: slideKey || null }
            : null;
        this.requestedAnnotationUsed = id ? onUsed || null : null;
        this.openRequestedAnnotation();
    }

    /**
     * Opens the requested annotation when its slide (the link's slide key,
     * when it names one) is loaded and shown. It is used once: opened, or
     * reported missing; the host is told, e.g. to drop it from the URL.
     */
    @action
    private openRequestedAnnotation() {
        const request = this.requestedAnnotation;
        if (
            !request ||
            !this.slideKey ||
            (request.slideKey && request.slideKey !== this.slideKey) ||
            this.loading ||
            !this.osdViewer?.viewport
        ) {
            return;
        }
        const { id } = request;
        const used = this.requestedAnnotationUsed;
        this.requestedAnnotation = null;
        this.requestedAnnotationUsed = null;
        if (this.loadFailed || this.accessIssue) return;
        used?.();
        const annotation = this.annotations.find(item => item.id === id);
        if (!annotation) {
            this.linkMessage = WSI_LINKED_ANNOTATION_MISSING;
            return;
        }
        // Show it whatever hid it.
        const layer = annotation.layerName || DEFAULT_LAYER;
        if (this.hiddenLayerNames.has(layer)) {
            const hidden = new Set(this.hiddenLayerNames);
            hidden.delete(layer);
            this.hiddenLayerNames = hidden;
            this.soloLayer = null;
            this.hiddenBeforeSolo = null;
        }
        const kind = this.annotationKind(annotation);
        if (!this.shownKinds[kind]) {
            this.shownKinds = { ...this.shownKinds, [kind]: true };
        }
        if (this.hideAll) this.toggleHideAll();
        this.applyLayerFilter();
        this.focusAnnotation(id);
    }

    /** Fits annotation `id` in the view and highlights it. */
    @action.bound
    focusAnnotation(id: string): boolean {
        if (!this.annotations.some(item => item.id === id)) return false;
        this.focusedAnnotationId = id;
        return this.zoomToAnnotation(id);
    }

    /** Forgets the focused annotation (Esc), unless one is under review. */
    @action.bound
    clearFocus() {
        if (!this.reviewQueue) this.focusedAnnotationId = null;
    }

    /**
     * The listed annotations (visible, under the list's filters) in the
     * order `]` and `[` step through them: nearest next from the top left.
     */
    @computed get navigationOrder(): string[] {
        const placed: Array<{ id: string; bounds: WsiBounds }> = [];
        this.listedAnnotations.forEach(annotation => {
            const shape = this.shapeOf(annotation);
            if (shape) {
                placed.push({ id: annotation.id, bounds: shapeBounds(shape) });
            }
        });
        return spatialOrder(placed);
    }

    /** Where the focused annotation is in `navigationOrder`, for the bar. */
    @computed get navigationPosition(): {
        index: number;
        total: number;
    } | null {
        const id = this.focusedAnnotationId;
        if (!id || this.reviewQueue) return null;
        const order = this.navigationOrder;
        return { index: order.indexOf(id), total: order.length };
    }

    /**
     * Fits the next listed annotation in the view (or the previous, with
     * -1), wrapping around; from none, the first (or the last).
     */
    @action.bound
    stepAnnotation(direction: 1 | -1 = 1): string | null {
        if (this.reviewQueue) return null;
        const order = this.navigationOrder;
        if (!order.length) return null;
        const at = this.focusedAnnotationId
            ? order.indexOf(this.focusedAnnotationId)
            : -1;
        const next =
            at < 0
                ? order[direction > 0 ? 0 : order.length - 1]
                : order[(at + direction + order.length) % order.length];
        this.focusAnnotation(next);
        return next;
    }

    /** Reports the pointer's image position while drawing (see `cursorReporter`). */
    setCursorReporter(reporter: ((x: number, y: number) => void) | null) {
        this.cursorReporter = reporter;
    }

    private reportCursor(
        screen: WsiXY,
        image = this.imagePoint(screen.x, screen.y)
    ) {
        if (image) {
            this.cursorReporter?.(Math.round(image.x), Math.round(image.y));
        }
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

    /** The group `label` is listed under on this slide (see `labelGroup`). */
    labelGroup(label: string): string {
        return labelGroup(label, this.autoLabelBases, this.labelVocabulary);
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
                    this.labelGroup(annotation.body?.[0]?.value || '')
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

    /**
     * The label a new point gets: the active label, else the active color's
     * name, else (for the default color) "Point".
     */
    @computed get activePointLabel(): string {
        const label = this.activeLabel.trim();
        if (label && this.isAllowedLabel(label)) return label;
        if (this.strictLabels) return this.labelVocabulary[0];
        const name = this.activeColorName.trim();
        return name && name !== DEFAULT_LAYER ? name : 'Point';
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

    /** Whether `annotation` is a high-power field (see `HPF_LABEL_RE`). */
    isHpf(annotation: WsiAnnotation): boolean {
        return (
            HPF_LABEL_RE.test((annotation.body?.[0]?.value || '').trim()) &&
            this.shapeOf(annotation)?.kind === 'ellipse'
        );
    }

    private pointIndexKey: [WsiAnnotation[], NamedColor[]] | null = null;
    private pointIndexValue: {
        xs: number[];
        points: Array<{
            x: number;
            y: number;
            label: string;
            annotation: WsiAnnotation;
        }>;
        counts: WeakMap<WsiAnnotation, WsiRegionPointCount>;
    } | null = null;

    /**
     * The slide's points sorted by x, with their label terms, for counting
     * the points inside regions; rebuilt when the annotations change.
     */
    private get pointIndex() {
        // Label terms depend on the annotations and the palette only.
        const annotations = this.annotations;
        const palette = this.customColors;
        const key = this.pointIndexKey;
        if (
            !this.pointIndexValue ||
            !key ||
            key[0] !== annotations ||
            key[1] !== palette
        ) {
            const points: Array<{
                x: number;
                y: number;
                label: string;
                annotation: WsiAnnotation;
            }> = [];
            annotations.forEach(annotation => {
                const shape = this.shapeOf(annotation);
                if (shape?.kind !== 'point') return;
                points.push({
                    x: shape.x,
                    y: shape.y,
                    label: this.labelTerm(
                        annotation.body?.[0]?.value || 'Point'
                    ),
                    annotation,
                });
            });
            points.sort((a, b) => a.x - b.x);
            this.pointIndexKey = [annotations, palette];
            this.pointIndexValue = {
                xs: points.map(point => point.x),
                points,
                counts: new WeakMap(),
            };
        }
        return this.pointIndexValue;
    }

    /**
     * The points inside a region (a rectangle, ellipse or polygon, not in
     * its holes): all points on the slide, whatever layer or filter hides
     * them, counted by label term, and per mm² on a slide with a scale.
     * Null for other shapes, and on a slide without points.
     */
    pointsInside(annotation: WsiAnnotation): WsiRegionPointCount | null {
        const shape = this.shapeOf(annotation);
        if (!shape || !isRegionShape(shape)) return null;
        const index = this.pointIndex;
        if (!index.points.length) return null;
        const cached = index.counts.get(annotation);
        if (cached) return cached;
        const bounds = shapeBounds(shape);
        // The first point at or right of the region's left edge.
        let low = 0;
        let high = index.xs.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (index.xs[middle] < bounds.minX) low = middle + 1;
            else high = middle;
        }
        const byLabel = new Map<string, number>();
        let total = 0;
        for (let i = low; i < index.points.length; i++) {
            const point = index.points[i];
            if (point.x > bounds.maxX) break;
            if (point.y < bounds.minY || point.y > bounds.maxY) continue;
            if (!shapeContainsPoint(shape, point, 0)) continue;
            total += 1;
            byLabel.set(point.label, (byLabel.get(point.label) || 0) + 1);
        }
        const count: WsiRegionPointCount = {
            total,
            byLabel: Array.from(byLabel.entries())
                .map(([label, n]) => ({ label, count: n }))
                .sort(
                    (a, b) =>
                        b.count - a.count || a.label.localeCompare(b.label)
                ),
        };
        const measurement = this.mpp ? measureShape(shape, this.mpp) : null;
        if (measurement?.area) {
            count.densityPerMm2 = total / (measurement.area / 1e6);
        }
        index.counts.set(annotation, count);
        return count;
    }

    /**
     * The points inside a region as the list and tooltip show them: only
     * when there are any, or while counting (the Point or HPF tool is on,
     * or the region is a high-power field), so a region without points
     * does not read "Points inside: 0".
     */
    shownPointsInside(annotation: WsiAnnotation): WsiRegionPointCount | null {
        const count = this.pointsInside(annotation);
        if (!count) return null;
        return count.total > 0 ||
            this.activeTool === 'point' ||
            this.activeTool === 'hpf' ||
            this.isHpf(annotation)
            ? count
            : null;
    }

    /**
     * The high-power fields on the slide and the points inside them: per
     * label term, and per 10 fields (the mitotic count's usual unit).
     */
    /** Whose fields and points the HPF table counts. */
    @observable hpfScope: WsiHpfScope = 'mine';

    @action.bound
    setHpfScope(scope: WsiHpfScope) {
        this.hpfScope = scope;
    }

    /**
     * The scope the HPF table counts in: the user's own needs the user, so
     * without one every annotation counts.
     */
    @computed get hpfScopeNow(): WsiHpfScope {
        return this.hpfScope === 'mine' && !this.currentUser
            ? 'all'
            : this.hpfScope;
    }

    /** Whether `annotation` is in the HPF table's scope. */
    private inHpfScope(annotation: WsiAnnotation): boolean {
        switch (this.hpfScopeNow) {
            case 'mine':
                return (
                    !annotation.creator ||
                    annotation.creator === this.currentUser
                );
            case 'layer':
                return (
                    (annotation.layerName || DEFAULT_LAYER) === this.activeLayer
                );
            default:
                return true;
        }
    }

    /**
     * The high-power fields in scope (`hpfScope`) and the points in them:
     * each point counted once, also where fields overlap; the area with
     * overlaps counted once (fields are circles of tissue, so their pairwise
     * overlaps are exact unless three overlap). Null without fields.
     */
    @computed get hpfSummary(): WsiHpfSummary | null {
        const fields = this.annotations.filter(
            annotation => this.isHpf(annotation) && this.inHpfScope(annotation)
        );
        if (!fields.length) return null;
        const index = this.pointIndex;
        const inside = new Set<number>();
        const circles: Array<{ x: number; y: number; r: number }> = [];
        let areaUm2 = 0;
        fields.forEach(field => {
            const shape = this.shapeOf(field)!;
            const bounds = shapeBounds(shape);
            let low = 0;
            let high = index.xs.length;
            while (low < high) {
                const middle = (low + high) >> 1;
                if (index.xs[middle] < bounds.minX) low = middle + 1;
                else high = middle;
            }
            for (let i = low; i < index.points.length; i++) {
                const point = index.points[i];
                if (point.x > bounds.maxX) break;
                if (point.y < bounds.minY || point.y > bounds.maxY) continue;
                if (inside.has(i) || !this.inHpfScope(point.annotation)) {
                    continue;
                }
                if (shapeContainsPoint(shape, point, 0)) inside.add(i);
            }
            const measurement = measureShape(shape, this.mpp);
            if (
                shape.kind === 'ellipse' &&
                measurement?.area &&
                measurement.unit === 'um' &&
                this.mpp
            ) {
                areaUm2 += measurement.area;
                circles.push({
                    x: shape.cx * this.mpp.x,
                    y: shape.cy * this.mpp.y,
                    r: Math.sqrt(measurement.area / Math.PI),
                });
            }
        });
        const overlapping = new Set<number>();
        for (let a = 0; a < circles.length; a++) {
            for (let b = a + 1; b < circles.length; b++) {
                const lens = circleOverlap(circles[a], circles[b]);
                if (lens > 0) {
                    areaUm2 -= lens;
                    overlapping.add(a);
                    overlapping.add(b);
                }
            }
        }
        const byLabel = new Map<string, number>();
        inside.forEach(i => {
            const label = index.points[i].label;
            byLabel.set(label, (byLabel.get(label) || 0) + 1);
        });
        const total = inside.size;
        const per10 = (n: number) => (n / fields.length) * 10;
        return {
            fields: fields.length,
            areaMm2: Math.max(0, areaUm2) / 1e6,
            total,
            per10: per10(total),
            byLabel: Array.from(byLabel.entries())
                .map(([label, count]) => ({
                    label,
                    count,
                    per10: per10(count),
                }))
                .sort(
                    (a, b) =>
                        b.count - a.count || a.label.localeCompare(b.label)
                ),
            provisional: fields.length < HPF_MIN_FIELDS,
            overlapping: overlapping.size,
            scope: this.hpfScopeNow,
        };
    }

    /** Sets the area of new high-power fields, in mm², and remembers it. */
    @action.bound
    setHpfArea(areaMm2: number) {
        if (!(areaMm2 >= HPF_AREA_MIN_MM2 && areaMm2 <= HPF_AREA_MAX_MM2)) {
            return;
        }
        this.hpfAreaMm2 = Math.round(areaMm2 * 1000) / 1000;
        try {
            localStorage.setItem(LOCALSTORAGE_HPF_KEY, String(this.hpfAreaMm2));
        } catch (_) {
            // Ignore unavailable local storage.
        }
    }

    /** A high-power field's radii in image pixels, from the slide's mpp. */
    private hpfRadii(): { rx: number; ry: number } | null {
        const mpp = this.mpp;
        if (!mpp) return null;
        const radiusUm = Math.sqrt(this.hpfAreaMm2 / Math.PI) * 1000;
        return { rx: radiusUm / mpp.x, ry: radiusUm / mpp.y };
    }

    /** The Measure button's tool: a saved line, or the quick ruler. */
    @computed get measureTool(): 'line' | 'measure' {
        return this.measureKeep ? 'line' : 'measure';
    }

    /**
     * Whether Measure keeps its line as an annotation; while Measure is on
     * it switches between the line and the ruler at once.
     */
    @action.bound
    setMeasureKeep(keep: boolean) {
        this.measureKeep = keep;
        if (this.activeTool === 'line' || this.activeTool === 'measure') {
            this.setTool(this.measureTool);
        } else {
            this.saveToolbarPrefs();
        }
    }

    /** The field under the pointer while the HPF tool is on, on screen. */
    @computed get hpfCursor(): {
        x: number;
        y: number;
        rx: number;
        ry: number;
    } | null {
        const pointer = this.brushPointer;
        const radii = this.hpfRadii();
        if (!pointer || this.activeTool !== 'hpf' || !radii) return null;
        void this.viewportRevision;
        const imagePerScreen = this.imagePixelsPerScreenPixel();
        return {
            x: pointer.x,
            y: pointer.y,
            rx: radii.rx / imagePerScreen,
            ry: radii.ry / imagePerScreen,
        };
    }

    /** Numbers of high-power fields placed and not saved yet. */
    private readonly hpfNumbersInFlight = new Set<number>();

    /**
     * The next high-power field's number: one more than the highest on the
     * slide or being saved, so fields placed quickly one after another get
     * different numbers.
     */
    private nextHpfNumber(): number {
        let last = 0;
        this.annotations.forEach(annotation => {
            const match = HPF_LABEL_RE.exec(
                (annotation.body?.[0]?.value || '').trim()
            );
            if (match) last = Math.max(last, Number(match[1]));
        });
        this.hpfNumbersInFlight.forEach(n => (last = Math.max(last, n)));
        return last + 1;
    }

    /** Places a high-power field centred on `center`, in image pixels. */
    private async createHpf(center: WsiXY) {
        const radii = this.hpfRadii();
        if (!radii) return;
        const round = (value: number) => Math.round(value * 100) / 100;
        const number = this.nextHpfNumber();
        this.hpfNumbersInFlight.add(number);
        try {
            const annotation = this.draftAnnotation(
                `<svg><ellipse cx="${round(center.x)}" cy="${round(
                    center.y
                )}" rx="${round(radii.rx)}" ry="${round(radii.ry)}" /></svg>`,
                `HPF ${number}`
            );
            await this.createAnnotation(annotation);
        } finally {
            this.hpfNumbersInFlight.delete(number);
        }
    }

    /** The size of the shape being drawn, for a live readout. */
    @computed get drawPreviewMeasurement(): string | null {
        const preview = this.customDrawPreview;
        if (!preview?.imageStart || !preview.imageCurrent) return null;
        const a = preview.imageStart;
        const b = preview.imageCurrent;
        if (preview.tool === 'measure') {
            return formatRuler(measureRuler(a, b, this.mpp));
        }
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

    /**
     * Whether the user may draw, edit or delete annotations: not until the
     * slide's annotations have loaded.
     */
    @computed get canEdit(): boolean {
        return this.canWrite && !this.loading && !this.loadFailed;
    }

    /** Loads the slide's annotations again after a failed load. */
    @action.bound
    retryLoad() {
        const slideKey = this.slideKey;
        if (!this.apiUrl || !slideKey) return Promise.resolve();
        this.loadGeneration += 1;
        this.loadAbortController?.abort();
        this.loadAbortController = new AbortController();
        this.loading = true;
        this.loadFailed = false;
        this.error = null;
        return this.loadAnnotations(slideKey, this.loadGeneration);
    }

    /** Whether writes may be sent: a service, and no refusal of the study. */
    private get canWrite(): boolean {
        return Boolean(this.apiUrl) && this.accessIssue === null;
    }

    /** Records the point queue's length for the save status. */
    @action
    private syncPointQueue() {
        this.queuedPointCount = this.pointQueue.length;
    }

    /**
     * Whether the user's changes are saved, for the toolbar: saving (with
     * how many annotations, comments or notes are being sent or waiting),
     * dropped points not saved, saved (after a save on this slide), or
     * nothing to say yet.
     */
    @computed get saveStatus(): WsiSaveStatus {
        const saving = this.queuedPointCount + this.writesInFlight;
        const unsaved = this.unsavedPointCount;
        if (saving) return { state: 'saving', count: saving, unsaved };
        if (unsaved) return { state: 'unsaved', count: unsaved };
        return this.savedOnSlide ? { state: 'saved' } : { state: 'idle' };
    }

    /**
     * Counts a write request in `writesInFlight` until it is answered: its
     * items for a batch (`annotations` or `items`), else one. An answer
     * for the open slide marks it saved.
     */
    trackWrite(response: Promise<Response>, body: unknown) {
        let weight = 1;
        if (typeof body === 'string') {
            try {
                const parsed = JSON.parse(body);
                const items = parsed?.annotations || parsed?.items;
                if (Array.isArray(items) && items.length) weight = items.length;
            } catch (_) {
                weight = 1;
            }
        }
        const generation = this.generation;
        action(() => {
            this.writesInFlight += weight;
        })();
        response.then(
            action((answer: Response) => {
                this.writesInFlight -= weight;
                if (answer?.ok && generation === this.generation) {
                    this.savedOnSlide = true;
                }
            }),
            action(() => {
                this.writesInFlight -= weight;
            })
        );
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
        this.syncPointQueue();
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

    /** The annotations drawn on the slide: shown layers and Show. */
    @computed get shownAnnotations(): WsiAnnotation[] {
        return this.annotations.filter(annotation => this.isShown(annotation));
    }

    /** The annotations the list shows: those on the slide, filtered. */
    @computed get listedAnnotations(): WsiAnnotation[] {
        const { layer, author, text, label } = this.listFilter;
        const needle = text.trim().toLowerCase();
        return this.shownAnnotations.filter(annotation => {
            if (layer && (annotation.layerName || DEFAULT_LAYER) !== layer) {
                return false;
            }
            if (author && (annotation.creator || '') !== author) return false;
            if (
                label &&
                this.labelGroup(annotation.body?.[0]?.value || UNLABELED) !==
                    label
            ) {
                return false;
            }
            if (
                needle &&
                !(annotation.body?.[0]?.value || '')
                    .toLowerCase()
                    .includes(needle) &&
                !(annotation.note || '').toLowerCase().includes(needle)
            ) {
                return false;
            }
            return true;
        });
    }

    /**
     * How many of the slide's annotations the list leaves out: hidden by a
     * layer's eye or solo, by Show, or by the list's filters.
     */
    @computed get hiddenByFilters(): number {
        return this.annotations.length - this.listedAnnotations.length;
    }

    /**
     * Shows everything again: every layer (ending a solo), every kind under
     * Show, no list filter, and the annotations on the slide (H).
     */
    @action.bound
    showEverything() {
        this.soloLayer = null;
        this.hiddenBeforeSolo = null;
        this.hiddenLayerNames = new Set();
        this.shownKinds = ALL_KINDS_SHOWN;
        this.listFilter = EMPTY_LIST_FILTER;
        if (this.hideAll) this.toggleHideAll();
        this.applyLayerFilter();
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

    /** Listed annotations per label group (see `labelGroup`). */
    @computed get listedLabelCounts(): Map<string, number> {
        return countBy(this.listedAnnotations, annotation =>
            this.labelGroup(annotation.body?.[0]?.value || UNLABELED)
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
                pointCount: this.pointsInside(annotation) || undefined,
                aiReviewStatus: isAiProvenance(annotation.provenance)
                    ? isUnreviewedAi(annotation.provenance)
                        ? 'unreviewed'
                        : 'accepted'
                    : undefined,
                aiEdited: isEditedAi(annotation.provenance) || undefined,
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
        if (file.size > MAX_IMPORT_BYTES) {
            this.importError = `The file is ${(
                file.size /
                (1024 * 1024)
            ).toFixed(1)} MB; import files of at most ${MAX_IMPORT_BYTES /
                (1024 * 1024)} MB.`;
            return;
        }
        try {
            const raw = await readFileText(file);
            const result = parseGeoJsonImport(
                JSON.parse(raw),
                this.slideSize()
            );
            const drafts: WsiImportDraft[] = [];
            const skipped = [...result.skipped];
            result.drafts.forEach(draft => {
                if (this.isAllowedLabel(this.importLabel(draft))) {
                    drafts.push(draft);
                } else if (
                    !skipped.some(item => item.index === draft.featureIndex)
                ) {
                    skipped.push({
                        index: draft.featureIndex,
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

    @computed get canRedo(): boolean {
        return this.canEdit && !this.undoing && this.redoStack.length > 0;
    }

    /**
     * Whether Undo can take a review back: the service records reviews
     * and has not refused a reset (assumed until it does).
     */
    @computed get reviewsUndoable(): boolean {
        return this.reviewRoute !== false && this.resetRoute !== false;
    }

    /**
     * Whether Undo of a delete restores the annotation under its id with
     * its comments (assumed until the service shows it cannot).
     */
    @computed get restoresDeleted(): boolean {
        return this.restoreRoute !== false;
    }

    /** What undo would reverse, e.g. "Undo delete". */
    @computed get undoLabel(): string | null {
        const entry = this.undoStack[this.undoStack.length - 1];
        return entry ? `Undo ${describeChange(entry)}` : null;
    }

    /** What redo would apply again, e.g. "Redo delete". */
    @computed get redoLabel(): string | null {
        const entry = this.redoStack[this.redoStack.length - 1];
        return entry ? `Redo ${describeChange(entry, true)}` : null;
    }

    /**
     * Whether the user's last change was a review left off the undo
     * history (the service cannot reset reviews): the next Undo says so
     * instead of silently undoing an earlier edit.
     */
    private lastChangeWasReview = false;

    /** Records a new change: it can be undone, and nothing can be redone. */
    @action
    private pushUndo(entry: WsiUndoEntry) {
        this.lastChangeWasReview = false;
        // Any other change ends a run of point drops.
        if (entry.kind !== 'create' || !entry.pointRun) this.pointRun = null;
        this.undoStack = [...this.undoStack, entry].slice(-MAX_UNDO);
        this.redoStack = [];
    }

    /**
     * Records saved points of run `run` for undo: added to the last step
     * when that is the same run, else as a new step.
     */
    @action
    private recordPointRun(run: number, ids: string[]) {
        const last = this.undoStack[this.undoStack.length - 1];
        if (last?.kind === 'create' && last.pointRun === run) {
            this.undoStack = [
                ...this.undoStack.slice(0, -1),
                { ...last, ids: [...last.ids, ...ids] },
            ];
            this.redoStack = [];
        } else {
            this.pushUndo({ kind: 'create', ids, pointRun: run });
        }
    }

    /** Forgets the undo and redo history, e.g. on another slide. */
    @action
    private clearHistory() {
        this.undoStack = [];
        this.redoStack = [];
        this.pointRun = null;
    }

    /**
     * Points the undo and redo history at an annotation's new id after it
     * was re-created.
     */
    @action
    private renameInHistory(oldId: string, newId: string) {
        const rename = (entry: WsiUndoEntry): WsiUndoEntry =>
            entry.kind === 'group'
                ? { ...entry, entries: entry.entries.map(rename) }
                : entry.kind === 'review' || entry.kind === 'reset'
                ? entry
                : entry.kind === 'create'
                ? {
                      ...entry,
                      ids: entry.ids.map(id => (id === oldId ? newId : id)),
                  }
                : entry.kind === 'update'
                ? entry.before.id === oldId
                    ? { ...entry, before: { ...entry.before, id: newId } }
                    : entry
                : {
                      ...entry,
                      before: entry.before.map(item =>
                          item.id === oldId ? { ...item, id: newId } : item
                      ),
                  };
        this.undoStack = this.undoStack.map(rename);
        this.redoStack = this.redoStack.map(rename);
    }

    /**
     * Reverses this session's last change on the slide: a created
     * annotation is deleted, an edit is undone by saving the previous
     * version over the current one (with the current `version`), a deleted
     * annotation is restored under its id with its comments (created again
     * with a new id where the service cannot restore), and a review is
     * reset to unreviewed. Redo can apply the change again.
     */
    @action.bound
    async undo(): Promise<boolean> {
        if (this.lastChangeWasReview) {
            this.lastChangeWasReview = false;
            this.notice = WSI_REVIEW_UNDO_NOTICE;
            if (this.reviewQueue) {
                this.reviewQueue = {
                    ...this.reviewQueue,
                    message: WSI_REVIEW_UNDO_NOTICE,
                };
            }
            return false;
        }
        await this.flushPoints();
        this.pointRun = null;
        if (!this.canUndo) return false;
        const entry = this.undoStack[this.undoStack.length - 1];
        this.undoStack = this.undoStack.slice(0, -1);
        const inverse = await this.applyHistoryEntry(entry);
        if (inverse) {
            action(() => {
                this.redoStack = [...this.redoStack, inverse].slice(-MAX_UNDO);
            })();
        }
        return !!inverse;
    }

    /**
     * Applies the last undone change again, in one step as it was undone
     * (an import or a layer delete too). Undo can reverse it again.
     */
    @action.bound
    async redo(): Promise<boolean> {
        await this.flushPoints();
        this.pointRun = null;
        if (!this.canRedo) return false;
        const entry = this.redoStack[this.redoStack.length - 1];
        this.redoStack = this.redoStack.slice(0, -1);
        const inverse = await this.applyHistoryEntry(entry);
        if (inverse) {
            action(() => {
                this.undoStack = [...this.undoStack, inverse].slice(-MAX_UNDO);
            })();
        }
        return !!inverse;
    }

    /**
     * Applies an undo or redo entry without recording it as a new change:
     * deletes the created annotations, saves the previous version of an
     * edit (with the current `version`), or creates deleted annotations
     * again with new ids. Resolves to the entry that reverses what was
     * applied, or null when nothing was.
     */
    private async applyHistoryEntry(
        entry: WsiUndoEntry
    ): Promise<WsiUndoEntry | null> {
        action(() => {
            this.undoing = true;
        })();
        try {
            return await this.applyEntry(entry);
        } finally {
            action(() => {
                this.undoing = false;
            })();
        }
    }

    /** Applies one undo or redo entry (see `applyHistoryEntry`). */
    private async applyEntry(
        entry: WsiUndoEntry
    ): Promise<WsiUndoEntry | null> {
        if (entry.kind === 'group') {
            // A few at a time; each part reverses on its own.
            const inverses = (
                await runLimited(entry.entries, SINGLE_SAVE_CONCURRENCY, part =>
                    this.applyEntry(part)
                )
            ).filter((part): part is WsiUndoEntry => !!part);
            return inverses.length
                ? { kind: 'group', entries: inverses, label: entry.label }
                : null;
        }
        if (entry.kind === 'create') {
            if (entry.ids.length > 1) {
                const deleted = await this.deleteCreated(entry.ids);
                return deleted.length
                    ? {
                          kind: 'delete',
                          before: deleted,
                          ...(entry.pointRun
                              ? { pointRun: entry.pointRun }
                              : {}),
                      }
                    : null;
            }
            const deleted: WsiAnnotation[] = [];
            for (const id of entry.ids) {
                const current = this.annotations.find(item => item.id === id);
                if (current && (await this.deleteAnnotation(id, false))) {
                    deleted.push(current);
                }
            }
            return deleted.length ? { kind: 'delete', before: deleted } : null;
        }
        if (entry.kind === 'update') {
            const current = this.annotations.find(
                item => item.id === entry.before.id
            );
            if (!current) {
                action(() => {
                    this.error =
                        'Cannot undo or redo: the annotation was deleted.';
                })();
                return null;
            }
            const saved = await this.updateAnnotation(
                { ...entry.before, version: current.version },
                false
            );
            return saved ? { kind: 'update', before: current } : null;
        }
        if (entry.kind === 'review' || entry.kind === 'reset') {
            return this.applyReviewEntry(entry);
        }
        const outcome = await this.restoreDeleted(
            entry.before,
            !!entry.pointRun
        );
        if (!outcome) return null;
        const { restored, recreated } = outcome;
        const lostThreads = recreated.filter(
            ([before]) =>
                (this.commentCounts.get(before.id) ??
                    before.commentCount ??
                    0) > 0
        );
        if (lostThreads.length) {
            const comments = lostThreads.reduce(
                (sum, [before]) =>
                    sum +
                    (this.commentCounts.get(before.id) ??
                        before.commentCount ??
                        0),
                0
            );
            const first = lostThreads[0][0];
            action(() => {
                this.notice = `${
                    lostThreads.length === 1
                        ? `"${first.body?.[0]?.value || '(unlabeled)'}" was`
                        : `${lostThreads.length} annotations were`
                } created again as ${
                    lostThreads.length === 1
                        ? 'a new annotation'
                        : 'new annotations'
                }; ${
                    lostThreads.length === 1
                        ? comments === 1
                            ? 'its comment'
                            : `its ${comments} comments`
                        : `their ${comments} comments`
                } could not be restored.`;
            })();
        }
        const ids = [
            ...restored.map(item => item.id),
            ...recreated.map(([, saved]) => saved.id),
        ];
        return ids.length
            ? {
                  kind: 'create',
                  ids,
                  ...(entry.pointRun ? { pointRun: entry.pointRun } : {}),
              }
            : null;
    }

    /**
     * Brings deleted annotations back: restored under their ids, with
     * their comments, by `POST /annotations/{id}/restore` (one) or
     * `batch-restore` (several, up to 100 a request), with the version
     * each had when deleted. Where the service cannot restore (no route) or
     * no longer holds one (purged, or deleted before soft deletes), it is
     * created again with a new id (in batch saves for `points`), and the
     * history follows the new id. Others refused are reported (a conflict
     * reloads the slide). Null when another slide opened meanwhile.
     */
    private async restoreDeleted(
        before: WsiAnnotation[],
        points = false
    ): Promise<{
        restored: WsiAnnotation[];
        recreated: Array<[WsiAnnotation, WsiAnnotation]>;
        failed: WsiAnnotation[];
    } | null> {
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        const outcomes = await this.sendItems(
            'restore',
            before.map(item => ({ annotation: item, fields: {} })),
            entry => this.restoreOne(entry.annotation)
        );
        if (!this.isCurrent(context)) return null;
        const rows: any[] = [];
        const again: WsiAnnotation[] = [];
        const failed: Array<[WsiAnnotation, WsiItemOutcome]> = [];
        outcomes.forEach((outcome, index) => {
            if ('row' in outcome) rows.push(outcome.row);
            else if ('unsupported' in outcome || outcome.status === 404) {
                again.push(before[index]);
            } else failed.push([before[index], outcome]);
        });
        const restored = this.addSaved(
            rows.map(row => ({
                annotation: this.fromApi(row, this.slideKey || ''),
            }))
        );
        action(() => {
            restored.forEach(item => {
                if (typeof item.commentCount === 'number') {
                    this.commentCounts.set(item.id, item.commentCount);
                }
            });
        })();
        const recreated: Array<[WsiAnnotation, WsiAnnotation]> = [];
        if (again.length && points && again.length > 1) {
            recreated.push(...(await this.createPointRun(again)));
        } else {
            for (const item of again) {
                const saved = await this.createAnnotation(
                    {
                        ...item,
                        id: `client-undo-${Date.now()}-${Math.random()
                            .toString(36)
                            .slice(2)}`,
                    },
                    false
                );
                if (saved) {
                    this.renameInHistory(item.id, saved.id);
                    recreated.push([item, saved]);
                }
            }
        }
        if (failed.length && this.accessIssue === null) {
            const reasons = failed
                .slice(0, 3)
                .map(
                    ([item, outcome]) =>
                        `"${item.body?.[0]?.value || '(unlabeled)'}": ${
                            'reason' in outcome ? outcome.reason : 'refused'
                        }`
                );
            const message = `${failed.length} of ${before.length} annotation${
                before.length === 1 ? '' : 's'
            } could not be restored (${reasons.join('; ')}${
                failed.length > reasons.length ? '; …' : ''
            }).`;
            if (
                failed.some(
                    ([, outcome]) =>
                        'status' in outcome && outcome.status === 409
                )
            ) {
                await this.reloadCurrentSlide(message);
            } else {
                action(() => {
                    this.error = message;
                })();
            }
        }
        return {
            restored,
            recreated,
            failed: failed.map(([item]) => item),
        };
    }

    /**
     * Restores one deleted annotation with `POST
     * /annotations/{id}/restore` and the version it had when deleted. A 405
     * or a 404 "Not Found" means the service has no such route: it and
     * later restores answer `unsupported` for the session.
     */
    private async restoreOne(annotation: {
        id: string;
        version?: number;
    }): Promise<WsiItemOutcome> {
        if (this.restoreRoute === false) return { unsupported: true };
        let response: Response;
        try {
            response = await this.request(
                `/annotations/${encodeURIComponent(annotation.id)}/restore`,
                {
                    method: 'POST',
                    body: JSON.stringify({ version: annotation.version || 1 }),
                }
            );
        } catch (_) {
            return { status: 0, reason: 'network error' };
        }
        const outcome = await this.itemOutcome(response);
        if ('unsupported' in outcome) {
            action(() => {
                this.restoreRoute = false;
            })();
        } else if ('row' in outcome) {
            action(() => {
                this.restoreRoute = true;
            })();
        }
        return outcome;
    }

    /**
     * What one write's response says for an undo or redo item: the saved
     * row; `unsupported` for a missing route (a 405, a 404 "Not Found") or
     * a decision the service does not know (a 422 on `decision`); else the
     * status and the service's reason. A 401, or a 403 that is not the
     * service's own refusal, also turns editing off (see `refuseAccess`).
     */
    private async itemOutcome(response: Response): Promise<WsiItemOutcome> {
        if (response.ok) {
            try {
                return { row: await response.json() };
            } catch (_) {
                return {
                    status: response.status,
                    reason: 'unexpected response',
                };
            }
        }
        const detail = await this.errorDetail(response);
        if (
            response.status === 405 ||
            (response.status === 404 && detail === 'Not Found') ||
            (response.status === 422 && isUnknownDecision(detail))
        ) {
            return { unsupported: true };
        }
        const own = typeof detail === 'string' && /^only /i.test(detail);
        if (response.status === 401 || (response.status === 403 && !own)) {
            this.refuseAccess(response);
            return {
                status: response.status,
                reason: this.accessMessage || 'no access',
            };
        }
        return {
            status: response.status,
            reason:
                typeof detail === 'string'
                    ? detail
                    : `not saved (${response.status})`,
        };
    }

    /**
     * Sends undo or redo writes of one kind (`restore`, `review`): one item
     * with its single route (`single`); several with the batch route
     * (`batch-<kind>`), up to 100 a request, all or none. A batch that is
     * refused for one item (403, 404, 422) reports it and sends the rest
     * again; stale items (409) are reported and the rest sent again; a
     * missing batch route sends each with `single` from then on; a decision
     * the service does not know marks all `unsupported`. Resolves to one
     * outcome per item, in order.
     */
    private async sendItems(
        kind: 'restore' | 'review',
        items: Array<{
            annotation: { id: string; version?: number };
            fields: Record<string, unknown>;
        }>,
        single: (item: {
            annotation: { id: string; version?: number };
            fields: Record<string, unknown>;
        }) => Promise<WsiItemOutcome>
    ): Promise<WsiItemOutcome[]> {
        const out: WsiItemOutcome[] = items.map(() => ({
            status: 0,
            reason: 'not sent',
        }));
        const singles = async (indexes: number[]) => {
            const results = await runLimited(
                indexes,
                SINGLE_SAVE_CONCURRENCY,
                index => single(items[index])
            );
            indexes.forEach((index, at) => {
                out[index] = results[at];
            });
        };
        const all = items.map((_, index) => index);
        if (items.length === 1 || this.bulkRoutes[kind] === false) {
            await singles(all);
            return out;
        }
        let stop: WsiItemOutcome | null = null;
        for (let start = 0; start < all.length; start += BATCH_MAX_ITEMS) {
            let pending = all.slice(start, start + BATCH_MAX_ITEMS);
            while (pending.length) {
                if (stop) {
                    pending.forEach(index => {
                        out[index] = stop!;
                    });
                    break;
                }
                if (this.bulkRoutes[kind] === false) {
                    await singles(pending);
                    break;
                }
                const sent = pending;
                const outcome = await this.sendBulkBatch(
                    kind,
                    sent.map(index => items[index])
                );
                pending = [];
                if (outcome.kind === 'saved') {
                    action(() => {
                        this.bulkRoutes = { ...this.bulkRoutes, [kind]: true };
                    })();
                    sent.forEach((index, at) => {
                        out[index] = { row: outcome.rows[at] };
                    });
                } else if (outcome.kind === 'missing') {
                    action(() => {
                        this.bulkRoutes = { ...this.bulkRoutes, [kind]: false };
                    })();
                    pending = sent;
                } else if (outcome.kind === 'unsupported') {
                    stop = { unsupported: true };
                    pending = sent;
                } else if (outcome.kind === 'conflict') {
                    const stale = new Set(outcome.ids);
                    sent.forEach(index => {
                        if (stale.has(items[index].annotation.id)) {
                            out[index] = {
                                status: 409,
                                reason: 'changed elsewhere',
                            };
                        }
                    });
                    pending = sent.filter(
                        index => !stale.has(items[index].annotation.id)
                    );
                } else if (outcome.kind === 'refused') {
                    out[sent[outcome.index]] = {
                        status: outcome.status,
                        reason: outcome.reason,
                    };
                    pending = sent.filter((_, at) => at !== outcome.index);
                } else {
                    // Access refused, or the request failed: none saved.
                    stop = {
                        status: outcome.kind === 'access' ? 403 : 0,
                        reason: outcome.reason,
                    };
                    pending = sent;
                }
            }
        }
        return out;
    }

    /**
     * Applies a review entry: `review` (undo) resets the reviews, `reset`
     * (redo) reviews them again with the decision, each with its current
     * version. A service that cannot reset turns review undo off for the
     * session, and the next Undo goes on to the edit before. A reset
     * refused because another user reviewed it since (only the latest
     * reviewer may reset) says so. Resolves to the entry that reverses what
     * was applied.
     */
    private async applyReviewEntry(
        entry: Extract<WsiUndoEntry, { kind: 'review' | 'reset' }>
    ): Promise<WsiUndoEntry | null> {
        const decision = entry.kind === 'review' ? 'reset' : entry.decision;
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        const current = (id: string) =>
            this.annotations.find(item => item.id === id);
        const outcomes = await this.sendItems(
            'review',
            entry.items.map(item => ({
                annotation: {
                    id: item.id,
                    version: current(item.id)?.version ?? item.version,
                },
                fields: { decision },
            })),
            item => this.reviewOne(item.annotation, decision)
        );
        if (!this.isCurrent(context)) return null;
        const done: WsiReviewedItem[] = [];
        const rows: any[] = [];
        const failed: Array<[
            WsiReviewedItem,
            { status: number; reason: string }
        ]> = [];
        let unsupported = false;
        outcomes.forEach((outcome, index) => {
            const item = entry.items[index];
            if ('row' in outcome) {
                rows.push(outcome.row);
                done.push({
                    ...item,
                    version: outcome.row?.version ?? item.version,
                });
            } else if ('unsupported' in outcome) {
                unsupported = true;
            } else {
                failed.push([item, outcome]);
            }
        });
        const reviewers = new Map(
            failed.map(([item]) => [
                item.id,
                current(item.id)?.provenance?.reviewed_by,
            ])
        );
        this.applyReviewedRows(rows);
        if (unsupported) {
            action(() => {
                this.resetRoute = false;
                // Reviews are not undone from now on: drop them from the history.
                this.undoStack = this.undoStack.filter(
                    item => item.kind !== 'review'
                );
                this.redoStack = this.redoStack.filter(
                    item => item.kind !== 'reset'
                );
                this.notice = WSI_REVIEW_RESET_UNSUPPORTED;
                if (this.reviewQueue) {
                    this.reviewQueue = {
                        ...this.reviewQueue,
                        message: WSI_REVIEW_RESET_UNSUPPORTED,
                    };
                }
            })();
        } else if (decision === 'reset' && rows.length) {
            action(() => {
                this.resetRoute = true;
            })();
        }
        if (failed.length && this.accessIssue === null) {
            const what =
                decision === 'reset'
                    ? `undo the ${entry.decision} of`
                    : `${entry.decision} again`;
            const reasons = failed.slice(0, 3).map(([item, outcome]) => {
                const label = `"${item.label || '(unlabeled)'}"`;
                if (
                    outcome.status === 403 &&
                    /reviewer/i.test(outcome.reason)
                ) {
                    const who = reviewers.get(item.id);
                    return `${label}: ${
                        typeof who === 'string' && who ? who : 'another user'
                    } reviewed it since, and only the latest reviewer can undo a review`;
                }
                if (outcome.status === 422 && decision === 'reset') {
                    return `${label}: it is no longer reviewed`;
                }
                if (outcome.status === 404) {
                    return `${label}: it was deleted or is no longer shared with you`;
                }
                return `${label}: ${outcome.reason}`;
            });
            const message = `Could not ${what} ${
                failed.length === 1
                    ? reasons[0]
                    : `${failed.length} AI annotations (${reasons.join('; ')}${
                          failed.length > reasons.length ? '; …' : ''
                      })`
            }.`;
            if (
                failed.some(
                    ([, outcome]) =>
                        outcome.status === 409 || outcome.status === 404
                )
            ) {
                await this.reloadCurrentSlide(message);
            } else {
                action(() => {
                    this.error = message;
                })();
            }
        }
        if (decision === 'reset' && done.length && this.reviewQueue) {
            const back = done.find(item =>
                this.reviewQueue!.ids.includes(item.id)
            );
            if (back) {
                action(() => {
                    this.reviewQueue = {
                        ...this.reviewQueue!,
                        message: `Took back the ${
                            entry.decision
                        } of "${back.label || '(unlabeled)'}".`,
                    };
                    this.showReviewItem(back.id);
                })();
            }
        }
        if (!done.length) return null;
        return {
            kind: entry.kind === 'review' ? 'reset' : 'review',
            decision: entry.decision,
            items: done,
        };
    }

    /**
     * Sends one review (`accept`, `reject` or `reset`) with `POST
     * /annotations/{id}/review` for undo or redo.
     */
    private async reviewOne(
        annotation: { id: string; version?: number },
        decision: 'accept' | 'reject' | 'reset'
    ): Promise<WsiItemOutcome> {
        try {
            const response = await this.request(
                `/annotations/${encodeURIComponent(annotation.id)}/review`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        decision,
                        version: annotation.version || 1,
                    }),
                }
            );
            return await this.itemOutcome(response);
        } catch (_) {
            return { status: 0, reason: 'network error' };
        }
    }

    /**
     * Puts reviewed (or reset) rows in place: a rejected one leaves the
     * slide, the others replace their annotation or, back from a reject,
     * return to it.
     */
    private applyReviewedRows(rows: any[]) {
        if (!rows.length) return;
        const annotations = rows.map(row =>
            this.fromApi(row, this.slideKey || '')
        );
        const rejected = new Set(
            annotations
                .filter(item => isRejectedAi(item.provenance))
                .map(item => item.id)
        );
        if (rejected.size) this.removeManyLocally(rejected);
        const shown = new Set(this.annotations.map(item => item.id));
        const replaced = rows.filter(
            (_, index) =>
                !rejected.has(annotations[index].id) &&
                shown.has(annotations[index].id)
        );
        if (replaced.length) this.replaceSaved(replaced);
        const back = annotations.filter(
            item => !rejected.has(item.id) && !shown.has(item.id)
        );
        if (back.length) {
            this.addSaved(back.map(annotation => ({ annotation })));
        }
    }

    /**
     * Records reviews saved with the review route: one undo step when the
     * service can reset reviews (assumed until it shows otherwise), else
     * off the history, so the next Undo says reviews cannot be undone.
     */
    @action
    private recordReview(
        decision: 'accept' | 'reject',
        reviewed: WsiAnnotation[]
    ) {
        if (!reviewed.length) return;
        if (this.resetRoute === false) {
            this.lastChangeWasReview = true;
            return;
        }
        this.pushUndo({
            kind: 'review',
            decision,
            items: reviewed.map(item => ({
                id: item.id,
                version: item.version || 1,
                label: item.body?.[0]?.value || '',
            })),
        });
    }

    /**
     * Deletes created annotations for undo (or restored ones for redo):
     * with `batch-delete` in requests of up to 100 when the service has
     * it, else (or for a request it refuses) one by one. Resolves to those
     * deleted.
     */
    private async deleteCreated(ids: string[]): Promise<WsiAnnotation[]> {
        const points = ids
            .map(id => this.annotations.find(item => item.id === id))
            .filter((item): item is WsiAnnotation => !!item);
        return this.deleteMany(points);
    }

    /**
     * Creates a run of points again, in batch saves, where the service
     * cannot restore them; the history follows their new ids. Resolves to
     * the points created, each with its new one.
     */
    private async createPointRun(
        before: WsiAnnotation[]
    ): Promise<Array<[WsiAnnotation, WsiAnnotation]>> {
        const drafts = before.map(point => ({
            ...point,
            id: `client-undo-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2)}`,
        }));
        const results = await this.saveAnnotations(drafts);
        const saved = this.addSaved(results);
        const created: Array<[WsiAnnotation, WsiAnnotation]> = [];
        results.forEach((result, index) => {
            if (result.annotation) {
                this.renameInHistory(before[index].id, result.annotation.id);
                created.push([before[index], result.annotation]);
            }
        });
        if (saved.length < before.length && this.accessIssue === null) {
            action(() => {
                this.error = `${before.length - saved.length} of ${
                    before.length
                } points could not be created again (${describeFailures(
                    results
                )}).`;
            })();
        }
        return created;
    }

    /** AI annotations that no one has reviewed yet. */
    @computed get unreviewedAiCount(): number {
        return this.annotations.filter(annotation =>
            isUnreviewedAi(annotation.provenance)
        ).length;
    }

    private isShown(annotation: WsiAnnotation): boolean {
        // The annotation under review shows whatever hides the others.
        if (annotation.id === this.reviewQueue?.currentId) return true;
        return (
            this.onShownLayer(annotation) &&
            this.shownKinds[this.annotationKind(annotation)]
        );
    }

    private onShownLayer(annotation: WsiAnnotation): boolean {
        return !this.hiddenLayerNames.has(
            annotation.layerName || DEFAULT_LAYER
        );
    }

    /**
     * Who `annotation` comes from: AI when a machine made it, else the
     * user's own, or another user's. With the user unknown every manual
     * annotation counts as the user's.
     */
    annotationOrigin(annotation: WsiAnnotation): WsiAnnotationOrigin {
        if (isAiProvenance(annotation.provenance)) return 'ai';
        return this.currentUser &&
            annotation.creator &&
            annotation.creator !== this.currentUser
            ? 'others'
            : 'mine';
    }

    /**
     * The Show kind of `annotation`: AI ones by their review, the rest by
     * origin (see `annotationOrigin`).
     */
    annotationKind(annotation: WsiAnnotation): WsiAnnotationShowKind {
        const origin = this.annotationOrigin(annotation);
        if (origin !== 'ai') return origin;
        return isUnreviewedAi(annotation.provenance)
            ? 'aiUnreviewed'
            : 'aiAccepted';
    }

    /**
     * The annotations of each Show kind on the shown layers, so the counts
     * of the kinds shown add up to what the slide shows.
     */
    @computed get kindCounts(): Record<WsiAnnotationShowKind, number> {
        const counts = { mine: 0, others: 0, aiUnreviewed: 0, aiAccepted: 0 };
        this.annotations.forEach(annotation => {
            if (this.onShownLayer(annotation)) {
                counts[this.annotationKind(annotation)] += 1;
            }
        });
        return counts;
    }

    /** The Show kinds offered: no "Others" while the user is unknown. */
    @computed get showKinds(): WsiAnnotationShowKind[] {
        return WSI_SHOW_KINDS.filter(
            kind => kind !== 'others' || !!this.currentUser
        );
    }

    /** Whether Show hides any kind. */
    @computed get showFiltered(): boolean {
        return this.showKinds.some(kind => !this.shownKinds[kind]);
    }

    /** Shows or hides one kind, on the slide, the list and the counts. */
    @action.bound
    setKindShown(kind: WsiAnnotationShowKind, shown: boolean) {
        this.shownKinds = { ...this.shownKinds, [kind]: shown };
        if (!shown) {
            this.annotorious?.cancelSelected?.();
            this.annotationTooltip = null;
        }
        this.applyLayerFilter();
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
        this.resetFocus();
        this.listFilter = EMPTY_LIST_FILTER;
        this.clearHistory();
        this.importPreview = null;
        this.importError = null;
        this.error = null;
        this.notice = null;
        this.accessIssue = null;
        this.pointsLeftUnsaved = leftUnsaved;
        this.loadFailed = false;
        this.loading = Boolean(this.apiUrl);
        this.destroyAnnotorious();
        this.slideNotes.reset(slideKey);
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
        const apiChanged = apiUrl !== this.apiUrl;
        if (apiChanged) {
            this.reviewRoute = null;
            this.resetRoute = null;
            this.restoreRoute = null;
            this.batchRoute = null;
            this.commentRoute = null;
            this.bulkRoutes = {
                update: null,
                delete: null,
                review: null,
                restore: null,
                'review-fallback': false,
            };
        }
        this.apiUrl = apiUrl;
        this.studyId = studyId;
        this.clearHistory();
        this.restartRequests();
        this.cancelDrawing();
        this.annotations = [];
        this.resetFocus();
        this.error = null;
        this.notice = null;
        this.accessIssue = null;
        this.pointsLeftUnsaved = leftUnsaved;
        this.loadFailed = false;
        this.annotationTooltip = null;
        this.applyLayerFilter();
        const slideKey = this.slideKey;
        this.loading = Boolean(this.apiUrl && slideKey);
        this.slideNotes.reset(slideKey, apiChanged);
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
                          // A person reshaped it: an AI one is now edited.
                          provenance: editedProvenance(stored.provenance),
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
                if (event?.shiftKey) this.toggleSelected(annotation.id);
                else this.showAnnotationTooltip(annotation, event);
            }
        );
        this.pointLayer = new WsiPointLayer(viewer, openSeadragon);
        this.applyVisibility();
        if (viewer.addHandler) {
            viewer.addHandler('canvas-click', this.handleCanvasClick);
            viewer.addHandler('canvas-key', this.handleCanvasKey);
            this.canvasClickCleanup = () => {
                viewer.removeHandler?.('canvas-click', this.handleCanvasClick);
                viewer.removeHandler?.('canvas-key', this.handleCanvasKey);
            };
        }
        this.applySelectAction();
        this.applyLayerFilter();
        this.refreshStyle();
        this.installCustomDrawingHandlers();
        if (this.pointerSuspended) {
            this.setAnnotoriousOverlayPointerEvents(false);
        }
        this.openRequestedAnnotation();
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
     * Lets Annotorious edit only the shapes the user may change, and only
     * while Annotate is on; others can be selected, for their tooltip, but
     * not moved.
     */
    private applySelectAction() {
        if (!this.annotorious) return;
        if (!this.canEdit || !this.annotating) {
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
        this.slideNotes.reset(null);
        this.resetFocus();
        this.clearHistory();
        this.error = null;
        this.annotationTooltip = null;
        this.loading = false;
        this.destroyAnnotorious();
    }

    /** Annotate is on and the user may draw: the drawing tools show. */
    @computed get annotateOn(): boolean {
        return this.annotating && this.canEdit;
    }

    /** Turns Annotate on or off; off, drawing stops and Select is on. */
    @action.bound
    setAnnotating(annotating: boolean) {
        if (annotating && !this.canEdit) return;
        if (!annotating) this.cancelDrawing();
        this.annotating = annotating;
        this.saveToolbarPrefs();
        this.applySelectAction();
    }

    private saveToolbarPrefs() {
        saveToolbarPrefs({
            annotating: this.annotating,
            shapeTool: this.shapeTool,
            outlineTool: this.outlineTool,
            measureKeep: this.measureKeep,
        });
    }

    /**
     * Whether the toolbar's single-key shortcuts apply: Annotate is on and
     * the user may draw.
     */
    @computed get toolShortcutsActive(): boolean {
        return (
            this.annotating &&
            this.canEdit &&
            this.visible &&
            !this.reviewQueue &&
            this.paneActive &&
            !this.viewerHidden
        );
    }

    /**
     * Picks a drawing tool, or Select with null; a drawing tool turns
     * Annotate on. The Shape and Outline menus remember their last tool.
     */
    @action.bound
    setTool(tool: WsiAnnotationTool) {
        if (tool !== null && !this.canEdit) return;
        // A high-power field needs the slide's scale.
        if (tool === 'hpf' && !this.mpp) return;
        void this.flushPoints();
        this.pointRun = null;
        if (isShapeTool(tool)) this.shapeTool = tool;
        if (isOutlineTool(tool)) this.outlineTool = tool;
        if (tool === 'line' || tool === 'measure') {
            this.measureKeep = tool === 'line';
        }
        if (tool !== null && !this.annotating) {
            this.annotating = true;
            this.applySelectAction();
        }
        if (tool !== null) {
            this.saveToolbarPrefs();
            // A tooltip left from Select would sit over the slide.
            this.annotationTooltip = null;
        }
        this.activeTool = tool;
        this.brushPointer = null;
        this.resetGesture();
        this.tissueMessage = null;
        if (tool === 'wand' || tool === 'smartBrush') {
            void this.ensureTissueSession(tool);
        }
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

    /** Sets the wand's and smart brush's tolerance; a pending wand outline follows. */
    @action.bound
    setTissueTolerance(tolerance: number) {
        if (!Number.isFinite(tolerance)) return;
        const value = Math.max(
            MIN_TISSUE_TOLERANCE,
            Math.min(MAX_TISSUE_TOLERANCE, Math.round(tolerance))
        );
        this.tissueTolerance = value;
        if (this.activeTool === 'wand' && this.tissueSession?.pending) {
            this.tissueSession.setTolerance(value);
        }
    }

    /**
     * The magic wand's or smart brush's session for `tool`, loading the
     * tissue chunk first; null when the tool changed meanwhile or there is
     * no slide.
     */
    private ensureTissueSession(
        tool: 'wand' | 'smartBrush'
    ): Promise<WsiTissueSession | null> {
        if (this.tissueSession?.tool === tool) {
            return Promise.resolve(this.tissueSession);
        }
        if (this.tissueSessionPromise && this.tissueSessionTool === tool) {
            return this.tissueSessionPromise;
        }
        this.disposeTissue();
        this.tissueSessionTool = tool;
        const promise: Promise<WsiTissueSession | null> = loadTissueTools().then(
            action((mod: WsiTissueModule) => {
                if (this.tissueSessionPromise !== promise) return null;
                const viewer = this.osdViewer;
                const host =
                    this.tissueHostFactory?.() ||
                    (viewer
                        ? mod.createOsdTissueHost({
                              viewer,
                              imagePoint: (x: number, y: number) =>
                                  this.imagePoint(x, y),
                              mpp: () => this.mpp,
                              objectivePower: () =>
                                  this.objectivePowerProvider(),
                          })
                        : null);
                if (!host) {
                    this.tissueSessionPromise = null;
                    return null;
                }
                const session: WsiTissueSession = new mod.WsiTissueSession(
                    tool,
                    host,
                    action((view: WsiTissueView | null) => {
                        if (this.tissueSession === session) {
                            this.tissueView = view;
                        }
                    })
                );
                this.tissueSession = session;
                return session;
            }),
            action(() => {
                if (this.tissueSessionPromise === promise) {
                    this.tissueSessionPromise = null;
                    this.tissueMessage =
                        'The magic wand could not be loaded. Pick the tool again to retry.';
                }
                return null;
            })
        );
        this.tissueSessionPromise = promise;
        return promise;
    }

    private tissueSessionTool: 'wand' | 'smartBrush' | null = null;

    /** Ends the tissue session (another slide, or a new pixel host). */
    private disposeTissue() {
        this.tissueSession?.dispose();
        this.tissueSession = null;
        this.tissueSessionPromise = null;
        this.tissueSessionTool = null;
        this.tissueView = null;
        this.tissueDrag = null;
        this.smartStroke = null;
    }

    /** Whether the magic wand has an outline waiting for Enter. */
    get tissuePending(): boolean {
        return !!this.tissueSession?.pending;
    }

    /**
     * A magic wand press at `image`: Shift adds the region to the outline
     * waiting, Alt cuts it out of it; Alt with no outline waiting starts
     * one that is cut out of the selected regions when saved. A press inside
     * the waiting outline starts nothing new: dragging it changes the
     * tolerance (as dragging any press does).
     */
    private wandPress(event: PointerEvent, image: WsiXY) {
        const session = this.tissueSession;
        const pending = !!session?.pending;
        let kind: 'new' | 'add' | 'subtract' = 'new';
        let cut = false;
        if (pending && event.shiftKey) kind = 'add';
        else if (pending && event.altKey) kind = 'subtract';
        else if (!pending && event.altKey && this.selectedRegions.length) {
            cut = true;
        }
        const inside =
            pending &&
            kind === 'new' &&
            regionContainsPoint(session!.region, image);
        this.tissueMessage = null;
        this.tissueDrag = {
            pointerId: event.pointerId,
            startY: event.clientY,
            start: inside
                ? session!.tolerance ?? this.tissueTolerance
                : this.tissueTolerance,
            moved: false,
        };
        if (inside) return;
        const tolerance = this.tissueTolerance;
        if (session?.tool === 'wand') {
            // At once, so a drag of this press adjusts this click.
            void session.wandClick(image, kind, tolerance, cut);
            return;
        }
        void this.ensureTissueSession('wand').then(ready =>
            ready?.wandClick(image, kind, tolerance, cut)
        );
    }

    /**
     * Saves the magic wand's outline (Enter or a double-click) as a polygon
     * or multipolygon annotation, drawn as the toolbar's layer, label and
     * color; an outline started with Alt is cut out of the selected regions
     * instead, and in "Cut a hole…" it is the shape cut out.
     */
    async saveTissueSelection(): Promise<boolean> {
        const session = this.tissueSession;
        if (!session?.pending) return false;
        await session.whenIdle();
        if (this.tissueSession !== session || !session.pending) return false;
        const region = session.region;
        const cut = session.isCut;
        session.discard();
        if (!region.length) {
            action(() => {
                this.tissueMessage =
                    'Nothing is selected: raise the tolerance, or click on tissue.';
            })();
            return false;
        }
        await this.createRegionShape(
            region,
            cut || this.shapeEditMode !== null
        );
        return true;
    }

    /** Drops the magic wand's outline (Esc); the tool stays on. */
    discardTissueSelection() {
        this.tissueSession?.discard();
        this.tissueDrag = null;
    }

    /** Takes back the magic wand's last click (Ctrl+Z while one waits). */
    undoTissueStep() {
        this.tissueSession?.undoStep();
    }

    /**
     * Ends a smart brush stroke: its painted region is saved like a brush
     * shape (or cut out of the selected regions with Alt, or split along).
     */
    private async finishSmartBrush(
        points: WsiXY[],
        imagePerScreen: number,
        edit: boolean
    ) {
        const stroke = this.smartStroke;
        this.smartStroke = null;
        const session = await this.ensureTissueSession('smartBrush');
        if (!session || !stroke) return;
        if (this.shapeEditMode === 'split') {
            if (stroke.handle) session.cancelStroke(stroke.handle);
            await this.applyDrawnEdit({
                path: simplifyPath(
                    points,
                    STROKE_SIMPLIFY_TOLERANCE * imagePerScreen
                ),
            });
            return;
        }
        if (!stroke.started) {
            this.startSmartStroke(session, stroke);
        }
        const last = points[points.length - 1];
        if (last) session.strokeAdd(last, stroke.handle);
        // The stroke finishes on its own: a next stroke may already be drawn.
        const { region } = await session.strokeEnd(stroke.handle);
        session.clearUnlessDrawing();
        if (!region.length) {
            action(() => {
                this.tissueMessage =
                    'Nothing like the color under the start of the stroke was painted: raise the tolerance, or start on tissue.';
            })();
            return;
        }
        await this.createRegionShape(region, edit, false);
    }

    /** Hands a smart brush stroke's points so far to the session. */
    private startSmartStroke(
        session: WsiTissueSession,
        stroke: { points: WsiXY[]; started: boolean; handle?: object }
    ) {
        const width =
            this.drawGesture?.strokeImageWidth ??
            this.brushImageWidth(this.imagePixelsPerScreenPixel());
        const handle = session.strokeStart(
            stroke.points[0],
            width / 2,
            this.tissueTolerance
        );
        stroke.handle = handle;
        stroke.points
            .slice(1)
            .forEach(point => session.strokeAdd(point, handle));
        stroke.started = true;
    }

    /**
     * Saves a region from the magic wand or smart brush: as a new
     * annotation, or with `edit` as the shape of a cut (or split). With
     * `resetGesture` false (a smart brush stroke, finished while the next
     * may be drawn) the gesture in progress stays.
     */
    private async createRegionShape(
        region: WsiRegion,
        edit: boolean,
        resetGesture = true
    ) {
        if (!region.length) return;
        if (edit) {
            if (resetGesture) this.resetGesture();
            await this.applyDrawnEdit({ region });
            return;
        }
        const annotation = this.draftAnnotation(
            regionSelectorSvg(region),
            this.newShapeLabel()
        );
        if (resetGesture) this.resetGesture();
        await this.createAnnotation(annotation);
    }

    /**
     * The magic wand's or smart brush's outline on screen (an even-odd
     * path), with where its last click is; null when there is none.
     */
    @computed get tissueOutline(): {
        d: string;
        cut: boolean;
        anchor: WsiXY | null;
    } | null {
        const view = this.tissueView;
        if (!view) return null;
        void this.viewportRevision;
        const place = this.screenTransform();
        if (!place) return null;
        const d = view.region
            .map(rings =>
                rings
                    .map(
                        ring =>
                            `M${ring
                                .map(point => {
                                    const at = place(point);
                                    return `${Math.round(at.x * 10) /
                                        10},${Math.round(at.y * 10) / 10}`;
                                })
                                .join('L')}Z`
                    )
                    .join('')
            )
            .join('');
        return {
            d,
            cut: view.cut,
            anchor: view.seed ? place(view.seed) : null,
        };
    }

    /** The brush width in image pixels, with `imagePerScreen` at this zoom. */
    private brushImageWidth(imagePerScreen: number): number {
        return brushWidthInImagePixels(
            { microns: this.brushWidthUm, screenPixels: this.brushWidthPx },
            this.mpp,
            imagePerScreen
        );
    }

    /**
     * The brush outline under the pointer while the brush is on, in screen
     * pixels: its centre and its diameter at the current zoom (the stroke's
     * width while one is drawn).
     */
    @computed get brushCursor(): {
        x: number;
        y: number;
        diameter: number;
    } | null {
        const pointer = this.brushPointer;
        if (!pointer || !isBrushTool(this.activeTool)) return null;
        // Read so that the outline resizes as the slide zooms.
        void this.viewportRevision;
        const imagePerScreen = this.imagePixelsPerScreenPixel();
        const width =
            this.drawGesture?.strokeImageWidth ??
            this.brushImageWidth(imagePerScreen);
        return { x: pointer.x, y: pointer.y, diameter: width / imagePerScreen };
    }

    /**
     * The outline of the shape being drawn, in screen pixels: its image
     * points placed with the viewport as it is now, so it stays on the same
     * tissue when the slide is panned or zoomed mid-gesture.
     */
    @computed get customDrawPreview(): WsiDrawPreview | null {
        const gesture = this.drawGesture;
        if (!gesture) return null;
        // Read so that the outline is redrawn as the slide moves.
        void this.viewportRevision;
        const current = gesture.pointer;
        const first = gesture.imageStart ?? gesture.imagePoints?.[0];
        const start = (first && this.screenPoint(first)) || current;
        const preview: WsiDrawPreview = { tool: gesture.tool, start, current };
        const imagePoints = gesture.imagePoints;
        if (imagePoints) {
            // Placed on screen only when read: a stroke's preview adds its
            // new points itself (see `strokePoints`), so following the
            // pointer costs the same at any stroke length.
            const count = imagePoints.length;
            let placed: WsiXY[] | undefined;
            Object.defineProperty(preview, 'points', {
                enumerable: true,
                get: () =>
                    placed ||
                    (placed = imagePoints
                        .slice(0, count)
                        .map(point => this.screenPoint(point))
                        .filter((point): point is WsiXY => !!point)),
            });
        }
        if (gesture.strokeImageWidth !== undefined) {
            preview.strokeWidth =
                gesture.strokeImageWidth / this.imagePixelsPerScreenPixel();
        }
        if (gesture.imageStart) {
            preview.imageStart = gesture.imageStart;
            preview.imageCurrent =
                this.imagePoint(current.x, current.y) || undefined;
        }
        return preview;
    }

    /** Clears the quick ruler (Esc, or another slide). */
    @action.bound
    clearRuler() {
        this.ruler = null;
    }

    /** The quick ruler on screen, following the slide as it moves. */
    @computed get rulerOnScreen(): WsiRulerOnScreen | null {
        const ruler = this.ruler;
        if (!ruler || !this.visible) return null;
        void this.viewportRevision;
        const a = this.screenPoint(ruler.start);
        const b = this.screenPoint(ruler.end);
        if (!a || !b) return null;
        return {
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            text: formatRuler(measureRuler(ruler.start, ruler.end, this.mpp)),
        };
    }

    /**
     * The freehand or brush stroke being drawn, in image pixels. Points are
     * added to the array in place as the pointer moves; a new stroke is a
     * new array.
     */
    strokePoints(): readonly WsiXY[] | null {
        const gesture = this.drawGesture;
        return gesture && isStrokeTool(gesture.tool)
            ? gesture.imagePoints || null
            : null;
    }

    /**
     * Image pixels to screen pixels as the slide is shown now, for placing
     * many points at once; changes with `viewRevision`.
     */
    strokeScreenMapper(): ((point: WsiXY) => WsiXY) | null {
        return this.screenTransform();
    }

    /** Bumped when the slide moves on screen (see `strokeScreenMapper`). */
    get viewRevision(): number {
        return this.viewportRevision;
    }

    /** Whether a shape is being drawn: a press, a stroke or polygon vertices. */
    get drawingInProgress(): boolean {
        return (
            !!this.drawGesture ||
            !!this.pointerDown ||
            this.polygonPoints.length > 0 ||
            !!this.tissueView
        );
    }

    /** Drops the shape being drawn; the tool stays on for the next one. */
    @action.bound
    cancelShape() {
        this.resetGesture();
        this.annotorious?.cancelDrawing?.();
    }

    /** Goes back to Select, dropping any shape being drawn. */
    @action.bound
    cancelDrawing() {
        void this.flushPoints();
        this.pointRun = null;
        this.shapeEditMode = null;
        this.activeTool = null;
        this.brushPointer = null;
        this.resetGesture();
        this.annotorious?.cancelDrawing?.();
        this.annotorious?.setDrawingEnabled?.(false);
        this.setAnnotoriousOverlayPointerEvents(true);
        this.setCustomPointerEvents(false);
    }

    @action.bound
    toggleVisible() {
        this.visible = !this.visible;
        this.applyVisibility();
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

    /**
     * The color of `layer`'s new annotations: the one the user gave it,
     * else the one most of its annotations have, else the default color for
     * the default layer and a color of its own for any other.
     */
    layerColor(layer: string): NamedColor {
        const chosen = this.layerColors[layer];
        if (chosen) return chosen;
        const counts = new Map<string, { color: NamedColor; n: number }>();
        this.annotations.forEach(annotation => {
            if (
                (annotation.layerName || DEFAULT_LAYER) !== layer ||
                !annotation.color
            ) {
                return;
            }
            const key = `${annotation.colorName || ''}|${annotation.color}`;
            const entry = counts.get(key) || {
                color: {
                    name: annotation.colorName || '',
                    hex: annotation.color,
                },
                n: 0,
            };
            entry.n += 1;
            counts.set(key, entry);
        });
        const common = Array.from(counts.values()).sort((a, b) => b.n - a.n);
        if (common.length) return common[0].color;
        if (layer === DEFAULT_LAYER) return DEFAULT_NAMED_COLORS[0];
        const index = Math.max(this.layerNames.indexOf(layer), 1) - 1;
        return {
            name: layer,
            hex: LAYER_COLOR_CYCLE[index % LAYER_COLOR_CYCLE.length],
        };
    }

    /**
     * Sets the color of the active layer's new annotations; the layer keeps
     * it from now on. Annotations already drawn keep their color.
     */
    @action.bound
    setActiveNamedColor(name: string, hex: string) {
        // A layer's color picked for another layer is named after the layer
        // it is used on, not the one it came from.
        const layerColorName =
            name !== this.activeLayer && this.layerNames.includes(name);
        this.useColor(layerColorName ? this.activeLayer : name, hex);
        this.layerColors = {
            ...this.layerColors,
            [this.activeLayer]: {
                name: this.activeColorName,
                hex: this.activeColor,
            },
        };
        saveLayerColors(this.layerColors);
    }

    @action
    private useColor(name: string, hex: string) {
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

    /** Draws on `layer` from now on, in the layer's color. */
    @action.bound
    setActiveLayer(layer: string) {
        this.activeLayer = layer;
        if (!this.customLayers.includes(layer)) {
            this.customLayers = [...this.customLayers, layer];
            saveLayerNames(this.customLayers);
        }
        const color = this.layerColor(layer);
        this.useColor(color.name, color.hex);
    }

    @action.bound
    addLayer(layer: string) {
        const normalized = layer.replace(/\|/g, '').trim();
        if (!normalized || this.customLayers.includes(normalized)) return;
        this.customLayers = [...this.customLayers, normalized];
        saveLayerNames(this.customLayers);
        this.setActiveLayer(normalized);
    }

    @action.bound
    toggleLayerVisibility(layer: string) {
        // Showing or hiding a layer by hand ends showing one layer alone.
        this.soloLayer = null;
        this.hiddenBeforeSolo = null;
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

    /**
     * The user's annotations in `layer`, which deleting it deletes, and
     * other users' annotations there, which keep it on the slide.
     */
    layerDeleteCounts(layer: string): { own: number; others: number } {
        const inLayer = this.annotations.filter(
            annotation => (annotation.layerName || DEFAULT_LAYER) === layer
        );
        const own = inLayer.filter(annotation => this.canModify(annotation))
            .length;
        return { own, others: inLayer.length - own };
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
        if (this.soloLayer === layer && !this.layerNames.includes(layer)) {
            this.toggleSoloLayer(layer);
        }
        const hidden = new Set(this.hiddenLayerNames);
        hidden.delete(layer);
        this.hiddenLayerNames = hidden;
        if (this.activeLayer === layer) {
            this.setActiveLayer(this.layerNames[0] || DEFAULT_LAYER);
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
     * trail and the viewer stops showing it. Undo resets the review to
     * unreviewed (`decision: "reset"`, see `applyReviewEntry`) where the
     * service can.
     *
     * A service without the route falls back to the creator-only update
     * (accept) and delete (reject), neither undoable. The route is missing on a 405, or on a
     * 404 whose JSON `detail` is the framework's "Not Found"; any other 404
     * (a proxy's page, or the annotation gone) does not decide it.
     */
    @action.bound
    async reviewAnnotation(
        id: string,
        decision: 'accept' | 'reject'
    ): Promise<boolean> {
        const reviewed = await this.submitReview(id, decision);
        if (reviewed && reviewed !== 'fallback') {
            this.recordReview(decision, [reviewed]);
        }
        return !!reviewed;
    }

    /**
     * Sends one review (see `reviewAnnotation`) without recording it for
     * undo: resolves to the reviewed annotation, `fallback` when the
     * service without the review route recorded it otherwise, or null when
     * it was not saved.
     */
    private async submitReview(
        id: string,
        decision: 'accept' | 'reject'
    ): Promise<WsiAnnotation | 'fallback' | null> {
        const annotation = this.annotations.find(item => item.id === id);
        if (!annotation || !this.canReview(annotation)) return null;
        if (this.reviewRoute === false) {
            return (await this.reviewWithoutRoute(annotation, decision))
                ? 'fallback'
                : null;
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
            if (!this.isCurrent(context)) return null;
            const detail =
                response.status === 404
                    ? await this.errorDetail(response)
                    : undefined;
            if (
                response.status === 405 ||
                (response.status === 404 && detail === 'Not Found')
            ) {
                action(() => {
                    this.reviewRoute = false;
                })();
                return (await this.reviewWithoutRoute(annotation, decision))
                    ? 'fallback'
                    : null;
            }
            if (await this.refuseNonCreator(response)) return null;
            if (this.refuseAccess(response)) return null;
            if (response.status === 404) {
                await this.reloadCurrentSlide(
                    typeof detail === 'string' && /annotation/i.test(detail)
                        ? 'The annotation was deleted elsewhere; reloaded latest data.'
                        : 'Unable to save the review.'
                );
                return null;
            }
            if (response.status === 409) {
                await this.reloadCurrentSlide(
                    'Annotation changed elsewhere; reloaded latest data.'
                );
                return null;
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
            if (!this.isCurrent(context)) return null;
            action(() => {
                this.reviewRoute = true;
                if (isRejectedAi(saved.provenance)) {
                    this.removeAnnotationLocally(id);
                } else {
                    this.replaceAnnotation(id, saved);
                }
            })();
            return saved;
        } catch (_) {
            if (!this.isCurrent(context)) return null;
            await this.reloadCurrentSlide('Unable to save the review.');
            return null;
        }
    }

    /** The JSON `detail` of an error response; undefined if it has none. */
    private async errorDetail(response: Response): Promise<unknown> {
        if (typeof response.clone !== 'function') return undefined;
        try {
            return (await response.clone().json())?.detail;
        } catch (_) {
            return undefined;
        }
    }

    /**
     * A review against a service without the review route: its creator
     * accepts with a versioned update and rejects by deleting. Like a
     * review, neither is recorded for undo.
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
                ? !!(await this.updateAnnotation(
                      {
                          ...annotation,
                          provenance: acceptedProvenance(annotation.provenance),
                      },
                      false
                  ))
                : await this.deleteAnnotation(annotation.id, false);
        if (done) {
            action(() => {
                this.lastChangeWasReview = true;
                this.notice = WSI_REVIEW_FALLBACK_NOTICE[decision];
            })();
        }
        return done;
    }

    @action.bound
    dismissNotice() {
        this.notice = null;
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

    // ---- AI review queue ----

    /**
     * Unreviewed AI annotations the user may review now, of those shown
     * (layers and Show): the review queue holds these.
     */
    @computed get reviewableAi(): WsiAnnotation[] {
        return this.shownAnnotations.filter(annotation =>
            this.canReview(annotation)
        );
    }

    /** Why the review queue cannot open now, or null when it can. */
    @computed get reviewUnavailable(): string | null {
        if (this.loading) return 'Loading annotations…';
        if (this.accessMessage) return this.accessMessage;
        if (!this.canEdit) {
            return this.loadFailed
                ? 'Annotations could not be loaded.'
                : 'Reviewing is not available for this slide.';
        }
        if (!this.unreviewedAiCount) {
            return 'No AI annotations are waiting for review.';
        }
        if (this.reviewableAi.length) return null;
        if (!this.annotations.some(annotation => this.canReview(annotation))) {
            return WSI_REVIEW_UNSUPPORTED_MESSAGE;
        }
        return WSI_REVIEW_HIDDEN_MESSAGE;
    }

    /** The queue's annotations the user can still review, in queue order. */
    @computed get reviewRemaining(): string[] {
        const queue = this.reviewQueue;
        if (!queue) return [];
        const byId = new Map(this.annotations.map(item => [item.id, item]));
        return queue.ids.filter(id => {
            const annotation = byId.get(id);
            return !!annotation && this.canReview(annotation);
        });
    }

    /**
     * How many of the queue's annotations are reviewed, by anyone (or gone),
     * of how many it started with.
     */
    @computed get reviewProgress(): { reviewed: number; total: number } {
        const ids = this.reviewQueue?.ids || [];
        const byId = new Map(this.annotations.map(item => [item.id, item]));
        const reviewed = ids.filter(id => {
            const annotation = byId.get(id);
            return !annotation || !isUnreviewedAi(annotation.provenance);
        }).length;
        return { reviewed, total: ids.length };
    }

    /** The annotation under review. */
    @computed get reviewCurrent(): WsiAnnotation | null {
        const id = this.reviewQueue?.currentId;
        return (id && this.annotations.find(item => item.id === id)) || null;
    }

    /**
     * Opens the review queue on the slide's unreviewed AI annotations that
     * the user may review, in `spatialOrder`, and shows the first.
     */
    @action.bound
    startReview(): boolean {
        if (this.reviewUnavailable) return false;
        this.cancelDrawing();
        this.annotationTooltip = null;
        const placed: Array<{ id: string; bounds: WsiBounds }> = [];
        const unplaced: string[] = [];
        this.reviewableAi.forEach(annotation => {
            const shape = this.shapeOf(annotation);
            if (shape) {
                placed.push({ id: annotation.id, bounds: shapeBounds(shape) });
            } else {
                unplaced.push(annotation.id);
            }
        });
        const ids = [...spatialOrder(placed), ...unplaced];
        this.reviewQueue = { ids, currentId: null, busy: false, message: null };
        this.showReviewItem(ids[0] || null);
        return true;
    }

    /** Shows `id` for review: highlighted and fitted in the view. */
    @action
    private showReviewItem(id: string | null) {
        if (!this.reviewQueue) return;
        this.rejectArmed = null;
        this.reviewQueue = { ...this.reviewQueue, currentId: id };
        this.focusedAnnotationId = id;
        this.annotorious?.cancelSelected?.();
        this.applyLayerFilter();
        if (id) this.zoomToAnnotation(id);
    }

    /**
     * The next annotation still to review after the current one in queue
     * order (or before it, with -1), wrapping around; the current one when
     * it is the only one left, and null when none is.
     */
    private nextReviewId(direction: 1 | -1): string | null {
        const queue = this.reviewQueue;
        const remaining = new Set(this.reviewRemaining);
        if (!queue || !remaining.size) return null;
        const n = queue.ids.length;
        const start = queue.currentId ? queue.ids.indexOf(queue.currentId) : -1;
        for (let step = 1; step <= n; step++) {
            const id = queue.ids[(((start + direction * step) % n) + n) % n];
            if (remaining.has(id)) return id;
        }
        return null;
    }

    /** Skips to the next annotation to review, or back to the previous. */
    @action.bound
    reviewStep(direction: 1 | -1 = 1) {
        const queue = this.reviewQueue;
        if (!queue || queue.busy) return;
        this.reviewQueue = { ...queue, message: null };
        this.showReviewItem(this.nextReviewId(direction));
    }

    /**
     * The annotation under review whose reject waits for confirmation (X or
     * Reject pressed once), or null.
     */
    @observable rejectArmed: string | null = null;

    /**
     * Rejects the annotation under review in two steps: the first press
     * (X or Reject) asks, the second (X, Enter or Confirm reject) rejects.
     * A reject hides it for everyone; Undo resets it where the service can.
     */
    @action.bound
    reviewReject(): Promise<boolean> {
        const current = this.reviewCurrent;
        if (!current || !this.reviewQueue || this.reviewQueue.busy) {
            return Promise.resolve(false);
        }
        if (this.rejectArmed !== current.id) {
            this.rejectArmed = current.id;
            return Promise.resolve(false);
        }
        this.rejectArmed = null;
        return this.reviewDecide('reject');
    }

    /** Takes back a reject waiting for confirmation. */
    @action.bound
    cancelReject() {
        this.rejectArmed = null;
    }

    /**
     * Accepts or rejects the annotation under review (see
     * `reviewAnnotation`), then shows the next one. When the review is not
     * saved, e.g. after a conflict reloaded the slide, the queue stays on the
     * annotation while it still needs review, and says why.
     */
    @action.bound
    async reviewDecide(decision: 'accept' | 'reject'): Promise<boolean> {
        const queue = this.reviewQueue;
        const current = this.reviewCurrent;
        if (!queue || queue.busy || !current || !this.canReview(current)) {
            return false;
        }
        const label = current.body?.[0]?.value || '(unlabeled)';
        this.reviewQueue = { ...queue, busy: true, message: null };
        this.error = null;
        const done = await this.reviewAnnotation(current.id, decision);
        action(() => {
            const now = this.reviewQueue;
            // The queue was closed, or another slide opened, meanwhile.
            if (!now || now.ids !== queue.ids) return;
            this.reviewQueue = {
                ...now,
                busy: false,
                message: done
                    ? `${
                          decision === 'accept' ? 'Accepted' : 'Rejected'
                      } "${label}".`
                    : this.error || 'The review was not saved.',
            };
            if (done || !this.reviewRemaining.includes(current.id)) {
                this.showReviewItem(this.nextReviewId(1));
            }
        })();
        return done;
    }

    /** Closes the review queue. */
    @action.bound
    exitReview() {
        if (!this.reviewQueue) return;
        this.rejectArmed = null;
        this.reviewQueue = null;
        this.focusedAnnotationId = null;
        this.applyLayerFilter();
    }

    /** Forgets the review queue and the focused annotation. */
    private resetFocus() {
        this.threads.clear();
        this.commentCounts.clear();
        this.savedOnSlide = false;
        this.ruler = null;
        this.reviewQueue = null;
        this.rejectArmed = null;
        this.focusedAnnotationId = null;
        this.linkMessage = null;
        this.selection.clear();
        this.selectionDrag = null;
        this.bulkUndo = null;
        this.bulkMessage = null;
        this.shapeEditMode = null;
    }

    /**
     * The review queue's keys (`WSI_REVIEW_KEYS`) while it is open, before
     * any tool shortcut; returns whether the key was one. Not while typing,
     * and not for a key a control already handled (the toolbar's arrows).
     */
    private handleReviewKey(event: KeyboardEvent, typing: boolean): boolean {
        if (
            !this.reviewQueue ||
            typing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.defaultPrevented
        ) {
            return false;
        }
        const armed = !!this.rejectArmed;
        // A reject waiting for confirmation: Enter confirms, Esc cancels.
        if (armed && (event.key === 'Enter' || event.key === 'Escape')) {
            event.preventDefault();
            if (event.key === 'Enter') void this.reviewReject();
            else this.cancelReject();
            return true;
        }
        const key = WSI_REVIEW_KEYS[event.key.toLowerCase()];
        if (!key) return false;
        // Enter on a focused control (the card's Skip, a list row) is that
        // control's own; elsewhere it accepts.
        if (event.key === 'Enter' && isActivatable(event.target)) return false;
        event.preventDefault();
        if (key !== 'reject') this.cancelReject();
        if (key === 'exit') this.exitReview();
        else if (key === 'next') this.reviewStep(1);
        else if (key === 'previous') this.reviewStep(-1);
        else if (key === 'reject') void this.reviewReject();
        else void this.reviewDecide(key);
        return true;
    }

    // ---- the overlay over the slide ----

    /** Whether the overlay over the slide has anything to draw. */
    @computed get overlayActive(): boolean {
        return (
            !!this.focusedAnnotationId ||
            this.selectedIds.size > 0 ||
            !!this.selectionDrag ||
            !!this.ruler ||
            !!this.tissueView ||
            (this.showSlideLabels && !this.hideAll)
        );
    }

    /**
     * Image pixels to screen pixels as the slide is shown now. The mapping
     * is affine, so three mapped points give it for any number of shapes.
     */
    private screenTransform(): ((point: WsiXY) => WsiXY) | null {
        const affine = this.screenAffine();
        if (!affine) return null;
        const { a, b, c, d, e, f } = affine;
        return point => ({
            x: a * point.x + c * point.y + e,
            y: b * point.x + d * point.y + f,
        });
    }

    /** `screenTransform` as the coefficients of a canvas transform. */
    private screenAffine(): WsiScreenAffine | null {
        const unit = 1000;
        const origin = this.screenPoint({ x: 0, y: 0 });
        const xAxis = this.screenPoint({ x: unit, y: 0 });
        const yAxis = this.screenPoint({ x: 0, y: unit });
        if (!origin || !xAxis || !yAxis) return null;
        return {
            a: (xAxis.x - origin.x) / unit,
            b: (xAxis.y - origin.y) / unit,
            c: (yAxis.x - origin.x) / unit,
            d: (yAxis.y - origin.y) / unit,
            e: origin.x,
            f: origin.y,
        };
    }

    /**
     * The annotations as the slide shows them now, for the downloaded view:
     * the shown layers (solo and hidden layers, the unreviewed-AI filter),
     * in their colors with the Display fill, and the labels on the slide
     * when they are on, and the quick ruler while it shows. Null while
     * nothing shows (hidden, or H without a ruler). Transient drawing (the
     * shape being drawn, the selection, the highlight) is left out.
     */
    snapshotScene(): WsiAnnotationScene | null {
        if (!this.visible) return null;
        const affine = this.screenAffine();
        if (!affine) return null;
        const scene: WsiAnnotationScene = {
            affine,
            shapes: [],
            points: [],
            labels: this.hideAll ? [] : this.slideLabels,
            fillOpacity: this.outlineOnly ? 0 : this.fillOpacity,
        };
        const shown = this.hideAll ? [] : this.shownAnnotations;
        for (const annotation of shown) {
            const shape = this.shapeOf(annotation);
            if (!shape) continue;
            if (shape.kind === 'point') {
                scene.points.push({
                    x: shape.x,
                    y: shape.y,
                    color: annotation.color || DEFAULT_COLOR,
                });
            } else {
                scene.shapes.push({
                    shape,
                    color: annotation.color || this.activeColor,
                });
            }
        }
        // The quick ruler shows whatever hides the annotations.
        if (this.ruler) {
            scene.ruler = {
                ...this.ruler,
                text: formatRuler(
                    measureRuler(this.ruler.start, this.ruler.end, this.mpp)
                ),
            };
        }
        if (!scene.shapes.length && !scene.points.length && !scene.ruler) {
            return null;
        }
        const element = this.osdViewer?.element as HTMLElement | undefined;
        if (element && typeof getComputedStyle === 'function') {
            scene.fontFamily =
                getComputedStyle(element).fontFamily || undefined;
        }
        return scene;
    }

    /**
     * Draws the annotations shown on the slide onto a snapshot of it whose
     * pixels are `scale` times the viewer's (see `snapshotScene`).
     */
    drawSnapshot(context: CanvasRenderingContext2D, scale: number) {
        const scene = this.snapshotScene();
        if (scene) drawAnnotationScene(context, scene, scale);
    }

    /** Where `annotation` is on screen now: its box, in pixels. */
    screenBox(
        annotation: WsiAnnotation,
        transform = this.screenTransform()
    ): WsiScreenBox | null {
        const shape = this.shapeOf(annotation);
        if (!shape || !transform) return null;
        const bounds = shapeBounds(shape);
        const corners = [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.minX, y: bounds.maxY },
            { x: bounds.maxX, y: bounds.maxY },
        ].map(transform);
        const xs = corners.map(point => point.x);
        const ys = corners.map(point => point.y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return {
            x,
            y,
            width: Math.max(...xs) - x,
            height: Math.max(...ys) - y,
        };
    }

    /** The focused annotation's box on screen, following the slide. */
    @computed get focusedBox(): WsiScreenBox | null {
        // Read so that the box follows the slide as it moves.
        void this.viewportRevision;
        const id = this.focusedAnnotationId;
        const annotation = id && this.annotations.find(item => item.id === id);
        return annotation ? this.screenBox(annotation) : null;
    }

    /**
     * The labels drawn on the slide while `showSlideLabels` is on: at the
     * top-left of each shown shape that is large enough on screen, without
     * overlapping (see `placeSlideLabels`). They follow the slide as it
     * moves, and are part of no export.
     */
    /**
     * The shapes that can carry a slide label, with their bounds in image
     * pixels: computed once per change of the shown annotations, not per
     * frame as the slide moves.
     */
    @computed private get labelShapes(): Array<{
        id: string;
        text: string;
        bounds: WsiBounds;
    }> {
        const shapes: Array<{
            id: string;
            text: string;
            bounds: WsiBounds;
        }> = [];
        this.shownAnnotations.forEach(annotation => {
            const text = annotation.body?.[0]?.value || '';
            if (!text.trim() || this.isPoint(annotation)) return;
            const shape = this.shapeOf(annotation);
            if (shape) {
                shapes.push({
                    id: annotation.id,
                    text,
                    bounds: shapeBounds(shape),
                });
            }
        });
        return shapes;
    }

    @computed get slideLabels(): WsiPlacedLabel[] {
        if (!this.showSlideLabels || this.hideAll || !this.visible) return [];
        void this.viewportRevision;
        const affine = this.screenAffine();
        if (!affine) return [];
        const { a, b, c, d, e, f } = affine;
        const transform = (point: WsiXY) => ({
            x: a * point.x + c * point.y + e,
            y: b * point.x + d * point.y + f,
        });
        const element = this.osdViewer?.element as HTMLElement | undefined;
        const view =
            element && element.clientWidth > 0 && element.clientHeight > 0
                ? { width: element.clientWidth, height: element.clientHeight }
                : null;
        // Cull in image pixels before mapping, sorting and placing: the view
        // as a box of the image (its corners mapped back), and a shape too
        // small on screen for a label.
        const det = a * d - b * c;
        let visible: WsiBounds | null = null;
        if (view && det) {
            const back = (x: number, y: number) => ({
                x: (d * (x - e) - c * (y - f)) / det,
                y: (-b * (x - e) + a * (y - f)) / det,
            });
            const corners = [
                back(0, 0),
                back(view.width, 0),
                back(0, view.height),
                back(view.width, view.height),
            ];
            visible = {
                minX: Math.min(...corners.map(p => p.x)),
                minY: Math.min(...corners.map(p => p.y)),
                maxX: Math.max(...corners.map(p => p.x)),
                maxY: Math.max(...corners.map(p => p.y)),
            };
        }
        // Screen pixels per image pixel (the larger axis, so no label is
        // culled that would show).
        const scale = Math.max(Math.hypot(a, b), Math.hypot(c, d));
        const candidates: Array<{
            id: string;
            text: string;
            box: WsiScreenBox;
        }> = [];
        this.labelShapes.forEach(({ id, text, bounds }) => {
            if (
                visible &&
                (bounds.maxX < visible.minX ||
                    bounds.minX > visible.maxX ||
                    bounds.maxY < visible.minY ||
                    bounds.minY > visible.maxY)
            ) {
                return;
            }
            // Its box on screen is at most (width + height) × scale on a
            // side, whatever the rotation.
            if (
                (bounds.maxX - bounds.minX + bounds.maxY - bounds.minY) *
                    scale <
                SLIDE_LABEL_MIN_SHAPE
            ) {
                return;
            }
            const points = [
                { x: bounds.minX, y: bounds.minY },
                { x: bounds.maxX, y: bounds.minY },
                { x: bounds.minX, y: bounds.maxY },
                { x: bounds.maxX, y: bounds.maxY },
            ].map(transform);
            const x = Math.min(...points.map(p => p.x));
            const y = Math.min(...points.map(p => p.y));
            candidates.push({
                id,
                text,
                box: {
                    x,
                    y,
                    width: Math.max(...points.map(p => p.x)) - x,
                    height: Math.max(...points.map(p => p.y)) - y,
                },
            });
        });
        return placeSlideLabels(candidates, view);
    }

    // ---- selection and bulk actions ----

    /** The selected annotations still on the slide, in list order. */
    @computed get selectedAnnotations(): WsiAnnotation[] {
        if (!this.selectedIds.size) return [];
        return this.annotations.filter(item => this.selectedIds.has(item.id));
    }

    isSelected(id: string): boolean {
        return this.selection.has(id);
    }

    @action.bound
    toggleSelected(id: string) {
        const next = new Set(this.selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.setSelection(next);
    }

    /** Selects `ids`, added to the selection or in place of it. */
    @action.bound
    select(ids: string[], add = true) {
        const next = new Set(add ? this.selectedIds : []);
        ids.forEach(id => next.add(id));
        this.setSelection(next);
    }

    /** Selects every annotation the list shows (Ctrl/Cmd+A). */
    @action.bound
    selectAllListed() {
        this.select(
            this.listedAnnotations.map(item => item.id),
            false
        );
    }

    @action.bound
    clearSelection() {
        this.setSelection(new Set<string>());
    }

    @action
    private setSelection(ids: Set<string>) {
        // Only the ids that change: each row observes its own.
        Array.from(this.selection.keys()).forEach(id => {
            if (!ids.has(id)) this.selection.delete(id);
        });
        ids.forEach(id => {
            if (!this.selection.has(id)) this.selection.set(id, true);
        });
        this.bulkUndo = null;
        this.bulkMessage = null;
        if (this.shapeEditMode && !this.shapeEditTargets().length) {
            this.shapeEditMode = null;
        }
        this.refreshStyle();
    }

    /** The selected annotations' boxes on screen, following the slide. */
    @computed get selectedBoxes(): Array<{ id: string; box: WsiScreenBox }> {
        void this.viewportRevision;
        if (!this.selectedIds.size || this.hideAll || !this.visible) return [];
        const transform = this.screenTransform();
        if (!transform) return [];
        const boxes: Array<{ id: string; box: WsiScreenBox }> = [];
        for (const annotation of this.selectedAnnotations) {
            if (boxes.length >= SELECTION_FRAME_LIMIT) break;
            if (!this.isShown(annotation)) continue;
            const box = this.screenBox(annotation, transform);
            if (box) boxes.push({ id: annotation.id, box });
        }
        return boxes;
    }

    /** The Shift+drag selection box on screen. */
    @computed get selectionDragBox(): WsiScreenBox | null {
        void this.viewportRevision;
        const drag = this.selectionDrag;
        const transform = drag && this.screenTransform();
        if (!drag || !transform) return null;
        const a = transform(drag.start);
        const b = transform(drag.current);
        return {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            width: Math.abs(b.x - a.x),
            height: Math.abs(b.y - a.y),
        };
    }

    /** Whether Shift+click and Shift+drag select on the slide now. */
    private get canSelectOnSlide(): boolean {
        return this.visible && !this.hideAll && this.activeTool === null;
    }

    /**
     * The topmost annotation on the slide at image point `point` (a click,
     * with a few screen pixels' tolerance); the smallest when several
     * overlap, so a shape inside another can be picked.
     */
    annotationAt(point: WsiXY): WsiAnnotation | null {
        const tolerance = 6 * this.imagePixelsPerScreenPixel();
        let best: WsiAnnotation | null = null;
        let bestArea = Infinity;
        this.shownAnnotations.forEach(annotation => {
            const shape = this.shapeOf(annotation);
            if (!shape || !shapeContainsPoint(shape, point, tolerance)) return;
            const bounds = shapeBounds(shape);
            const area =
                (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
            if (area <= bestArea) {
                best = annotation;
                bestArea = area;
            }
        });
        return best;
    }

    /**
     * Ends a Shift+drag: a click toggles the annotation under it; a box
     * adds the annotations that lie wholly inside it.
     */
    @action
    private finishSelectionDrag(end: WsiXY, moved: number) {
        const drag = this.selectionDrag;
        this.selectionDrag = null;
        if (!drag) return;
        if (moved <= CLICK_TOLERANCE) {
            const hit = this.annotationAt(end);
            if (hit) this.toggleSelected(hit.id);
            return;
        }
        const box = {
            minX: Math.min(drag.start.x, end.x),
            maxX: Math.max(drag.start.x, end.x),
            minY: Math.min(drag.start.y, end.y),
            maxY: Math.max(drag.start.y, end.y),
        };
        this.select(
            this.shownAnnotations
                .filter(annotation => {
                    const shape = this.shapeOf(annotation);
                    return !!shape && boundsInside(shapeBounds(shape), box);
                })
                .map(annotation => annotation.id)
        );
    }

    /** How many selected annotations a bulk action applies to. */
    @computed get bulkCounts(): {
        modifiable: number;
        reviewable: number;
        ai: number;
    } {
        const selected = this.selectedAnnotations;
        return {
            modifiable: selected.filter(item => this.canModify(item)).length,
            reviewable: selected.filter(item => this.canReview(item)).length,
            ai: selected.filter(item => isAiProvenance(item.provenance)).length,
        };
    }

    /**
     * Applies a bulk action to the selected annotations `eligible` allows,
     * and says what was done, skipped (`why`) and not saved.
     *
     * With the service's batch route for `kind` (`POST
     * /annotations/batch-update`, `-delete`, `-review`), the annotations go
     * in requests of up to `BATCH_MAX_ITEMS`, each with its current
     * `version`, saved all or none:
     * - a 409 lists every stale annotation: those are reported as changed
     *   elsewhere, the slide is reloaded so they show as stored, and the
     *   rest are sent again from the reloaded versions;
     * - a 403 or 404 names the first refused annotation: it is reported by
     *   its label with the service's reason, and the rest are sent again
     *   (a missing one also reloads the slide at the end);
     * - a 404 "Not Found" or a 405 means the service has no such route: the
     *   rest, and later bulk actions of the kind, use one request per
     *   annotation (`single`), four at a time.
     * `item` gives an annotation's batch fields besides `id` and `version`,
     * or null when it needs no change (it counts as done); `saved` takes
     * the saved rows (as they were, for a delete) to apply them.
     */
    private async runBulk(
        kind: WsiBulkKind,
        verb: string,
        eligible: (annotation: WsiAnnotation) => boolean,
        why: string,
        item: (annotation: WsiAnnotation) => Record<string, unknown> | null,
        single: (annotation: WsiAnnotation) => Promise<boolean>,
        saved: (pairs: Array<[WsiAnnotation, any]>) => void
    ): Promise<{ done: number; skipped: number; failed: number }> {
        const selected = this.selectedAnnotations;
        const targets = selected.filter(eligible);
        const skipped = selected.length - targets.length;
        action(() => {
            this.bulkBusy = true;
            this.bulkUndo = null;
            this.bulkMessage = null;
            this.error = null;
        })();
        let done = 0;
        const reasons: string[] = [];
        let failed = 0;
        const fail = (
            annotation: WsiAnnotation | undefined,
            reason: string
        ) => {
            failed += 1;
            const label = annotation?.body?.[0]?.value || '(unlabeled)';
            if (reasons.length < 3) reasons.push(`"${label}": ${reason}`);
        };
        /** The latest stored version, as a conflict may have reloaded it. */
        const current = (id: string) =>
            this.annotations.find(annotation => annotation.id === id);
        const singles = async (rest: WsiAnnotation[]) => {
            const results = await runLimited(
                rest,
                SINGLE_SAVE_CONCURRENCY,
                async target => {
                    const latest = current(target.id);
                    return !!latest && eligible(latest) && single(latest);
                }
            );
            results.forEach((ok, index) => {
                if (ok) done += 1;
                else fail(rest[index], this.error || 'not saved');
            });
        };
        try {
            if (this.bulkRoutes[kind] === false) {
                await singles(targets);
            } else {
                let reload = false;
                for (
                    let start = 0;
                    start < targets.length;
                    start += BATCH_MAX_ITEMS
                ) {
                    let pending = targets.slice(start, start + BATCH_MAX_ITEMS);
                    // Each pass saves the chunk or drops at least one item.
                    while (pending.length) {
                        if (this.bulkRoutes[kind] === false) {
                            await singles(pending);
                            pending = [];
                            break;
                        }
                        const batch: Array<{
                            annotation: WsiAnnotation;
                            fields: Record<string, unknown>;
                        }> = [];
                        pending.forEach(target => {
                            const latest = current(target.id);
                            if (!latest || !eligible(latest)) {
                                fail(
                                    target,
                                    'no longer on the slide or allowed'
                                );
                                return;
                            }
                            const fields = item(latest);
                            if (fields === null) done += 1;
                            else batch.push({ annotation: latest, fields });
                        });
                        pending = [];
                        if (!batch.length) break;
                        const outcome = await this.sendBulkBatch(kind, batch);
                        if (outcome.kind === 'missing') {
                            action(() => {
                                this.bulkRoutes = {
                                    ...this.bulkRoutes,
                                    [kind]: false,
                                };
                            })();
                            pending = batch.map(entry => entry.annotation);
                            continue;
                        }
                        if (outcome.kind === 'saved') {
                            action(() => {
                                this.bulkRoutes = {
                                    ...this.bulkRoutes,
                                    [kind]: true,
                                };
                            })();
                            saved(
                                batch.map((entry, index) => [
                                    entry.annotation,
                                    outcome.rows[index],
                                ])
                            );
                            done += batch.length;
                            break;
                        }
                        if (outcome.kind === 'conflict') {
                            const stale = new Set(outcome.ids);
                            batch
                                .filter(entry => stale.has(entry.annotation.id))
                                .forEach(entry =>
                                    fail(
                                        entry.annotation,
                                        'changed elsewhere; reloaded'
                                    )
                                );
                            await this.reloadCurrentSlide(
                                'Some annotations changed elsewhere; reloaded latest data.'
                            );
                            pending = batch
                                .map(entry => entry.annotation)
                                .filter(
                                    annotation => !stale.has(annotation.id)
                                );
                            continue;
                        }
                        if (outcome.kind === 'refused') {
                            const refused = batch[outcome.index];
                            fail(refused?.annotation, outcome.reason);
                            if (outcome.status === 404) reload = true;
                            pending = batch
                                .filter((_, index) => index !== outcome.index)
                                .map(entry => entry.annotation);
                            continue;
                        }
                        // Access refused, or the request failed: none saved.
                        batch.forEach(entry =>
                            fail(entry.annotation, outcome.reason)
                        );
                        if (outcome.kind === 'access') break;
                    }
                    if (this.accessIssue !== null) {
                        targets
                            .slice(start + BATCH_MAX_ITEMS)
                            .forEach(target => fail(target, 'no access'));
                        break;
                    }
                }
                if (reload) {
                    await this.reloadCurrentSlide(
                        'An annotation was deleted elsewhere; reloaded latest data.'
                    );
                }
            }
        } finally {
            const plural = (n: number) =>
                `${n} annotation${n === 1 ? '' : 's'}`;
            const parts = [`${verb} ${plural(done)}`];
            if (skipped) {
                parts.push(
                    `skipped ${skipped} ${
                        skipped === 1 ? 'that is' : 'that are'
                    } ${why}`
                );
            }
            if (failed) {
                parts.push(
                    `${failed} could not be saved${
                        reasons.length
                            ? ` (${reasons.join('; ')}${
                                  failed > reasons.length ? '; …' : ''
                              })`
                            : ''
                    }`
                );
            }
            action(() => {
                this.bulkBusy = false;
                this.bulkMessage = `${parts.join('; ')}.`;
                this.bulkUndo = !done
                    ? null
                    : kind === 'review-fallback' ||
                      (kind === 'review' && !this.reviewsUndoable)
                    ? 'final'
                    : 'undoable';
            })();
        }
        return { done, skipped, failed };
    }

    /**
     * Sends one bulk batch request (see `runBulk`) and says how it went:
     * saved (with the rows in order), a conflict (the stale ids), one item
     * refused (its position and the service's reason), the route missing,
     * a `decision` the service does not know (`unsupported`), access
     * refused, or failed.
     */
    private async sendBulkBatch(
        kind: WsiBulkKind,
        batch: Array<{
            annotation: { id: string; version?: number };
            fields: Record<string, unknown>;
        }>
    ): Promise<
        | { kind: 'saved'; rows: any[] }
        | { kind: 'conflict'; ids: string[] }
        | { kind: 'refused'; index: number; reason: string; status: number }
        | { kind: 'missing' }
        | { kind: 'unsupported'; reason: string }
        | { kind: 'access'; reason: string }
        | { kind: 'failed'; reason: string }
    > {
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        let response: Response;
        try {
            response = await this.request(
                `/annotations/batch-${kind}`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        items: batch.map(({ annotation, fields }) => ({
                            id: annotation.id,
                            version: annotation.version || 1,
                            ...fields,
                        })),
                    }),
                },
                context.signal
            );
        } catch (_) {
            return { kind: 'failed', reason: 'network error' };
        }
        if (!this.isCurrent(context)) {
            return { kind: 'failed', reason: 'another slide opened' };
        }
        const detail = response.ok
            ? undefined
            : await this.errorDetail(response);
        if (
            response.status === 405 ||
            (response.status === 404 && detail === 'Not Found')
        ) {
            return { kind: 'missing' };
        }
        if (response.status === 422 && isUnknownDecision(detail)) {
            return {
                kind: 'unsupported',
                reason: 'the service does not take this decision',
            };
        }
        if (response.status === 409) {
            const conflicts = (detail as any)?.conflicts;
            const ids = Array.isArray(conflicts)
                ? conflicts
                      .map((conflict: any) => conflict?.id)
                      .filter((id: unknown) => typeof id === 'string')
                : [];
            return ids.length
                ? { kind: 'conflict', ids }
                : { kind: 'conflict', ids: batch.map(e => e.annotation.id) };
        }
        if (
            (response.status === 403 || response.status === 404) &&
            detail &&
            typeof detail === 'object' &&
            typeof (detail as any).index === 'number'
        ) {
            const named = detail as {
                index: number;
                id?: unknown;
                msg?: unknown;
            };
            const message = String(named.msg || 'refused');
            const index =
                batch[named.index]?.annotation.id === named.id ||
                named.id === undefined
                    ? named.index
                    : batch.findIndex(
                          entry => entry.annotation.id === named.id
                      );
            // A refusal that names no item of this request saves none.
            if (index < 0 || index >= batch.length) {
                return { kind: 'failed', reason: message };
            }
            return {
                kind: 'refused',
                index,
                reason: message,
                status: response.status,
            };
        }
        if (response.status === 422) {
            const named = batchItemErrors(
                Array.isArray(detail)
                    ? detail.map((error: any) => ({
                          ...error,
                          loc: Array.isArray(error?.loc)
                              ? error.loc.map((part: unknown) =>
                                    part === 'items' ? 'annotations' : part
                                )
                              : error?.loc,
                      }))
                    : detail
            );
            const first = Array.from(named.entries())[0];
            if (first) {
                return {
                    kind: 'refused',
                    index: first[0],
                    reason: first[1],
                    status: 422,
                };
            }
        }
        if (this.refuseAccess(response)) {
            return {
                kind: 'access',
                reason: this.accessMessage || 'no access',
            };
        }
        if (!response.ok) {
            return {
                kind: 'failed',
                reason:
                    typeof detail === 'string'
                        ? detail
                        : `save failed (${response.status})`,
            };
        }
        try {
            const rows = await response.json();
            if (Array.isArray(rows) && rows.length === batch.length) {
                return { kind: 'saved', rows };
            }
        } catch (_) {
            // Reported below.
        }
        return { kind: 'failed', reason: 'unexpected response' };
    }

    /** Puts saved rows in place of their annotations, in one change. */
    @action
    private replaceSaved(rows: any[]) {
        const byId = new Map<string, WsiAnnotation>();
        rows.forEach(row => {
            const annotation = this.fromApi(row, this.slideKey || '');
            byId.set(annotation.id, annotation);
        });
        this.annotations = this.annotations.map(
            annotation => byId.get(annotation.id) || annotation
        );
        this.applyLayerFilter();
        this.refreshStyle();
    }

    /** Removes annotations, in one change. */
    @action
    private removeManyLocally(ids: Set<string>) {
        this.annotations = this.annotations.filter(item => !ids.has(item.id));
        this.applyLayerFilter();
        this.refreshStyle();
    }

    /**
     * Saves `change` on each selected annotation the user may modify, as
     * one undo step.
     */
    private async bulkUpdate(
        verb: string,
        change: (annotation: WsiAnnotation) => WsiAnnotation | null
    ) {
        const before: WsiAnnotation[] = [];
        const result = await this.runBulk(
            'update',
            verb,
            annotation => this.canModify(annotation),
            'not yours',
            annotation => {
                const updated = change(annotation);
                if (!updated) return null;
                return {
                    body: this.toApiBody(updated),
                    target: { selector: updated.target.selector },
                    ...(updated.visibleTo !== undefined
                        ? { visible_to: updated.visibleTo }
                        : {}),
                };
            },
            async annotation => {
                const updated = change(annotation);
                if (!updated) return true;
                const saved = await this.updateAnnotation(updated, false);
                if (saved) before.push(annotation);
                return !!saved;
            },
            pairs => {
                pairs.forEach(([annotation]) => before.push(annotation));
                this.replaceSaved(pairs.map(([, row]) => row));
            }
        );
        if (before.length) {
            this.pushUndo({
                kind: 'group',
                entries: before.map(item => ({ kind: 'update', before: item })),
            });
        }
        return result;
    }

    /** Relabels the selected annotations the user may modify. */
    @action.bound
    bulkRelabel(label: string) {
        const value = label
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
        if (!value || !this.isAllowedLabel(value)) {
            this.bulkUndo = null;
            this.bulkMessage = value
                ? `"${value}" is not one of the allowed labels.`
                : 'Type a label first.';
            return Promise.resolve(null);
        }
        return this.bulkUpdate('Relabelled', annotation =>
            annotation.body?.[0]?.value === value
                ? null
                : {
                      ...annotation,
                      body: [
                          {
                              type: 'TextualBody',
                              value,
                              purpose: 'commenting',
                          },
                      ],
                  }
        );
    }

    /** Moves the selected annotations the user may modify to `layer`. */
    @action.bound
    bulkMoveToLayer(layer: string) {
        const name = layer.replace(/\|/g, '').trim();
        if (!name) return Promise.resolve(null);
        if (!this.customLayers.includes(name)) {
            this.customLayers = [...this.customLayers, name];
            saveLayerNames(this.customLayers);
        }
        return this.bulkUpdate(`Moved to "${name}"`, annotation =>
            (annotation.layerName || DEFAULT_LAYER) === name
                ? null
                : { ...annotation, layerName: name, legacyComment: undefined }
        );
    }

    /** Shares the selected annotations the user may modify, or makes them private. */
    @action.bound
    bulkSetShared(shared: boolean) {
        return this.bulkUpdate(shared ? 'Shared' : 'Made private', annotation =>
            annotationVisibility(annotation.visibleTo) ===
            (shared ? 'shared' : 'private')
                ? null
                : { ...annotation, visibleTo: shared ? [] : null }
        );
    }

    /**
     * Accepts or rejects the selected unreviewed AI annotations with the
     * review routes (`batch-review`, else one review each), as one undo
     * step where the service can reset reviews (see `recordReview`).
     */
    @action.bound
    async bulkReview(decision: 'accept' | 'reject') {
        const reviewed: WsiAnnotation[] = [];
        const result = await this.runBulk(
            // Without the review route, reviews fall back one by one.
            this.reviewRoute === false ? 'review-fallback' : 'review',
            decision === 'accept' ? 'Accepted' : 'Rejected',
            annotation => this.canReview(annotation),
            'not unreviewed AI annotations you can review',
            () => ({ decision }),
            async annotation => {
                const saved = await this.submitReview(annotation.id, decision);
                if (saved && saved !== 'fallback') reviewed.push(saved);
                return !!saved;
            },
            pairs => {
                action(() => {
                    this.reviewRoute = true;
                })();
                pairs.forEach(([, row]) =>
                    reviewed.push(this.fromApi(row, this.slideKey || ''))
                );
                this.applyReviewedRows(pairs.map(([, row]) => row));
            }
        );
        this.recordReview(decision, reviewed);
        return result;
    }

    /** Deletes the selected annotations the user may modify, as one undo step. */
    @action.bound
    async bulkDelete() {
        const deleted: WsiAnnotation[] = [];
        const result = await this.runBulk(
            'delete',
            'Deleted',
            annotation => this.canModify(annotation),
            'not yours',
            () => ({}),
            async annotation => {
                const done = await this.deleteAnnotation(annotation.id, false);
                if (done) deleted.push(annotation);
                return done;
            },
            pairs => {
                pairs.forEach(([annotation]) => deleted.push(annotation));
                this.removeManyLocally(
                    new Set(pairs.map(([annotation]) => annotation.id))
                );
            }
        );
        if (deleted.length) this.pushUndo({ kind: 'delete', before: deleted });
        return result;
    }

    @action.bound
    dismissBulkMessage() {
        this.bulkUndo = null;
        this.bulkMessage = null;
    }

    // ---- shape editing: merge, subtract, intersect, cut, split ----

    /** The selected annotations, in the order they were selected. */
    @computed get selectionInOrder(): WsiAnnotation[] {
        const byId = new Map(this.annotations.map(item => [item.id, item]));
        return Array.from(this.selectedIds)
            .map(id => byId.get(id))
            .filter((item): item is WsiAnnotation => !!item);
    }

    /** An annotation's region (see `shapeRegion`), or null for a line or point. */
    regionOf(annotation: WsiAnnotation): WsiRegion | null {
        const shape = this.shapeOf(annotation);
        return shape ? shapeRegion(shape) : null;
    }

    /**
     * The selected regions (rectangles, ellipses, polygons with or without
     * holes or parts), in the order they were selected.
     */
    @computed get selectedRegions(): WsiAnnotation[] {
        return this.selectionInOrder.filter(item =>
            isRegionShape(this.shapeOf(item))
        );
    }

    /** What a cut or split in progress applies to. */
    private shapeEditTargets(): WsiAnnotation[] {
        const regions = this.selectedRegions;
        return this.shapeEditMode === 'split' ? regions.slice(0, 1) : regions;
    }

    /**
     * The shape operations the selection allows, each with its menu text
     * and why it is off. Results are saved as the user's: a new annotation
     * of a merge or intersection; a subtraction, cut, split or separation
     * changes the user's own region in place, and makes a new annotation of
     * the user's from another user's region, which stays as it is.
     */
    @computed get shapeOps(): Record<
        WsiShapeOperation,
        { enabled: boolean; text: string; title: string }
    > {
        const regions = this.selectedRegions;
        const n = regions.length;
        const first = regions[0];
        const name = first
            ? `"${first.body?.[0]?.value || '(unlabeled)'}"`
            : '';
        const off = !this.canEdit
            ? 'Annotations are read-only here'
            : this.bulkBusy
            ? 'Saving…'
            : null;
        const op = (
            text: string,
            ready: boolean,
            title: string,
            why: string
        ) => ({
            enabled: !off && ready,
            text,
            title: off || (ready ? title : why),
        });
        const multipart = regions.filter(item => {
            const shape = this.shapeOf(item);
            return shape?.kind === 'multipolygon' && shape.polygons.length > 1;
        }).length;
        return {
            merge: op(
                `Merge ${n} regions`,
                n >= 2,
                'One new annotation of yours covering all of them, labelled as the first selected; your own originals are replaced',
                'Select two or more regions to merge'
            ),
            subtract: op(
                n >= 2 ? `Subtract the others from ${name}` : 'Subtract',
                n >= 2,
                `Cut the other selected regions out of ${name}, the first selected`,
                'Select the region to cut from first, then the regions to cut out'
            ),
            intersect: op(
                `Intersect ${n} regions`,
                n >= 2,
                'One new annotation of yours where all of them overlap; the originals stay',
                'Select two or more regions to intersect'
            ),
            cut: op(
                'Cut a hole…',
                n >= 1,
                'Draw a shape inside the selected regions to cut it out (or hold Alt while finishing a shape)',
                'Select a region to cut a hole in'
            ),
            split: op(
                n === 1 ? `Split ${name} by a line…` : 'Split by a line…',
                n === 1,
                'Draw a line across the region, from edge to edge; each piece becomes its own annotation',
                'Select one region to split'
            ),
            separate: op(
                multipart
                    ? `Separate the parts of ${multipart} region${
                          multipart === 1 ? '' : 's'
                      }`
                    : 'Separate parts',
                multipart > 0,
                'Each part of a multi-part region becomes its own annotation',
                'None of the selected regions has more than one part'
            ),
        };
    }

    /**
     * The originals a merge of the selection would delete: the user's own,
     * except AI ones (see `mergeSelected`).
     */
    get mergeDeletes(): WsiAnnotation[] {
        return this.selectedRegions.filter(
            item => this.canModify(item) && !isAiProvenance(item.provenance)
        );
    }

    /** Runs the shape operation picked in the selection bar. */
    @action.bound
    runShapeOp(operation: WsiShapeOperation): Promise<boolean> | void {
        if (!this.shapeOps[operation].enabled) return;
        switch (operation) {
            case 'merge':
                return this.mergeSelected();
            case 'subtract':
                return this.subtractSelected();
            case 'intersect':
                return this.intersectSelected();
            case 'separate':
                return this.separateSelected();
            default:
                this.startShapeEdit(operation);
        }
    }

    /**
     * Waits for a shape to be drawn: for `cut`, a closed shape (the Outline
     * menu's last tool is picked unless a closed-shape tool is on), cut out
     * of the selected regions; for `split`, a line (the Line tool, or a
     * freehand or polygon path) across the selected region. Stays on for
     * further cuts; a split ends it. Esc or Select stops it.
     */
    @action.bound
    startShapeEdit(mode: 'cut' | 'split') {
        if (!this.shapeOps[mode].enabled) return;
        const tool = this.activeTool;
        if (mode === 'cut') {
            const closed =
                tool === 'rectangle' ||
                tool === 'ellipse' ||
                tool === 'circle' ||
                isOutlineTool(tool);
            if (!closed) this.setTool(this.outlineTool);
        } else if (
            tool !== 'line' &&
            tool !== 'freehand' &&
            tool !== 'polygon'
        ) {
            this.setTool('line');
        }
        this.shapeEditMode = mode;
        this.bulkUndo = null;
        this.bulkMessage = null;
    }

    /** Stops a cut or split and goes back to Select. */
    @action.bound
    stopShapeEdit() {
        this.shapeEditMode = null;
        this.cancelDrawing();
    }

    /** What to draw for the cut or split in progress, for the selection bar. */
    @computed get shapeEditHint(): string | null {
        const targets = this.shapeEditTargets();
        if (!this.shapeEditMode || !targets.length) return null;
        const name =
            targets.length === 1
                ? `"${targets[0].body?.[0]?.value || '(unlabeled)'}"`
                : `the ${targets.length} selected regions`;
        return this.shapeEditMode === 'cut'
            ? `Cut a hole: draw a shape inside ${name}; it is cut out. Esc stops.`
            : `Split: draw a line across ${name}, from edge to edge. Esc stops.`;
    }

    /** Whether the shape being finished is for a cut or split, not saved. */
    private get drawingForShapeEdit(): boolean {
        return (
            this.shapeEditMode !== null ||
            (this.drawAlt && this.selectedRegions.length > 0)
        );
    }

    /**
     * A shape drawn for a cut or split: a closed region is cut out of the
     * selected regions (a cut, or Alt), a path splits the selected region.
     */
    private async applyDrawnEdit(drawn: {
        region?: WsiRegion | null;
        path?: WsiPoint[];
    }) {
        this.drawAlt = false;
        if (this.shapeEditMode === 'split') {
            if (drawn.path && drawn.path.length >= 2) {
                await this.splitSelected(drawn.path);
            } else {
                action(() => {
                    this.bulkMessage =
                        'To split, draw a line (or a freehand or polygon path) across the region.';
                })();
            }
            return;
        }
        if (drawn.region && drawn.region.length) {
            await this.cutSelected(drawn.region);
        } else {
            action(() => {
                this.bulkMessage =
                    'To cut a hole, draw a closed shape: a rectangle, ellipse, polygon, freehand or brush shape.';
            })();
        }
    }

    /** "Tumor 1" in quotes, for messages. */
    private quoted(annotation: WsiAnnotation): string {
        return `"${annotation.body?.[0]?.value || '(unlabeled)'}"`;
    }

    /**
     * A new annotation of the user's with `region`, made by `operation` from
     * `sources`: `from`'s label, layer and color; its sharing when it is
     * the user's own, else the default for new annotations; a provenance
     * naming the sources (see `derivedProvenance`).
     */
    private derivedDraft(
        from: WsiAnnotation,
        region: WsiRegion,
        operation: WsiShapeOperation,
        sources: WsiAnnotation[]
    ): WsiAnnotation {
        const draft = this.draftAnnotation(
            regionSelectorSvg(region),
            from.body?.[0]?.value || this.newShapeLabel()
        );
        return {
            ...draft,
            color: from.color || draft.color,
            colorName: from.colorName ?? draft.colorName,
            layerName: from.layerName || draft.layerName,
            visibleTo: this.canModify(from) ? from.visibleTo : undefined,
            provenance: derivedProvenance(operation, sources),
        };
    }

    /** The shape operation running now; the next waits for it. */
    private shapeEditChain: Promise<unknown> = Promise.resolve();

    /**
     * Runs shape operations one after another, so each reads the geometry
     * and versions the previous one saved (two quick cuts both apply).
     */
    private serializeShapeEdit<T>(run: () => Promise<T>): Promise<T> {
        const next = this.shapeEditChain.then(run, run);
        this.shapeEditChain = next.catch(() => undefined);
        return next;
    }

    /**
     * The shape operations' module (with polygon-clipping), loaded as its
     * own chunk on first use; null, saying so, when it cannot be loaded.
     */
    private async shapeOpsModule(): Promise<WsiShapeOpsModule | null> {
        try {
            return await loadShapeOps();
        } catch (_) {
            action(() => {
                this.bulkMessage =
                    'The shape operations could not be loaded. Try again.';
            })();
            return null;
        }
    }

    /**
     * Deletes `annotations` without recording undo: with the service's
     * `batch-delete` in one all-or-none request per 100, else (no route)
     * one by one. With `atomic`, a refused batch deletes none instead of
     * trying them one by one. Resolves to those deleted.
     */
    private async deleteMany(
        annotations: WsiAnnotation[],
        atomic = false
    ): Promise<WsiAnnotation[]> {
        const deleted: WsiAnnotation[] = [];
        for (
            let start = 0;
            start < annotations.length;
            start += BATCH_MAX_ITEMS
        ) {
            const chunk = annotations.slice(start, start + BATCH_MAX_ITEMS);
            if (this.bulkRoutes.delete !== false) {
                const outcome = await this.sendBulkBatch(
                    'delete',
                    chunk.map(annotation => ({ annotation, fields: {} }))
                );
                if (outcome.kind === 'saved') {
                    action(() => {
                        this.bulkRoutes = { ...this.bulkRoutes, delete: true };
                    })();
                    this.removeManyLocally(new Set(chunk.map(item => item.id)));
                    deleted.push(...chunk);
                    continue;
                }
                if (outcome.kind === 'missing') {
                    action(() => {
                        this.bulkRoutes = { ...this.bulkRoutes, delete: false };
                    })();
                } else {
                    if (outcome.kind !== 'access') {
                        action(() => {
                            this.error = `Delete refused: ${
                                outcome.kind === 'conflict'
                                    ? 'changed elsewhere'
                                    : outcome.reason
                            }.`;
                        })();
                    }
                    if (atomic || outcome.kind === 'access') break;
                }
            }
            const results = await runLimited(
                chunk,
                SINGLE_SAVE_CONCURRENCY,
                item => this.deleteAnnotation(item.id, false)
            );
            chunk.forEach((item, index) => {
                if (results[index]) deleted.push(item);
            });
        }
        return deleted;
    }

    /**
     * Saves a shape operation as one undo step, all or nothing: new
     * annotations first (in batch saves), then the new geometry of the
     * user's own regions (versioned `PUT`s; an AI one keeps its source and
     * is marked edited), then the deletes of the user's own originals (one
     * all-or-none `batch-delete` where the service has it). When any part
     * fails, what was saved is taken back (created ones deleted, changed
     * ones put back, deleted ones restored), so no overlapping shapes are
     * left, and `rolledBack` says so; undo then has nothing to do. Undo of
     * a saved operation deletes what was created, puts the previous
     * geometry back and restores the deleted ones (see `restoreDeleted`).
     */
    private async applyShapeEdit(
        operation: WsiShapeOperation,
        plan: {
            creates: WsiAnnotation[];
            updates: Array<{ annotation: WsiAnnotation; region: WsiRegion }>;
            deletes: WsiAnnotation[];
        }
    ): Promise<{
        created: WsiAnnotation[];
        updated: WsiAnnotation[];
        deleted: WsiAnnotation[];
        failed: number;
        rolledBack: boolean;
    }> {
        action(() => {
            this.bulkBusy = true;
            this.bulkUndo = null;
            this.bulkMessage = null;
            this.error = null;
        })();
        let created: WsiAnnotation[] = [];
        let updated: WsiAnnotation[] = [];
        let deleted: WsiAnnotation[] = [];
        let befores: WsiAnnotation[] = [];
        let failed = 0;
        let rolledBack = false;
        try {
            if (plan.creates.length) {
                const results = await this.saveAnnotations(plan.creates);
                created.push(...this.addSaved(results, plan.creates));
                failed += plan.creates.length - created.length;
            }
            if (!failed) {
                for (const { annotation, region } of plan.updates) {
                    const before = this.annotations.find(
                        item => item.id === annotation.id
                    );
                    if (!before) {
                        failed += 1;
                        break;
                    }
                    const saved = await this.updateAnnotation(
                        {
                            ...before,
                            target: {
                                ...before.target,
                                selector: {
                                    type: 'SvgSelector',
                                    value: regionSelectorSvg(region),
                                },
                            },
                            provenance: editedProvenance(before.provenance),
                        },
                        false
                    );
                    if (saved) {
                        updated.push(saved);
                        befores.push(before);
                    } else {
                        failed += 1;
                        break;
                    }
                }
            }
            if (!failed && plan.deletes.length) {
                deleted = await this.deleteMany(plan.deletes, true);
                failed += plan.deletes.length - deleted.length;
            }
            if (
                failed &&
                (created.length || updated.length || deleted.length)
            ) {
                const left = await this.rollBackShapeEdit(
                    created,
                    updated,
                    befores,
                    deleted
                );
                rolledBack =
                    !left.created.length &&
                    !left.updated.length &&
                    !left.deleted.length;
                created = left.created;
                updated = left.updated;
                befores = left.befores;
                deleted = left.deleted;
            }
        } finally {
            const entries: WsiUndoEntry[] = [
                ...(created.length
                    ? [
                          {
                              kind: 'create',
                              ids: created.map(item => item.id),
                          } as WsiUndoEntry,
                      ]
                    : []),
                ...befores.map(
                    before => ({ kind: 'update', before } as WsiUndoEntry)
                ),
                ...(deleted.length
                    ? [{ kind: 'delete', before: deleted } as WsiUndoEntry]
                    : []),
            ];
            action(() => {
                this.bulkBusy = false;
                if (entries.length) {
                    this.pushUndo({
                        kind: 'group',
                        label: SHAPE_OPERATION_NAMES[operation],
                        entries,
                    });
                }
            })();
        }
        return { created, updated, deleted, failed, rolledBack };
    }

    /**
     * Takes back a shape operation that was saved only in part: deletes the
     * annotations it created, puts the previous geometry back on those it
     * changed and restores those it deleted under their ids (created again
     * where the service cannot restore; see `restoreDeleted`). Resolves to
     * what could not be taken back (still saved), for undo.
     */
    private async rollBackShapeEdit(
        created: WsiAnnotation[],
        updated: WsiAnnotation[],
        befores: WsiAnnotation[],
        deleted: WsiAnnotation[]
    ): Promise<{
        created: WsiAnnotation[];
        updated: WsiAnnotation[];
        befores: WsiAnnotation[];
        deleted: WsiAnnotation[];
    }> {
        const reason = this.error;
        const removed = new Set(
            (await this.deleteMany(created)).map(item => item.id)
        );
        const leftUpdated: WsiAnnotation[] = [];
        const leftBefores: WsiAnnotation[] = [];
        for (let i = updated.length - 1; i >= 0; i--) {
            const current =
                this.annotations.find(item => item.id === updated[i].id) ||
                updated[i];
            const restored = await this.updateAnnotation(
                { ...befores[i], version: current.version },
                false
            );
            if (!restored) {
                leftUpdated.push(updated[i]);
                leftBefores.push(befores[i]);
            }
        }
        let leftDeleted: WsiAnnotation[] = [];
        if (deleted.length) {
            const back = await this.restoreDeleted(deleted);
            const returned = new Set([
                ...(back?.restored || []).map(item => item.id),
                ...(back?.recreated || []).map(([before]) => before.id),
            ]);
            leftDeleted = deleted.filter(item => !returned.has(item.id));
        }
        action(() => {
            this.error = reason;
        })();
        return {
            created: created.filter(item => !removed.has(item.id)),
            updated: leftUpdated,
            befores: leftBefores,
            deleted: leftDeleted,
        };
    }

    /**
     * A plan that gives `target` the `pieces` left by an operation: the
     * user's own region takes the first piece in place (keeping its id) and
     * the rest become new annotations; another user's region stays as it is
     * and every piece becomes a new annotation of the user's.
     */
    private replacementPlan(
        operation: WsiShapeOperation,
        target: WsiAnnotation,
        pieces: WsiRegion[],
        sources: WsiAnnotation[]
    ) {
        const own = this.canModify(target);
        return {
            updates: own ? [{ annotation: target, region: pieces[0] }] : [],
            creates: (own ? pieces.slice(1) : pieces).map(piece =>
                this.derivedDraft(target, piece, operation, sources)
            ),
            kept: own ? [] : [target],
        };
    }

    /** Says what a shape operation did, kept and could not save. */
    @action
    private reportShapeEdit(
        done: string,
        outcome: { failed: number; rolledBack?: boolean },
        notes: string[] = []
    ) {
        this.bulkUndo = outcome.rolledBack ? null : 'undoable';
        if (outcome.rolledBack) {
            this.bulkUndo = null;
            this.bulkMessage = `${done.replace(/\.$/, '')}${
                this.error ? ` (${this.error.replace(/\.$/, '')})` : ''
            }. What was saved of it was taken back, so nothing changed.`;
            return;
        }
        const parts = [done, ...notes];
        if (outcome.failed) {
            parts.push(
                `${outcome.failed} change${
                    outcome.failed === 1 ? '' : 's'
                } could not be saved${this.error ? ` (${this.error})` : ''}.`
            );
        }
        this.bulkMessage = parts.join(' ');
    }

    /** "Kept 2 that are not yours." */
    private keptNote(kept: WsiAnnotation[]): string[] {
        if (!kept.length) return [];
        return [
            `Kept ${kept.map(item => this.quoted(item)).join(', ')}: ${
                kept.length === 1 ? 'it is' : 'they are'
            } not yours, so ${
                kept.length === 1 ? 'it stays' : 'they stay'
            } as ${kept.length === 1 ? 'it is' : 'they are'}.`,
        ];
    }

    /**
     * Merges the selected regions into one new annotation of the user's
     * (the union; parts that do not touch stay parts), with the label,
     * layer and color of the first selected. The user's own originals are
     * deleted, except AI ones (the service lets only trusted writers create
     * AI annotations, so undo could not bring them back); other users'
     * stay. One undo step. The result is selected.
     */
    @action.bound
    async mergeSelected(): Promise<boolean> {
        return this.serializeShapeEdit(async () => {
            const regions = this.selectedRegions;
            if (regions.length < 2 || !this.canEdit) return false;
            const ops = await this.shapeOpsModule();
            if (!ops) return false;
            const union = ops.unionRegions(
                regions.map(item => this.regionOf(item)!).filter(Boolean)
            );
            if (!union.length) {
                this.bulkMessage =
                    'Nothing to merge: the regions have no area.';
                return false;
            }
            const kept = regions.filter(item => !this.canModify(item));
            const keptAi = regions.filter(
                item => this.canModify(item) && isAiProvenance(item.provenance)
            );
            const deletes = regions.filter(
                item => this.canModify(item) && !isAiProvenance(item.provenance)
            );
            const outcome = await this.applyShapeEdit('merge', {
                creates: [
                    this.derivedDraft(regions[0], union, 'merge', regions),
                ],
                updates: [],
                deletes,
            });
            const result = outcome.created[0];
            if (!result) {
                this.reportShapeEdit(
                    'The merged region was not saved.',
                    outcome
                );
                return false;
            }
            this.select([result.id], false);
            this.reportShapeEdit(
                `Merged ${regions.length} regions into ${this.quoted(result)}.`,
                outcome,
                [
                    ...this.keptNote(kept),
                    ...(keptAi.length
                        ? [
                              `Kept your AI annotation${
                                  keptAi.length === 1 ? '' : 's'
                              } ${keptAi
                                  .map(item => this.quoted(item))
                                  .join(
                                      ', '
                                  )}: only the service's trusted writers can create AI annotations, so undo could not bring ${
                                  keptAi.length === 1 ? 'it' : 'them'
                              } back. Reject or delete ${
                                  keptAi.length === 1 ? 'it' : 'them'
                              } if no longer needed.`,
                          ]
                        : []),
                ]
            );
            return true;
        });
    }

    /**
     * Cuts the other selected regions out of the first selected: in place
     * when it is the user's, else as a new annotation of the user's. The
     * others stay. One undo step.
     */
    @action.bound
    async subtractSelected(): Promise<boolean> {
        return this.serializeShapeEdit(async () => {
            const regions = this.selectedRegions;
            if (regions.length < 2 || !this.canEdit) return false;
            const [subject, ...clips] = regions;
            const region = this.regionOf(subject)!;
            const ops = await this.shapeOpsModule();
            if (!ops) return false;
            const result = ops.subtractRegions(
                region,
                clips.map(item => this.regionOf(item)!)
            );
            if (!result.length) {
                this.bulkUndo = null;
                this.bulkMessage = `Nothing would be left of ${this.quoted(
                    subject
                )}; nothing was changed.`;
                return false;
            }
            if (Math.abs(regionArea(result) - regionArea(region)) < 1e-6) {
                this.bulkUndo = null;
                this.bulkMessage = `The other regions do not overlap ${this.quoted(
                    subject
                )}; nothing was changed.`;
                return false;
            }
            const plan = this.replacementPlan(
                'subtract',
                subject,
                [result],
                regions
            );
            const outcome = await this.applyShapeEdit('subtract', {
                ...plan,
                deletes: [],
            });
            if (!outcome.created.length && !outcome.updated.length) {
                this.reportShapeEdit('The subtraction was not saved.', outcome);
                return false;
            }
            this.reportShapeEdit(
                `Cut ${clips.length} region${
                    clips.length === 1 ? '' : 's'
                } out of ${this.quoted(subject)}${
                    plan.kept.length ? ', as a new annotation of yours' : ''
                }.`,
                outcome,
                this.keptNote(plan.kept)
            );
            return true;
        });
    }

    /**
     * Saves where all the selected regions overlap as one new annotation of
     * the user's, labelled as the first selected. The originals stay.
     */
    @action.bound
    async intersectSelected(): Promise<boolean> {
        return this.serializeShapeEdit(async () => {
            const regions = this.selectedRegions;
            if (regions.length < 2 || !this.canEdit) return false;
            const ops = await this.shapeOpsModule();
            if (!ops) return false;
            const result = ops.intersectRegions(
                regions.map(item => this.regionOf(item)!)
            );
            if (!result.length) {
                this.bulkMessage =
                    'The selected regions do not all overlap; nothing was saved.';
                return false;
            }
            const outcome = await this.applyShapeEdit('intersect', {
                creates: [
                    this.derivedDraft(regions[0], result, 'intersect', regions),
                ],
                updates: [],
                deletes: [],
            });
            const created = outcome.created[0];
            if (!created) {
                this.reportShapeEdit(
                    'The intersection was not saved.',
                    outcome
                );
                return false;
            }
            this.select([created.id], false);
            this.reportShapeEdit(
                `Saved where ${regions.length} regions overlap as ${this.quoted(
                    created
                )}.`,
                outcome
            );
            return true;
        });
    }

    /**
     * Cuts `cutter` out of each selected region it overlaps: a hole when it
     * lies inside, a notch at an edge, pieces when it cuts across. The
     * user's own regions change in place, another user's region gives a new
     * annotation of the user's. A region it would remove entirely is left.
     * One undo step for all.
     */
    async cutSelected(cutter: WsiRegion): Promise<boolean> {
        return this.serializeShapeEdit(async () => {
            const targets = this.selectedRegions;
            const bounds = regionBounds(cutter);
            if (!targets.length || !bounds || !this.canEdit) return false;
            const ops = await this.shapeOpsModule();
            if (!ops) return false;
            const creates: WsiAnnotation[] = [];
            const updates: Array<{
                annotation: WsiAnnotation;
                region: WsiRegion;
            }> = [];
            const kept: WsiAnnotation[] = [];
            const whole: WsiAnnotation[] = [];
            const cut: WsiAnnotation[] = [];
            targets.forEach(target => {
                const region = this.regionOf(target)!;
                const box = regionBounds(region);
                if (!box || !boundsOverlap(box, bounds)) return;
                const result = ops.subtractRegions(region, [cutter]);
                if (Math.abs(regionArea(result) - regionArea(region)) < 1e-6) {
                    return;
                }
                if (!result.length) {
                    whole.push(target);
                    return;
                }
                const plan = this.replacementPlan(
                    'cut',
                    target,
                    [result],
                    [target]
                );
                creates.push(...plan.creates);
                updates.push(...plan.updates);
                kept.push(...plan.kept);
                cut.push(target);
            });
            if (!cut.length) {
                action(() => {
                    this.bulkUndo = null;
                    this.bulkMessage = whole.length
                        ? `The shape covers all of ${whole
                              .map(item => this.quoted(item))
                              .join(', ')}; nothing was cut.`
                        : 'The shape does not overlap a selected region; nothing was cut.';
                })();
                return false;
            }
            const outcome = await this.applyShapeEdit('cut', {
                creates,
                updates,
                deletes: [],
            });
            if (!outcome.created.length && !outcome.updated.length) {
                this.reportShapeEdit('The cut was not saved.', outcome);
                return false;
            }
            this.reportShapeEdit(
                `Cut the shape out of ${cut
                    .map(item => this.quoted(item))
                    .join(', ')}.`,
                outcome,
                [
                    ...(kept.length
                        ? [
                              `${kept
                                  .map(item => this.quoted(item))
                                  .join(', ')} ${
                                  kept.length === 1 ? 'is' : 'are'
                              } not yours: the cut was saved as a new annotation of yours, and the original stays.`,
                          ]
                        : []),
                    ...(whole.length
                        ? [
                              `Left ${whole
                                  .map(item => this.quoted(item))
                                  .join(', ')}: the shape covers all of it.`,
                          ]
                        : []),
                ]
            );
            return true;
        });
    }

    /**
     * Splits the selected region along `path` (a line or polyline across
     * it): the user's own region keeps the largest piece and the others
     * become new annotations with its label, layer and color; another
     * user's region stays and every piece is a new annotation of the
     * user's. One undo step. Ends the split, selecting the pieces.
     */
    async splitSelected(path: WsiPoint[]): Promise<boolean> {
        return this.serializeShapeEdit(async () => {
            const target = this.selectedRegions[0];
            if (!target || !this.canEdit) return false;
            const ops = await this.shapeOpsModule();
            if (!ops) return false;
            const pieces = ops.splitRegionByPath(this.regionOf(target)!, path);
            if (pieces.length < 2) {
                action(() => {
                    this.bulkUndo = null;
                    this.bulkMessage = `The line does not cut ${this.quoted(
                        target
                    )} in two: draw it across the region, from edge to edge.`;
                })();
                return false;
            }
            const plan = this.replacementPlan('split', target, pieces, [
                target,
            ]);
            const outcome = await this.applyShapeEdit('split', {
                ...plan,
                deletes: [],
            });
            if (!outcome.created.length && !outcome.updated.length) {
                this.reportShapeEdit('The split was not saved.', outcome);
                return false;
            }
            action(() => {
                this.shapeEditMode = null;
            })();
            this.cancelDrawing();
            this.select(
                [...outcome.updated, ...outcome.created].map(item => item.id),
                false
            );
            this.reportShapeEdit(
                `Split ${this.quoted(target)} into ${pieces.length} pieces.`,
                outcome,
                plan.kept.length
                    ? [
                          `${this.quoted(
                              target
                          )} is not yours: the pieces are new annotations of yours, and the original stays.`,
                      ]
                    : []
            );
            return true;
        });
    }

    /**
     * Makes each part of the selected multi-part regions its own annotation:
     * the user's own region keeps its first part, another user's region
     * stays and every part is new. One undo step.
     */
    @action.bound
    async separateSelected(): Promise<boolean> {
        return this.serializeShapeEdit(async () => {
            const targets = this.selectedRegions.filter(item => {
                const shape = this.shapeOf(item);
                return (
                    shape?.kind === 'multipolygon' && shape.polygons.length > 1
                );
            });
            if (!targets.length || !this.canEdit) return false;
            const creates: WsiAnnotation[] = [];
            const updates: Array<{
                annotation: WsiAnnotation;
                region: WsiRegion;
            }> = [];
            const kept: WsiAnnotation[] = [];
            let parts = 0;
            targets.forEach(target => {
                const pieces = regionParts(this.regionOf(target)!);
                parts += pieces.length;
                const plan = this.replacementPlan('separate', target, pieces, [
                    target,
                ]);
                creates.push(...plan.creates);
                updates.push(...plan.updates);
                kept.push(...plan.kept);
            });
            const outcome = await this.applyShapeEdit('separate', {
                creates,
                updates,
                deletes: [],
            });
            if (!outcome.created.length && !outcome.updated.length) {
                this.reportShapeEdit('The parts were not saved.', outcome);
                return false;
            }
            this.select(
                [...outcome.updated, ...outcome.created].map(item => item.id),
                false
            );
            this.reportShapeEdit(
                `Separated ${parts} parts of ${targets.length} region${
                    targets.length === 1 ? '' : 's'
                }.`,
                outcome,
                this.keptNote(kept)
            );
            return true;
        });
    }

    // ---- side by side ----

    /** The open slide's key, for side-by-side transfers. */
    get currentSlideKey(): string | null {
        return this.slideKey;
    }

    /**
     * Copies of annotations of another slide, mapped onto this one through
     * an alignment (`svg` is each one's mapped selector), saved as new
     * annotations of the user's in batch saves, as one undo step ("Undo
     * transfer of 3 annotations"). Each keeps its source's label, layer,
     * color and note, takes the default sharing, and is marked transferred
     * and unverified (see `transferredProvenance`).
     */
    async addTransferred(
        items: Array<{ source: WsiAnnotation; svg: string }>,
        from: {
            slideKey: string;
            model: string;
            residual: number | null;
            unit: 'um' | 'px';
        }
    ): Promise<{ created: WsiAnnotation[]; failed: number }> {
        if (!this.canEdit || !this.slideKey || !items.length) {
            return { created: [], failed: items.length };
        }
        const drafts = items.map(({ source, svg }) => {
            const draft = this.draftAnnotation(
                svg,
                source.body?.[0]?.value || this.newShapeLabel()
            );
            return {
                ...draft,
                color: source.color || draft.color,
                colorName: source.colorName ?? draft.colorName,
                layerName: source.layerName || draft.layerName,
                note: source.note || undefined,
                provenance: transferredProvenance(source, from),
            };
        });
        const generation = this.generation;
        const slideKey = this.slideKey;
        action(() => {
            this.bulkBusy = true;
            this.error = null;
        })();
        let created: WsiAnnotation[] = [];
        try {
            const results = await this.saveAnnotations(drafts);
            if (generation !== this.generation || slideKey !== this.slideKey) {
                return { created: [], failed: drafts.length };
            }
            created = this.addSaved(results, drafts);
            const failed = drafts.length - created.length;
            action(() => {
                if (created.length) {
                    this.pushUndo({
                        kind: 'group',
                        label: `transfer of ${created.length} annotation${
                            created.length === 1 ? '' : 's'
                        }`,
                        entries: [
                            {
                                kind: 'create',
                                ids: created.map(item => item.id),
                            },
                        ],
                    });
                }
                if (failed && this.accessIssue === null) {
                    this.error = `Copied ${created.length} of ${
                        drafts.length
                    } annotations; ${failed} could not be saved (${describeFailures(
                        results
                    )}).`;
                }
            })();
            return { created, failed };
        } finally {
            action(() => {
                this.bulkBusy = false;
            })();
        }
    }

    /** Whether the user may mark a transferred annotation verified. */
    canVerifyTransfer(annotation: WsiAnnotation): boolean {
        return (
            !!transferSource(annotation.provenance) &&
            annotation.provenance?.verified !== true &&
            !annotation.unsaved &&
            this.canModify(annotation)
        );
    }

    /**
     * Marks a transferred annotation verified: its place was checked by a
     * person (versioned `PUT`, creator only; not on the undo history).
     */
    async markTransferVerified(id: string): Promise<boolean> {
        const annotation = this.annotations.find(item => item.id === id);
        if (!annotation || !this.canVerifyTransfer(annotation)) return false;
        const saved = await this.updateAnnotation(
            {
                ...annotation,
                provenance: verifiedProvenance(
                    annotation.provenance,
                    this.currentUser
                ),
            },
            false
        );
        return !!saved;
    }

    /**
     * Whether this viewer takes keys and drawing tools. Side by side, only
     * the active pane's does; the other still shows its annotations.
     */
    @observable paneActive = true;

    @action.bound
    setPaneActive(active: boolean) {
        if (this.paneActive === active) return;
        if (!active) {
            this.cancelDrawing();
            this.annotationTooltip = null;
        }
        this.paneActive = active;
    }

    /**
     * The host hides the viewer (e.g. an inactive tab that stays mounted):
     * no shortcut acts then.
     */
    @observable viewerHidden = false;

    @action.bound
    setViewerHidden(hidden: boolean) {
        this.viewerHidden = hidden;
    }

    /** Clicks go to side-by-side point placing, not to shapes. */
    private pointerSuspended = false;

    /**
     * Stops clicks from selecting or editing shapes (and drawing), e.g.
     * while alignment points are placed on the slide; false gives them back.
     */
    @action.bound
    setPointerSuspended(suspended: boolean) {
        if (this.pointerSuspended === suspended) return;
        this.pointerSuspended = suspended;
        if (suspended) {
            this.cancelDrawing();
            this.annotationTooltip = null;
        }
        this.setAnnotoriousOverlayPointerEvents(
            !suspended && !isPointerAnnotationTool(this.activeTool)
        );
    }

    // ---- comment threads ----

    /** Whether annotations offer comment threads here. */
    @computed get commentsAvailable(): boolean {
        return this.commentRoute === true;
    }

    /** The comments in `annotation`'s thread, as this slide knows them. */
    commentCountOf(annotation: WsiAnnotation): number {
        return (
            this.commentCounts.get(annotation.id) ??
            annotation.commentCount ??
            0
        );
    }

    /**
     * The comment threads that deleting `annotations` concerns: kept with
     * a deleted annotation for a restore where the service restores (see
     * `restoresDeleted`), else gone with it. Loads the threads not loaded yet
     * (up to `THREAD_CHECK_LIMIT` annotations) to tell whose comments they
     * are; `byOthers` is null when not all could be checked. Null when none
     * has comments.
     */
    async threadLoss(
        annotations: WsiAnnotation[]
    ): Promise<{
        annotations: WsiAnnotation[];
        comments: number;
        byOthers: number | null;
    } | null> {
        const commented = annotations.filter(
            item => this.commentCountOf(item) > 0
        );
        if (!commented.length) return null;
        const unloaded = commented.filter(
            item => !this.threads.get(item.id)?.comments.length
        );
        if (this.commentsAvailable) {
            await runLimited(
                unloaded.slice(0, THREAD_CHECK_LIMIT),
                SINGLE_SAVE_CONCURRENCY,
                item => this.loadComments(item.id)
            );
        }
        let comments = 0;
        let byOthers: number | null = 0;
        commented.forEach(item => {
            const thread = this.threads.get(item.id);
            const count = this.commentCountOf(item);
            comments += count;
            if (
                !thread ||
                thread.comments.length < count ||
                !this.currentUser
            ) {
                byOthers = null;
            } else if (byOthers !== null) {
                byOthers += thread.comments.filter(
                    comment => comment.author !== this.currentUser
                ).length;
            }
        });
        return { annotations: commented, comments, byOthers };
    }

    /**
     * The warning for deleting (or merging away) `annotations` with
     * comments, or '' when none has any: how many comments, whether other
     * users wrote some, and what becomes of them: where the service
     * restores deleted annotations, Undo brings them back with their
     * comments until the service purges them (after
     * `WSI_DELETED_RETENTION_DAYS` by default); else they are gone.
     */
    async threadLossWarning(
        annotations: WsiAnnotation[],
        verb: 'Deleting' | 'Merging'
    ): Promise<string> {
        const loss = await this.threadLoss(annotations);
        if (!loss) return '';
        const { comments, byOthers } = loss;
        const n = loss.annotations.length;
        const whose =
            byOthers === null
                ? ', possibly some by other users'
                : byOthers > 0
                ? `, ${byOthers === comments ? 'all' : byOthers} by other users`
                : ', all yours';
        const holder =
            n === 1
                ? `"${loss.annotations[0].body?.[0]?.value ||
                      '(unlabeled)'}" has`
                : `${n} of them have`;
        const counted = `${holder} ${comments} comment${
            comments === 1 ? '' : 's'
        }${whose}.`;
        if (this.restoresDeleted) {
            return `${counted} Undo (Ctrl+Z) brings ${
                n === 1 ? 'it' : 'them'
            } back with ${
                n === 1 ? 'its comments' : 'their comments'
            }; otherwise the service removes deleted annotations and their comments for good after ${WSI_DELETED_RETENTION_DAYS} days (its default).`;
        }
        return `${counted} ${verb} deletes ${
            n === 1 ? 'its comment thread' : 'their comment threads'
        }, and Undo cannot bring the comments back.`;
    }

    /** Whether the user may change `comment`: its author (the service checks). */
    canChangeComment(comment: WsiComment): boolean {
        return (
            this.canEdit &&
            (!this.currentUser || comment.author === this.currentUser)
        );
    }

    @action
    private setThread(id: string, patch: Partial<WsiCommentThread>) {
        this.threads.set(id, {
            loading: false,
            busy: false,
            comments: [],
            error: null,
            ...this.threads.get(id),
            ...patch,
        });
    }

    @action
    private setCommentCount(id: string, count: number) {
        this.commentCounts.set(id, Math.max(0, count));
    }

    private toComment(item: any): WsiComment {
        return {
            id: String(item?.id),
            author: String(item?.author || ''),
            body: String(item?.body || ''),
            created: String(item?.created_at || ''),
            updated: String(item?.updated_at || item?.created_at || ''),
        };
    }

    /**
     * Handles a thread request's refusal; returns whether `response` was
     * one. A 404 or 405 from a service without threads turns them off; a
     * missing annotation reloads the slide; the service's own refusals are
     * shown on the thread; the proxy's refuse the study.
     */
    private async refuseThread(
        id: string,
        response: Response
    ): Promise<boolean> {
        if (response.ok) return false;
        const detail = await this.errorDetail(response);
        if (
            response.status === 405 ||
            (response.status === 404 && detail === 'Not Found')
        ) {
            action(() => {
                this.commentRoute = false;
            })();
            return true;
        }
        if (response.status === 404 && detail === 'Annotation not found') {
            this.setThread(id, { loading: false, busy: false });
            await this.reloadCurrentSlide(
                'The annotation was deleted or is no longer shared; reloaded latest data.'
            );
            return true;
        }
        if (
            (response.status === 403 || response.status === 404) &&
            typeof detail === 'string'
        ) {
            // A comment deleted meanwhile: show the thread as it is now.
            if (response.status === 404) await this.loadComments(id);
            this.setThread(id, {
                loading: false,
                busy: false,
                error:
                    response.status === 404
                        ? 'That comment was deleted meanwhile; the thread was reloaded.'
                        : /only the author/i.test(detail)
                        ? 'Only its author can change this comment.'
                        : detail,
            });
            return true;
        }
        if (this.refuseAccess(response)) {
            this.setThread(id, { loading: false, busy: false });
            return true;
        }
        this.setThread(id, {
            loading: false,
            busy: false,
            error:
                response.status === 422
                    ? typeof detail === 'string'
                        ? detail
                        : 'A comment needs 1 to 4,000 characters.'
                    : `The comment thread could not be saved or loaded (${response.status}).`,
        });
        return true;
    }

    /** Loads `id`'s comment thread, oldest first. */
    @action.bound
    async loadComments(id: string): Promise<void> {
        if (!this.commentsAvailable || id.startsWith('client-')) return;
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        this.setThread(id, { loading: true, error: null });
        try {
            const response = await this.request(
                `/annotations/${encodeURIComponent(id)}/comments`,
                {},
                context.signal
            );
            if (!this.isCurrent(context)) return;
            if (await this.refuseThread(id, response)) return;
            const raw = await response.json();
            if (!this.isCurrent(context)) return;
            const page = readPage<any>(raw, 'comments');
            const comments = page.items.map(item => this.toComment(item));
            this.setThread(id, {
                loading: false,
                comments,
                nextOffset: page.nextOffset,
                total: page.total ?? comments.length,
            });
            this.setCommentCount(id, page.total ?? comments.length);
        } catch (_) {
            if (!this.isCurrent(context)) return;
            this.setThread(id, {
                loading: false,
                error: 'The comments could not be loaded.',
            });
        }
    }

    /**
     * Loads the next page of `id`'s thread ("Show more"), after the
     * comments loaded so far; a comment already shown is not repeated.
     */
    @action.bound
    async loadMoreComments(id: string): Promise<void> {
        const thread = this.threads.get(id);
        const offset = thread?.nextOffset;
        if (offset === null || offset === undefined || thread?.loading) return;
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        this.setThread(id, { loading: true, error: null });
        try {
            const response = await this.request(
                `/annotations/${encodeURIComponent(
                    id
                )}/comments?offset=${offset}`,
                {},
                context.signal
            );
            if (!this.isCurrent(context)) return;
            if (await this.refuseThread(id, response)) return;
            const raw = await response.json();
            if (!this.isCurrent(context)) return;
            const page = readPage<any>(raw, 'comments');
            const known = new Set(
                (this.threads.get(id)?.comments || []).map(item => item.id)
            );
            const more = page.items
                .map(item => this.toComment(item))
                .filter(item => !known.has(item.id));
            this.setThread(id, {
                loading: false,
                comments: [...(this.threads.get(id)?.comments || []), ...more],
                nextOffset: page.nextOffset,
                total: page.total ?? this.threads.get(id)?.total,
            });
            if (page.total !== null) this.setCommentCount(id, page.total);
        } catch (_) {
            if (!this.isCurrent(context)) return;
            this.setThread(id, {
                loading: false,
                error: 'More comments could not be loaded.',
            });
        }
    }

    /**
     * Sends a comment request on `id`'s thread; resolves to the answer's
     * JSON (null for none), or undefined when it was refused or failed.
     */
    private async sendComment(
        id: string,
        path: string,
        init: RequestInit
    ): Promise<any | undefined> {
        const context = {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
        this.setThread(id, { busy: true, error: null });
        try {
            const response = await this.request(path, init, context.signal);
            if (!this.isCurrent(context)) return undefined;
            if (await this.refuseThread(id, response)) return undefined;
            const value =
                response.status === 204 ? null : await response.json();
            if (!this.isCurrent(context)) return undefined;
            this.setThread(id, { busy: false });
            return value;
        } catch (_) {
            if (!this.isCurrent(context)) return undefined;
            this.setThread(id, {
                busy: false,
                error: 'The comment could not be saved.',
            });
            return undefined;
        }
    }

    /** Adds a comment to `id`'s thread; resolves to whether it was saved. */
    @action.bound
    async addComment(id: string, text: string): Promise<boolean> {
        const body = text.trim();
        if (!body || body.length > COMMENT_MAX_LENGTH || !this.canEdit) {
            return false;
        }
        const saved = await this.sendComment(
            id,
            `/annotations/${encodeURIComponent(id)}/comments`,
            { method: 'POST', body: JSON.stringify({ body }) }
        );
        if (!saved) return false;
        const thread = this.threads.get(id);
        const comments = [...(thread?.comments || []), this.toComment(saved)];
        this.setThread(id, {
            comments,
            total: thread?.total !== undefined ? thread.total + 1 : undefined,
        });
        const annotation = this.annotations.find(item => item.id === id);
        this.setCommentCount(
            id,
            (annotation ? this.commentCountOf(annotation) : 0) + 1
        );
        return true;
    }

    /** Edits the user's comment `commentId`; resolves to whether it was saved. */
    @action.bound
    async editComment(
        id: string,
        commentId: string,
        text: string
    ): Promise<boolean> {
        const body = text.trim();
        if (!body || body.length > COMMENT_MAX_LENGTH) return false;
        const saved = await this.sendComment(
            id,
            `/annotations/${encodeURIComponent(
                id
            )}/comments/${encodeURIComponent(commentId)}`,
            { method: 'PUT', body: JSON.stringify({ body }) }
        );
        if (!saved) return false;
        const comment = this.toComment(saved);
        this.setThread(id, {
            comments: (this.threads.get(id)?.comments || []).map(item =>
                item.id === commentId ? comment : item
            ),
        });
        return true;
    }

    /** Deletes the user's comment `commentId`; resolves to whether it went. */
    @action.bound
    async deleteComment(id: string, commentId: string): Promise<boolean> {
        const done = await this.sendComment(
            id,
            `/annotations/${encodeURIComponent(
                id
            )}/comments/${encodeURIComponent(commentId)}`,
            { method: 'DELETE' }
        );
        if (done === undefined) return false;
        const thread = this.threads.get(id);
        const comments = (thread?.comments || []).filter(
            item => item.id !== commentId
        );
        // A deleted comment shifts the later pages back by one.
        this.setThread(id, {
            comments,
            total:
                thread?.total !== undefined
                    ? Math.max(0, thread.total - 1)
                    : undefined,
            nextOffset:
                typeof thread?.nextOffset === 'number'
                    ? Math.max(0, thread.nextOffset - 1)
                    : thread?.nextOffset,
        });
        const annotation = this.annotations.find(item => item.id === id);
        this.setCommentCount(
            id,
            (annotation ? this.commentCountOf(annotation) : 1) - 1
        );
        return true;
    }

    @action.bound
    dismissThreadError(id: string) {
        this.setThread(id, { error: null });
    }

    // ---- display ----

    private saveDisplayPrefs() {
        saveDisplayPrefs({
            fillOpacity: this.fillOpacity,
            outlineOnly: this.outlineOnly,
            showLabels: this.showSlideLabels,
        });
    }

    /** Sets the fill opacity of shapes, 0 to 1. */
    @action.bound
    setFillOpacity(opacity: number) {
        if (!(opacity >= 0)) return;
        this.fillOpacity = Math.min(1, Math.round(opacity * 100) / 100);
        this.saveDisplayPrefs();
        this.refreshStyle();
    }

    @action.bound
    setOutlineOnly(outlineOnly: boolean) {
        this.outlineOnly = outlineOnly;
        this.saveDisplayPrefs();
        this.refreshStyle();
    }

    @action.bound
    setShowSlideLabels(show: boolean) {
        this.showSlideLabels = show;
        this.saveDisplayPrefs();
        // Place the labels for the view as it is now.
        this.viewportRevision += 1;
    }

    /** Hides or shows every annotation on the slide (H). */
    @action.bound
    toggleHideAll() {
        this.hideAll = !this.hideAll;
        this.applyVisibility();
        if (this.hideAll) {
            this.annotationTooltip = null;
            this.annotorious?.cancelSelected?.();
        } else {
            this.viewportRevision += 1;
        }
    }

    /** Puts `visible` and `hideAll` on the slide's drawings. */
    private applyVisibility() {
        const shown = this.visible && !this.hideAll;
        this.annotorious?.setVisible?.(shown);
        this.pointLayer?.setVisible(shown);
    }

    /**
     * Shows only `layer`, hiding the others; for the layer shown alone,
     * shows the layers hidden before again.
     */
    @action.bound
    toggleSoloLayer(layer: string) {
        if (this.soloLayer === layer) {
            this.hiddenLayerNames = new Set(this.hiddenBeforeSolo || []);
            this.soloLayer = null;
            this.hiddenBeforeSolo = null;
        } else {
            if (this.soloLayer === null) {
                this.hiddenBeforeSolo = new Set(this.hiddenLayerNames);
            }
            this.soloLayer = layer;
            this.hiddenLayerNames = new Set(
                this.layerNames.filter(name => name !== layer)
            );
            this.annotorious?.cancelSelected?.();
            if (
                this.annotationTooltip?.layerName &&
                this.annotationTooltip.layerName !== layer
            ) {
                this.annotationTooltip = null;
            }
        }
        this.applyLayerFilter();
    }

    // ---- what the slide notes use (WsiSlideNotesHost) ----

    serviceRequest(
        path: string,
        init: RequestInit,
        signal: AbortSignal | undefined
    ): Promise<Response> {
        return this.request(path, init, signal);
    }

    requestContext() {
        return {
            generation: this.generation,
            slideKey: this.slideKey,
            signal: this.abortController?.signal,
        };
    }

    isCurrentContext(context: {
        generation: number;
        slideKey: string | null;
        signal?: AbortSignal;
    }): boolean {
        return this.isCurrent(context);
    }

    refuseServiceAccess(response: Response): boolean {
        return this.refuseAccess(response);
    }

    get serviceStudyId(): string | undefined {
        return this.studyId;
    }

    private request(
        path: string,
        init: RequestInit = {},
        signal: AbortSignal | undefined = this.abortController?.signal
    ) {
        const response = wsiServiceFetch(
            this.apiUrl || '',
            path,
            this.studyId,
            {
                ...init,
                signal,
            }
        );
        if ((init.method || 'GET').toUpperCase() !== 'GET') {
            this.trackWrite(response, init.body);
        }
        return response;
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
                if (
                    this.commentRoute === null &&
                    raw.some(item => item && 'comment_count' in item)
                ) {
                    this.commentRoute = true;
                }
                this.commentCounts.clear();
                this.annotations = annotations;
                this.loading = false;
                this.loadFailed = false;
                this.error = null;
                this.applySelectAction();
                this.applyLayerFilter();
                this.openRequestedAnnotation();
            })();
        } catch (error) {
            if (
                loadGeneration !== this.loadGeneration ||
                (error as Error).name === 'AbortError'
            )
                return;
            action(() => {
                this.loading = false;
                this.loadFailed = true;
                this.error = 'Unable to load annotations.';
                this.cancelDrawing();
                this.annotorious?.setUserSelectAction?.('SELECT');
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
            if (
                response.status === 422 &&
                this.isCurrent(context) &&
                refusesTarget(await this.errorDetail(response))
            ) {
                this.removeAnnotationLocally(annotation.id);
                action(() => {
                    this.error = WSI_SHAPE_REFUSED;
                })();
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

    async createAgentAnnotation(input: {
        label: string;
        layerName: string;
        color: string;
        selector: string;
    }): Promise<boolean> {
        if (!this.slideKey) return false;
        const saved = await this.createAnnotation({
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            type: 'Annotation',
            id: `agent-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2)}`,
            body: [
                {
                    type: 'TextualBody',
                    value: input.label,
                    purpose: 'commenting',
                },
            ],
            target: {
                source: this.slideKey,
                selector: { type: 'SvgSelector', value: input.selector },
            },
            color: input.color,
            colorName: input.layerName,
            layerName: input.layerName,
        });
        return saved !== null;
    }

    @action.bound
    adoptAgentAnnotations(items: Array<Record<string, unknown>>) {
        const slideKey = this.slideKey;
        if (!slideKey) return;
        const saved = items
            .filter(item => {
                const itemSlideKey = item.slide_id;
                const itemStudyId = item.study_id;
                return (
                    itemSlideKey === slideKey &&
                    (typeof itemStudyId !== 'string' ||
                        !this.studyId ||
                        itemStudyId === this.studyId)
                );
            })
            .map(item => this.fromApi(item, slideKey));
        if (!saved.length) return;
        const savedById = new Map(
            saved.map(annotation => [annotation.id, annotation])
        );
        this.annotations = [
            ...this.annotations.filter(
                annotation => !savedById.has(annotation.id)
            ),
            ...saved,
        ];
        this.applyLayerFilter();
        this.refreshStyle();
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
            if (
                (response.status === 404 || response.status === 422) &&
                this.isCurrent(context)
            ) {
                const detail =
                    response.status === 422
                        ? await this.errorDetail(response)
                        : undefined;
                if (response.status === 404 || refusesTarget(detail)) {
                    // Gone meanwhile, or a shape the service refuses: show
                    // the slide as stored.
                    await this.reloadCurrentSlide(
                        response.status === 404
                            ? 'The annotation was deleted elsewhere; reloaded latest data.'
                            : WSI_SHAPE_REFUSED
                    );
                    return null;
                }
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
            this.syncPointQueue();
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
                    } else if (
                        response.status === 422 &&
                        refusesTarget(await this.errorDetail(response))
                    ) {
                        results[index] = { reason: WSI_SHAPE_REFUSED };
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

    @action
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
            updated: item.updated_at,
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
            ...(typeof item.comment_count === 'number'
                ? { commentCount: item.comment_count }
                : {}),
        };
    }

    /**
     * Draws with the pointer. Every pointer position becomes image pixels
     * when it happens, with the viewport of that moment, and the shape being
     * drawn is kept in image pixels; so the wheel or the zoom buttons may
     * pan and zoom the slide mid-gesture, and the outline follows the
     * tissue. Only the pointer that started a press draws; a press the
     * browser takes away (pointercancel, lost capture) drops the drag shape
     * or stroke, and a polygon keeps the vertices placed so far.
     */
    private installCustomDrawingHandlers() {
        const viewer = this.osdViewer;
        const element = viewer?.element as HTMLElement | undefined;
        if (!element) return;
        const local = (event: MouseEvent): WsiXY => {
            const rect = element.getBoundingClientRect();
            return {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
            };
        };
        // Another pointer, such as a second finger, while one is pressed.
        const otherPointer = (event: PointerEvent) =>
            !!this.pointerDown &&
            this.pointerDown.pointerId !== event.pointerId;
        const stop = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
        };
        const down = action((event: PointerEvent) => {
            if (
                event.shiftKey &&
                event.button === 0 &&
                this.canSelectOnSlide &&
                !otherPointer(event) &&
                !this.selectionDrag
            ) {
                const screen = local(event);
                const image = this.imagePoint(screen.x, screen.y);
                if (!image) return;
                this.selectionDrag = {
                    pointerId: event.pointerId,
                    start: image,
                    current: image,
                    client: { x: event.clientX, y: event.clientY },
                };
                try {
                    if (event.pointerId !== undefined) {
                        element.setPointerCapture?.(event.pointerId);
                    }
                } catch (_) {
                    /* the pointer is already gone */
                }
                stop(event);
                return;
            }
            const tool = this.activeTool;
            if (!isPointerAnnotationTool(tool) || event.button !== 0) return;
            if (otherPointer(event)) return;
            const screen = local(event);
            const image = this.imagePoint(screen.x, screen.y);
            if (!image) return;
            this.pointerDown = {
                tool,
                pointerId: event.pointerId,
                image,
                client: { x: event.clientX, y: event.clientY },
            };
            this.annotationTooltip = null;
            // A point or field drops on click; a drag still pans the slide.
            if (tool === 'point' || tool === 'hpf') return;
            if (tool === 'wand') {
                // A click outlines; the press's drag changes the tolerance.
                this.pointerDown = null;
                try {
                    if (event.pointerId !== undefined) {
                        element.setPointerCapture?.(event.pointerId);
                    }
                } catch (_) {
                    /* the pointer is already gone */
                }
                this.wandPress(event, image);
                this.reportCursor(screen, image);
                stop(event);
                return;
            }
            // Keep the press when the pointer leaves the slide.
            if (event.pointerId !== undefined) {
                try {
                    element.setPointerCapture?.(event.pointerId);
                } catch (_) {
                    /* the pointer is already gone */
                }
            }
            if (isStrokeTool(tool)) {
                const imagePerScreen = this.imagePixelsPerScreenPixel();
                this.strokeImagePerScreen = imagePerScreen;
                this.drawGesture = {
                    tool,
                    imagePoints: [image],
                    pointer: screen,
                    // Fixed for the stroke: µm of tissue, or screen pixels
                    // at the zoom it starts without a scale.
                    strokeImageWidth: isBrushTool(tool)
                        ? this.brushImageWidth(imagePerScreen)
                        : undefined,
                };
                if (tool === 'smartBrush') {
                    const stroke = {
                        points: this.drawGesture.imagePoints!,
                        started: false,
                    };
                    this.smartStroke = stroke;
                    this.tissueMessage = null;
                    void this.ensureTissueSession('smartBrush').then(
                        session => {
                            if (
                                session &&
                                this.smartStroke === stroke &&
                                !stroke.started
                            ) {
                                this.startSmartStroke(session, stroke);
                            }
                        }
                    );
                }
            } else if (tool === 'polygon') {
                this.drawGesture = {
                    tool,
                    imagePoints: this.polygonPoints,
                    pointer: screen,
                };
            } else {
                this.drawGesture = { tool, imageStart: image, pointer: screen };
            }
            this.reportCursor(screen, image);
            stop(event);
        });
        const move = action((event: PointerEvent) => {
            const drag = this.selectionDrag;
            if (drag) {
                if (drag.pointerId !== event.pointerId) return;
                const screen = local(event);
                const image = this.imagePoint(screen.x, screen.y);
                if (image) this.selectionDrag = { ...drag, current: image };
                this.reportCursor(screen, image);
                stop(event);
                return;
            }
            const tissueDrag = this.tissueDrag;
            if (tissueDrag && tissueDrag.pointerId === event.pointerId) {
                // Up raises the tolerance, down lowers it.
                const dy = event.clientY - tissueDrag.startY;
                if (tissueDrag.moved || Math.abs(dy) >= CLICK_TOLERANCE) {
                    tissueDrag.moved = true;
                    this.setTissueTolerance(
                        tissueDrag.start - dy * TOLERANCE_PER_DRAG_PX
                    );
                }
                stop(event);
                return;
            }
            if (otherPointer(event)) return;
            const tool = this.activeTool;
            const screen = local(event);
            if (isBrushTool(tool) || tool === 'hpf') this.brushPointer = screen;
            const gesture = this.drawGesture;
            if (!isPointerAnnotationTool(tool) || !gesture) return;
            // A polygon's edge follows the pointer between clicks; other
            // shapes follow only while pressed.
            if (tool !== 'polygon' && !this.pointerDown) return;
            if (isStrokeTool(tool)) {
                const points = gesture.imagePoints || [];
                const last = points[points.length - 1];
                const imagePerScreen = this.imagePixelsPerScreenPixel();
                const image = this.imagePoint(screen.x, screen.y);
                const sampled =
                    !!image &&
                    (!last ||
                        Math.hypot(image.x - last.x, image.y - last.y) >=
                            STROKE_SAMPLE_SPACING * imagePerScreen);
                if (sampled) {
                    this.strokeImagePerScreen = Math.min(
                        this.strokeImagePerScreen,
                        imagePerScreen
                    );
                    // Added in place: no copy of the stroke per move.
                    points.push(image!);
                    if (tool === 'smartBrush' && this.smartStroke?.started) {
                        this.tissueSession?.strokeAdd(
                            image!,
                            this.smartStroke.handle
                        );
                    }
                }
                this.drawGesture = {
                    ...gesture,
                    imagePoints: points,
                    pointer: screen,
                };
            } else {
                this.drawGesture = { ...gesture, pointer: screen };
            }
            // The viewer's own cursor tracking does not see this move.
            this.reportCursor(screen);
            stop(event);
        });
        const up = action((event: PointerEvent) => {
            // Alt as a shape ends cuts it out of the selected regions.
            this.drawAlt = !!event.altKey;
            if (
                this.tissueDrag &&
                this.tissueDrag.pointerId === event.pointerId
            ) {
                this.tissueDrag = null;
                stop(event);
                return;
            }
            const drag = this.selectionDrag;
            if (drag) {
                if (drag.pointerId !== event.pointerId) return;
                const screen = local(event);
                this.finishSelectionDrag(
                    this.imagePoint(screen.x, screen.y) || drag.current,
                    Math.hypot(
                        event.clientX - drag.client.x,
                        event.clientY - drag.client.y
                    )
                );
                stop(event);
                return;
            }
            const start = this.pointerDown;
            if (!start || otherPointer(event)) return;
            this.pointerDown = null;
            if (this.activeTool !== start.tool) return;
            const screen = local(event);
            const endPoint = this.imagePoint(screen.x, screen.y);
            if (!endPoint) {
                this.endPress(start.tool);
                return;
            }

            if (isStrokeTool(start.tool)) {
                const gesture = this.drawGesture;
                const points = [...(gesture?.imagePoints || []), endPoint];
                const imagePerScreen = Math.min(
                    this.strokeImagePerScreen,
                    this.imagePixelsPerScreenPixel()
                );
                this.endPress(start.tool);
                if (start.tool === 'smartBrush') {
                    void this.finishSmartBrush(
                        points,
                        imagePerScreen,
                        this.drawingForShapeEdit
                    );
                } else {
                    void this.createStrokeShape(
                        start.tool,
                        points,
                        imagePerScreen,
                        gesture?.strokeImageWidth
                    );
                }
                stop(event);
                return;
            }

            if (start.tool === 'point' || start.tool === 'hpf') {
                const moved = Math.hypot(
                    event.clientX - start.client.x,
                    event.clientY - start.client.y
                );
                if (moved <= CLICK_TOLERANCE) {
                    if (start.tool === 'point') this.createPoint(endPoint);
                    else void this.createHpf(endPoint);
                }
                return;
            }

            if (start.tool === 'polygon') {
                const moved = Math.hypot(
                    event.clientX - start.client.x,
                    event.clientY - start.client.y
                );
                if (moved > 15) {
                    // A drag is not a vertex; keep showing the polygon so far.
                    this.endPress('polygon');
                    stop(event);
                    return;
                }
                // The vertices where they are on screen now.
                const vertices = this.polygonPoints;
                const first = vertices[0] && this.screenPoint(vertices[0]);
                const last =
                    vertices.length > 0 &&
                    this.screenPoint(vertices[vertices.length - 1]);
                // The clicks of a closing double-click land on the last vertex.
                const repeatsLast =
                    !!last &&
                    Math.hypot(screen.x - last.x, screen.y - last.y) <= 4;
                const closes =
                    vertices.length >= 3 &&
                    !!first &&
                    Math.hypot(screen.x - first.x, screen.y - first.y) <= 20;
                if (closes) {
                    this.polygonPoints = [];
                    this.drawGesture = null;
                    void this.createPolygonShape(vertices);
                } else {
                    if (!repeatsLast) {
                        this.polygonPoints = [...vertices, endPoint];
                    }
                    this.drawGesture = {
                        tool: 'polygon',
                        imagePoints: this.polygonPoints,
                        pointer: screen,
                    };
                }
                stop(event);
                return;
            }

            this.drawGesture = null;
            if (start.tool === 'measure') {
                // A click without a drag keeps the last measurement.
                const moved = Math.hypot(
                    event.clientX - start.client.x,
                    event.clientY - start.client.y
                );
                if (moved > CLICK_TOLERANCE) {
                    this.ruler = { start: start.image, end: endPoint };
                }
                stop(event);
                return;
            }
            void this.createCustomShape(start.image, endPoint, start.tool);
            stop(event);
        });
        // The browser ended the press without a pointerup here.
        const lost = action((event: PointerEvent) => {
            if (this.selectionDrag?.pointerId === event.pointerId) {
                this.selectionDrag = null;
                return;
            }
            if (
                this.tissueDrag &&
                this.tissueDrag.pointerId === event.pointerId
            ) {
                this.tissueDrag = null;
                return;
            }
            const start = this.pointerDown;
            if (!start || otherPointer(event)) return;
            this.pointerDown = null;
            this.endPress(start.tool);
            if (start.tool === 'smartBrush') {
                this.smartStroke = null;
                this.tissueSession?.discard();
            }
        });
        const doubleClick = action((event: MouseEvent) => {
            if (this.activeTool === 'wand' && this.tissueSession?.pending) {
                void this.saveTissueSelection();
                stop(event);
                return;
            }
            if (this.activeTool !== 'polygon' || this.polygonPoints.length < 3)
                return;
            this.drawAlt = !!event.altKey;
            const points = this.polygonPoints;
            this.polygonPoints = [];
            this.drawGesture = null;
            void this.createPolygonShape(points);
            stop(event);
        });
        const leave = action(() => {
            this.brushPointer = null;
        });
        // While a wand outline waits, the wheel changes its tolerance (up
        // raises it) instead of zooming; the zoom buttons still zoom.
        const wheel = action((event: WheelEvent) => {
            if (this.activeTool !== 'wand' || !this.tissueSession?.pending) {
                return;
            }
            stop(event);
            const direction = event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0;
            if (!direction) return;
            const current =
                this.tissueSession.tolerance ?? this.tissueTolerance;
            this.setTissueTolerance(
                current + direction * (event.shiftKey ? 5 : 1)
            );
        });
        // Redraws the shape being drawn and the brush outline as the slide
        // moves under them.
        const viewportChanged = action(() => {
            if (this.drawGesture || this.brushPointer || this.overlayActive) {
                this.viewportRevision += 1;
            }
        });
        const listeners: Array<[string, (event: any) => void]> = [
            ['pointerdown', down],
            ['pointermove', move],
            ['pointerup', up],
            ['pointercancel', lost],
            ['lostpointercapture', lost],
            ['dblclick', doubleClick],
            ['pointerleave', leave],
        ];
        listeners.forEach(([name, listener]) =>
            element.addEventListener(name, listener, true)
        );
        element.addEventListener('wheel', wheel, {
            capture: true,
            passive: false,
        });
        VIEWPORT_EVENTS.forEach(name =>
            viewer.addHandler?.(name, viewportChanged)
        );
        this.pointerCleanup = () => {
            listeners.forEach(([name, listener]) =>
                element.removeEventListener(name, listener, true)
            );
            element.removeEventListener('wheel', wheel, true);
            VIEWPORT_EVENTS.forEach(name =>
                viewer.removeHandler?.(name, viewportChanged)
            );
        };
    }

    /**
     * Ends a press: a drag shape or stroke is dropped (it is saved first,
     * when it ended normally); a polygon keeps the vertices placed so far.
     */
    @action
    private endPress(tool: WsiPointerAnnotationTool) {
        this.strokeImagePerScreen = Infinity;
        this.drawGesture =
            tool === 'polygon' && this.polygonPoints.length && this.drawGesture
                ? { ...this.drawGesture, imagePoints: this.polygonPoints }
                : null;
    }

    /** Drops the shape being drawn and any press in progress. */
    private resetGesture() {
        this.drawGesture = null;
        this.pointerDown = null;
        this.strokeImagePerScreen = Infinity;
        this.polygonPoints = [];
        this.discardTissueSelection();
        this.smartStroke = null;
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
        // A hidden viewer takes no keys, and side by side the other pane's
        // viewer takes them.
        if (!this.paneActive || this.viewerHidden) return;
        const typing = isTypingTarget(event.target);
        if (this.handleReviewKey(event, typing)) return;
        if (!typing && this.tissueSession?.pending) {
            // Enter saves the magic wand's outline; Ctrl+Z takes back its
            // last click (the outline goes with the first).
            if (event.key === 'Enter') {
                event.preventDefault();
                void this.saveTissueSelection();
                return;
            }
            if (
                (event.ctrlKey || event.metaKey) &&
                !event.shiftKey &&
                event.key.toLowerCase() === 'z'
            ) {
                event.preventDefault();
                this.undoTissueStep();
                return;
            }
        }
        // Esc drops the shape being drawn, then the quick ruler, then goes
        // back to Select; with Select it clears the selection (below).
        if (
            event.key === 'Escape' &&
            this.activeTool &&
            this.drawingInProgress
        ) {
            this.cancelShape();
            return;
        }
        if (event.key === 'Escape' && this.ruler && !typing) {
            this.clearRuler();
            return;
        }
        if (event.key === 'Escape' && this.shapeEditMode && !typing) {
            this.stopShapeEdit();
            return;
        }
        if (event.key === 'Escape' && this.activeTool) {
            this.cancelDrawing();
            return;
        }
        if (typing || event.altKey) return;
        const key = event.key.toLowerCase();
        if (event.ctrlKey || event.metaKey) {
            // Ctrl/Cmd+A selects the listed annotations, from the viewer.
            if (
                key === 'a' &&
                !event.shiftKey &&
                this.visible &&
                this.inViewer(event.target)
            ) {
                event.preventDefault();
                this.selectAllListed();
                return;
            }
            // Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl+Y redo.
            const redo =
                (key === 'z' && event.shiftKey) ||
                (key === 'y' && event.ctrlKey && !event.shiftKey);
            if (redo && this.canRedo) {
                event.preventDefault();
                void this.redo();
            } else if (key === 'z' && !event.shiftKey && this.canUndo) {
                event.preventDefault();
                void this.undo();
            }
            return;
        }
        if (
            (event.key === WSI_NEXT_ANNOTATION_KEY ||
                event.key === WSI_PREVIOUS_ANNOTATION_KEY) &&
            this.visible &&
            !this.reviewQueue
        ) {
            event.preventDefault();
            this.stepAnnotation(event.key === WSI_NEXT_ANNOTATION_KEY ? 1 : -1);
            return;
        }
        if (event.key === 'Escape' && this.selectedIds.size) {
            this.clearSelection();
            return;
        }
        if (
            event.key === 'Escape' &&
            this.focusedAnnotationId &&
            !this.reviewQueue
        ) {
            this.clearFocus();
            return;
        }
        if (key === WSI_HIDE_ALL_KEY && !event.shiftKey && this.visible) {
            event.preventDefault();
            this.toggleHideAll();
            return;
        }
        if (this.toolShortcutsActive && key === 'b' && event.shiftKey) {
            event.preventDefault();
            this.setTool('smartBrush');
            return;
        }
        if (this.toolShortcutsActive && key === 'c' && event.shiftKey) {
            event.preventDefault();
            this.setTool('hpf');
            return;
        }
        const shortcut = this.toolShortcutsActive
            ? WSI_TOOL_SHORTCUTS[key]
            : undefined;
        if (!shortcut) return;
        event.preventDefault();
        if (shortcut === 'select') this.cancelDrawing();
        else this.setTool(shortcut);
    };

    /**
     * Whether a key went to the viewer: the focus is in it, or nowhere
     * while Annotate is on (Ctrl/Cmd+A elsewhere selects the page's text).
     */
    private inViewer(target: EventTarget | null): boolean {
        const element = target as HTMLElement | null;
        if (!element || element === document.body) return this.annotating;
        return !!element.closest?.('[data-wsi-viewer-root]');
    }

    /**
     * Keeps OpenSeadragon's own keys from acting on a key that picks a
     * tool while the toolbar's shortcuts apply, and its R (rotate), F
     * (flip) and W (pan up) keys off always: Annotate off they are the
     * tool keys a user expects, and a slide turned by a stray key turns
     * the annotations' frame of reference. The arrow keys still pan.
     */
    private readonly handleCanvasKey = (event: {
        originalEvent: KeyboardEvent;
        preventDefaultAction: boolean;
    }) => {
        const original = event.originalEvent;
        const plain =
            !original.ctrlKey && !original.metaKey && !original.altKey;
        if (OSD_KEYS_OFF.includes(original.key)) {
            event.preventDefaultAction = true;
            return;
        }
        // OpenSeadragon pans with A, S and the arrow keys.
        if (
            this.reviewQueue &&
            plain &&
            WSI_REVIEW_KEYS[original.key.toLowerCase()]
        ) {
            event.preventDefaultAction = true;
            return;
        }
        if (
            this.toolShortcutsActive &&
            !original.ctrlKey &&
            !original.metaKey &&
            !original.altKey &&
            WSI_TOOL_SHORTCUTS[original.key.toLowerCase()]
        ) {
            event.preventDefaultAction = true;
        }
    };

    /**
     * The image point under screen pixel (`x`, `y`) of the slide, as the
     * slide is shown now (mid-animation too, not where a zoom will end).
     */
    private imagePoint(x: number, y: number): WsiXY | null {
        const viewport = this.osdViewer?.viewport;
        if (!viewport || !this.openSeadragon) return null;
        const point = viewport.pointFromPixel(
            new this.openSeadragon.Point(x, y),
            true
        );
        const imagePoint = viewport.viewportToImageCoordinates(point);
        return { x: imagePoint.x, y: imagePoint.y };
    }

    getAgentViewerElementSize(): { width: number; height: number } {
        const element = this.osdViewer?.element as HTMLElement | undefined;
        return {
            width: element?.clientWidth || 0,
            height: element?.clientHeight || 0,
        };
    }

    getAgentViewerElementPoint(imagePoint: {
        x: number;
        y: number;
    }): { x: number; y: number } | null {
        return this.screenPoint(imagePoint);
    }

    /** Where image point `point` is shown now, in screen pixels. */
    private screenPoint(point: WsiXY): WsiXY | null {
        const viewport = this.osdViewer?.viewport;
        if (!viewport || !this.openSeadragon) return null;
        const pixel = viewport.pixelFromPoint(
            viewport.imageToViewportCoordinates(
                new this.openSeadragon.Point(point.x, point.y)
            ),
            true
        );
        return { x: pixel.x, y: pixel.y };
    }

    subscribeAgentViewerChanges(callback: () => void): () => void {
        const viewer = this.osdViewer;
        if (!viewer?.addHandler) return () => {};
        const events = ['viewport-change', 'animation-finish', 'resize'];
        events.forEach(event => viewer.addHandler(event, callback));
        return () =>
            events.forEach(event => viewer.removeHandler?.(event, callback));
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
        const selector: string =
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
        if (this.drawingForShapeEdit) {
            this.resetGesture();
            const shape = parseAnnotationShape({
                type: 'SvgSelector',
                value: selector,
            });
            await this.applyDrawnEdit(
                shape?.kind === 'line'
                    ? { path: shape.points }
                    : { region: shape && shapeRegion(shape) }
            );
            return;
        }
        const annotation = this.draftAnnotation(selector, this.newShapeLabel());
        // The tool stays on; the next shape may start before this one is saved.
        this.resetGesture();
        await this.createAnnotation(annotation);
    }

    /** Image pixels per screen pixel as the slide is shown now. */
    private imagePixelsPerScreenPixel(): number {
        const a = this.imagePoint(0, 0);
        const b = this.imagePoint(100, 0);
        return a && b ? Math.hypot(b.x - a.x, b.y - a.y) / 100 || 1 : 1;
    }

    /**
     * Saves a freehand stroke as the polygon it encloses, or a brush stroke
     * as the outline of a band `strokeImageWidth` image pixels wide along it.
     * Either is simplified with Douglas–Peucker first, to a tolerance in
     * image pixels from `imagePerScreen`, the finest zoom the stroke was
     * drawn at: zooming out mid-stroke does not erase detail drawn closer.
     */
    private async createStrokeShape(
        tool: 'freehand' | 'brush',
        points: Array<{ x: number; y: number }>,
        imagePerScreen: number,
        strokeImageWidth = this.brushImageWidth(imagePerScreen)
    ) {
        const path = simplifyPath(
            points,
            STROKE_SIMPLIFY_TOLERANCE * imagePerScreen
        );
        this.resetGesture();
        if (this.shapeEditMode === 'split') {
            // The stroke is the line to split along.
            await this.applyDrawnEdit({ path });
            return;
        }
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
            strokeOutline(path, strokeImageWidth / 2),
            (STROKE_SIMPLIFY_TOLERANCE / 3) * imagePerScreen
        );
        await this.createPolygonShape(outline);
    }

    private async createPolygonShape(points: Array<{ x: number; y: number }>) {
        if (this.shapeEditMode === 'split' && points.length >= 2) {
            // The vertices are the path to split along.
            this.resetGesture();
            await this.applyDrawnEdit({ path: points });
            return;
        }
        if (points.length < 3) return;
        if (this.drawingForShapeEdit) {
            this.resetGesture();
            await this.applyDrawnEdit({ region: [[points]] });
            return;
        }
        const round = (value: number) => Math.round(value * 100) / 100;
        const selector = `<svg><polygon points="${points
            .map(point => `${round(point.x)},${round(point.y)}`)
            .join(' ')}" /></svg>`;
        const annotation = this.draftAnnotation(selector, this.newShapeLabel());
        this.resetGesture();
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
        const now = Date.now();
        if (
            !this.pointRun ||
            now - this.pointRun.lastAt > POINT_UNDO_GROUP_MS
        ) {
            this.pointRun = { id: this.nextPointRun++, lastAt: now };
        } else {
            this.pointRun.lastAt = now;
        }
        this.pointRunOf.set(annotation.id, this.pointRun.id);
        this.annotations = [...this.annotations, annotation];
        this.applyLayerFilter(false);
        this.pointQueue.push(annotation);
        this.syncPointQueue();
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
        this.syncPointQueue();
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
                // Each run of drops undoes as one step.
                const runs = new Map<number, string[]>();
                drafts.forEach((draft, index) => {
                    const savedPoint = results[index]?.annotation;
                    if (!savedPoint) return;
                    const run = this.pointRunOf.get(draft.id) || 0;
                    runs.set(run, [...(runs.get(run) || []), savedPoint.id]);
                });
                runs.forEach((ids, run) =>
                    run
                        ? this.recordPointRun(run, ids)
                        : ids.forEach(id =>
                              this.pushUndo({ kind: 'create', ids: [id] })
                          )
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
                drafts.forEach(draft => this.pointRunOf.delete(draft.id));
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
        this.syncPointQueue();
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

    /** "By alice · version 3", for the tooltip; undefined for a draft. */
    private historySummary(annotation: WsiAnnotation): string | undefined {
        if (!annotation.creator) return undefined;
        const version = annotation.version || 1;
        return `By ${annotation.creator}${
            version > 1 ? ` · version ${version}` : ''
        }`;
    }

    @action
    private showAnnotationTooltip(
        annotation: WsiAnnotation,
        event: MouseEvent
    ) {
        const text = annotation.body?.[0]?.value || '';
        const stored = this.annotations.find(item => item.id === annotation.id);
        const measurement = this.measurementOf(stored || annotation);
        const inside = this.shownPointsInside(stored || annotation);
        const note = (stored || annotation).note || '';
        if (!text && !measurement && !note) return;
        this.annotationTooltip = {
            id: annotation.id,
            x: event.clientX,
            y: event.clientY,
            text,
            layerName: annotation.layerName || DEFAULT_LAYER,
            ai: isAiProvenance(annotation.provenance)
                ? isUnreviewedAi(annotation.provenance)
                    ? 'unreviewed'
                    : 'accepted'
                : undefined,
            aiEdited: isEditedAi(annotation.provenance) || undefined,
            aiOrigin: aiOriginDescription(annotation.provenance) || undefined,
            measurement: measurement
                ? formatMeasurement(measurement)
                : undefined,
            pointsInside: inside
                ? `Points inside: ${formatRegionCount(inside)}`
                : undefined,
            history: this.historySummary(stored || annotation),
            comments: (() => {
                const count = this.commentsAvailable
                    ? this.commentCountOf(stored || annotation)
                    : 0;
                return count
                    ? `${count} comment${count === 1 ? '' : 's'}`
                    : undefined;
            })(),
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
        this.brushPointer = null;
        this.resetGesture();
        this.disposeTissue();
        try {
            this.annotorious?.destroy?.();
        } catch (_) {
            /* best effort */
        }
        this.annotorious = null;
        this.osdViewer = null;
        this.openSeadragon = null;
        this.activeTool = null;
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
        if (
            this.activeTool ||
            this.pointerSuspended ||
            !event?.quick ||
            !event.position
        ) {
            return;
        }
        const marker = this.pointLayer?.hitTest(event.position);
        const annotation =
            marker && this.annotations.find(item => item.id === marker.id);
        if (annotation && event.originalEvent) {
            this.showAnnotationTooltip(annotation, event.originalEvent);
        }
    };

    private refreshStyle() {
        if (!this.annotorious) return;
        const fillOpacity = this.outlineOnly ? 0 : this.fillOpacity;
        const selected = this.selectedIds;
        this.annotorious.setStyle?.((annotation: WsiAnnotation) => {
            const color = annotation.color || this.activeColor;
            return {
                stroke: color,
                fill: color,
                fillOpacity,
                strokeWidth: selected.has(annotation.id) ? 4 : 2,
            };
        });
    }
}
