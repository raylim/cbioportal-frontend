/**
 * The annotation service's `body` (its `AnnotationBody`): `label`, `comment`,
 * `type`, `layer_name`, `color` and `provenance`. The service fills a missing
 * `layer_name` with "Default" and a missing `color` with its own default.
 */
export interface WsiAnnotationApiBody {
    label?: string;
    comment?: string;
    type?: string;
    layer_name?: string;
    color?: string;
    provenance?: Record<string, unknown> | null;
}

/** The layer the service stores when a body names none. */
export const SERVICE_DEFAULT_LAYER = 'Default';
/** The color the service stores when a body names none. */
export const SERVICE_DEFAULT_COLOR = '#2f80ed';

const MAX_LEGACY_LAYER_LENGTH = 100;

/**
 * Whether `body` is a row written before the viewer stored layers in
 * `layer_name`. Those rows kept the layer name in `comment` and sent no
 * `layer_name`, `color` or `provenance`, so the service stored its defaults.
 * A row is read as legacy when all of these hold:
 *
 * - `provenance` is missing or null: other writers (the research assistant,
 *   loaders) set it, and their one-line comment is a note;
 * - `layer_name` is missing or "Default";
 * - `color` is missing or exactly the service default `#2f80ed`;
 * - `comment` is one line of at most 100 characters.
 *
 * The viewer always writes `color`, and writes the service default in upper
 * case (`#2F80ED`, the same color), so a row it writes is never read as legacy
 * and a one-line note on a Default-layer annotation stays a note.
 */
export function isLegacyLayerComment(
    body: WsiAnnotationApiBody | null | undefined
): boolean {
    if (!body) return false;
    const layer = body.layer_name;
    const color = body.color;
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    return (
        (body.provenance === undefined || body.provenance === null) &&
        (layer === undefined ||
            layer === null ||
            layer === SERVICE_DEFAULT_LAYER) &&
        (color === undefined ||
            color === null ||
            color === SERVICE_DEFAULT_COLOR) &&
        comment.length > 0 &&
        comment.length <= MAX_LEGACY_LAYER_LENGTH &&
        !/[\r\n]/.test(comment)
    );
}

/**
 * The layer and the user's note of a stored body. A comment that only
 * repeats `layer_name` is not a note. For a legacy row (see
 * `isLegacyLayerComment`), `legacyComment` is the stored comment read as the
 * layer; the viewer sends it back unchanged until the user edits the note,
 * so a misread note is never lost.
 */
export function readLayerAndNote(
    body: WsiAnnotationApiBody | null | undefined
): { layerName: string; note: string; legacyComment?: string } {
    if (isLegacyLayerComment(body)) {
        return {
            layerName: body!.comment!.trim(),
            note: '',
            legacyComment: body!.comment!,
        };
    }
    const layer =
        typeof body?.layer_name === 'string' ? body.layer_name.trim() : '';
    const comment = typeof body?.comment === 'string' ? body.comment : '';
    return {
        layerName: layer || SERVICE_DEFAULT_LAYER,
        // The service's assistant also copies the layer name into comment;
        // that copy is not a note.
        note: layer && comment.trim() === layer ? '' : comment,
    };
}

/**
 * The `color` to send for `hex`. The service default is sent in upper case so
 * the row cannot be mistaken for a legacy one (see `isLegacyLayerComment`).
 */
export function serviceColor(hex: string): string {
    return hex.toLowerCase() === SERVICE_DEFAULT_COLOR
        ? SERVICE_DEFAULT_COLOR.toUpperCase()
        : hex;
}

/** `provenance.source` values of the research assistant's annotations. */
const ASSISTANT_SOURCES = ['agent', 'assistant'];
/**
 * `provenance.source` values of a model's annotations; "precomputed" marks
 * model output loaded in bulk.
 */
const MODEL_SOURCES = ['ai', 'model', 'precomputed'];
/** `provenance.review_status` once a user has accepted an AI annotation. */
export const AI_REVIEW_ACCEPTED = 'accepted';
/** `provenance.review_status` once a user has rejected an AI annotation. */
export const AI_REVIEW_REJECTED = 'rejected';

/** What made an AI annotation: the research assistant or a model. */
export type WsiAiOrigin = 'assistant' | 'model';

/**
 * Whether a machine made the annotation, and which kind: the research
 * assistant (`provenance.source` "agent" or "assistant") or a model ("ai",
 * "model" or "precomputed"). Null for a person's annotation. The annotation
 * service treats the same sources as machine-made.
 */
