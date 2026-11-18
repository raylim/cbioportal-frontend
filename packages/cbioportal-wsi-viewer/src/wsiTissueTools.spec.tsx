/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WsiAnnotationToolbar, SHORTCUT_HELP } from './wsiAnnotationToolbar';
import { WsiTissueBar, WsiTissueOverlay } from './wsiTissueOverlay';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import {
    parseAnnotationShape,
    shapeRegion,
} from './wsiAnnotationGeometryUtils';
import { regionArea, regionBounds } from './wsiAnnotationShapeOps';
import {
    attachTestController,
    flush,
    serviceRow,
    TestAnnotationService,
} from './wsiAnnotationTestService';
import { loadTissueTools } from './wsiTissueLoader';
import {
    SLIDE_PINK,
    SLIDE_PURPLE,
    SLIDE_BROWN,
    testSlideHost,
    TestDisk,
} from './wsiTissueTestSlide';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

// The synthetic slide is rendered pixel by pixel in JavaScript.
jest.setTimeout(60_000);

/**
 * A 2048-pixel slide: pink tissue (radius 700) holding a lighter pink disk
 * (radius 150, 16.5 from it in color distance), a purple disk (radius 200) and a brown one
 * (radius 120).
 */
const LIGHT_PINK: [number, number, number] = [248, 205, 230];
const DISKS: TestDisk[] = [
    { x: 1024, y: 1024, r: 700, color: SLIDE_PINK },
    { x: 1300, y: 800, r: 150, color: LIGHT_PINK },
    { x: 800, y: 1000, r: 200, color: SLIDE_PURPLE },
    { x: 1250, y: 1350, r: 120, color: SLIDE_BROWN },
];
/** Image pixels per screen pixel in the harness (20× at 0.25 µm). */
const SCALE = 2;

const squareSvg = (x: number, y: number, size: number) =>
    `<svg><polygon points="${x},${y} ${x + size},${y} ${x + size},${y +
        size} ${x},${y + size}" /></svg>`;

/** Waits until `condition` holds (the main-thread engine yields per step). */
async function until(condition: () => boolean, tries = 2000) {
    for (let i = 0; i < tries && !condition(); i++) {
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
        });
    }
    expect(condition()).toBe(true);
}

const regionOfSelector = (selector: string) =>
    shapeRegion(
        parseAnnotationShape({ type: 'SvgSelector', value: selector })!
    )!;

