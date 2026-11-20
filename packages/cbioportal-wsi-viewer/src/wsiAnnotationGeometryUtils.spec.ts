import {
    brushWidthInImagePixels,
    ellipsePerimeter,
    formatArea,
    formatLength,
    formatMeasurement,
    measureShape,
    normalizeSvgSelector,
    parseAnnotationShape,
    pathLength,
    polygonArea,
    simplifyPath,
    strokeOutline,
} from './wsiAnnotationGeometryUtils';

const svg = (value: string) => ({ type: 'SvgSelector', value });

describe('parseAnnotationShape', () => {
    it('reads fragment rectangles and the SVG shapes the viewer writes', () => {
        expect(
            parseAnnotationShape({
                type: 'FragmentSelector',
                value: 'xywh=pixel:1,2,30,40',
            })
        ).toEqual({ kind: 'rectangle', x: 1, y: 2, width: 30, height: 40 });
        expect(
            parseAnnotationShape(
                svg('<svg><rect x="1" y="2" width="3" height="4" /></svg>')
            )
        ).toEqual({ kind: 'rectangle', x: 1, y: 2, width: 3, height: 4 });
        expect(
            parseAnnotationShape(
                svg('<svg><ellipse cx="5" cy="6" rx="7" ry="8" /></svg>')
            )
        ).toEqual({ kind: 'ellipse', cx: 5, cy: 6, rx: 7, ry: 8 });
        expect(
            parseAnnotationShape(
                svg('<svg><circle cx="5" cy="6" r="2" /></svg>')
            )
        ).toEqual({ kind: 'ellipse', cx: 5, cy: 6, rx: 2, ry: 2 });
        expect(
            parseAnnotationShape(
                svg('<svg><circle cx="5" cy="6" r="0" /></svg>')
            )
        ).toEqual({ kind: 'point', x: 5, y: 6 });
        expect(
            parseAnnotationShape(
                svg('<svg><line x1="0" y1="0" x2="3" y2="4" /></svg>')
            )
        ).toEqual({
            kind: 'line',
            points: [
                { x: 0, y: 0 },
                { x: 3, y: 4 },
            ],
        });
        expect(
            parseAnnotationShape(
                svg('<svg><polygon points="0,0 10,0 10,10" /></svg>')
            )
        ).toEqual({
            kind: 'polygon',
            points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
            ],
        });
        expect(
            parseAnnotationShape(
                svg('<svg><polyline points="0 0 3 4" /></svg>')
            )
        ).toEqual({
            kind: 'polyline',
            points: [
                { x: 0, y: 0 },
                { x: 3, y: 4 },
            ],
        });
    });

    it('returns null for shapes it cannot measure', () => {
        expect(parseAnnotationShape(svg('<svg><path d="M0 0" /></svg>'))).toBe(
            null
        );
        expect(
            parseAnnotationShape(svg('<svg><polygon points="0,0 1,1" /></svg>'))
        ).toBe(null);
        expect(
            parseAnnotationShape(svg('<svg><rect x="a" y="0" /></svg>'))
        ).toBe(null);
        expect(parseAnnotationShape(null)).toBe(null);
    });
});

describe('normalizeSvgSelector', () => {
    it('turns circles into ellipses but keeps points', () => {
        expect(
            normalizeSvgSelector('<svg><circle cx="1" cy="2" r="3" /></svg>')
        ).toBe('<svg><ellipse cx="1" cy="2" rx="3" ry="3" /></svg>');
        expect(
            normalizeSvgSelector('<svg><circle cx="1" cy="2" r="0" /></svg>')
        ).toBe('<svg><circle cx="1" cy="2" r="0" /></svg>');
    });
});

describe('measurement math', () => {
    it('computes the shoelace area of polygons in either winding', () => {
        const square = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ];
        expect(polygonArea(square)).toBe(100);
        expect(polygonArea([...square].reverse())).toBe(100);
        // An L shape: a 10x10 square minus a 5x5 corner.
        expect(
            polygonArea([
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 5 },
                { x: 5, y: 5 },
                { x: 5, y: 10 },
                { x: 0, y: 10 },
            ])
        ).toBe(75);
        expect(pathLength(square, true)).toBe(40);
        expect(pathLength(square)).toBe(30);
    });

    it('computes ellipse perimeter by Ramanujan and is exact for a circle', () => {
        expect(ellipsePerimeter(5, 5)).toBeCloseTo(2 * Math.PI * 5, 10);
        // a=10, b=5: the exact perimeter is 48.4422...
        expect(ellipsePerimeter(10, 5)).toBeCloseTo(48.4422, 3);
        expect(ellipsePerimeter(0, 0)).toBe(0);
    });

    it('scales by microns-per-pixel on each axis', () => {
        const mpp = { x: 0.5, y: 0.25 };
        expect(
            measureShape(
                { kind: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
                mpp
            )
        ).toEqual({ unit: 'um', area: 1250, perimeter: 150 });
        const ellipse = measureShape(
            { kind: 'ellipse', cx: 0, cy: 0, rx: 20, ry: 20 },
            mpp
        )!;
        expect(ellipse.unit).toBe('um');
        expect(ellipse.area).toBeCloseTo(Math.PI * 10 * 5, 10);
        expect(ellipse.perimeter).toBeCloseTo(ellipsePerimeter(10, 5), 10);
        expect(
            measureShape(
                {
                    kind: 'line',
                    points: [
                        { x: 0, y: 0 },
                        { x: 6, y: 16 },
                    ],
                },
                mpp
            )
        ).toEqual({ unit: 'um', length: 5 });
        expect(
            measureShape(
                {
                    kind: 'polygon',
                    points: [
                        { x: 0, y: 0 },
                        { x: 4, y: 0 },
                        { x: 0, y: 12 },
                    ],
                },
                mpp
            )
        ).toEqual({ unit: 'um', area: 3, perimeter: 2 + 3 + Math.hypot(2, 3) });
        expect(measureShape({ kind: 'point', x: 1, y: 1 }, mpp)).toBe(null);
    });

    it('measures in pixels without a scale', () => {
        expect(
            measureShape({
                kind: 'line',
                points: [
                    { x: 0, y: 0 },
                    { x: 3, y: 4 },
                ],
            })
        ).toEqual({ unit: 'px', length: 5 });
    });
});

