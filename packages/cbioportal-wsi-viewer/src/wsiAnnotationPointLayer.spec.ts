/**
 * @jest-environment jsdom
 */
import { WsiPointLayer } from './wsiAnnotationPointLayer';

class Point {
    constructor(public x: number, public y: number) {}
}

/** A viewer showing the image at half size, panned by (10, 20). */
function fakeViewer() {
    const handlers: Record<string, Array<() => void>> = {};
    const canvas = document.createElement('div');
    return {
        canvas,
        handlers,
        viewport: {
            imageToViewerElementCoordinates: (point: Point) =>
                new Point(point.x / 2 + 10, point.y / 2 + 20),
        },
        addHandler: jest.fn((event: string, handler: () => void) => {
            (handlers[event] = handlers[event] || []).push(handler);
        }),
        removeHandler: jest.fn(),
    };
}

describe('WsiPointLayer', () => {
    const originalRaf = window.requestAnimationFrame;
    const arc = jest.fn();
    beforeEach(() => {
        arc.mockClear();
        (window as any).requestAnimationFrame = undefined;
        jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            setTransform: jest.fn(),
            clearRect: jest.fn(),
            beginPath: jest.fn(),
            arc,
            fill: jest.fn(),
            stroke: jest.fn(),
        } as any);
        jest.spyOn(
            HTMLCanvasElement.prototype,
            'clientWidth',
            'get'
        ).mockReturnValue(400);
        jest.spyOn(
            HTMLCanvasElement.prototype,
            'clientHeight',
            'get'
        ).mockReturnValue(300);
    });
    afterEach(() => {
        window.requestAnimationFrame = originalRaf;
        jest.restoreAllMocks();
    });

    it('draws visible markers at screen positions and redraws on viewport changes', () => {
        const viewer = fakeViewer();
        const layer = new WsiPointLayer(viewer, { Point });
        expect(viewer.canvas.querySelector('canvas')).toBeTruthy();

        layer.setMarkers([
            { id: 'a', x: 100, y: 100, color: '#f00' },
            // Off screen: not drawn.
            { id: 'b', x: 5000, y: 5000, color: '#f00' },
        ]);
        expect(arc).toHaveBeenCalledTimes(1);
        expect(arc.mock.calls[0].slice(0, 2)).toEqual([60, 70]);

        viewer.handlers['update-viewport'].forEach(handler => handler());
        expect(arc).toHaveBeenCalledTimes(2);

        layer.setVisible(false);
        expect(arc).toHaveBeenCalledTimes(2);

        layer.destroy();
        expect(viewer.canvas.querySelector('canvas')).toBeNull();
        expect(viewer.removeHandler).toHaveBeenCalledWith(
            'update-viewport',
            expect.any(Function)
        );
    });

    it('finds the nearest marker under the pointer', () => {
        const layer = new WsiPointLayer(fakeViewer(), { Point });
        layer.setMarkers([
            { id: 'a', x: 100, y: 100, color: '#f00' },
            { id: 'b', x: 110, y: 100, color: '#f00' },
        ]);
        expect(layer.hitTest({ x: 64, y: 70 })?.id).toBe('b');
        expect(layer.hitTest({ x: 60, y: 71 })?.id).toBe('a');
        expect(layer.hitTest({ x: 200, y: 200 })).toBeNull();
    });
});
