/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import {
    ANNOTATION_LIST_HEIGHT,
    WsiAnnotationDrawPreview,
    WsiAnnotationPanel,
} from './wsiAnnotationControls';
import {
    attachTestController,
    serviceRow,
    TestAnnotationService,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

const MANY = 5000;
/** The list applies a scroll position once per frame. */
const nextFrame = () =>
    act(
        () =>
            new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    );
/** The estimated row height the list uses before measuring (jsdom has no layout). */
const ROW = 64;

describe('A long annotation list and a long stroke', () => {
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

    async function many() {
        const rows = Array.from({ length: MANY }, (_, i) =>
            serviceRow(
                `a${i}`,
                `${(i % 100) * 20},${Math.floor(i / 100) * 20},10,10`,
                {
                    label: `Cell ${i}`,
                }
            )
        );
        const service = new TestAnnotationService(rows).install();
        const harness = await attachTestController(service);
        cleanup.push(harness.cleanup);
        return { service, ...harness };
    }

    const listedRows = () =>
        screen
            .getByTestId('annotation-list')
            .querySelectorAll('[role="listitem"]');

    it('renders 5,000 annotations as a window of rows that follows scrolling', async () => {
        const { controller } = await many();
        expect(controller.listedAnnotations).toHaveLength(MANY);
        const started = performance.now();
        render(<WsiAnnotationPanel controller={controller} />);
        const elapsed = performance.now() - started;
        // A generous budget: rendering every row took several seconds.
        expect(elapsed).toBeLessThan(3000);
        const list = screen.getByTestId('annotation-list');
        expect(list.getAttribute('data-virtual')).toBe('true');
        expect(listedRows().length).toBeLessThan(30);
        expect((list.firstElementChild as HTMLElement).style.height).toBe(
            `${MANY * ROW}px`
        );
        const first = listedRows()[0];
        expect(first.getAttribute('aria-posinset')).toBe('1');
        expect(first.getAttribute('aria-setsize')).toBe(String(MANY));

        // Scrolled half-way, the rows there render, placed at their offsets.
        act(() => {
            list.scrollTop = 2500 * ROW;
            fireEvent.scroll(list);
        });
        await nextFrame();
        const row = screen.getByTestId('annotation-row-a2500');
        expect(row.style.top).toBe(`${2500 * ROW}px`);
        expect(screen.queryByTestId('annotation-row-a0')).toBeNull();
        expect(listedRows().length).toBeLessThan(30);

        // Checkboxes select as before.
        fireEvent.click(screen.getByTestId('annotation-select-a2500'));
        expect(controller.isSelected('a2500')).toBe(true);
    });

    it('moves between rows with the arrow keys, Home and End, keeping the focused row', async () => {
        const { controller } = await many();
        render(<WsiAnnotationPanel controller={controller} />);
        const list = screen.getByTestId('annotation-list');
        const label = (id: string) =>
            screen.getByTestId(`annotation-goto-${id}`);
        act(() => label('a0').focus());
        fireEvent.keyDown(label('a0'), { key: 'ArrowDown' });
        expect(document.activeElement).toBe(label('a1'));
        fireEvent.keyDown(label('a1'), { key: 'ArrowUp' });
        expect(document.activeElement).toBe(label('a0'));

        // End renders the last row and focuses it; the list scrolls to it.
        fireEvent.keyDown(label('a0'), { key: 'End' });
        expect(document.activeElement).toBe(label(`a${MANY - 1}`));
        expect(list.scrollTop).toBe(MANY * ROW - ANNOTATION_LIST_HEIGHT);

        // Scrolled away, the focused row stays rendered (and focused).
        act(() => {
            list.scrollTop = 0;
            fireEvent.scroll(list);
        });
        await nextFrame();
        expect(screen.getByTestId('annotation-row-a0')).toBeTruthy();
        expect(document.activeElement).toBe(label(`a${MANY - 1}`));
        fireEvent.keyDown(label(`a${MANY - 1}`), { key: 'Home' });
        expect(document.activeElement).toBe(label('a0'));
        expect(controller.annotations).toHaveLength(MANY);
    });

    it('scrolls to the annotation the slide is pointed at', async () => {
        const { controller } = await many();
        render(<WsiAnnotationPanel controller={controller} />);
        const list = screen.getByTestId('annotation-list');
        act(() => {
            controller.focusAnnotation('a3000');
        });
        expect(list.scrollTop).toBe(3001 * ROW - ANNOTATION_LIST_HEIGHT);
        expect(screen.getByTestId('annotation-row-a3000')).toBeTruthy();
    });

    it('captures a 5,000-point freehand stroke in linear time', async () => {
        const service = new TestAnnotationService([]).install();
        const harness = await attachTestController(service);
        cleanup.push(harness.cleanup);
        const { controller, pointer, viewportChanged } = harness;
        controller.setAnnotating(true);
        controller.setTool('freehand');
        const { container } = render(
            <WsiAnnotationDrawPreview controller={controller} />
        );
        pointer('pointerdown', 0, 0);
        const polyline = container.querySelector(
            '[data-testid="annotation-stroke-preview"]'
        ) as SVGPolylineElement;
        expect(polyline.getAttribute('points')).toBe('0,0');
        // Stand in for the browser's SVGPointList, which jsdom lacks.
        const appended: Array<{ x: number; y: number }> = [];
        const clear = jest.fn(() => (appended.length = 0));
        Object.defineProperty(polyline, 'points', {
            value: {
                appendItem: (point: { x: number; y: number }) =>
                    appended.push({ x: point.x, y: point.y }),
                clear,
            },
        });
        (polyline.ownerSVGElement as any).createSVGPoint = () => ({
            x: 0,
            y: 0,
        });
        const strokePoints = controller.strokePoints();
        const screenPoint = jest.spyOn(controller as any, 'screenPoint');
        screenPoint.mockClear();

        const started = performance.now();
        for (let i = 1; i < MANY; i++) {
            pointer('pointermove', i * 3, (i % 2) * 3);
        }
        const elapsed = performance.now() - started;
        // Points were added in place, and each placed on screen once.
        expect(controller.strokePoints()).toBe(strokePoints);
        expect(strokePoints).toHaveLength(MANY);
        expect(appended).toHaveLength(MANY - 1);
        expect(appended[MANY - 2]).toEqual({ x: (MANY - 1) * 3, y: 3 });
        expect(clear).not.toHaveBeenCalled();
        // A few conversions per move whatever the stroke's length; placing
        // every point again on every move would be 12.5 million.
        expect(screenPoint.mock.calls.length).toBeLessThan(MANY * 6);
        expect(elapsed).toBeLessThan(15000);

        // The slide moving places the stroke again, once.
        viewportChanged();
        expect(clear).toHaveBeenCalledTimes(1);
        expect(appended).toHaveLength(MANY);

        pointer('pointerup', (MANY - 1) * 3, 3);
        expect(controller.strokePoints()).toBeNull();
    });
});

describe('A short annotation list', () => {
    beforeAll(() => loadAnnotorious());
    const LIST_TOP = 300;

    it('scrolls to the annotation the slide is pointed at', async () => {
        // Layout as a browser gives it: the list is position: relative, so
        // it is the rows' offsetParent and a row's offsetTop is its place
        // in the list, whatever lies above the list in the panel.
        const proto = HTMLElement.prototype as any;
        const saved = {
            offsetTop: Object.getOwnPropertyDescriptor(proto, 'offsetTop')!,
            offsetHeight: Object.getOwnPropertyDescriptor(
                proto,
                'offsetHeight'
            )!,
            clientHeight: Object.getOwnPropertyDescriptor(
                Element.prototype,
                'clientHeight'
            )!,
        };
        Object.defineProperty(proto, 'offsetTop', {
            configurable: true,
            get(this: HTMLElement) {
                if (this.getAttribute('data-testid') === 'annotation-list') {
                    return LIST_TOP;
                }
                const id = this.getAttribute('data-annotation-row');
                return id ? Number(id.slice(1)) * ROW : 0;
            },
        });
        Object.defineProperty(proto, 'offsetHeight', {
            configurable: true,
            get(this: HTMLElement) {
                return this.hasAttribute('data-annotation-row') ? ROW : 0;
            },
        });
        Object.defineProperty(Element.prototype, 'clientHeight', {
            configurable: true,
            get(this: HTMLElement) {
                return this.getAttribute('data-testid') === 'annotation-list'
                    ? ANNOTATION_LIST_HEIGHT
                    : 0;
            },
        });
        try {
            const rows = Array.from({ length: 20 }, (_, i) =>
                serviceRow(`a${i}`, `${i * 20},0,10,10`, { label: `Cell ${i}` })
            );
            const service = new TestAnnotationService(rows).install();
            const { controller, cleanup } = await attachTestController(service);
            render(<WsiAnnotationPanel controller={controller} />);
            const list = screen.getByTestId('annotation-list');
            expect(list.getAttribute('data-virtual')).toBeNull();
            act(() => {
                controller.focusAnnotation('a15');
            });
            const top = 15 * ROW;
            expect(list.scrollTop).toBeLessThanOrEqual(top);
            expect(
                list.scrollTop + ANNOTATION_LIST_HEIGHT
            ).toBeGreaterThanOrEqual(top + ROW);
            cleanup();
        } finally {
            Object.defineProperty(proto, 'offsetTop', saved.offsetTop);
            Object.defineProperty(proto, 'offsetHeight', saved.offsetHeight);
            Object.defineProperty(
                Element.prototype,
                'clientHeight',
                saved.clientHeight
            );
        }
    });
});
