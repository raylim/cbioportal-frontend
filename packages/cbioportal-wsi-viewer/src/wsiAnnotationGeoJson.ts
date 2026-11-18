import {
    regionSelectorSvg,
    WsiAnnotationShape,
    WsiMeasurement,
    WsiMpp,
    WsiPoint,
    WsiRegion,
} from './wsiAnnotationGeometryUtils';

/**
 * GeoJSON export and import of annotations, in the form QuPath reads and
 * writes: one Feature per annotation, coordinates in level-0 image pixels
 * (x right, y down), and `properties.classification` naming the class and
 * its color. Exports name the slide by its opaque slide key only.
 */

type Position = [number, number];

export type WsiGeoJsonGeometry =
    | { type: 'Point'; coordinates: Position }
    | { type: 'LineString'; coordinates: Position[] }
    | { type: 'Polygon'; coordinates: Position[][] }
    | { type: 'MultiPolygon'; coordinates: Position[][][] };

export interface WsiGeoJsonFeature {
    type: 'Feature';
    id: string;
    geometry: WsiGeoJsonGeometry;
    properties: Record<string, unknown>;
}

export interface WsiGeoJsonFeatureCollection {
    type: 'FeatureCollection';
    /** Where the features belong; ignored by GeoJSON readers such as QuPath. */
    wsi: {
        slide_key: string;
        coordinates: 'level-0 image pixels';
        mpp?: WsiMpp;
    };
    features: WsiGeoJsonFeature[];
}

/** What an exported feature describes. */
export interface WsiExportItem {
    id: string;
    shape: WsiAnnotationShape;
    label: string;
    /** The class name: the label without a trailing number. */
    classification: string;
    color: string;
    layer: string;
    note?: string;
    measurement?: WsiMeasurement | null;
    /** The points inside a region, by label term, and per mm². */
    pointCount?: {
        total: number;
        byLabel: Array<{ label: string; count: number }>;
        densityPerMm2?: number;
    };
    aiReviewStatus?: 'unreviewed' | 'accepted';
    /** An AI annotation a person changed ("AI, edited"). */
    aiEdited?: boolean;
}

/** Vertices of an exported ellipse; GeoJSON has no ellipse. */
const ELLIPSE_VERTICES = 72;

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function position(point: WsiPoint): Position {
    return [round(point.x), round(point.y)];
}

function closedRing(points: WsiPoint[]): Position[] {
    const ring = points.map(position);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    return ring;
}

export function shapeToGeometry(shape: WsiAnnotationShape): WsiGeoJsonGeometry {
    switch (shape.kind) {
        case 'point':
            return { type: 'Point', coordinates: position(shape) };
        case 'line':
        case 'polyline':
            return {
                type: 'LineString',
                coordinates: shape.points.map(position),
            };
        case 'rectangle': {
            const { x, y, width, height } = shape;
            return {
                type: 'Polygon',
                coordinates: [
                    closedRing([
                        { x, y },
                        { x: x + width, y },
                        { x: x + width, y: y + height },
                        { x, y: y + height },
                    ]),
                ],
            };
        }
        case 'ellipse': {
            const points: WsiPoint[] = [];
            for (let i = 0; i < ELLIPSE_VERTICES; i++) {
                const angle = (2 * Math.PI * i) / ELLIPSE_VERTICES;
                points.push({
                    x: shape.cx + shape.rx * Math.cos(angle),
                    y: shape.cy + shape.ry * Math.sin(angle),
                });
            }
            return { type: 'Polygon', coordinates: [closedRing(points)] };
        }
        case 'multipolygon': {
            // A part's outer ring first, then its holes.
            const polygons = shape.polygons.map(rings => rings.map(closedRing));
            return polygons.length === 1
                ? { type: 'Polygon', coordinates: polygons[0] }
                : { type: 'MultiPolygon', coordinates: polygons };
        }
        default:
            return { type: 'Polygon', coordinates: [closedRing(shape.points)] };
    }
}

export function hexToRgb(hex: string): [number, number, number] {
    let value = hex.replace('#', '');
    if (value.length === 3 || value.length === 4) {
        value = value
            .slice(0, 3)
            .split('')
            .map(c => c + c)
            .join('');
    }
    const n = parseInt(value.slice(0, 6), 16);
    return isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: number[]): string {
    return `#${rgb
        .slice(0, 3)
        .map(c =>
            Math.max(0, Math.min(255, Math.round(c)))
                .toString(16)
                .padStart(2, '0')
        )
        .join('')}`;
}

/** QuPath-style measurement names and values. */
function measurementProperties(
    measurement: WsiMeasurement
): Record<string, number> {
    const unit = measurement.unit === 'um' ? 'µm' : 'px';
    const values: Record<string, number> = {};
    if (measurement.length !== undefined) {
        values[`Length ${unit}`] = round(measurement.length);
    }
    if (measurement.area !== undefined) {
        values[`Area ${unit}^2`] = round(measurement.area);
    }
    if (measurement.perimeter !== undefined) {
        values[`Perimeter ${unit}`] = round(measurement.perimeter);
    }
    return values;
}

