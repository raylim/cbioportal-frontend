const MIN_RENDERABLE_ANNOTATION_SIZE = 1;

export function normalizeSvgSelector(svg: string): string {
    let normalized = svg.replace(
        /<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s*\/>/g,
        (_match, cx, cy, radius) =>
            `<ellipse cx="${cx}" cy="${cy}" rx="${radius}" ry="${radius}" />`
    );
    normalized = normalized.replace(
        /<ellipse\s+cx="([^"]+)"\s+cy="([^"]+)"\s+rx="([^"]+)"\s+ry="([^"]+)"\s*\/>/g,
        (_match, cx, cy, rx, ry) => {
            const safeRadius = (value: string) =>
                Math.max(
                    MIN_RENDERABLE_ANNOTATION_SIZE,
                    Math.abs(Number(value)) || 0
                );
            return `<ellipse cx="${cx}" cy="${cy}" rx="${safeRadius(
                rx
            )}" ry="${safeRadius(ry)}" />`;
        }
    );
    return normalized.replace(
        /<line\s+x1="([^"]+)"\s+y1="([^"]+)"\s+x2="([^"]+)"\s+y2="([^"]+)"\s*\/>/g,
        (_match, x1, y1, x2, y2) => {
            if (Number(x1) !== Number(x2) || Number(y1) !== Number(y2)) {
                return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
            }
            return `<line x1="${x1}" y1="${y1}" x2="${Number(x1) +
                MIN_RENDERABLE_ANNOTATION_SIZE}" y2="${y2}" />`;
        }
    );
}

export interface WsiPoint {
    x: number;
    y: number;
}

/** An annotation's geometry in level-0 image pixels. */
export type WsiAnnotationShape =
    | { kind: 'rectangle'; x: number; y: number; width: number; height: number }
    | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
    | { kind: 'line'; points: [WsiPoint, WsiPoint] }
    | { kind: 'polyline'; points: WsiPoint[] }
    | { kind: 'polygon'; points: WsiPoint[] }
    | { kind: 'point'; x: number; y: number };

function svgAttributes(element: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(element))) {
        attributes[match[1]] = match[2];
    }
    return attributes;
}

function parsePointList(value: string | undefined): WsiPoint[] | null {
    if (!value) return null;
    const numbers = value
        .trim()
        .split(/[\s,]+/)
        .map(Number);
    if (numbers.length < 2 || numbers.length % 2 || numbers.some(isNaN)) {
        return null;
    }
    const points: WsiPoint[] = [];
    for (let i = 0; i < numbers.length; i += 2) {
        points.push({ x: numbers[i], y: numbers[i + 1] });
    }
    return points;
}

function finite(...values: number[]): boolean {
    return values.every(value => Number.isFinite(value));
}

/**
 * The shape an annotation selector describes: a `FragmentSelector` rectangle
 * (`xywh=pixel:x,y,w,h`) or the first shape of an `SvgSelector`. A circle of
 * radius 0 is a point. Null for anything else, such as an SVG path.
 */
export function parseAnnotationShape(
    selector: { type?: string; value?: unknown } | null | undefined
): WsiAnnotationShape | null {
    if (!selector || typeof selector.value !== 'string') return null;
    if (selector.type === 'FragmentSelector') {
        const match = /^xywh=(?:pixel:)?([^,]+),([^,]+),([^,]+),([^,]+)$/.exec(
            selector.value.trim()
        );
        if (!match) return null;
        const [x, y, width, height] = match.slice(1).map(Number);
        return finite(x, y, width, height)
            ? { kind: 'rectangle', x, y, width, height }
            : null;
    }
    if (selector.type !== 'SvgSelector') return null;
    const element = /<(rect|ellipse|circle|line|polygon|polyline)\b([^>]*)>/i.exec(
        selector.value
    );
    if (!element) return null;
    const tag = element[1].toLowerCase();
    const a = svgAttributes(element[2]);
    const n = (name: string) => Number(a[name]);
    switch (tag) {
        case 'rect':
            return finite(n('x'), n('y'), n('width'), n('height'))
                ? {
                      kind: 'rectangle',
                      x: n('x'),
                      y: n('y'),
                      width: n('width'),
                      height: n('height'),
                  }
                : null;
        case 'ellipse':
            return finite(n('cx'), n('cy'), n('rx'), n('ry'))
                ? {
                      kind: 'ellipse',
                      cx: n('cx'),
                      cy: n('cy'),
                      rx: Math.abs(n('rx')),
                      ry: Math.abs(n('ry')),
                  }
                : null;
        case 'circle':
            if (!finite(n('cx'), n('cy'), n('r'))) return null;
            return n('r') === 0
                ? { kind: 'point', x: n('cx'), y: n('cy') }
                : {
                      kind: 'ellipse',
                      cx: n('cx'),
                      cy: n('cy'),
                      rx: Math.abs(n('r')),
                      ry: Math.abs(n('r')),
                  };
        case 'line':
            return finite(n('x1'), n('y1'), n('x2'), n('y2'))
                ? {
                      kind: 'line',
                      points: [
                          { x: n('x1'), y: n('y1') },
                          { x: n('x2'), y: n('y2') },
                      ],
                  }
                : null;
        default: {
            const points = parsePointList(a.points);
            if (!points) return null;
            if (tag === 'polyline') {
                return points.length >= 2 ? { kind: 'polyline', points } : null;
            }
            return points.length >= 3 ? { kind: 'polygon', points } : null;
        }
    }
}

