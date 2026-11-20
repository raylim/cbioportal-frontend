import {
    applyAffine,
    composeAffine,
    decomposeAffine,
    fitAffine,
    fitAlignment,
    fitSimilarity,
    formatAlignmentError,
    invertAffine,
    mapShape,
    shapeSelectorSvg,
    WsiAffine,
    WsiAlignmentPair,
} from './wsiCompareTransform';
import {
    defaultPairCandidate,
    groupPairCandidates,
    pairingCandidates,
    slideSpecimenLabel,
    slideStainLabel,
} from './wsiComparePairing';
import {
    alignmentStorageKey,
    clearAlignment,
    loadAlignment,
    saveAlignment,
} from './wsiCompareStore';
import {
    followerPose,
    invertMapping,
    leftToRightMapping,
    nearestTurn,
} from './wsiCompareSync';
import {
    parseAnnotationShape,
    regionSelectorSvg,
    WsiPoint,
} from './wsiAnnotationGeometryUtils';
import { regionArea } from './wsiAnnotationShapeOps';
import {
    makeBlock,
    makeHierarchy,
    makePart,
    makeSlide,
} from './wsiTestFixtures';
import { Sample } from './wsiViewerTypes';

/** Rotation by `deg`, scale `s`, shift (tx, ty), optionally mirrored in y. */
function similarity(
    deg: number,
    s: number,
    tx: number,
    ty: number,
    mirrored = false
): WsiAffine {
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r) * s;
    const sin = Math.sin(r) * s;
    return mirrored
        ? { a: cos, b: sin, c: sin, d: -cos, tx, ty }
        : { a: cos, b: -sin, c: sin, d: cos, tx, ty };
}

function expectAffine(
    actual: WsiAffine | null,
    expected: WsiAffine,
    digits = 6
) {
    expect(actual).not.toBeNull();
    (['a', 'b', 'c', 'd', 'tx', 'ty'] as const).forEach(key =>
        expect(actual![key]).toBeCloseTo(expected[key], digits)
    );
}

const SOURCE: WsiPoint[] = [
    { x: 1000, y: 2000 },
    { x: 5000, y: 2500 },
    { x: 3000, y: 7000 },
    { x: 6500, y: 6000 },
];