/**
 * The points inside a region as measurements: "Num points", one "Num
 * points: <label>" per label term, and "Points per mm^2" with a scale.
 */
function pointCountProperties(
    count: NonNullable<WsiExportItem['pointCount']>
): Record<string, number> {
    const values: Record<string, number> = { 'Num points': count.total };
    count.byLabel.forEach(item => {
        values[`Num points: ${item.label}`] = item.count;
    });
    if (count.densityPerMm2 !== undefined) {
        values['Points per mm^2'] = round(count.densityPerMm2);
    }
    return values;
}

export function toGeoJsonFeatureCollection(
    items: WsiExportItem[],
    slideKey: string,
    mpp?: WsiMpp
): WsiGeoJsonFeatureCollection {
    return {
        type: 'FeatureCollection',
        wsi: {
            slide_key: slideKey,
            coordinates: 'level-0 image pixels',
            ...(mpp ? { mpp } : {}),
        },
        features: items.map(item => {
            const properties: Record<string, unknown> = {
                objectType: 'annotation',
                name: item.label,
                classification: {
                    name: item.classification,
                    color: hexToRgb(item.color),
                },
                isLocked: false,
                layer: item.layer,
            };
            if (item.note) properties.note = item.note;
            const measurements: Record<string, number> = {
                ...(item.measurement
                    ? measurementProperties(item.measurement)
                    : {}),
                ...(item.pointCount
                    ? pointCountProperties(item.pointCount)
                    : {}),
            };
            if (Object.keys(measurements).length) {
                properties.measurements = measurements;
            }
            if (item.aiReviewStatus) {
                properties.ai_generated = true;
                properties.ai_review_status = item.aiReviewStatus;
            }
            if (item.aiEdited) properties.ai_edited = true;
            return {
                type: 'Feature',
                id: item.id,
                geometry: shapeToGeometry(item.shape),
                properties,
            };
        }),
    };
}

/** An annotation to create from an imported feature. */
export interface WsiImportDraft {
    /** The SVG selector value, in level-0 image pixels. */
    svg: string;
    kind: 'point' | 'line' | 'polygon';
    /** The position of the feature it came from (several for a multi-part one). */
    featureIndex: number;
    label?: string;
    className?: string;
    color?: string;
    layer?: string;
    note?: string;
}

export interface WsiImportResult {
    drafts: WsiImportDraft[];
    /** Why features were left out, by feature position. */
    skipped: Array<{ index: number; reason: string }>;
}

export const MAX_IMPORT_FEATURES = 2000;
/** The largest file an import reads. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_VERTICES = 5000;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function isPosition(value: unknown): value is Position {
    return (
        Array.isArray(value) &&
        value.length >= 2 &&
        Number.isFinite(value[0]) &&
        Number.isFinite(value[1])
    );
}

function svgPoints(positions: Position[]): string {
    return positions.map(([x, y]) => `${round(x)},${round(y)}`).join(' ');
}

function text(value: unknown, max: number): string | undefined {
    return typeof value === 'string' && value.trim()
        ? value.trim().slice(0, max)
        : undefined;
}

/**
 * Validates GeoJSON (a FeatureCollection, a Feature or an array of
 * Features) and turns its features into annotation drafts. Points, lines
 * and polygons are kept: a polygon with its holes, and a MultiPolygon as one
 * annotation of all its parts and their holes; MultiPoint and
 * MultiLineString split into one annotation per part. A feature is skipped
 * when its coordinates are not finite, a ring has fewer than 3 vertices,
 * they fall outside `size` (the slide in level-0 pixels) when given, or it
 * has more than `MAX_IMPORT_VERTICES` vertices (all rings and parts
 * together); the reason names the part of a MultiPolygon.
 * Throws when the input is not GeoJSON features or holds more than
 * `MAX_IMPORT_FEATURES` annotations.
 */