/** Microns per pixel of a slide, along x and y. */
export interface WsiMpp {
    x: number;
    y: number;
}

/**
 * An annotation's size: in microns when the slide has microns-per-pixel,
 * else in level-0 image pixels.
 */
export interface WsiMeasurement {
    unit: 'um' | 'px';
    /** Length of a line or polyline. */
    length?: number;
    /** Area and perimeter of a closed shape. */
    area?: number;
    perimeter?: number;
}

/** The shoelace area of a simple polygon. */
export function polygonArea(points: WsiPoint[]): number {
    let twice = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        twice += a.x * b.y - b.x * a.y;
    }
    return Math.abs(twice) / 2;
}

/** Length of a path; closed adds the segment back to the start. */
export function pathLength(points: WsiPoint[], closed = false): number {
    let length = 0;
    const segments = closed ? points.length : points.length - 1;
    for (let i = 0; i < segments; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        length += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return length;
}

/** Ramanujan's second approximation of an ellipse's perimeter. */
export function ellipsePerimeter(a: number, b: number): number {
    if (a + b === 0) return 0;
    const h = ((a - b) * (a - b)) / ((a + b) * (a + b));
    return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/**
 * Measures a shape. Coordinates are scaled by the slide's microns-per-pixel
 * along each axis first, so a slide whose x and y scales differ is measured
 * correctly. A point has no size.
 */
export function measureShape(
    shape: WsiAnnotationShape,
    mpp?: WsiMpp | null
): WsiMeasurement | null {
    const sx = mpp ? mpp.x : 1;
    const sy = mpp ? mpp.y : 1;
    const unit = mpp ? 'um' : 'px';
    const scale = (points: WsiPoint[]) =>
        points.map(point => ({ x: point.x * sx, y: point.y * sy }));
    switch (shape.kind) {
        case 'rectangle': {
            const width = Math.abs(shape.width) * sx;
            const height = Math.abs(shape.height) * sy;
            return {
                unit,
                area: width * height,
                perimeter: 2 * (width + height),
            };
        }
        case 'ellipse': {
            const a = shape.rx * sx;
            const b = shape.ry * sy;
            return {
                unit,
                area: Math.PI * a * b,
                perimeter: ellipsePerimeter(a, b),
            };
        }
        case 'line':
        case 'polyline':
            return { unit, length: pathLength(scale(shape.points)) };
        case 'polygon': {
            const points = scale(shape.points);
            return {
                unit,
                area: polygonArea(points),
                perimeter: pathLength(points, true),
            };
        }
        default:
            return null;
    }
}

function formatNumber(value: number, decimals: number): string {
    return value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

/** A length: µm below 1 mm, else mm; or pixels. */
export function formatLength(value: number, unit: 'um' | 'px'): string {
    if (unit === 'px') return `${formatNumber(value, 0)} px`;
    if (value < 1000) {
        return `${formatNumber(value, value < 10 ? 1 : 0)} µm`;
    }
    const mm = value / 1000;
    return `${formatNumber(mm, mm < 10 ? 2 : 1)} mm`;
}

/** An area: µm² below 0.01 mm², else mm²; or square pixels. */
export function formatArea(value: number, unit: 'um' | 'px'): string {
    if (unit === 'px') return `${formatNumber(value, 0)} px²`;
    if (value < 10000) {
        return `${formatNumber(value, value < 10 ? 1 : 0)} µm²`;
    }
    const mm2 = value / 1e6;
    return `${formatNumber(mm2, mm2 < 1 ? 3 : mm2 < 10 ? 2 : 1)} mm²`;
}

/** "Length 120 µm", or "Area 0.031 mm² · Perimeter 640 µm". */
export function formatMeasurement(measurement: WsiMeasurement): string {
    const parts: string[] = [];
    if (measurement.length !== undefined) {
        parts.push(
            `Length ${formatLength(measurement.length, measurement.unit)}`
        );
    }
    if (measurement.area !== undefined) {
        parts.push(`Area ${formatArea(measurement.area, measurement.unit)}`);
    }
    if (measurement.perimeter !== undefined) {
        parts.push(
            `Perimeter ${formatLength(measurement.perimeter, measurement.unit)}`
        );
    }
    return parts.join(' · ');
}

export interface WsiBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** The bounding box of a shape, in image pixels. */
export function shapeBounds(shape: WsiAnnotationShape): WsiBounds {
    switch (shape.kind) {
        case 'rectangle':
            return {
                minX: Math.min(shape.x, shape.x + shape.width),
                minY: Math.min(shape.y, shape.y + shape.height),
                maxX: Math.max(shape.x, shape.x + shape.width),
                maxY: Math.max(shape.y, shape.y + shape.height),
            };
        case 'ellipse':
            return {
                minX: shape.cx - shape.rx,
                minY: shape.cy - shape.ry,
                maxX: shape.cx + shape.rx,
                maxY: shape.cy + shape.ry,
            };
        case 'point':
            return {
                minX: shape.x,
                minY: shape.y,
                maxX: shape.x,
                maxY: shape.y,
            };
        default: {
            const xs = shape.points.map(point => point.x);
            const ys = shape.points.map(point => point.y);
            return {
                minX: Math.min(...xs),
                minY: Math.min(...ys),
                maxX: Math.max(...xs),
                maxY: Math.max(...ys),
            };
        }
    }
}
