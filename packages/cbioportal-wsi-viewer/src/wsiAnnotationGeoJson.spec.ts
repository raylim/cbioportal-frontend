import {
    MAX_IMPORT_FEATURES,
    MAX_IMPORT_VERTICES,
    parseGeoJsonImport,
    toGeoJsonFeatureCollection,
} from './wsiAnnotationGeoJson';

describe('toGeoJsonFeatureCollection', () => {
    it('writes QuPath-style features in level-0 pixels, named by the slide key only', () => {
        const collection = toGeoJsonFeatureCollection(
            [
                {
                    id: 'a1',
                    shape: {
                        kind: 'rectangle',
                        x: 10,
                        y: 20,
                        width: 30,
                        height: 40,
                    },
                    label: 'Tumor 1',
                    classification: 'Tumor',
                    color: '#ef4444',
                    layer: 'Regions',
                    note: 'Check margin',
                    measurement: { unit: 'um', area: 300, perimeter: 70 },
                },
                {
                    id: 'p1',
                    shape: { kind: 'point', x: 5.555, y: 6 },
                    label: 'Mitosis',
                    classification: 'Mitosis',
                    color: '#0f0',
                    layer: 'Counts',
                    measurement: null,
                    aiReviewStatus: 'unreviewed',
                },
                {
                    id: 'l1',
                    shape: {
                        kind: 'line',
                        points: [
                            { x: 0, y: 0 },
                            { x: 3, y: 4 },
                        ],
                    },
                    label: 'Depth',
                    classification: 'Depth',
                    color: '#3b82f6',
                    layer: 'Default',
                    measurement: { unit: 'px', length: 5 },
                },
            ],
            '0123456789ab',
            { x: 0.5, y: 0.5 }
        );

        expect(collection.type).toBe('FeatureCollection');
        expect(collection.wsi).toEqual({
            slide_key: '0123456789ab',
            coordinates: 'level-0 image pixels',
            mpp: { x: 0.5, y: 0.5 },
        });
        const [rect, point, line] = collection.features;
        expect(rect).toEqual({
            type: 'Feature',
            id: 'a1',
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [10, 20],
                        [40, 20],
                        [40, 60],
                        [10, 60],
                        [10, 20],
                    ],
                ],
            },
            properties: {
                objectType: 'annotation',
                name: 'Tumor 1',
                classification: { name: 'Tumor', color: [239, 68, 68] },
                isLocked: false,
                layer: 'Regions',
                note: 'Check margin',
                measurements: { 'Area µm^2': 300, 'Perimeter µm': 70 },
            },
        });
        expect(point.geometry).toEqual({
            type: 'Point',
            coordinates: [5.56, 6],
        });
        expect(point.properties).toMatchObject({
            classification: { name: 'Mitosis', color: [0, 255, 0] },
            ai_generated: true,
            ai_review_status: 'unreviewed',
        });
        expect(point.properties).not.toHaveProperty('measurements');
        expect(line.geometry).toEqual({
            type: 'LineString',
            coordinates: [
                [0, 0],
                [3, 4],
            ],
        });
        expect(line.properties.measurements).toEqual({ 'Length px': 5 });
        expect(JSON.stringify(collection)).not.toMatch(
            /image_?id|sealed|serving|object_?key/i
        );
    });

    it('writes an ellipse as a closed polygon', () => {
        const [feature] = toGeoJsonFeatureCollection(
            [
                {
                    id: 'e',
                    shape: { kind: 'ellipse', cx: 100, cy: 50, rx: 20, ry: 10 },
                    label: 'E',
                    classification: 'E',
                    color: '#000',
                    layer: 'Default',
                },
            ],
            'abcdefabcdef'
        ).features;
        const ring = (feature.geometry as any).coordinates[0];
        expect(ring).toHaveLength(73);
        expect(ring[0]).toEqual([120, 50]);
        expect(ring[72]).toEqual(ring[0]);
    });
});