export function aiOrigin(
    provenance: Record<string, unknown> | null | undefined
): WsiAiOrigin | null {
    const source = provenance?.source;
    if (typeof source !== 'string') return null;
    const normalized = source.trim().toLowerCase();
    if (ASSISTANT_SOURCES.includes(normalized)) return 'assistant';
    if (MODEL_SOURCES.includes(normalized)) return 'model';
    return null;
}

/** Whether a machine (the assistant or a model) made the annotation. */
export function isAiProvenance(
    provenance: Record<string, unknown> | null | undefined
): boolean {
    return aiOrigin(provenance) !== null;
}

/** An AI annotation that no user has accepted or rejected yet. */
export function isUnreviewedAi(
    provenance: Record<string, unknown> | null | undefined
): boolean {
    return (
        isAiProvenance(provenance) &&
        provenance!.review_status !== AI_REVIEW_ACCEPTED &&
        provenance!.review_status !== AI_REVIEW_REJECTED
    );
}

/** An AI annotation a user rejected; the viewer does not show these. */
export function isRejectedAi(
    provenance: Record<string, unknown> | null | undefined
): boolean {
    return (
        isAiProvenance(provenance) &&
        provenance!.review_status === AI_REVIEW_REJECTED
    );
}

/**
 * Who made an AI annotation, for its badge's tooltip, e.g. "Made by a model
 * (luad-patterns)" or "Made by the research assistant". Null otherwise.
 */
export function aiOriginDescription(
    provenance: Record<string, unknown> | null | undefined
): string | null {
    const origin = aiOrigin(provenance);
    if (!origin) return null;
    if (origin === 'assistant') return 'Made by the research assistant';
    const model = provenance!.model;
    return typeof model === 'string' && model.trim()
        ? `Made by a model (${model.trim()})`
        : 'Made by a model';
}

/**
 * The provenance of an accepted AI annotation: the stored one, marked
 * `review_status: "accepted"` with the time of review.
 */
export function acceptedProvenance(
    provenance: Record<string, unknown> | null | undefined,
    now: Date = new Date()
): Record<string, unknown> {
    return {
        ...(provenance || {}),
        review_status: AI_REVIEW_ACCEPTED,
        reviewed_at: now.toISOString(),
    };
}

/** One line of an annotation's history: what happened, who, and when. */
export interface WsiHistoryEntry {
    what: string;
    who?: string;
    when?: string;
}

/** A review and a save this close together are the same change. */
const REVIEW_SAVE_GAP_MS = 5000;

/**
 * An annotation's history from the fields the service stores: who created
 * it and when, its version and its last change, its AI origin and its
 * review. The service keeps no change log, so the last change is credited
 * to the reviewer when it is the review (saved within a few seconds of
 * `reviewed_at`), else to the creator, the only user who may edit it.
 */
export function annotationHistory(annotation: {
    creator?: string;
    created?: string;
    updated?: string;
    version?: number;
    provenance?: Record<string, unknown> | null;
}): WsiHistoryEntry[] {
    const entries: WsiHistoryEntry[] = [];
    const provenance = annotation.provenance || null;
    const origin = aiOriginDescription(provenance);
    entries.push({
        what: origin
            ? `Created (${origin.replace(/^Made by /, 'by ')})`
            : 'Created',
        who: annotation.creator,
        when: annotation.created,
    });
    const version = annotation.version || 1;
    const reviewedAt =
        typeof provenance?.reviewed_at === 'string'
            ? provenance.reviewed_at
            : undefined;
    const reviewedBy =
        typeof provenance?.reviewed_by === 'string'
            ? provenance.reviewed_by
            : undefined;
    const status =
        typeof provenance?.review_status === 'string'
            ? provenance.review_status
            : undefined;
    if (status && (reviewedAt || reviewedBy)) {
        entries.push({
            what:
                status === AI_REVIEW_ACCEPTED
                    ? 'Accepted'
                    : status === AI_REVIEW_REJECTED
                    ? 'Rejected'
                    : `Review: ${status}`,
            who: reviewedBy,
            when: reviewedAt,
        });
    }
    if (version > 1) {
        const time = (value: string | undefined) => {
            const parsed = value ? Date.parse(value) : NaN;
            return Number.isFinite(parsed) ? parsed : null;
        };
        const updated = time(annotation.updated);
        const reviewed = time(reviewedAt);
        const byReview =
            updated !== null &&
            reviewed !== null &&
            Math.abs(updated - reviewed) <= REVIEW_SAVE_GAP_MS;
        entries.push({
            what: `Last changed (version ${version})`,
            who: byReview ? reviewedBy : annotation.creator,
            when: annotation.updated,
        });
    }
    return entries;
}