describe('Magic wand and smart brush', () => {
    beforeAll(() => Promise.all([loadAnnotorious(), loadTissueTools()]));
    let cleanup: Array<() => void> = [];
    beforeEach(() => {
        jest.restoreAllMocks();
        window.localStorage.clear();
    });
    afterEach(() => {
        cleanup.forEach(run => run());
        cleanup = [];
    });

    async function setup(rows: any[] = []) {
        const service = new TestAnnotationService(rows).install();
        const harness = await attachTestController(service, {
            imagePerScreen: () => SCALE,
            mpp: { x: 0.25, y: 0.25 },
        });
        cleanup.push(harness.cleanup);
        const host = testSlideHost({
            size: 2048,
            disks: DISKS,
            imagePerScreen: SCALE,
            viewX: 0,
            viewY: 0,
            viewWidth: 1024,
            viewHeight: 1024,
        });
        harness.controller.setTissueHost(() => host);
        harness.controller.setAnnotating(true);
        return { service, host, ...harness };
    }

    /** A click at image point (x, y), with modifiers. */
    const click = (
        harness: { pointer: (...args: any[]) => any },
        x: number,
        y: number,
        init: MouseEventInit = {}
    ) => {
        harness.pointer('pointerdown', x / SCALE, y / SCALE, init);
        harness.pointer('pointerup', x / SCALE, y / SCALE, init);
    };

    const outlined = (controller: any, steps: number) => () =>
        !!controller.tissueView &&
        !controller.tissueView.busy &&
        controller.tissueView.steps === steps &&
        controller.tissueView.region.length > 0;

    it('outlines a click, saves it with Enter and undoes the save', async () => {
        const harness = await setup();
        const { controller, service } = harness;
        harness.press('w');
        expect(controller.activeTool).toBe('wand');
        click(harness, 800, 1000);
        await until(outlined(controller, 1));
        expect(controller.tissueView!.source).toBe('screen');
        expect(controller.tissueOutline!.d).toMatch(/^M[\d.]+,[\d.]+L/);
        expect(controller.drawingInProgress).toBe(true);
        expect(service.writes()).toEqual([]);
        harness.press('Enter');
        await until(() => service.writes().length === 1);
        expect(service.writes()).toEqual([['POST', '/wsi/annotations']]);
        const row = Array.from(service.rows.values())[0];
        expect(row.target.selector.value).toMatch(/^<svg><polygon points="/);
        const area = regionArea(regionOfSelector(row.target.selector.value));
        expect(area / (Math.PI * 200 * 200)).toBeGreaterThan(0.96);
        expect(area / (Math.PI * 200 * 200)).toBeLessThan(1.04);
        // Drawn as the toolbar's layer, color and next auto label.
        expect(row.body.layer_name).toBe(controller.activeLayer);
        expect(row.body.color.toLowerCase()).toBe(
            controller.activeColor.toLowerCase()
        );
        expect(controller.tissueView).toBeNull();
        // The wand stays on; the save undoes like any shape.
        expect(controller.activeTool).toBe('wand');
        await act(async () => {
            await controller.undo();
        });
        expect(service.writes()[1][0]).toBe('DELETE');
        expect(service.rows.size).toBe(0);
    });

    it('adds a region with Shift+click and saves both as one multipolygon', async () => {
        const harness = await setup();
        const { controller, service } = harness;
        controller.setTool('wand');
        click(harness, 800, 1000);
        await until(outlined(controller, 1));
        click(harness, 1250, 1350, { shiftKey: true });
        await until(outlined(controller, 2));
        expect(controller.tissueView!.region).toHaveLength(2);
        // Ctrl+Z takes back the Shift+click only.
        harness.press('z', { ctrlKey: true });
        expect(controller.tissueView!.region).toHaveLength(1);
        expect(controller.tissueView!.steps).toBe(1);
        click(harness, 1250, 1350, { shiftKey: true });
        await until(outlined(controller, 2));
        await act(async () => {
            await controller.saveTissueSelection();
        });
        const row = Array.from(service.rows.values())[0];
        expect(row.target.selector.value).toMatch(
            /^<svg><g><path fill-rule="evenodd" d="M [^"]+" \/><path fill-rule="evenodd" d="M /
        );
        expect(regionOfSelector(row.target.selector.value)).toHaveLength(2);
    });

    it('cuts a hole with Alt+click and keeps it in the saved region', async () => {
        const harness = await setup();
        const { controller, service } = harness;
        controller.setTool('wand');
        // At 30 the pink tissue takes in the lighter pink disk.
        controller.setTissueTolerance(30);
        click(harness, 1024, 1500);
        await until(outlined(controller, 1));
        const whole = regionArea(controller.tissueView!.region);
        // Alt+click on the lighter disk, dragged down 48 screen pixels to
        // a tolerance of 6: it selects the lighter disk only and cuts it
        // out. The first click keeps its 30.
        harness.pointer('pointerdown', 1300 / SCALE, 800 / SCALE, {
            altKey: true,
        });
        harness.pointer('pointermove', 1300 / SCALE, 800 / SCALE + 24);
        harness.pointer('pointermove', 1300 / SCALE, 800 / SCALE + 48);
        harness.pointer('pointerup', 1300 / SCALE, 800 / SCALE + 48);
        expect(controller.tissueTolerance).toBe(6);
        await until(
            () =>
                outlined(controller, 2)() &&
                controller.tissueView!.tolerance === 6
        );
        const cut = regionArea(controller.tissueView!.region);
        expect((whole - cut) / (Math.PI * 150 * 150)).toBeGreaterThan(0.9);
        expect((whole - cut) / (Math.PI * 150 * 150)).toBeLessThan(1.1);
        harness.press('Enter');
        await until(() => service.rows.size === 1);
        const region = regionOfSelector(
            Array.from(service.rows.values())[0].target.selector.value
        );
        // The pink part with the purple and brown disks and the cut as holes.
        expect(region).toHaveLength(1);
        expect(region[0]).toHaveLength(4);
    });

    it('changes the tolerance by dragging and scrolling while an outline waits', async () => {
        const harness = await setup();
        const { controller, element } = harness;
        controller.setTool('wand');
        const wheel = (deltaY: number) => {
            const event = new WheelEvent('wheel', {
                deltaY,
                bubbles: true,
                cancelable: true,
            });
            act(() => {
                element.dispatchEvent(event);
            });
            return event;
        };
        // Nothing waits: the wheel zooms as usual.
        expect(wheel(-100).defaultPrevented).toBe(false);
        click(harness, 800, 1000);
        await until(outlined(controller, 1));
        expect(controller.tissueTolerance).toBe(15);
        expect(wheel(-100).defaultPrevented).toBe(true);
        expect(controller.tissueTolerance).toBe(16);
        wheel(100);
        wheel(100);
        expect(controller.tissueTolerance).toBe(14);
        // A press inside the outline starts nothing new; dragging it up
        // 20 screen pixels raises the tolerance by 10.
        harness.pointer('pointerdown', 400, 500);
        harness.pointer('pointermove', 400, 490);
        harness.pointer('pointermove', 400, 480);
        harness.pointer('pointerup', 400, 480);
        expect(controller.tissueTolerance).toBe(24);
        await until(
            () =>
                controller.tissueView?.tolerance === 24 &&
                !controller.tissueView.busy
        );
        expect(controller.tissueView!.steps).toBe(1);
        // Esc discards it; nothing was saved.
        harness.press('Escape');
        expect(controller.tissueView).toBeNull();
        expect(controller.activeTool).toBe('wand');
    });

    it('cuts an outline started with Alt out of the selected region', async () => {
        const harness = await setup([
            serviceRow('mine', squareSvg(600, 800, 400), { creator: 'me' }),
        ]);
        const { controller, service } = harness;
        controller.select(['mine']);
        controller.setTool('wand');
        click(harness, 800, 1000, { altKey: true });
        await until(outlined(controller, 1));
        expect(controller.tissueView!.cut).toBe(true);
        harness.press('Enter');
        await until(() => service.writes().length === 1);
        expect(service.writes()).toEqual([['PUT', '/wsi/annotations/mine']]);
        const region = regionOfSelector(
            service.rows.get('mine').target.selector.value
        );
        // The square less the part of the purple disk inside it.
        expect(regionArea(region)).toBeLessThan(
            400 * 400 - 0.4 * Math.PI * 200 * 200
        );
        expect(controller.undoLabel).toBe('Undo cut');
    });

    it('paints along a tissue edge with the smart brush, stopping at it', async () => {
        const harness = await setup();
        const { controller, service } = harness;
        harness.press('B', { shiftKey: true });
        expect(controller.activeTool).toBe('smartBrush');
        controller.setBrushWidth(50);
        // Just inside the purple disk's left edge (x = 600 at y = 1000).
        harness.pointer('pointerdown', 640 / SCALE, 920 / SCALE);
        for (let y = 940; y <= 1080; y += 20) {
            harness.pointer('pointermove', 640 / SCALE, y / SCALE);
        }
        harness.pointer('pointerup', 640 / SCALE, 1080 / SCALE);
        await until(() => service.writes().length === 1);
        const region = regionOfSelector(
            Array.from(service.rows.values())[0].target.selector.value
        );
        const box = regionBounds(region)!;
        expect(box.minX).toBeGreaterThan(595);
        // 50 µm wide: 200 image pixels, so up to 100 right of the path.
        expect(box.maxX).toBeLessThan(745);
        expect(controller.tissueView).toBeNull();
        expect(controller.activeTool).toBe('smartBrush');
    });

    it('offers both tools in the Outline menu, with the tolerance and help', async () => {
        const harness = await setup();
        const { controller } = harness;
        render(
            <>
                <WsiAnnotationToolbar controller={controller} />
                <WsiTissueOverlay controller={controller} />
                <WsiTissueBar controller={controller} />
            </>
        );
        fireEvent.click(screen.getByTestId('annotation-tool-outline-menu'));
        expect(screen.getByTestId('annotation-tool-wand').textContent).toBe(
            'Magic wandW'
        );
        expect(
            screen.getByTestId('annotation-tool-smartBrush').textContent
        ).toBe('Smart brushShift+B');
        fireEvent.click(screen.getByTestId('annotation-tool-wand'));
        expect(controller.activeTool).toBe('wand');
        const slider = screen.getByTestId('annotation-tissue-tolerance');
        fireEvent.change(slider, { target: { value: '22' } });
        expect(controller.tissueTolerance).toBe(22);
        expect(
            screen.getByTestId('annotation-tissue-tolerance-value').textContent
        ).toBe('22');
        expect(screen.getByTestId('annotation-tissue-hint').textContent).toBe(
            'Click on tissue to outline the region of similar color.'
        );
        click(harness, 800, 1000);
        await until(outlined(controller, 1));
        expect(
            screen.getByTestId('annotation-tissue-tolerance-chip').textContent
        ).toBe('Tolerance 22');
        expect(
            screen
                .getByTestId('annotation-tissue-outline')
                .getAttribute('data-source')
        ).toBe('screen');
        expect(
            screen.getByTestId('annotation-tissue-source').textContent
        ).toMatch(/^\(on-screen pixels, \d+ ms\)$/);
        expect(
            screen.getByTestId('annotation-tissue-hint').textContent
        ).toMatch(/^Enter or double-click saves/);
        // The brush width shows for the smart brush, with the tolerance.
        act(() => controller.setTool('smartBrush'));
        expect(screen.getByTestId('annotation-brush-width')).toBeTruthy();
        expect(screen.getByTestId('annotation-tissue-tolerance')).toBeTruthy();
        const wand = SHORTCUT_HELP.find(
            section => section.title === 'Magic wand'
        )!;
        expect(wand.keys.map(([keys]) => keys.join(' / '))).toEqual([
            'Click',
            'Drag up/down / Scroll',
            'Shift+click',
            'Alt+click',
            'Enter / Double-click',
            'Ctrl+Z',
            'Esc',
        ]);
    });

    it('says when a stroke painted nothing', async () => {
        const harness = await setup();
        const { controller, service } = harness;
        controller.setTool('smartBrush');
        // On the white background with a tolerance of 1, outside the slide.
        controller.setTissueTolerance(1);
        harness.pointer('pointerdown', 5000, 5000);
        harness.pointer('pointermove', 5010, 5000);
        harness.pointer('pointerup', 5020, 5000);
        await until(() => !!controller.tissueMessage);
        expect(controller.tissueMessage).toMatch(/^Nothing like the color/);
        expect(service.writes()).toEqual([]);
        await flush();
    });
});