describe('measurement formatting', () => {
    it('switches to millimetres for large sizes', () => {
        expect(formatLength(4.25, 'um')).toBe('4.3 µm');
        expect(formatLength(120.4, 'um')).toBe('120 µm');
        expect(formatLength(1234, 'um')).toBe('1.23 mm');
        expect(formatLength(12345, 'um')).toBe('12.3 mm');
        expect(formatLength(1234.4, 'px')).toBe('1,234 px');
        expect(formatArea(5, 'um')).toBe('5.0 µm²');
        expect(formatArea(9500, 'um')).toBe('9,500 µm²');
        expect(formatArea(31000, 'um')).toBe('0.031 mm²');
        expect(formatArea(2.5e6, 'um')).toBe('2.50 mm²');
        expect(formatArea(25e6, 'um')).toBe('25.0 mm²');
        expect(formatArea(1500, 'px')).toBe('1,500 px²');
    });

    it('lists the measures a shape has', () => {
        expect(formatMeasurement({ unit: 'um', length: 120 })).toBe(
            'Length 120 µm'
        );
        expect(
            formatMeasurement({ unit: 'um', area: 31000, perimeter: 640 })
        ).toBe('Area 0.031 mm² · Perimeter 640 µm');
        expect(
            formatMeasurement({ unit: 'px', area: 100, perimeter: 40 })
        ).toBe('Area 100 px² · Perimeter 40 px');
    });
});

describe('simplifyPath', () => {
    it('drops points within the tolerance and keeps corners and ends', () => {
        const jittery = [
            { x: 0, y: 0 },
            { x: 1, y: 0.2 },
            { x: 2, y: -0.2 },
            { x: 3, y: 0.1 },
            { x: 4, y: 0 },
            { x: 4.1, y: 1 },
            { x: 3.9, y: 2 },
            { x: 4, y: 3 },
        ];
        expect(simplifyPath(jittery, 0.5)).toEqual([
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 3 },
        ]);
        expect(simplifyPath(jittery, 0.01)).toHaveLength(jittery.length);
        expect(simplifyPath([{ x: 1, y: 1 }], 1)).toEqual([{ x: 1, y: 1 }]);
    });

    it('handles long strokes without recursion', () => {
        const long = Array.from({ length: 100000 }, (_, i) => ({
            x: i,
            y: Math.sin(i / 1000) * 100,
        }));
        const simplified = simplifyPath(long, 1);
        expect(simplified.length).toBeLessThan(500);
        expect(simplified[0]).toEqual(long[0]);
        expect(simplified[simplified.length - 1]).toEqual(
            long[long.length - 1]
        );
    });
});

describe('strokeOutline', () => {
    it('outlines a straight stroke as a capsule of the brush width', () => {
        const outline = strokeOutline(
            [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
            ],
            10,
            64
        );
        // A 100 x 20 band plus two half discs of radius 10.
        expect(polygonArea(outline)).toBeCloseTo(100 * 20 + Math.PI * 100, -1);
        const ys = outline.map(point => point.y);
        const xs = outline.map(point => point.x);
        expect(Math.max(...ys)).toBeCloseTo(10, 6);
        expect(Math.min(...ys)).toBeCloseTo(-10, 6);
        expect(Math.max(...xs)).toBeCloseTo(110, 1);
        expect(Math.min(...xs)).toBeCloseTo(-10, 1);
    });

    it('mitres corners so a bent stroke keeps its width', () => {
        const outline = strokeOutline(
            [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
                { x: 100, y: 100 },
            ],
            5,
            16
        );
        // Each 100-pixel arm is 10 wide; the corner adds about a square.
        const area = polygonArea(outline);
        expect(area).toBeGreaterThan(2000);
        expect(area).toBeLessThan(2200);
    });

    it('outlines a dot as a disc and nothing for no width', () => {
        const dot = strokeOutline([{ x: 5, y: 5 }], 3, 32);
        expect(polygonArea(dot)).toBeCloseTo(Math.PI * 9, 0);
        expect(strokeOutline([{ x: 0, y: 0 }], 0)).toEqual([]);
    });
});

describe('brushWidthInImagePixels', () => {
    const width = { microns: 50, screenPixels: 16 };

    it('converts µm with the slide scale, whatever the zoom', () => {
        expect(brushWidthInImagePixels(width, { x: 0.5, y: 0.5 }, 1)).toBe(100);
        expect(brushWidthInImagePixels(width, { x: 0.5, y: 0.5 }, 32)).toBe(
            100
        );
        expect(brushWidthInImagePixels(width, { x: 0.25, y: 0.25 }, 4)).toBe(
            200
        );
    });

    it('uses the mean scale when x and y differ', () => {
        expect(brushWidthInImagePixels(width, { x: 0.4, y: 0.6 }, 1)).toBe(100);
    });

    it('falls back to screen pixels at the zoom without a valid scale', () => {
        expect(brushWidthInImagePixels(width, undefined, 4)).toBe(64);
        expect(brushWidthInImagePixels(width, null, 0.5)).toBe(8);
        expect(brushWidthInImagePixels(width, { x: 0, y: 0.5 }, 2)).toBe(32);
    });
});
