import {
    measureShape,
    parseAnnotationShape,
    regionSelectorSvg,
    regionShape,
    shapeBounds,
    shapeRegion,
    WsiRegion,
} from './wsiAnnotationGeometryUtils';
import { parseGeoJsonImport, shapeToGeometry } from './wsiAnnotationGeoJson';
import { shapeContainsPoint } from './wsiAnnotationSpatial';
import {
    intersectRegions,
    regionArea,
    regionParts,
    splitRegionByPath,
    subtractRegions,
    unionRegions,
} from './wsiAnnotationShapeOps';

const square = (x: number, y: number, size: number) => [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
];

/** A 100×100 square at the origin with a 20×20 hole at (40, 40). */
const holed: WsiRegion = [[square(0, 0, 100), square(40, 40, 20)]];

const svg = (value: string) => ({ type: 'SvgSelector', value });

describe('regions with holes and several parts', () => {
    it('keeps a one-ring region a <polygon>, as before', () => {
        const value = regionSelectorSvg([[square(0, 0, 10)]]);
        expect(value).toBe(
            '<svg><polygon points="0,0 10,0 10,10 0,10" /></svg>'
        );
        expect(parseAnnotationShape(svg(value))).toEqual({
            kind: 'polygon',
            points: square(0, 0, 10),
        });
    });

    it('stores holes and parts as evenodd paths, as Annotorious does', () => {
        const value = regionSelectorSvg([...holed, [square(200, 0, 10)]]);
        expect(value).toBe(
            '<svg><g>' +
                '<path fill-rule="evenodd" d="M 0,0 L 100,0 L 100,100 L 0,100 Z M 40,40 L 60,40 L 60,60 L 40,60 Z" />' +
                '<path fill-rule="evenodd" d="M 200,0 L 210,0 L 210,10 L 200,10 Z" />' +
                '</g></svg>'
        );
        expect(parseAnnotationShape(svg(value))).toEqual({
            kind: 'multipolygon',
            polygons: [...holed, [square(200, 0, 10)]],
        });
    });

    it('reads relative, H/V and repeated-point paths, and open paths as polylines', () => {
        expect(
            parseAnnotationShape(
                svg(
                    '<svg><path d="m 0 0 h 10 v 10 h -10 z M 2,2 L 8,2 8,8 2,8 2,2 Z" /></svg>'
                )
            )
        ).toEqual({
            kind: 'multipolygon',
            polygons: [[square(0, 0, 10), square(2, 2, 6)]],
        });
        expect(
            parseAnnotationShape(
                svg('<svg><path d="M 0,0 L 5,5 L 9,0" /></svg>')
            )
        ).toEqual({
            kind: 'polyline',
            points: [
                { x: 0, y: 0 },
                { x: 5, y: 5 },
                { x: 9, y: 0 },
            ],
        });
        expect(
            parseAnnotationShape(
                svg('<svg><path d="M 0,0 C 1,1 2,2 3,3 Z" /></svg>')
            )
        ).toBeNull();
        expect(
            parseAnnotationShape(svg('<svg><path d="M 0,0 L 1,1 Z" /></svg>'))
        ).toBeNull();
    });

    it('measures area as the outer rings less the holes, and every ring for the perimeter', () => {
        const shape = regionShape([...holed, [square(200, 0, 10)]])!;
        expect(measureShape(shape)).toEqual({
            unit: 'px',
            area: 100 * 100 - 20 * 20 + 10 * 10,
            perimeter: 400 + 80 + 40,
        });
        // Per axis with an mpp.
        expect(measureShape(regionShape(holed)!, { x: 0.5, y: 0.25 })).toEqual({
            unit: 'um',
            area: (100 * 100 - 20 * 20) * 0.5 * 0.25,
            perimeter: 2 * (50 + 25) + 2 * (10 + 5),
        });
        expect(shapeBounds(shape)).toEqual({
            minX: 0,
            minY: 0,
            maxX: 210,
            maxY: 100,
        });
    });

    it('finds points inside a part but not in its holes', () => {
        const shape = regionShape(holed)!;
        expect(shapeContainsPoint(shape, { x: 10, y: 10 }, 0)).toBe(true);
        expect(shapeContainsPoint(shape, { x: 50, y: 50 }, 0)).toBe(false);
        expect(shapeContainsPoint(shape, { x: 150, y: 50 }, 0)).toBe(false);
        // Near the hole's edge with a click's tolerance.
        expect(shapeContainsPoint(shape, { x: 42, y: 50 }, 3)).toBe(true);
    });

    it('exports a Polygon with holes, or a MultiPolygon, and imports them back', () => {
        const one = shapeToGeometry(regionShape(holed)!);
        expect(one).toEqual({
            type: 'Polygon',
            coordinates: [
                [
                    [0, 0],
                    [100, 0],
                    [100, 100],
                    [0, 100],
                    [0, 0],
                ],
                [
                    [40, 40],
                    [60, 40],
                    [60, 60],
                    [40, 60],
                    [40, 40],
                ],
            ],
        });
        const two = shapeToGeometry(
            regionShape([...holed, [square(200, 0, 10)]])!
        );
        expect(two.type).toBe('MultiPolygon');
        const imported = parseGeoJsonImport({
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: one, properties: { name: 'A' } },
                { type: 'Feature', geometry: two, properties: { name: 'B' } },
            ],
        });
        expect(imported.skipped).toEqual([]);
        expect(imported.drafts.map(draft => draft.kind)).toEqual([
            'polygon',
            'polygon',
        ]);
        expect(parseAnnotationShape(svg(imported.drafts[0].svg))).toEqual(
            regionShape(holed)
        );
        expect(parseAnnotationShape(svg(imported.drafts[1].svg))).toEqual(
            regionShape([...holed, [square(200, 0, 10)]])
        );
    });

    it('skips a MultiPolygon with a bad part, naming the part', () => {
        const { drafts, skipped } = parseGeoJsonImport({
            type: 'Feature',
            geometry: {
                type: 'MultiPolygon',
                coordinates: [
                    [
                        [
                            [0, 0],
                            [10, 0],
                            [10, 10],
                            [0, 0],
                        ],
                    ],
                    [
                        [
                            [20, 20],
                            [30, 20],
                            [20, 20],
                        ],
                    ],
                ],
            },
            properties: {},
        });
        expect(drafts).toEqual([]);
        expect(skipped).toEqual([
            { index: 0, reason: 'part 2: fewer than 3 vertices' },
        ]);
    });
});