describe('alignment transforms', () => {
    it('fits a similarity exactly from 2+ pairs, rotation and scale included', () => {
        const truth = similarity(30, 1.25, 400, -150);
        const fitted = fitSimilarity(
            SOURCE,
            SOURCE.map(p => applyAffine(truth, p))
        );
        expectAffine(fitted, truth);
        const parts = decomposeAffine(fitted!);
        expect(parts.scale).toBeCloseTo(1.25, 6);
        expect(parts.rotationDeg).toBeCloseTo(30, 6);
        expect(parts.reflected).toBe(false);
    });

    it('fits a mirrored section as a reflection, and not from noise alone', () => {
        const truth = similarity(-20, 0.9, 12000, 300, true);
        const fitted = fitSimilarity(
            SOURCE,
            SOURCE.map(p => applyAffine(truth, p))
        );
        expectAffine(fitted, truth);
        const parts = decomposeAffine(fitted!);
        expect(parts.reflected).toBe(true);
        expect(parts.rotationDeg).toBeCloseTo(-20, 6);
        // A plain map with a little noise stays plain.
        const plain = similarity(10, 1, 0, 0);
        const noisy = SOURCE.map((p, i) => {
            const q = applyAffine(plain, p);
            return { x: q.x + (i % 2 ? 3 : -3), y: q.y + (i % 3 ? -2 : 2) };
        });
        expect(decomposeAffine(fitSimilarity(SOURCE, noisy)!).reflected).toBe(
            false
        );
    });

    it('fits an affine map with shear exactly, and refuses collinear points', () => {
        const truth: WsiAffine = {
            a: 1.1,
            b: 0.2,
            c: -0.05,
            d: 0.95,
            tx: 300,
            ty: -40,
        };
        expectAffine(
            fitAffine(
                SOURCE,
                SOURCE.map(p => applyAffine(truth, p))
            ),
            truth
        );
        const line = [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
            { x: 20, y: 20 },
        ];
        expect(fitAffine(line, line)).toBeNull();
        expect(fitSimilarity([{ x: 1, y: 1 }], [{ x: 2, y: 2 }])).toBeNull();
    });

    it('inverts and composes back to the identity', () => {
        const t = similarity(47, 2.5, -1000, 250);
        const inverse = invertAffine(t)!;
        expectAffine(composeAffine(inverse, t), {
            a: 1,
            b: 0,
            c: 0,
            d: 1,
            tx: 0,
            ty: 0,
        });
        const p = { x: 1234, y: -567 };
        const back = applyAffine(inverse, applyAffine(t, p));
        expect(back.x).toBeCloseTo(p.x, 6);
        expect(back.y).toBeCloseTo(p.y, 6);
        expect(
            invertAffine({ a: 1, b: 2, c: 2, d: 4, tx: 0, ty: 0 })
        ).toBeNull();
    });

    it('reports each pair’s residual in µm of the right slide, and the RMS', () => {
        const truth = similarity(15, 1, 2000, 1000);
        // The fourth right point is 40 px off in x.
        const pairs: WsiAlignmentPair[] = SOURCE.map((left, i) => {
            const right = applyAffine(truth, left);
            return {
                id: `p${i + 1}`,
                left,
                right: i === 3 ? { x: right.x + 40, y: right.y } : right,
            };
        });
        const fit = fitAlignment(pairs, 'similarity', { x: 0.5, y: 0.5 })!;
        expect(fit.unit).toBe('um');
        expect(fit.count).toBe(4);
        expect(fit.exact).toBe(false);
        // Least squares spreads the 20 µm offset: the moved pair keeps the
        // largest residual, and the RMS is below it.
        const residuals = pairs.map(pair => fit.residuals[pair.id]);
        expect(Math.max(...residuals)).toBe(fit.residuals.p4);
        expect(fit.residuals.p4).toBeGreaterThan(5);
        expect(fit.residuals.p4).toBeLessThan(20);
        expect(fit.rms).toBeCloseTo(
            Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / 4),
            9
        );
        expect(fit.max).toBe(fit.residuals.p4);
        // In pixels without a scale.
        expect(fitAlignment(pairs, 'similarity', null)!.unit).toBe('px');
    });

    it('needs 3 complete pairs; affine with exactly 3 is an exact fit', () => {
        const truth = similarity(5, 1, 10, 10);
        const pairs: WsiAlignmentPair[] = SOURCE.slice(0, 3).map((left, i) => ({
            id: `p${i}`,
            left,
            right: applyAffine(truth, left),
        }));
        expect(fitAlignment(pairs.slice(0, 2), 'similarity')).toBeNull();
        expect(
            fitAlignment(
                [
                    ...pairs.slice(0, 2),
                    { id: 'x', left: SOURCE[2], right: null },
                ],
                'similarity'
            )
        ).toBeNull();
        const affine = fitAlignment(pairs, 'affine')!;
        expect(affine.exact).toBe(true);
        expect(affine.rms).toBeCloseTo(0, 6);
        expect(fitAlignment(pairs, 'similarity')!.exact).toBe(false);
    });

    it('formats errors in µm, mm or px', () => {
        expect(formatAlignmentError(8.24, 'um')).toBe('8.2 µm');
        expect(formatAlignmentError(42.6, 'um')).toBe('43 µm');
        expect(formatAlignmentError(1240, 'um')).toBe('1.24 mm');
        expect(formatAlignmentError(15.4, 'px')).toBe('15 px');
    });
});

