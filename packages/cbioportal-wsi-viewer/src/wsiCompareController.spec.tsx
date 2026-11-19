/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { WsiAnnotationPanel } from './wsiAnnotationControls';
import { WsiViewerState } from './wsiViewerState';
import { WsiAnnotation } from './wsiViewerTypes';
import { WsiComparePane, WsiCompareController } from './wsiCompareController';
import { WsiAlignPanel } from './wsiCompareView';
import { alignmentStorageKey } from './wsiCompareStore';
import { makeSlide, makeTileMetadata } from './wsiTestFixtures';
import {
    attachTestController,
    flush,
    serviceRow,
    TEST_SLIDE_KEY,
    TestAnnotationService,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

class Point {
    constructor(public x: number, public y: number) {}
}
const OSD = { Point };

/**
 * A stand-in OpenSeadragon viewer of a `width`-pixel-wide image in a
 * `container`-pixel-wide view: viewport units are image widths, its view
 * moves at once, and it raises `pan`, `zoom`, `rotate` and `flip` as
 * OpenSeadragon does.
 */
function fakeViewer(width: number, container = 500) {
    const handlers = new Map<string, Array<(event: any) => void>>();
    const raise = (name: string, event: any = {}) =>
        (handlers.get(name) || []).forEach(handler => handler(event));
    const view = { cx: 0.5, cy: 0.5, zoom: 1, rotation: 0, flip: false };
    const viewport = {
        getCenter: () => new Point(view.cx, view.cy),
        getZoom: () => view.zoom,
        getRotation: () => view.rotation,
        getFlip: () => view.flip,
        setFlip: (flip: boolean) => {
            view.flip = flip;
            raise('flip', { flipped: flip });
        },
        setRotation: (degrees: number, immediately: boolean) => {
            view.rotation = degrees;
            raise('rotate', { degrees, immediately });
        },
        zoomTo: (zoom: number, _ref: unknown, immediately: boolean) => {
            view.zoom = zoom;
            raise('zoom', { zoom, immediately });
        },
        panTo: (center: Point, immediately: boolean) => {
            view.cx = center.x;
            view.cy = center.y;
            raise('pan', { center, immediately });
        },
        viewportToImageCoordinates: (p: Point) =>
            new Point(p.x * width, p.y * width),
        imageToViewportCoordinates: (p: Point) =>
            new Point(p.x / width, p.y / width),
        viewportToImageZoom: (zoom: number) => (zoom * container) / width,
        imageToViewportZoom: (zoom: number) => (zoom * width) / container,
        pixelFromPoint: (p: Point) =>
            new Point(
                (p.x - view.cx) * container * view.zoom + container / 2,
                (p.y - view.cy) * container * view.zoom + container / 2
            ),
        pointFromPixel: (p: Point) =>
            new Point(
                (p.x - container / 2) / (container * view.zoom) + view.cx,
                (p.y - container / 2) / (container * view.zoom) + view.cy
            ),
    };
    return {
        view,
        viewport,
        world: { getItemCount: () => 1 },
        addHandler: (name: string, handler: (event: any) => void) =>
            handlers.set(name, [...(handlers.get(name) || []), handler]),
        removeHandler: (name: string, handler: (event: any) => void) =>
            handlers.set(
                name,
                (handlers.get(name) || []).filter(item => item !== handler)
            ),
        raise,
        /** The image point at the view's centre. */
        center: () => ({ x: view.cx * width, y: view.cy * width }),
        /** Screen pixels per image pixel. */
        scale: () => (view.zoom * container) / width,
    };
}

/** A pane whose annotation controller is a stand-in recording its calls. */
function stubPane(
    slideKey: string,
    width: number,
    annotations: Partial<Record<string, unknown>> = {}
): WsiComparePane {
    const state = new WsiViewerState();
    act(() => {
        state.selectedSlide = makeSlide({ slide_key: slideKey });
        state.selectedMeta = makeTileMetadata({
            dimensions: { width, height: width },
            mpp: { x: 0.25, y: 0.25 },
        });
    });
    return {
        state,
        annotations: {
            setPaneActive: jest.fn(),
            setPointerSuspended: jest.fn(),
            selectedAnnotations: [],
            annotationsByLayer: new Map(),
            shapeOf: () => null,
            currentSlideKey: slideKey,
            canEdit: true,
            ...annotations,
        } as any,
    };
}

/** Pairs placing left points onto the right slide by `map`. */
function placePairs(
    compare: WsiCompareController,
    map: (p: { x: number; y: number }) => { x: number; y: number },
    points = [
        { x: 1000, y: 1000 },
        { x: 3000, y: 1500 },
        { x: 2000, y: 3500 },
    ]
) {
    points.forEach(point => {
        compare.placePoint('left', point);
        compare.placePoint('right', map(point));
    });
}

describe('Side by side: sync, alignment and pane activity', () => {
    beforeEach(() => window.localStorage.clear());

    function setup(leftWidth = 4000, rightWidth = 2000) {
        const left = stubPane('aaaaaaaaaaaa', leftWidth);
        const right = stubPane('bbbbbbbbbbbb', rightWidth);
        const compare = new WsiCompareController(side =>
            side === 'left' ? left : right
        );
        compare.setOpen(true);
        compare.refreshPair();
        const leftViewer = fakeViewer(leftWidth);
        const rightViewer = fakeViewer(rightWidth);
        compare.attachViewer('left', leftViewer, OSD);
        compare.attachViewer('right', rightViewer, OSD);
        return { compare, left, right, leftViewer, rightViewer };
    }

    it('makes one pane active: only it takes keys and tools', () => {
        const { compare, left, right } = setup();
        expect(left.annotations.setPaneActive).toHaveBeenLastCalledWith(true);
        expect(right.annotations.setPaneActive).toHaveBeenLastCalledWith(false);
        compare.setActiveSide('right');
        expect(left.annotations.setPaneActive).toHaveBeenLastCalledWith(false);
        expect(right.annotations.setPaneActive).toHaveBeenLastCalledWith(true);
        expect(compare.leader).toBe('right');
        compare.setOpen(false);
        expect(left.annotations.setPaneActive).toHaveBeenLastCalledWith(true);
    });

    it('locked: the leading pane moves the other by relative position; unlocked it does not', () => {
        const { compare, leftViewer, rightViewer } = setup();
        // Left leads: the right shows the same place and share of width.
        leftViewer.viewport.panTo(new Point(0.25, 0.75), true);
        expect(rightViewer.center()).toEqual({ x: 500, y: 1500 });
        leftViewer.viewport.zoomTo(4, null, true);
        expect(rightViewer.scale()).toBeCloseTo(leftViewer.scale() * 2, 9);
        // The follower's own events do not echo back.
        expect(leftViewer.center()).toEqual({ x: 1000, y: 3000 });
        // The right leads after a press in its pane.
        compare.noteInteraction('right');
        rightViewer.viewport.panTo(new Point(0.5, 0.5), true);
        expect(leftViewer.center()).toEqual({ x: 2000, y: 2000 });
        compare.setLocked(false);
        rightViewer.viewport.panTo(new Point(0.1, 0.1), true);
        expect(leftViewer.center()).toEqual({ x: 2000, y: 2000 });
        // Locking again syncs from the active pane (left).
        compare.setLocked(true);
        expect(rightViewer.center()).toEqual({ x: 1000, y: 1000 });
    });

    it('follows by µm from an anchor', () => {
        const { compare, leftViewer, rightViewer } = setup(4000, 4000);
        leftViewer.viewport.panTo(new Point(0.25, 0.25), true);
        compare.setLocked(false);
        rightViewer.viewport.panTo(new Point(0.5, 0.5), true);
        // The same tissue in both centres: set the anchor, then lock.
        compare.setAnchorHere();
        compare.setLocked(true);
        expect(rightViewer.center()).toEqual({ x: 2000, y: 2000 });
        expect(compare.syncMode).toBe('anchor');
        expect(compare.anchor).toEqual({
            left: { x: 1000, y: 1000 },
            right: { x: 2000, y: 2000 },
        });
        compare.noteInteraction('left');
        leftViewer.viewport.panTo(new Point(0.3, 0.25), true);
        expect(rightViewer.center().x).toBeCloseTo(2200, 9);
        expect(rightViewer.center().y).toBeCloseTo(2000, 9);
    });

    it('fits 3 pairs, then maps centre, zoom and rotation through the alignment', () => {
        const { compare, leftViewer, rightViewer } = setup(4000, 4000);
        // The right slide is the left turned 90° clockwise at half scale.
        const toRight = (p: { x: number; y: number }) => ({
            x: 3000 - p.y / 2,
            y: 500 + p.x / 2,
        });
        compare.placePoint('left', { x: 1000, y: 1000 });
        expect(compare.pendingSide).toBe('right');
        compare.placePoint('right', toRight({ x: 1000, y: 1000 }));
        expect(compare.fit).toBeNull();
        placePairs(compare, toRight, [
            { x: 3000, y: 1500 },
            { x: 2000, y: 3500 },
        ]);
        const fit = compare.fit!;
        expect(fit.count).toBe(3);
        expect(fit.rms).toBeLessThan(1e-6);
        expect(compare.syncMode).toBe('aligned');
        compare.noteInteraction('left');
        leftViewer.viewport.panTo(new Point(0.5, 0.25), true);
        const expected = toRight({ x: 2000, y: 1000 });
        expect(rightViewer.center().x).toBeCloseTo(expected.x, 6);
        expect(rightViewer.center().y).toBeCloseTo(expected.y, 6);
        expect(rightViewer.scale()).toBeCloseTo(leftViewer.scale() * 2, 6);
        expect(rightViewer.view.rotation).toBeCloseTo(-90, 6);
        // Kept for the pair, read back with the slides either way round.
        const stored = window.localStorage.getItem(
            alignmentStorageKey('aaaaaaaaaaaa', 'bbbbbbbbbbbb')
        );
        expect(JSON.parse(stored!).pairs).toHaveLength(3);
    });

    it('edits, deletes, clears and resets points', () => {
        const { compare } = setup();
        const toRight = (p: { x: number; y: number }) => ({
            x: p.x / 2,
            y: p.y / 2,
        });
        placePairs(compare, toRight);
        act(() => compare.setPanelOpen(true));
        expect(compare.placing).toBe(false);
        const [first] = compare.pairs;
        compare.movePoint(first.id, 'right', { x: 520, y: 500 });
        expect(compare.fit!.residuals[first.id]).toBeGreaterThan(1);
        compare.deletePair(compare.pairs[2].id);
        expect(compare.fit).toBeNull();
        compare.clearPoints();
        expect(compare.pairs).toEqual([]);
        compare.resetPoints();
        expect(compare.pairs).toHaveLength(3);
        expect(compare.fit!.rms).toBeLessThan(1e-6);
    });

    it('places a point on a quick click while placing, and lets a drag pan', () => {
        const { compare, leftViewer } = setup();
        act(() => compare.setPanelOpen(true));
        expect(compare.placing).toBe(true);
        const event = {
            quick: true,
            position: new Point(250, 250),
            preventDefaultAction: false,
        };
        leftViewer.raise('canvas-click', event);
        expect(event.preventDefaultAction).toBe(true);
        expect(compare.pairs[0].left).toEqual({ x: 2000, y: 2000 });
        leftViewer.raise('canvas-click', {
            quick: false,
            position: new Point(10, 10),
        });
        expect(compare.pairs).toHaveLength(1);
    });
});

describe('Side by side: copying annotations through the alignment', () => {
    beforeAll(() => loadAnnotorious());
    let cleanup: Array<() => void> = [];
    beforeEach(() => {
        jest.restoreAllMocks();
        window.localStorage.clear();
    });
    afterEach(() => {
        cleanup.forEach(run => run());
        cleanup = [];
    });

    const SOURCE_KEY = 'aaaaaaaaaaaa';
    const holedSquare: WsiAnnotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: 'src-1',
        body: [
            { type: 'TextualBody', value: 'Tumor 1', purpose: 'commenting' },
        ],
        target: {
            source: SOURCE_KEY,
            selector: {
                type: 'SvgSelector',
                value:
                    '<svg><g><path fill-rule="evenodd" d="M 0,0 L 100,0 L 100,100 L 0,100 Z M 40,40 L 60,40 L 60,60 L 40,60 Z" /></g></svg>',
            },
        },
        layerName: 'Tumor',
        color: '#e03131',
        note: 'check the margin',
        provenance: { source: 'model', model: 'luad-patterns' },
    };

    async function setup() {
        const service = new TestAnnotationService([
            serviceRow('mine', '10,10,5,5'),
        ]).install();
        const harness = await attachTestController(service, {
            mpp: { x: 0.5, y: 0.5 },
        });
        cleanup.push(harness.cleanup);
        const { controller } = harness;
        const left = stubPane(SOURCE_KEY, 4000, {
            selectedAnnotations: [holedSquare],
            annotationsByLayer: new Map([['Tumor', [holedSquare]]]),
            shapeOf: (annotation: WsiAnnotation) =>
                annotation.id === 'src-1'
                    ? require('./wsiAnnotationGeometryUtils').parseAnnotationShape(
                          annotation.target.selector
                      )
                    : null,
        });
        const state = new WsiViewerState();
        act(() => {
            state.selectedSlide = makeSlide({ slide_key: TEST_SLIDE_KEY });
            state.selectedMeta = makeTileMetadata({
                dimensions: { width: 4000, height: 4000 },
                mpp: { x: 0.5, y: 0.5 },
            });
        });
        const right: WsiComparePane = { state, annotations: controller };
        const compare = new WsiCompareController(side =>
            side === 'left' ? left : right
        );
        compare.setOpen(true);
        compare.refreshPair();
        // A shift of (1000, 500) with a 2-pixel error on the third pair.
        const shift = (p: { x: number; y: number }) => ({
            x: p.x + 1000,
            y: p.y + 500,
        });
        placePairs(compare, shift, [
            { x: 0, y: 0 },
            { x: 1000, y: 0 },
        ]);
        compare.placePoint('left', { x: 0, y: 1000 });
        compare.placePoint('right', { x: 1002, y: 1500 });
        return { service, compare, controller, harness };
    }

    it('copies a holed AI region as a new manual annotation, transferred and unverified, in one undo step', async () => {
        const { service, compare, controller } = await setup();
        expect(compare.transferChoices).toEqual({
            selected: 1,
            layers: [{ layer: 'Tumor', count: 1 }],
        });
        expect(compare.transferUnavailable).toBeNull();
        let copied = 0;
        await act(async () => {
            copied = await compare.transfer({ kind: 'selected' });
        });
        expect(copied).toBe(1);
        const batch = service.calls.find(call =>
            call.path.endsWith('/annotations/batch')
        )!;
        expect(batch.body.annotations).toHaveLength(1);
        const sent = batch.body.annotations[0];
        expect(sent.body).toMatchObject({
            label: 'Tumor 1',
            layer_name: 'Tumor',
            comment: 'check the margin',
        });
        const provenance = sent.body.provenance;
        expect(provenance).toMatchObject({
            source: 'manual',
            operation: 'transfer',
            transferred_from: { slide_key: SOURCE_KEY, annotation_id: 'src-1' },
            transform_model: 'similarity',
            verified: false,
            derived_from_ai: true,
        });
        // The error of the fit, in µm of the target slide.
        expect(provenance.transform_residual_um).toBeGreaterThan(0);
        expect(provenance.transform_residual_um).toBeLessThan(1);
        // The hole is kept, shifted with the outer ring.
        expect(sent.target.selector.value).toContain('fill-rule="evenodd"');
        expect(sent.target.selector.value).toMatch(/M 1000(\.\d+)?,500/);
        const copy = controller.annotations.find(
            item => item.provenance?.operation === 'transfer'
        )!;
        expect(controller.shapeOf(copy)!.kind).toBe('multipolygon');
        expect(compare.activeSide).toBe('right');
        expect(compare.message).toContain('Copied 1 annotation to the right');
        expect(controller.undoLabel).toBe('Undo transfer of 1 annotation');

        // Shown as transferred and AI, edited; the creator may verify it.
        render(<WsiAnnotationPanel controller={controller} />);
        expect(
            screen.getByTestId(`annotation-transfer-badge-${copy.id}`)
                .textContent
        ).toContain('Transferred · unverified');
        expect(
            screen.getByTestId(`annotation-ai-badge-${copy.id}`).textContent
        ).toContain('AI, edited');
        await act(async () => {
            fireEvent.click(screen.getByTestId(`verify-transfer-${copy.id}`));
        });
        await flush();
        const put = service.calls.find(
            call => call.method === 'PUT' && call.path.endsWith(copy.id)
        )!;
        expect(put.body.body.provenance).toMatchObject({
            verified: true,
            verified_by: 'me',
        });
        expect(
            screen.getByTestId(`annotation-transfer-badge-${copy.id}`)
                .textContent
        ).toContain('Transferred · verified');
        expect(screen.queryByTestId(`verify-transfer-${copy.id}`)).toBeNull();

        // Undo removes the copy; redo saves it again with its provenance.
        await act(async () => {
            await controller.undo();
        });
        expect(
            controller.annotations.some(
                item => item.provenance?.operation === 'transfer'
            )
        ).toBe(false);
        await act(async () => {
            await controller.redo();
        });
        const again = controller.annotations.find(
            item => item.provenance?.operation === 'transfer'
        )!;
        expect(again.provenance).toMatchObject({
            transferred_from: { slide_key: SOURCE_KEY, annotation_id: 'src-1' },
        });
    });

    it('copies nothing without an alignment, and Reset brings the points back', async () => {
        const { compare } = await setup();
        act(() => compare.setPanelOpen(true));
        compare.clearPoints();
        expect(compare.transferUnavailable).toMatch(/at least 3 point pairs/);
        expect(await compare.transfer({ kind: 'selected' })).toBe(0);
        compare.resetPoints();
        expect(compare.fit).not.toBeNull();
    });

    it('shows the residuals, the error and the copy choices in the panel', async () => {
        const { compare } = await setup();
        act(() => compare.setPanelOpen(true));
        render(<WsiAlignPanel compare={compare} />);
        expect(screen.getByTestId('wsi-compare-rms').textContent).toContain(
            'µm'
        );
        expect(screen.getByTestId('wsi-compare-pairs').children).toHaveLength(
            3
        );
        expect(
            screen.getByRole('button', { name: 'Delete point pair 2' })
        ).toBeTruthy();
        expect(
            screen.getByTestId('wsi-compare-copy-layer-Tumor').textContent
        ).toContain('Layer Tumor (1)');
        fireEvent.click(
            screen.getByRole('button', { name: 'Delete point pair 2' })
        );
        expect(compare.pairs).toHaveLength(2);
        expect(screen.getByTestId('wsi-compare-copy').textContent).toContain(
            'Place at least 3 point pairs'
        );
    });
});

