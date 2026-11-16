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
 * `layer_name` or `color`, so the service stored its defaults for both. A row
 * is read as legacy when all of these hold:
 *
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
 * repeats `layer_name` is not a note.
 */
export function readLayerAndNote(
    body: WsiAnnotationApiBody | null | undefined
): { layerName: string; note: string } {
    if (isLegacyLayerComment(body)) {
        return { layerName: body!.comment!.trim(), note: '' };
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