describe('mapping annotation geometry', () => {
    const t = similarity(90, 2, 1000, 0);

    it('maps a rectangle to a rotated polygon and keeps its area scaled', () => {
        const shape = mapShape(
            { kind: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
            t
        );
        expect(shape.kind).toBe('polygon');
        const points = (shape as { points: WsiPoint[] }).points;
        expect(points[0].x).toBeCloseTo(1000, 6);
        expect(points[0].y).toBeCloseTo(0, 6);
        expect(points[1].x).toBeCloseTo(1000, 6);
        expect(points[1].y).toBeCloseTo(200, 6);
        const parsed = parseAnnotationShape({
            type: 'SvgSelector',
            value: shapeSelectorSvg(shape),
        });
        expect(parsed!.kind).toBe('polygon');
    });

    it('keeps holes and parts of a multipolygon, mapped ring by ring', () => {
        const square = (x: number, y: number, size: number) => [
            { x, y },
            { x: x + size, y },
            { x: x + size, y: y + size },
            { x, y: y + size },
        ];
        const region = [
            [square(0, 0, 100), square(40, 40, 20)],
            [square(200, 0, 30)],
        ];
        const parsed = parseAnnotationShape({
            type: 'SvgSelector',
            value: regionSelectorSvg(region),
        })!;
        const mapped = mapShape(parsed, t);
        expect(mapped.kind).toBe('multipolygon');
        const polygons = (mapped as { polygons: WsiPoint[][][] }).polygons;
        expect(polygons).toHaveLength(2);
        expect(polygons[0]).toHaveLength(2);
        // Area scales by s² = 4: (10000 − 400 + 900) · 4.
        expect(regionArea(polygons)).toBeCloseTo((10000 - 400 + 900) * 4, 3);
        const reparsed = parseAnnotationShape({
            type: 'SvgSelector',
            value: shapeSelectorSvg(mapped),
        })!;
        expect(reparsed.kind).toBe('multipolygon');
        expect(
            regionArea((reparsed as { polygons: WsiPoint[][][] }).polygons)
        ).toBeCloseTo(42000, 0);
    });

    it('maps points, lines and polylines in kind, and an ellipse to a polygon', () => {
        const point = mapShape({ kind: 'point', x: 10, y: 0 }, t) as {
            kind: string;
            x: number;
            y: number;
        };
        expect(point.kind).toBe('point');
        expect(point.x).toBeCloseTo(1000, 6);
        expect(point.y).toBeCloseTo(20, 6);
        const line = mapShape(
            {
                kind: 'line',
                points: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                ],
            },
            t
        );
        expect(line.kind).toBe('line');
        expect(shapeSelectorSvg(line)).toBe(
            '<svg><line x1="1000" y1="0" x2="1000" y2="20" /></svg>'
        );
        expect(
            mapShape(
                {
                    kind: 'polyline',
                    points: [
                        { x: 0, y: 0 },
                        { x: 1, y: 1 },
                        { x: 2, y: 0 },
                    ],
                },
                t
            ).kind
        ).toBe('polyline');
        const ellipse = mapShape(
            { kind: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5 },
            t
        );
        expect(ellipse.kind).toBe('polygon');
        expect(shapeSelectorSvg({ kind: 'point', x: 1.234, y: 5 })).toBe(
            '<svg><circle cx="1.23" cy="5" r="0" /></svg>'
        );
    });
});

describe('pairing by match level', () => {
    const he = makeSlide({ slide_key: 'aaaa00000001', stain_kind: 'hne' });
    const ttf1 = makeSlide({
        slide_key: 'aaaa00000002',
        stain_kind: 'ihc',
        stain_name: 'TTF-1',
        stain_group: 'IHC',
    });
    const heRecut = makeSlide({
        slide_key: 'aaaa00000003',
        stain_kind: 'hne',
        stain_group: 'H&E (Recut)',
    });
    const otherBlockHe = makeSlide({
        slide_key: 'aaaa00000004',
        stain_kind: 'hne',
        block_label: 'A2',
        block_number: '2',
    });
    const otherBlockIhc = makeSlide({
        slide_key: 'aaaa00000005',
        stain_kind: 'ihc',
        stain_name: 'Ki-67',
        block_label: 'A2',
        block_number: '2',
    });
    const otherPart = makeSlide({
        slide_key: 'aaaa00000006',
        stain_kind: 'ihc',
        stain_name: 'PD-L1',
        part_number: '2',
    });
    const unmatched = makeSlide({
        slide_key: 'aaaa00000007',
        stain_kind: 'hne',
    });
    const notServable = makeSlide({
        slide_key: 'aaaa00000008',
        stain_kind: 'ihc',
        can_serve_tiles: false,
    });
    const sample: Sample = {
        sample_id: 'S-1',
        parts: [
            makePart([
                makeBlock([he, heRecut, ttf1, notServable], '1'),
                makeBlock([otherBlockHe, otherBlockIhc], '2'),
            ]),
            { ...makePart([makeBlock([otherPart])]), part_number: '2' },
        ],
    };
    const hierarchy = makeHierarchy([
        { sample_id: 'UNMATCHED', parts: [makePart([makeBlock([unmatched])])] },
        sample,
    ]);

    it('offers the same block first, the counterpart stain leading', () => {
        const keys = pairingCandidates(hierarchy, he).map(
            c => `${c.level}:${c.slide.slide_key.slice(-1)}`
        );
        expect(keys).toEqual([
            'block:2', // IHC TTF-1, same block
            'block:3', // H&E recut, same block
            'part:5', // IHC Ki-67, other block
            'part:4',
            'patient:6', // other part of the sample
            'patient:7', // unmatched, last
        ]);
    });

    it('defaults an IHC slide to its same-block H&E', () => {
        expect(defaultPairCandidate(hierarchy, ttf1)!.slide.slide_key).toBe(
            he.slide_key
        );
        expect(defaultPairCandidate(hierarchy, he)!.slide.slide_key).toBe(
            ttf1.slide_key
        );
        expect(
            pairingCandidates(hierarchy, ttf1).every(c => c.slide !== ttf1)
        ).toBe(true);
    });

    it('groups the candidates for the picker', () => {
        const groups = groupPairCandidates(pairingCandidates(hierarchy, he));
        expect(groups.map(g => g.group)).toEqual([
            'Same block',
            'Same part',
            'S-1 · Part 2',
            'Unmatched slides',
        ]);
    });

    it('names where a slide was cut from, without a doubled "Block"', () => {
        expect(slideSpecimenLabel(otherPart)).toBe('Part 2 · Block A1');
        expect(
            slideSpecimenLabel(
                makeSlide({ part_number: '5', block_label: 'Block 1' })
            )
        ).toBe('Part 5 · Block 1');
    });

    it('names stains as the slide list does', () => {
        expect(slideStainLabel(ttf1)).toBe('IHC TTF-1');
        expect(slideStainLabel(heRecut)).toBe('H&E recut');
        expect(
            slideStainLabel(makeSlide({ stain_group: 'H&E (Initial)' }))
        ).toBe('H&E');
    });

    it('offers nothing without a hierarchy', () => {
        expect(pairingCandidates(null, he)).toEqual([]);
        expect(defaultPairCandidate(makeHierarchy([]), he)).toBeUndefined();
    });
});

