/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import {
    DEFAULT_HPF_AREA_MM2,
    formatDensity,
    formatRegionCount,
} from './wsiAnnotationController';
import {
    measureShape,
    parseAnnotationShape,
} from './wsiAnnotationGeometryUtils';
import { WsiAnnotationPanel } from './wsiAnnotationControls';
import { WsiAnnotationToolbar } from './wsiAnnotationToolbar';
import { HPF_HELP_TEXT, HPF_RATE_HELP } from './wsiHpfHelp';
import {
    attachTestController,
    flush,
    pointRow,
    serviceRow,
    TestAnnotationService,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

const MPP = { x: 0.25, y: 0.25 };

describe('formatRegionCount', () => {
    it('gives the total, the labels and the density', () => {
        expect(
            formatRegionCount({
                total: 12,
                byLabel: [
                    { label: 'Mitosis', count: 7 },
                    { label: 'Lymphocyte', count: 5 },
                ],
                densityPerMm2: 50.64,
            })
        ).toBe('12 (Mitosis 7, Lymphocyte 5) · 50.6 per mm²');
        expect(formatRegionCount({ total: 0, byLabel: [] })).toBe('0');
        expect(formatDensity(1234.5)).toBe('1,235 per mm²');
        expect(formatDensity(4.24)).toBe('4.2 per mm²');
        expect(formatDensity(0)).toBe('0 per mm²');
    });
});

describe('High-power fields and points inside regions', () => {
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

    async function setup(seed: any[] = [], mpp: typeof MPP | null = MPP) {
        const service = new TestAnnotationService(seed).install();
        const harness = await attachTestController(service, mpp ? { mpp } : {});
        cleanup.push(harness.cleanup);
        harness.controller.setAnnotating(true);
        return { service, ...harness };
    }

    it('places a field of the chosen area with a click, labelled HPF n', async () => {
        const { controller, service, pointer } = await setup([
            serviceRow(
                'old',
                '<svg><ellipse cx="9" cy="9" rx="5" ry="5" /></svg>',
                {
                    label: 'HPF 5',
                }
            ),
        ]);
        expect(controller.hpfAreaMm2).toBe(DEFAULT_HPF_AREA_MM2);
        controller.setTool('hpf');
        expect(controller.activeTool).toBe('hpf');
        // Not a Shape menu tool: the Shape button keeps its own.
        expect(controller.shapeTool).toBe('rectangle');

        // A drag pans the slide; a click places the field.
        pointer('pointerdown', 100, 100);
        pointer('pointermove', 160, 100);
        pointer('pointerup', 160, 100);
        await flush();
        expect(service.writes()).toEqual([]);
        pointer('pointermove', 2000, 2000);
        expect(controller.hpfCursor).toMatchObject({ x: 2000, y: 2000 });
        expect(controller.hpfCursor!.rx).toBeCloseTo(1098.6, 0);
        pointer('pointerdown', 2000, 2000);
        pointer('pointerup', 2001, 2000);
        await flush();
        const created = service.calls.find(call => call.method === 'POST')!
            .body;
        expect(created.body.label).toBe('HPF 6');
        const shape = parseAnnotationShape(created.target.selector)!;
        expect(shape).toMatchObject({ kind: 'ellipse', cx: 2001, cy: 2000 });
        const area = measureShape(shape, MPP)!.area! / 1e6;
        expect(area).toBeCloseTo(0.237, 3);
        // The tool stays on for the next field.
        expect(controller.activeTool).toBe('hpf');

        // Another area, remembered; a slide with unequal scales gets an
        // ellipse in pixels that is a circle on the tissue.
        controller.setHpfArea(0.196);
        expect(window.localStorage.getItem('wsi_annotation_hpf_area_v1')).toBe(
            '0.196'
        );
        controller.setHpfArea(99);
        expect(controller.hpfAreaMm2).toBe(0.196);
        controller.setMppProvider(() => ({ x: 0.5, y: 0.25 }));
        pointer('pointerdown', 500, 500);
        pointer('pointerup', 500, 500);
        await flush();
        const second = service.calls.filter(call => call.method === 'POST')[1]
            .body;
        expect(second.body.label).toBe('HPF 7');
        const ellipse = parseAnnotationShape(second.target.selector) as any;
        expect(ellipse.ry / ellipse.rx).toBeCloseTo(2, 2);
        expect(
            measureShape(ellipse, { x: 0.5, y: 0.25 })!.area! / 1e6
        ).toBeCloseTo(0.196, 3);
    });

    it('numbers fields placed before the previous one is saved', async () => {
        const { controller, service, pointer } = await setup();
        controller.setTool('hpf');
        service.hold = true;
        for (const x of [100, 3000]) {
            pointer('pointerdown', x, 100);
            pointer('pointerup', x, 100);
        }
        await flush();
        service.release();
        await flush();
        expect(
            service.calls
                .filter(call => call.method === 'POST')
                .map(call => call.body.body.label)
        ).toEqual(['HPF 1', 'HPF 2']);
        // Once saved, the next continues from the highest.
        pointer('pointerdown', 5000, 100);
        pointer('pointerup', 5000, 100);
        await flush();
        expect(
            service.calls.filter(call => call.method === 'POST')[2].body.body
                .label
        ).toBe('HPF 3');
        expect(controller.hpfSummary?.fields).toBe(3);
    });

    it('needs the slide scale', async () => {
        const { controller } = await setup([], null);
        controller.setTool('hpf');
        expect(controller.activeTool).toBeNull();
        controller.setTool('rectangle');
        render(<WsiAnnotationToolbar controller={controller} />);
        const item = screen.getByTestId('annotation-tool-hpf');
        expect(item.getAttribute('aria-disabled')).toBe('true');
        expect(item.getAttribute('title')).toContain('needs the slide scale');
        fireEvent.click(item);
        expect(controller.activeTool).toBe('rectangle');
    });

    it('offers the common field areas and a custom one while the tool is on', async () => {
        const { controller } = await setup();
        render(<WsiAnnotationToolbar controller={controller} />);
        expect(screen.queryByTestId('annotation-hpf-area')).toBeNull();
        // The Count group's HPF button explains what a field is.
        const item = screen.getByTestId('annotation-tool-hpf');
        expect(
            item.closest('[data-testid="annotation-tools-count"]')
        ).not.toBeNull();
        expect(item.getAttribute('title')).toMatch(/^HPF field \(Shift\+C\)/);
        const itemHelp = document.getElementById(
            item.getAttribute('aria-describedby')!
        )!;
        expect(itemHelp.textContent).toBe(HPF_HELP_TEXT);
        expect(HPF_HELP_TEXT).toMatch(
            /^HPF \(high-power field\): the area of tissue seen through the microscope at high magnification \(40× objective\)\./
        );
        fireEvent.click(item);
        const select = screen.getByTestId(
            'annotation-hpf-area'
        ) as HTMLSelectElement;
        expect(select.value).toBe('0.237');
        expect(
            within(select)
                .getAllByRole('option')
                .map(option => option.textContent)
        ).toEqual([
            '0.159 mm² (0.45 mm)',
            '0.196 mm² (0.5 mm)',
            '0.237 mm² (0.55 mm), default',
            '0.283 mm² (0.6 mm)',
            '0.332 mm² (0.65 mm)',
            '0.374 mm² (0.69 mm)',
            'Custom…',
        ]);
        // The picker is described by the help; its info icon shows it on
        // focus.
        expect(
            document.getElementById(select.getAttribute('aria-describedby')!)!
                .textContent
        ).toBe(HPF_HELP_TEXT);
        const info = screen.getByTestId('annotation-hpf-area-info');
        expect(info.getAttribute('aria-label')).toBe(
            'What a high-power field (HPF) is'
        );
        expect(info.getAttribute('tabindex')).toBe('0');
        fireEvent.change(select, { target: { value: '0.312' } });
        fireEvent.change(select, { target: { value: 'custom' } });
        const input = screen.getByTestId('annotation-hpf-area-custom');
        fireEvent.change(input, { target: { value: '0.3' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(controller.hpfAreaMm2).toBe(0.3);
        fireEvent.change(input, { target: { value: '0' } });
        fireEvent.blur(input);
        expect(controller.hpfAreaMm2).toBe(0.3);
        expect((input as HTMLInputElement).value).toBe('0.3');
    });

    it('counts the points inside each region by label, with the density, in the list, tooltip and export', async () => {
        const { controller, element } = await setup([
            // 400 × 400 px = 100 × 100 µm = 0.01 mm².
            serviceRow('box', '0,0,400,400', { label: 'Tumor' }),
            serviceRow(
                'tri',
                '<svg><polygon points="1000,0 1400,0 1000,400" /></svg>',
                { label: 'Edge' }
            ),
            serviceRow(
                'line',
                '<svg><line x1="0" y1="0" x2="9" y2="9" /></svg>'
            ),
            pointRow('p1', 10, 10, 'Mitosis'),
            pointRow('p2', 390, 20, 'Mitosis'),
            pointRow('p3', 200, 200, 'Lymphocyte', { layer: 'Hidden' }),
            pointRow('p4', 401, 10, 'Mitosis'),
            pointRow('p5', 1010, 10, 'Mitosis'),
            pointRow('p6', 1390, 390, 'Mitosis'),
        ]);
        controller.toggleLayerVisibility('Hidden');
        const box = controller.annotations.find(item => item.id === 'box')!;
        expect(controller.pointsInside(box)).toEqual({
            total: 3,
            byLabel: [
                { label: 'Mitosis', count: 2 },
                { label: 'Lymphocyte', count: 1 },
            ],
            densityPerMm2: 300,
        });
        const triangle = controller.annotations.find(
            item => item.id === 'tri'
        )!;
        expect(controller.pointsInside(triangle)?.total).toBe(1);
        expect(
            controller.pointsInside(
                controller.annotations.find(item => item.id === 'line')!
            )
        ).toBeNull();

        render(<WsiAnnotationPanel controller={controller} />);
        fireEvent.click(screen.getByTestId('annotation-counts-toggle'));
        expect(
            screen.getByTestId('annotation-points-inside-box').textContent
        ).toBe('Points inside: 3 (Mitosis 2, Lymphocyte 1) · 300 per mm²');

        const clickHandler = (controller as any).annotorious.on.mock.calls.find(
            ([name]: [string]) => name === 'clickAnnotation'
        )[1];
        clickHandler(box, { clientX: 5, clientY: 5 });
        expect(controller.annotationTooltip?.pointsInside).toBe(
            'Points inside: 3 (Mitosis 2, Lymphocyte 1) · 300 per mm²'
        );

        const feature = controller
            .exportGeoJson('all')
            .features.find(item => item.id === 'box')!;
        expect(feature.properties.measurements).toMatchObject({
            'Num points': 3,
            'Num points: Mitosis': 2,
            'Num points: Lymphocyte': 1,
            'Points per mm^2': 300,
        });
        expect(element).toBeTruthy();
    });

    it('sums the points in the high-power fields per 10 fields', async () => {
        const field = (id: string, cx: number) =>
            serviceRow(
                id,
                `<svg><ellipse cx="${cx}" cy="1000" rx="1098.6" ry="1098.6" /></svg>`,
                { label: id === 'f1' ? 'HPF 1' : 'HPF 2' }
            );
        const { controller } = await setup([
            field('f1', 1000),
            field('f2', 5000),
            pointRow('m1', 1000, 1000, 'Mitosis'),
            pointRow('m2', 1100, 1000, 'Mitosis'),
            pointRow('m3', 900, 900, 'Mitosis'),
            pointRow('m4', 5000, 1000, 'Mitosis'),
            pointRow('l1', 5000, 900, 'Lymphocyte'),
            pointRow('far', 9000, 9000, 'Mitosis'),
        ]);
        const summary = controller.hpfSummary!;
        expect(summary.fields).toBe(2);
        expect(summary.areaMm2).toBeCloseTo(0.474, 2);
        expect(summary.byLabel).toEqual([
            { label: 'Mitosis', count: 4, per10: 20 },
            { label: 'Lymphocyte', count: 1, per10: 5 },
        ]);
        expect(summary.per10).toBe(25);
        render(<WsiAnnotationPanel controller={controller} />);
        fireEvent.click(screen.getByTestId('annotation-counts-toggle'));
        const table = screen.getByTestId('annotation-hpf-summary');
        // The caption, then its info icon and the hidden help.
        expect(table.querySelector('caption')!.textContent).toMatch(
            /^2 high-power fields \(0\.474 mm²\) HPF \(high-power field\)/
        );
        // Per 10 HPF and per mm² of the fields' area (4 / 0.474 mm²).
        const headers = Array.from(table.querySelectorAll('th'));
        expect(headers.map(th => th.firstChild!.textContent!.trim())).toEqual([
            'Points',
            'In fields',
            'Per 10 HPF',
            'Per mm²',
        ]);
        // Each rate column is described by its help (an info icon, not a
        // title only).
        expect(
            document.getElementById(
                headers[2].getAttribute('aria-describedby')!
            )!.textContent
        ).toBe(HPF_RATE_HELP[0].text);
        expect(screen.getByTestId('annotation-hpf-per-mm2-info')).toBeTruthy();
        // Two fields: the rate per 10 HPF is provisional, not bold.
        expect(screen.getByTestId('annotation-hpf-notes').textContent).toBe(
            'Provisional: based on 2 fields; a rate per 10 HPF needs at least 10.'
        );
        expect(
            (screen
                .getByTestId('annotation-hpf-rate-Mitosis')
                .querySelectorAll('td')[2] as HTMLElement).style.fontWeight
        ).toBe('400');
        expect(
            screen.getByTestId('annotation-hpf-rate-Mitosis').textContent
        ).toMatch(/^Mitosis4208\.4$/);
        expect(
            screen.getByTestId('annotation-hpf-rate-total').textContent
        ).toMatch(/^All points52510\.5$/);
        // The table is described by the help, which explains both rates.
        const help = document.getElementById(
            table.getAttribute('aria-describedby')!
        )!.textContent!;
        expect(help).toContain(HPF_HELP_TEXT);
        HPF_RATE_HELP.forEach(item =>
            expect(help).toContain(`${item.label}: ${item.text}`)
        );
        expect(screen.getByTestId('annotation-hpf-summary-info')).toBeTruthy();
    });

    it("counts a point in overlapping fields once, the overlap once, and the user's own by default", async () => {
        // Two fields of radius 1098.6 px (0.237 mm² at 0.25 µm), centres
        // 1000 px apart: they overlap.
        const field = (id: string, cx: number, creator = 'me') =>
            serviceRow(
                id,
                `<svg><ellipse cx="${cx}" cy="1000" rx="1098.6" ry="1098.6" /></svg>`,
                { label: `HPF ${id.slice(1)}`, creator }
            );
        const { controller } = await setup([
            field('f1', 1000),
            field('f2', 2000),
            field('f3', 9000, 'other'),
            pointRow('both', 1500, 1000, 'Mitosis'),
            pointRow('one', 600, 1000, 'Mitosis'),
            pointRow('theirs', 1400, 1000, 'Mitosis', { creator: 'other' }),
            pointRow('theirs2', 9000, 1000, 'Mitosis', { creator: 'other' }),
        ]);
        const mine = controller.hpfSummary!;
        expect(mine.scope).toBe('mine');
        expect(mine.fields).toBe(2);
        // "both" lies in both fields and counts once; "theirs" is not mine.
        expect(mine.total).toBe(2);
        expect(mine.overlapping).toBe(2);
        // Less than the two fields' 0.474 mm²: the lens counts once.
        expect(mine.areaMm2).toBeLessThan(0.474);
        expect(mine.areaMm2).toBeGreaterThan(0.237);
        render(<WsiAnnotationPanel controller={controller} />);
        fireEvent.click(screen.getByTestId('annotation-counts-toggle'));
        expect(screen.getByTestId('annotation-hpf-overlap').textContent).toBe(
            '2 fields overlap: a point in an overlap is counted once and the area once, so the rate per 10 HPF is low. Move or delete the overlapping fields.'
        );
        // All users: their field and points too.
        fireEvent.change(screen.getByTestId('annotation-hpf-scope'), {
            target: { value: 'all' },
        });
        const all = controller.hpfSummary!;
        expect(all.fields).toBe(3);
        expect(all.total).toBe(4);
    });
});