export function parseGeoJsonImport(
    input: unknown,
    size?: { width: number; height: number } | null
): WsiImportResult {
    const features: unknown[] = Array.isArray(input)
        ? input
        : (input as any)?.type === 'FeatureCollection' &&
          Array.isArray((input as any).features)
        ? (input as any).features
        : (input as any)?.type === 'Feature'
        ? [input]
        : (() => {
              throw new Error('Not a GeoJSON FeatureCollection or Feature.');
          })();
    const drafts: WsiImportDraft[] = [];
    const skipped: WsiImportResult['skipped'] = [];
    const inside = (positions: Position[]) =>
        !size ||
        positions.every(
            ([x, y]) => x >= 0 && y >= 0 && x <= size.width && y <= size.height
        );

    features.forEach((feature: any, index) => {
        const skip = (reason: string) => skipped.push({ index, reason });
        if (feature?.type !== 'Feature' || !feature.geometry) {
            skip('not a Feature with a geometry');
            return;
        }
        const properties = feature.properties || {};
        const classification = properties.classification || {};
        const className = text(classification.name, 200);
        const rgb = Array.isArray(classification.color)
            ? classification.color
            : null;
        const color =
            rgb && rgb.length >= 3 && rgb.every(Number.isFinite)
                ? rgbToHex(rgb)
                : typeof properties.color === 'string' &&
                  HEX_COLOR_RE.test(properties.color)
                ? properties.color
                : undefined;
        const base = {
            featureIndex: index,
            label: text(properties.name, 200) || className,
            className,
            color,
            layer: text(properties.layer, 100),
            note: text(properties.note, 2000),
        };
        const parts: WsiImportDraft[] = [];
        const geometry = feature.geometry;
        const coordinates = geometry.coordinates;
        const addPoint = (value: unknown) => {
            if (!isPosition(value)) throw new Error('invalid coordinates');
            if (!inside([value])) throw new Error('outside the slide');
            parts.push({
                ...base,
                kind: 'point',
                svg: `<svg><circle cx="${round(value[0])}" cy="${round(
                    value[1]
                )}" r="0" /></svg>`,
            });
        };
        const addLine = (value: unknown) => {
            if (
                !Array.isArray(value) ||
                value.length < 2 ||
                !value.every(isPosition)
            ) {
                throw new Error('invalid coordinates');
            }
            if (value.length > MAX_IMPORT_VERTICES) {
                throw new Error('too many vertices');
            }
            if (!inside(value)) throw new Error('outside the slide');
            parts.push({
                ...base,
                kind: 'line',
                svg:
                    value.length === 2
                        ? `<svg><line x1="${round(value[0][0])}" y1="${round(
                              value[0][1]
                          )}" x2="${round(value[1][0])}" y2="${round(
                              value[1][1]
                          )}" /></svg>`
                        : `<svg><polyline points="${svgPoints(
                              value
                          )}" /></svg>`,
            });
        };
        /** A GeoJSON polygon's rings: the outer ring, then its holes. */
        const polygonRings = (value: unknown, part?: number): WsiPoint[][] => {
            const where = part === undefined ? '' : `part ${part + 1}: `;
            if (!Array.isArray(value) || !value.length) {
                throw new Error(`${where}invalid coordinates`);
            }
            return value.map((ring: unknown, index: number) => {
                if (!Array.isArray(ring) || !ring.every(isPosition)) {
                    throw new Error(`${where}invalid coordinates`);
                }
                const open =
                    ring.length > 1 &&
                    ring[0][0] === ring[ring.length - 1][0] &&
                    ring[0][1] === ring[ring.length - 1][1]
                        ? ring.slice(0, -1)
                        : ring;
                if (open.length < 3) {
                    throw new Error(
                        `${where}${
                            index ? 'a hole has ' : ''
                        }fewer than 3 vertices`
                    );
                }
                if (!inside(open)) throw new Error(`${where}outside the slide`);
                return open.map(([x, y]: Position) => ({ x, y }));
            });
        };
        /** One annotation of a polygon with holes, or of every part. */
        const addRegion = (region: WsiRegion) => {
            const vertices = region.reduce(
                (sum, rings) =>
                    sum + rings.reduce((n, ring) => n + ring.length, 0),
                0
            );
            if (vertices > MAX_IMPORT_VERTICES) {
                throw new Error('too many vertices');
            }
            parts.push({
                ...base,
                kind: 'polygon',
                svg: regionSelectorSvg(region),
            });
        };
        try {
            switch (geometry.type) {
                case 'Point':
                    addPoint(coordinates);
                    break;
                case 'MultiPoint':
                    (coordinates || []).forEach(addPoint);
                    break;
                case 'LineString':
                    addLine(coordinates);
                    break;
                case 'MultiLineString':
                    (coordinates || []).forEach(addLine);
                    break;
                case 'Polygon':
                    addRegion([polygonRings(coordinates)]);
                    break;
                case 'MultiPolygon':
                    if (!Array.isArray(coordinates) || !coordinates.length) {
                        throw new Error('invalid coordinates');
                    }
                    addRegion(
                        coordinates.map((polygon: unknown, part: number) =>
                            polygonRings(polygon, part)
                        )
                    );
                    break;
                default:
                    throw new Error(
                        `unsupported geometry ${String(geometry.type)}`
                    );
            }
            if (!parts.length) throw new Error('no coordinates');
            drafts.push(...parts);
        } catch (error) {
            skip((error as Error).message);
        }
    });
    if (drafts.length > MAX_IMPORT_FEATURES) {
        throw new Error(
            `The file has ${drafts.length} annotations; import at most ${MAX_IMPORT_FEATURES} at a time.`
        );
    }
    return { drafts, skipped };
}