describe('alignment persistence', () => {
    beforeEach(() => window.localStorage.clear());

    const pairs: WsiAlignmentPair[] = [
        { id: 'p1', left: { x: 1, y: 2 }, right: { x: 3, y: 4 } },
        { id: 'p2', left: { x: 5, y: 6 }, right: null },
    ];

    it('keeps a pair under both slide keys, and reads it either way round', () => {
        expect(alignmentStorageKey('bbb', 'aaa')).toBe(
            alignmentStorageKey('aaa', 'bbb')
        );
        expect(
            saveAlignment('bbb', 'aaa', {
                pairs,
                model: 'affine',
                anchor: { left: { x: 0, y: 0 }, right: { x: 9, y: 9 } },
            })
        ).toBe(true);
        expect(loadAlignment('bbb', 'aaa')).toEqual({
            pairs,
            model: 'affine',
            anchor: { left: { x: 0, y: 0 }, right: { x: 9, y: 9 } },
        });
        // Swapped panes: left and right swap too.
        expect(loadAlignment('aaa', 'bbb')).toEqual({
            pairs: [
                { id: 'p1', left: { x: 3, y: 4 }, right: { x: 1, y: 2 } },
                { id: 'p2', left: null, right: { x: 5, y: 6 } },
            ],
            model: 'affine',
            anchor: { left: { x: 9, y: 9 }, right: { x: 0, y: 0 } },
        });
    });

    it('removes an empty alignment, and clears one', () => {
        saveAlignment('a', 'b', { pairs, model: 'similarity', anchor: null });
        saveAlignment('a', 'b', {
            pairs: [],
            model: 'similarity',
            anchor: null,
        });
        expect(window.localStorage.getItem(alignmentStorageKey('a', 'b'))).toBe(
            null
        );
        saveAlignment('a', 'b', { pairs, model: 'similarity', anchor: null });
        clearAlignment('a', 'b');
        expect(loadAlignment('a', 'b')).toBeNull();
    });

    it('ignores what it cannot read, and survives storage that throws', () => {
        window.localStorage.setItem(alignmentStorageKey('a', 'b'), '{oops');
        expect(loadAlignment('a', 'b')).toBeNull();
        window.localStorage.setItem(
            alignmentStorageKey('a', 'b'),
            JSON.stringify({ v: 2, pairs: [] })
        );
        expect(loadAlignment('a', 'b')).toBeNull();
        const getItem = jest
            .spyOn(Storage.prototype, 'getItem')
            .mockImplementation(() => {
                throw new Error('denied');
            });
        const setItem = jest
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new Error('quota');
            });
        try {
            expect(loadAlignment('a', 'b')).toBeNull();
            expect(
                saveAlignment('a', 'b', {
                    pairs,
                    model: 'similarity',
                    anchor: null,
                })
            ).toBe(false);
        } finally {
            getItem.mockRestore();
            setItem.mockRestore();
        }
    });
});

