const MIN_RENDERABLE_ANNOTATION_SIZE = 1;

/**
 * Rewrites an SVG selector into shapes Annotorious draws: a circle becomes an
 * ellipse, and a zero-size ellipse or line gets a minimal size. A circle of
 * radius 0 is a point, which the viewer draws itself, and is kept.
 */
export function normalizeSvgSelector(svg: string): string {
    let normalized = svg.replace(
        /<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s*\/>/g,
        (match, cx, cy, radius) =>
            Number(radius) === 0
                ? match
                : `<ellipse cx="${cx}" cy="${cy}" rx="${radius}" ry="${radius}" />`
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
 * A brush width in level-0 image pixels. With the slide's microns-per-pixel
 * the width is `microns` of tissue, the same at every zoom; a slide whose x
 * and y scales differ uses their mean, since the brush band is round.
 * Without an mpp it is `screenPixels` at the zoom of the stroke, where one
 * screen pixel is `imagePerScreen` image pixels.
 */
export function brushWidthInImagePixels(
    width: { microns: number; screenPixels: number },
    mpp: WsiMpp | null | undefined,
    imagePerScreen: number
): number {
    if (mpp && mpp.x > 0 && mpp.y > 0) {
        return width.microns / ((mpp.x + mpp.y) / 2);
    }
    return width.screenPixels * imagePerScreen;
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

function distanceToSegment(point: WsiPoint, a: WsiPoint, b: WsiPoint): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = Math.max(
        0,
        Math.min(
            1,
            ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared
        )
    );
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Douglas–Peucker simplification: drops the points that lie within
 * `tolerance` of the line between the points kept around them. The ends
 * are always kept. Iterative, so long strokes cannot overflow the stack.
 */
export function simplifyPath(
    points: WsiPoint[],
    tolerance: number
): WsiPoint[] {
    if (points.length <= 2) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, points.length - 1]];
    while (stack.length) {
        const [first, last] = stack.pop()!;
        let farthest = -1;
        let farthestDistance = tolerance;
        for (let i = first + 1; i < last; i++) {
            const distance = distanceToSegment(
                points[i],
                points[first],
                points[last]
            );
            if (distance > farthestDistance) {
                farthest = i;
                farthestDistance = distance;
            }
        }
        if (farthest >= 0) {
            keep[farthest] = 1;
            stack.push([first, farthest], [farthest, last]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

function normalize(x: number, y: number): WsiPoint {
    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
}

/** Points on the arc around `center` from angle `from`, turning by `sweep`. */
function arc(
    center: WsiPoint,
    radius: number,
    from: number,
    sweep: number,
    segments: number
): WsiPoint[] {
    const points: WsiPoint[] = [];
    for (let i = 1; i < segments; i++) {
        const angle = from + (sweep * i) / segments;
        points.push({
            x: center.x + radius * Math.cos(angle),
            y: center.y + radius * Math.sin(angle),
        });
    }
    return points;
}

/**
 * The outline of a stroke `2 * halfWidth` wide along `path`, as one polygon:
 * the left edge, a round cap, the right edge back, and a round cap. Corners
 * are mitred, with the miter limited to twice the half width. A stroke that
 * doubles back sharply can produce a self-touching outline; simplifying the
 * path first keeps that rare.
 */
export function strokeOutline(
    path: WsiPoint[],
    halfWidth: number,
    capSegments = 8
): WsiPoint[] {
    const points = path.filter(
        (point, i) =>
            i === 0 ||
            Math.hypot(point.x - path[i - 1].x, point.y - path[i - 1].y) > 1e-9
    );
    if (!points.length || halfWidth <= 0) return [];
    if (points.length === 1) {
        return [
            { x: points[0].x + halfWidth, y: points[0].y },
            ...arc(points[0], halfWidth, 0, 2 * Math.PI, capSegments * 2),
        ];
    }
    const segmentNormals = points.slice(1).map((point, i) => {
        const direction = normalize(
            point.x - points[i].x,
            point.y - points[i].y
        );
        return { x: -direction.y, y: direction.x };
    });
    const left: WsiPoint[] = [];
    const right: WsiPoint[] = [];
    points.forEach((point, i) => {
        const before = segmentNormals[Math.max(0, i - 1)];
        const after = segmentNormals[Math.min(segmentNormals.length - 1, i)];
        const miter = normalize(before.x + after.x, before.y + after.y);
        const cosine = miter.x * after.x + miter.y * after.y;
        const length = Math.min(
            halfWidth / Math.max(cosine, 1e-6),
            2 * halfWidth
        );
        left.push({
            x: point.x + miter.x * length,
            y: point.y + miter.y * length,
        });
        right.push({
            x: point.x - miter.x * length,
            y: point.y - miter.y * length,
        });
    });
    const last = points.length - 1;
    const endNormal = segmentNormals[segmentNormals.length - 1];
    const startNormal = segmentNormals[0];
    // Each cap turns half a circle from the left edge to the right edge.
    const endCap = arc(
        points[last],
        halfWidth,
        Math.atan2(endNormal.y, endNormal.x),
        -Math.PI,
        capSegments
    );
    const startCap = arc(
        points[0],
        halfWidth,
        Math.atan2(-startNormal.y, -startNormal.x),
        -Math.PI,
        capSegments
    );
    return [...left, ...endCap, ...right.reverse(), ...startCap];
}