describe('Side by side: the inactive pane takes no keys', () => {
    it('sends Ctrl+Z and H to the active pane only, with two viewers listening', async () => {
        const service = new TestAnnotationService([
            serviceRow('a1', '10,10,5,5'),
            serviceRow('b1', '30,30,5,5'),
        ]).install();
        const first = await attachTestController(service);
        const second = await attachTestController(service);
        const left = first.controller;
        const right = second.controller;
        await act(async () => {
            await left.removeAnnotation('a1');
        });
        await act(async () => {
            await right.removeAnnotation('b1');
        });
        expect(left.canUndo).toBe(true);
        expect(right.canUndo).toBe(true);
        // Side by side with the left pane active.
        act(() => right.setPaneActive(false));
        first.press('z', { ctrlKey: true });
        await flush();
        expect(left.canUndo).toBe(false);
        expect(right.canUndo).toBe(true);
        first.press('h');
        expect(left.hideAll).toBe(true);
        expect(right.hideAll).toBe(false);
        // Now the right pane.
        act(() => {
            left.setPaneActive(false);
            right.setPaneActive(true);
        });
        first.press('h');
        expect(left.hideAll).toBe(true);
        expect(right.hideAll).toBe(true);
        first.press('z', { ctrlKey: true });
        await flush();
        expect(right.canUndo).toBe(false);
        expect(left.canRedo).toBe(true);
        expect(
            service.writes().filter(([method]) => method === 'POST')
        ).toHaveLength(2);
        first.cleanup();
        second.cleanup();
    });

    beforeAll(() => loadAnnotorious());
    afterEach(() => jest.restoreAllMocks());

    it('ignores tool shortcuts and undo while the other pane is active', async () => {
        const service = new TestAnnotationService([]).install();
        const harness = await attachTestController(service);
        const { controller, press } = harness;
        act(() => controller.setAnnotating(true));
        press('l');
        expect(controller.activeTool).toBe('line');
        act(() => controller.setPaneActive(false));
        expect(controller.activeTool).toBeNull();
        expect(controller.toolShortcutsActive).toBe(false);
        press('r');
        expect(controller.activeTool).toBeNull();
        act(() => controller.setPaneActive(true));
        press('r');
        expect(controller.activeTool).toBe('rectangle');
        harness.cleanup();
    });
});
