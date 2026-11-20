/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { formatRuler, measureRuler } from './wsiAnnotationGeometryUtils';
import { WsiAnnotationOverlay } from './wsiAnnotationOverlay';
import { WsiAnnotationDrawPreview } from './wsiAnnotationControls';
import { WsiAnnotationToolbar } from './wsiAnnotationToolbar';
import { drawAnnotationScene } from './wsiAnnotationSnapshot';
import {
    attachTestController,
    flush,
    serviceRow,
    TestAnnotationService,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

describe('measureRuler', () => {
    it('measures in µm per axis and gives the angle from the horizontal', () => {
        // 300 px right and 400 px up at 0.25 µm/px: 75 by 100 µm.
        const reading = measureRuler(
            { x: 0, y: 400 },
            { x: 300, y: 0 },
            { x: 0.25, y: 0.25 }
        );
        expect(reading.unit).toBe('um');
        expect(reading.length).toBeCloseTo(125);
        expect(reading.angle).toBeCloseTo(53.13, 1);
        expect(formatRuler(reading)).toBe('125 µm · 53°');
        // Unequal scales: x counts double.
        expect(
            measureRuler({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0.5, y: 0.25 })
                .length
        ).toBeCloseTo(50);
        // Direction does not matter; angles stay in [0, 180).
        expect(
            measureRuler({ x: 300, y: 0 }, { x: 0, y: 400 }, null).angle
        ).toBeCloseTo(53.13, 1);
        expect(
            measureRuler({ x: 0, y: 0 }, { x: 10, y: 10 }, null).angle
        ).toBeCloseTo(135);
        expect(
            formatRuler(
                measureRuler(
                    { x: 0, y: 0 },
                    { x: 8000, y: 0 },
                    {
                        x: 0.25,
                        y: 0.25,
                    }
                )
            )
        ).toBe('2.00 mm · 0°');
        expect(
            formatRuler(measureRuler({ x: 0, y: 0 }, { x: 0, y: 50 }, null))
        ).toBe('50 px · 90°');
    });
});

describe('The Measure tool', () => {
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

    async function setup() {
        const service = new TestAnnotationService([
            serviceRow('a1', '10,10,50,50'),
        ]).install();
        const harness = await attachTestController(service, {
            mpp: { x: 0.25, y: 0.25 },
        });
        cleanup.push(harness.cleanup);
        harness.controller.setAnnotating(true);
        return { service, ...harness };
    }

    it('measures with M, shows the reading until the next one or Esc, and saves nothing', async () => {
        const { controller, service, drag, press, pointer } = await setup();
        render(<WsiAnnotationOverlay controller={controller} />);
        press('m');
        expect(controller.activeTool).toBe('measure');

        // While dragging, the reading follows the pointer.
        pointer('pointerdown', 0, 400);
        pointer('pointermove', 150, 200);
        expect(controller.drawPreviewMeasurement).toMatch(/^6\d µm · 53°$/);
        pointer('pointermove', 300, 0);
        pointer('pointerup', 300, 0);
        expect(controller.ruler).toEqual({
            start: { x: 0, y: 400 },
            end: { x: 300, y: 0 },
        });
        expect(screen.getByTestId('annotation-ruler-text').textContent).toBe(
            '125 µm · 53°'
        );
        await flush();
        expect(service.writes()).toEqual([]);
        expect(controller.undoStack).toEqual([]);
        expect(controller.annotations).toHaveLength(1);

        // The tool stays on; a click without a drag keeps the reading.
        pointer('pointerdown', 50, 50);
        pointer('pointerup', 51, 50);
        expect(controller.ruler?.end).toEqual({ x: 300, y: 0 });
        // The next measurement replaces it.
        drag([0, 0], [400, 0]);
        expect(screen.getByTestId('annotation-ruler-text').textContent).toBe(
            '100 µm · 0°'
        );

        // Esc clears it and keeps the tool; Esc again goes to Select.
        press('Escape');
        expect(controller.ruler).toBeNull();
        expect(screen.queryByTestId('annotation-ruler')).toBeNull();
        expect(controller.activeTool).toBe('measure');
        press('Escape');
        expect(controller.activeTool).toBeNull();

        // Never in the GeoJSON export.
        controller.setTool('measure');
        drag([0, 0], [400, 0]);
        expect(controller.ruler).not.toBeNull();
        expect(controller.exportGeoJson('all').features).toHaveLength(1);
        await flush();
        expect(service.writes()).toEqual([]);
    });

    it('follows the slide as it zooms, and clears on another slide', async () => {
        let imagePerScreen = 1;
        const service = new TestAnnotationService([]).install();
        const harness = await attachTestController(service, {
            imagePerScreen: () => imagePerScreen,
            mpp: { x: 0.25, y: 0.25 },
        });
        cleanup.push(harness.cleanup);
        const { controller, drag, viewportChanged } = harness;
        controller.setAnnotating(true);
        controller.setTool('measure');
        render(<WsiAnnotationOverlay controller={controller} />);
        drag([10, 10], [110, 10]);
        expect(controller.rulerOnScreen).toMatchObject({ x1: 10, x2: 110 });
        imagePerScreen = 0.5;
        viewportChanged();
        expect(controller.rulerOnScreen).toMatchObject({ x1: 20, x2: 220 });
        // Its length is in tissue, so it stays.
        expect(controller.rulerOnScreen?.text).toBe('25 µm · 0°');

        controller.beginSlide('ba9876543210');
        expect(controller.ruler).toBeNull();
    });

    it('draws the ruler while dragging and in the downloaded view, even with H', async () => {
        const { controller, pointer, drag, press } = await setup();
        render(
            <>
                <WsiAnnotationDrawPreview controller={controller} />
                <WsiAnnotationToolbar controller={controller} />
            </>
        );
        screen.getByTestId('annotation-tool-measure').click();
        expect(controller.activeTool).toBe('measure');
        expect(
            screen
                .getByTestId('annotation-tool-measure')
                .getAttribute('aria-label')
        ).toBe('Measure (M): a quick ruler, not saved');
        pointer('pointerdown', 0, 0);
        pointer('pointermove', 40, 0);
        expect(screen.getByTestId('annotation-ruler-preview')).toBeTruthy();
        expect(
            screen.getByTestId('annotation-draw-measurement').textContent
        ).toBe('10 µm · 0°');
        pointer('pointerup', 40, 0);
        drag([0, 0], [400, 0]);

        press('h');
        expect(controller.hideAll).toBe(true);
        (controller as any).screenAffine = () => ({
            a: 1,
            b: 0,
            c: 0,
            d: 1,
            e: 0,
            f: 0,
        });
        const scene = controller.snapshotScene();
        expect(scene?.shapes).toEqual([]);
        expect(scene?.ruler).toMatchObject({
            start: { x: 0, y: 0 },
            end: { x: 400, y: 0 },
            text: '100 µm · 0°',
        });
        const calls: string[] = [];
        const context = new Proxy(
            {},
            {
                get: (_target, name) => (...args: unknown[]) =>
                    calls.push(`${String(name)}(${args.join(',')})`),
                set: () => true,
            }
        ) as any;
        drawAnnotationScene(context, scene!, 2);
        expect(calls).toContain('moveTo(0,0)');
        expect(calls).toContain('lineTo(400,0)');
        expect(calls).toContain('fillText(100 µm · 0°,412,-10)');

        // Without a ruler, H leaves nothing to draw.
        press('Escape');
        expect(controller.snapshotScene()).toBeNull();
    });

    it('keeps the line as an annotation with Keep on (L), a ruler with it off (M)', async () => {
        const { controller, press } = await setup();
        render(<WsiAnnotationToolbar controller={controller} />);
        expect(screen.queryByTestId('annotation-tool-line')).toBeNull();
        press('l');
        expect(controller.activeTool).toBe('line');
        const measure = screen.getByTestId('annotation-tool-measure');
        expect(measure.getAttribute('aria-pressed')).toBe('true');
        expect(measure.getAttribute('aria-label')).toBe(
            'Measure (L): kept as a line annotation'
        );
        const keep = screen.getByTestId(
            'annotation-measure-keep'
        ) as HTMLInputElement;
        expect(keep.checked).toBe(true);
        // Unchecked while on: the ruler at once, and remembered.
        fireEvent.click(keep);
        expect(controller.activeTool).toBe('measure');
        expect(controller.measureKeep).toBe(false);
        expect(
            JSON.parse(
                window.localStorage.getItem('wsi_annotation_toolbar_v1')!
            ).measureKeep
        ).toBe(false);
        press('Escape');
        expect(controller.activeTool).toBeNull();
        press('l');
        press('v');
        // The button picks the last choice.
        fireEvent.click(measure);
        expect(controller.activeTool).toBe('line');
        press('m');
        expect(controller.activeTool).toBe('measure');
        expect(controller.measureKeep).toBe(false);
    });
});