describe('parseGeoJsonImport', () => {
    const feature = (geometry: unknown, properties: unknown = {}) => ({
        type: 'Feature',
        geometry,
        properties,
    });

    it('reads QuPath features into annotation drafts', () => {
        const result = parseGeoJsonImport({
            type: 'FeatureCollection',
            features: [
                feature(
                    {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [0, 0],
                                [10, 0],
                                [10, 10],
                                [0, 0],
                            ],
                            [
                                [2, 2],
                                [3, 2],
                                [3, 3],
                                [2, 2],
                            ],
                        ],
                    },
                    {
                        objectType: 'annotation',
                        classification: { name: 'Tumor', color: [255, 0, 0] },
                        note: 'From QuPath',
                    }
                ),
                feature(
                    {
                        type: 'MultiPoint',
                        coordinates: [
                            [1, 2],
                            [3.333, 4],
                        ],
                    },
                    { name: 'Mitosis', layer: 'Counts', color: '#00ff00' }
                ),
                feature({
                    type: 'LineString',
                    coordinates: [
                        [0, 0],
                        [5, 5],
                    ],
                }),
                feature({
                    type: 'LineString',
                    coordinates: [
                        [0, 0],
                        [5, 5],
                        [9, 1],
                    ],
                }),
                feature({
                    type: 'MultiPolygon',
                    coordinates: [
                        [
                            [
                                [0, 0],
                                [1, 0],
                                [1, 1],
                            ],
                        ],
                        [
                            [
                                [5, 5],
                                [6, 5],
                                [6, 6],
                            ],
                        ],
                    ],
                }),
            ],
        });
        expect(result.skipped).toEqual([]);
        expect(result.drafts).toEqual([
            {
                kind: 'polygon',
                featureIndex: 0,
                svg: '<svg><polygon points="0,0 10,0 10,10" /></svg>',
                label: 'Tumor',
                className: 'Tumor',
                color: '#ff0000',
                layer: undefined,
                note: 'From QuPath',
            },
            expect.objectContaining({
                kind: 'point',
                svg: '<svg><circle cx="1" cy="2" r="0" /></svg>',
                label: 'Mitosis',
                color: '#00ff00',
                layer: 'Counts',
            }),
            expect.objectContaining({
                kind: 'point',
                svg: '<svg><circle cx="3.33" cy="4" r="0" /></svg>',
            }),
            expect.objectContaining({
                kind: 'line',
                svg: '<svg><line x1="0" y1="0" x2="5" y2="5" /></svg>',
            }),
            expect.objectContaining({
                kind: 'line',
                svg: '<svg><polyline points="0,0 5,5 9,1" /></svg>',
            }),
            expect.objectContaining({ kind: 'polygon' }),
            expect.objectContaining({ kind: 'polygon' }),
        ]);
    });

    it('skips invalid features and ones outside the slide', () => {
        const result = parseGeoJsonImport(
            [
                feature({ type: 'Point', coordinates: [1, 'x'] }),
                feature({ type: 'Point', coordinates: [500, 10] }),
                feature({
                    type: 'Polygon',
                    coordinates: [
                        [
                            [0, 0],
                            [1, 1],
                        ],
                    ],
                }),
                feature({ type: 'GeometryCollection', geometries: [] }),
                { type: 'Feature', geometry: null },
                feature({ type: 'Point', coordinates: [50, 50] }),
            ],
            { width: 100, height: 100 }
        );
        expect(result.drafts).toHaveLength(1);
        expect(result.skipped).toEqual([
            { index: 0, reason: 'invalid coordinates' },
            { index: 1, reason: 'outside the slide' },
            { index: 2, reason: 'fewer than 3 vertices' },
            { index: 3, reason: 'unsupported geometry GeometryCollection' },
            { index: 4, reason: 'not a Feature with a geometry' },
        ]);
    });

    it('skips too many vertices, an unsupported geometry, a bad part and a short open ring', () => {
        const ring = (n: number) =>
            Array.from({ length: n }, (_, i) => [i % 50, Math.floor(i / 50)]);
        const result = parseGeoJsonImport(
            [
                feature({
                    type: 'Polygon',
                    coordinates: [ring(MAX_IMPORT_VERTICES + 1)],
                }),
                feature({
                    type: 'LineString',
                    coordinates: ring(MAX_IMPORT_VERTICES + 1),
                }),
                feature({ type: 'Circle', coordinates: [1, 1] }),
                // One bad part skips the whole feature.
                feature({
                    type: 'MultiPolygon',
                    coordinates: [
                        [
                            [
                                [0, 0],
                                [1, 0],
                                [1, 1],
                            ],
                        ],
                        [
                            [
                                [0, 0],
                                [1, 'x'],
                                [1, 1],
                            ],
                        ],
                    ],
                }),
                // Open (not closed) and only two vertices.
                feature({
                    type: 'Polygon',
                    coordinates: [
                        [
                            [0, 0],
                            [4, 4],
                        ],
                    ],
                }),
                feature({
                    type: 'Polygon',
                    coordinates: [ring(MAX_IMPORT_VERTICES)],
                }),
            ],
            { width: 100, height: 200 }
        );
        expect(result.skipped).toEqual([
            { index: 0, reason: 'too many vertices' },
            { index: 1, reason: 'too many vertices' },
            { index: 2, reason: 'unsupported geometry Circle' },
            { index: 3, reason: 'invalid coordinates' },
            { index: 4, reason: 'fewer than 3 vertices' },
        ]);
        expect(result.drafts.map(draft => draft.featureIndex)).toEqual([5]);
    });

    it('checks no bounds when the slide size is unknown', () => {
        const far = feature({ type: 'Point', coordinates: [1e7, 2e7] });
        expect(parseGeoJsonImport([far], null).drafts).toHaveLength(1);
        expect(parseGeoJsonImport([far]).drafts).toHaveLength(1);
        expect(
            parseGeoJsonImport([far], { width: 10, height: 10 }).skipped
        ).toEqual([{ index: 0, reason: 'outside the slide' }]);
    });

    it('refuses input that is not GeoJSON features, or too many', () => {
        expect(() => parseGeoJsonImport({ type: 'Polygon' })).toThrow(
            'Not a GeoJSON FeatureCollection or Feature.'
        );
        expect(() => parseGeoJsonImport(null)).toThrow();
        const many = Array.from({ length: MAX_IMPORT_FEATURES + 1 }, () =>
            feature({ type: 'Point', coordinates: [1, 1] })
        );
        expect(() => parseGeoJsonImport(many)).toThrow(/at most 2000/);
    });

    it('reads back what it exports', () => {
        const exported = toGeoJsonFeatureCollection(
            [
                {
                    id: 'a',
                    shape: {
                        kind: 'polygon',
                        points: [
                            { x: 1, y: 1 },
                            { x: 9, y: 1 },
                            { x: 5, y: 7 },
                        ],
                    },
                    label: 'Stroma 2',
                    classification: 'Stroma',
                    color: '#22c55e',
                    layer: 'Regions',
                    note: 'n',
                },
            ],
            'abcdefabcdef'
        );
        expect(
            parseGeoJsonImport(JSON.parse(JSON.stringify(exported))).drafts
        ).toEqual([
            {
                kind: 'polygon',
                featureIndex: 0,
                svg: '<svg><polygon points="1,1 9,1 5,7" /></svg>',
                label: 'Stroma 2',
                className: 'Stroma',
                color: '#22c55e',
                layer: 'Regions',
                note: 'n',
            },
        ]);
    });
});