describe('view sync', () => {
    const left = { width: 40000, height: 30000, mpp: { x: 0.25, y: 0.25 } };
    const right = { width: 20000, height: 15000, mpp: { x: 0.5, y: 0.5 } };

    it('follows the same relative place and share of the width without an alignment', () => {
        const mapping = leftToRightMapping('relative', { left, right })!;
        const pose = followerPose(
            {
                center: { x: 20000, y: 15000 },
                zoom: 0.1,
                rotation: 0,
                flip: false,
            },
            mapping
        );
        expect(pose.center).toEqual({ x: 10000, y: 7500 });
        expect(pose.zoom).toBeCloseTo(0.2, 9);
    });

    it('follows by µm from an anchor', () => {
        const mapping = leftToRightMapping('anchor', {
            left,
            right,
            anchor: { left: { x: 1000, y: 1000 }, right: { x: 5000, y: 200 } },
        })!;
        // 400 left px = 100 µm = 200 right px from the anchors.
        const pose = followerPose(
            { center: { x: 1400, y: 1000 }, zoom: 1, rotation: 0, flip: false },
            mapping
        );
        expect(pose.center.x).toBeCloseTo(5200, 9);
        expect(pose.center.y).toBeCloseTo(200, 9);
        // The same µm per screen pixel: half the zoom on the coarser scan.
        expect(pose.zoom).toBeCloseTo(2, 9);
        expect(leftToRightMapping('anchor', { left, right })).toBeNull();
    });

    it('maps centre, zoom and rotation through an alignment, both ways', () => {
        const transform = similarity(30, 0.5, 100, 200);
        const fit = fitAlignment(
            SOURCE.map((p, i) => ({
                id: `p${i}`,
                left: p,
                right: applyAffine(transform, p),
            })),
            'similarity'
        );
        const mapping = leftToRightMapping('aligned', { left, right, fit })!;
        const leader = {
            center: { x: 3000, y: 4000 },
            zoom: 0.5,
            rotation: 10,
            flip: false,
        };
        const follower = followerPose(leader, mapping);
        const expected = applyAffine(transform, leader.center);
        expect(follower.center.x).toBeCloseTo(expected.x, 6);
        expect(follower.center.y).toBeCloseTo(expected.y, 6);
        expect(follower.zoom).toBeCloseTo(1, 6);
        expect(follower.rotation).toBeCloseTo(340, 6);
        // The right pane leading maps back to the leader's pose.
        const back = followerPose(follower, invertMapping(mapping)!);
        expect(back.center.x).toBeCloseTo(leader.center.x, 6);
        expect(back.center.y).toBeCloseTo(leader.center.y, 6);
        expect(back.zoom).toBeCloseTo(leader.zoom, 6);
        expect(back.rotation).toBeCloseTo(leader.rotation, 6);
    });

    it("keeps a mirrored section mirrored, in the leader's orientation", () => {
        const transform = similarity(30, 1, 0, 0, true);
        const mapping = {
            transform,
            ...decomposeAffine(transform),
        };
        const pose = followerPose(
            { center: { x: 10, y: 20 }, zoom: 1, rotation: 0, flip: false },
            mapping
        );
        expect(pose.flip).toBe(false);
        const expected = applyAffine(transform, { x: 10, y: 20 });
        expect(pose.center.x).toBeCloseTo(expected.x, 9);
        expect(pose.center.y).toBeCloseTo(expected.y, 9);
        // R(ρ − θ − 180°)·s·R(θ)·diag(1, −1) = s·R(ρ)·diag(−1, 1): the
        // leader's orientation, mirrored left to right.
        expect(pose.rotation).toBeCloseTo(150, 6);
    });

    it('turns the short way round', () => {
        expect(nearestTurn(350, 10)).toBe(-10);
        expect(nearestTurn(10, 350)).toBe(370);
        expect(nearestTurn(90, 0)).toBe(90);
    });
});