describe('boolean operations on regions', () => {
    const a: WsiRegion = [[square(0, 0, 10)]];
    const b: WsiRegion = [[square(5, 0, 10)]];
    const far: WsiRegion = [[square(100, 100, 10)]];

    it('merges overlapping regions into one, and apart ones into parts', () => {
        const merged = unionRegions([a, b]);
        expect(merged).toHaveLength(1);
        expect(regionArea(merged)).toBeCloseTo(150);
        const parts = unionRegions([a, far]);
        expect(parts).toHaveLength(2);
        expect(regionArea(parts)).toBeCloseTo(200);
    });

    it('cuts a hole inside, and a notch at the edge', () => {
        const hole = subtractRegions(
            [[square(0, 0, 100)]],
            [[[square(40, 40, 20)]]]
        );
        expect(hole).toHaveLength(1);
        expect(hole[0]).toHaveLength(2);
        expect(regionArea(hole)).toBeCloseTo(9600);
        const notch = subtractRegions(a, [b]);
        expect(notch).toHaveLength(1);
        expect(notch[0]).toHaveLength(1);
        expect(regionArea(notch)).toBeCloseTo(50);
        expect(subtractRegions(a, [[[square(-5, -5, 30)]]])).toEqual([]);
    });

    it('intersects', () => {
        expect(regionArea(intersectRegions([a, b]))).toBeCloseTo(50);
        expect(intersectRegions([a, far])).toEqual([]);
    });

    it('splits a region by a line across it, keeping holes', () => {
        const pieces = splitRegionByPath(holed, [
            { x: 30, y: -10 },
            { x: 30, y: 110 },
        ]);
        expect(pieces).toHaveLength(2);
        // The larger piece keeps the hole; the band is 0.2 px wide.
        expect(pieces[0][0]).toHaveLength(2);
        expect(regionArea(pieces[0])).toBeCloseTo(70 * 100 - 400 - 10, 0);
        expect(regionArea(pieces[1])).toBeCloseTo(30 * 100 - 10, 0);
        // A line that stops inside does not split.
        expect(
            splitRegionByPath(holed, [
                { x: 30, y: -10 },
                { x: 30, y: 20 },
            ])
        ).toHaveLength(1);
        // A bent line.
        expect(
            splitRegionByPath(
                [[square(0, 0, 10)]],
                [
                    { x: -1, y: 5 },
                    { x: 5, y: 5 },
                    { x: 5, y: 11 },
                ]
            )
        ).toHaveLength(2);
    });

    it('separates parts and turns shapes into regions', () => {
        expect(regionParts([...holed, ...far])).toEqual([holed, far]);
        const ellipse = shapeRegion({
            kind: 'ellipse',
            cx: 0,
            cy: 0,
            rx: 10,
            ry: 5,
        })!;
        expect(ellipse[0][0]).toHaveLength(96);
        expect(regionArea(ellipse)).toBeCloseTo(Math.PI * 50, 0);
        expect(
            shapeRegion({
                kind: 'line',
                points: [
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                ],
            })
        ).toBeNull();
    });
});
