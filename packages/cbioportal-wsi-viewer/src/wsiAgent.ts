import { TileMetadata } from './wsiViewerTypes';

export type WsiAgentActionStatus =
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'completed'
    | 'failed'
    | 'expired';

export interface WsiAgentViewport {
    image_data_url?: string;
    image_width?: number;
    image_height?: number;
    image_transform?: [number, number, number, number, number, number];
    slide_width: number;
    slide_height: number;
    center_x?: number;
    center_y?: number;
    zoom?: number;
    source_fingerprint: string;
    capture_id: string;
    viewer_generation: number;
}

export interface WsiAgentContext {
    study_id: string;
    patient_id: string;
    sample_id?: string;
    /** The opaque slide key, in the service's slide_id field; never an image ID. */
    slide_id: string;
    stain_name?: string;
    match_level?: string;
    filters: Record<string, unknown>;
    slide_metadata: Record<string, unknown>;
    patient_context: Record<string, unknown>;
    existing_annotations: Array<Record<string, unknown>>;
    viewport: WsiAgentViewport;
    embedding_context?: WsiAgentEmbeddingContext;
}

export interface WsiAgentEmbeddingContext {
    provider: 'quiltnet';
    scope: 'study';
    /** Opaque slide keys, in the service's slide_ids field. */
    slide_ids: string[];
}

export function buildWsiAgentEmbeddingContext(
    studyId: string,
    slideKeys: string[]
): WsiAgentEmbeddingContext | undefined {
    if (studyId !== 'coad_msk_2025') return undefined;
    const uniqueSlideKeys = Array.from(
        new Set(slideKeys.filter(slideKey => slideKey.length > 0))
    );
    return {
        provider: 'quiltnet',
        scope: 'study',
        slide_ids: uniqueSlideKeys,
    };
}

/**
 * The slide metadata the assistant may see: the pixel pyramid's shape and
 * scan properties, picked field by field so that nothing else the tile
 * metadata may carry (a file name, an image ID, an accession) is sent.
 */
export function buildWsiAgentSlideMetadata(
    meta: TileMetadata
): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
        dimensions: {
            width: meta.dimensions.width,
            height: meta.dimensions.height,
        },
        levels: meta.levels,
        level_dimensions: (meta.level_dimensions || []).map(level => ({
            width: level.width,
            height: level.height,
        })),
        max_zoom: meta.max_zoom,
        tile_size: meta.tile_size,
    };
    if (meta.level_downsamples) {
        metadata.level_downsamples = [...meta.level_downsamples];
    }
    if (meta.mpp) metadata.mpp = { x: meta.mpp.x, y: meta.mpp.y };
    if (meta.objective_power != null) {
        metadata.objective_power = meta.objective_power;
    }
    if (meta.vendor) metadata.vendor = meta.vendor;
    return metadata;
}

export interface WsiAgentCoordinateRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WsiAgentAnnotationProvenance {
    source: 'agent';
    agent_run_id?: string;
    proposal_id?: string;
    provider?: string;
    model?: string;
    retrieval_mode?: 'text' | 'visual' | 'representative';
    query_hash?: string;
    candidate_id?: string;
    retrieval_run_id?: string;
    rank?: number;
    score?: number;
    confidence?: number;
    rationale?: string;
}

export interface WsiAgentProposal {
    id: string;
    session_id: string;
    action_type:
        | 'create_annotation'
        | 'annotation_batch'
        | 'update_annotation'
        | 'delete_annotation'
        | 'viewer_action';
    study_id: string;
    /** The opaque slide key the proposal was made on. */
    slide_id: string;
    payload: Record<string, any>;
    status: WsiAgentActionStatus;
    created_at: string;
    decided_at?: string;
    outcome?: { success: boolean; detail?: string };
}

export interface WsiAgentSlidePoint {
    x: number;
    y: number;
}

export interface WsiAgentSseEvent {
    event: string;
    data: any;
}

export function parseWsiAgentSseBlock(block: string): WsiAgentSseEvent | null {
    let event = 'message';
    const dataLines: string[] = [];
    block.split(/\r?\n/).forEach(line => {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    });
    if (!dataLines.length) return null;
    try {
        return { event, data: JSON.parse(dataLines.join('\n')) };
    } catch (_) {
        return null;
    }
}

export function applyWsiAgentTransform(
    normalized: { x: number; y: number },
    viewport: WsiAgentViewport
): { x: number; y: number } {
    const imageWidth = viewport.image_width || viewport.slide_width;
    const imageHeight = viewport.image_height || viewport.slide_height;
    const u = (normalized.x / 1000) * imageWidth;
    const v = (normalized.y / 1000) * imageHeight;
    const transform = viewport.image_transform;
    if (!transform) {
        return {
            x: (normalized.x / 1000) * viewport.slide_width,
            y: (normalized.y / 1000) * viewport.slide_height,
        };
    }
    return {
        x: transform[0] * u + transform[1] * v + transform[2],
        y: transform[3] * u + transform[4] * v + transform[5],
    };
}

export function applyWsiAgentRegionTransform(
    normalized: { x: number; y: number },
    region: WsiAgentCoordinateRegion
): { x: number; y: number } {
    return {
        x: region.x + (normalized.x / 1000) * region.width,
        y: region.y + (normalized.y / 1000) * region.height,
    };
}

export function wsiAgentRectangleBounds(
    points: Array<{ x: number; y: number }>
): { x: number; y: number; width: number; height: number } | null {
    if (!points.length) return null;
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
        x,
        y,
        width: Math.max(...xs) - x,
        height: Math.max(...ys) - y,
    };
}

export function buildWsiAgentSvgSelector(
    geometryType: 'rectangle' | 'polygon',
    normalizedPoints: Array<{ x: number; y: number }>,
    viewport: WsiAgentViewport,
    coordinateRegion?: WsiAgentCoordinateRegion
): string {
    const points = normalizedPoints.map(point =>
        coordinateRegion
            ? applyWsiAgentRegionTransform(point, coordinateRegion)
            : applyWsiAgentTransform(point, viewport)
    );
    if (geometryType === 'rectangle') {
        const bounds = wsiAgentRectangleBounds(points);
        if (!bounds) return '<svg />';
        return `<svg><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" /></svg>`;
    }
    return `<svg><polygon points="${points
        .map(point => `${point.x},${point.y}`)
        .join(' ')}" /></svg>`;
}

export function buildWsiAgentSvgSelectorFromSlidePoints(
    geometryType: 'rectangle' | 'polygon',
    points: WsiAgentSlidePoint[]
): string {
    if (geometryType === 'rectangle') {
        const bounds = wsiAgentRectangleBounds(points);
        if (!bounds) return '<svg />';
        return (
            '<svg><rect x="' +
            bounds.x +
            '" y="' +
            bounds.y +
            '" width="' +
            bounds.width +
            '" height="' +
            bounds.height +
            '" /></svg>'
        );
    }
    return (
        '<svg><polygon points="' +
        points.map(point => point.x + ',' + point.y).join(' ') +
        '" /></svg>'
    );
}

export function agentEndpoint(apiUrl: string, path: string): string {
    return `${apiUrl.replace(/\/$/, '')}${path}`;
}
