/**
 * @jest-environment jsdom
 */

import { WsiAnnotationController } from './wsiAnnotationController';
import { drawAnnotationScene } from './wsiAnnotationSnapshot';
import { backgroundBehind, composeSnapshot } from './wsiViewStateUtils';
import { WsiViewerController } from './wsiViewerController';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

type Call = [string, ...any[]];

/**
 * A 2D context that applies the current transform to the points it is
 * given, as a canvas does, and records what is drawn where (in canvas
 * pixels) with the style of the moment.
 */
function recordingContext() {
    const calls: Call[] = [];
    let m = [1, 0, 0, 1, 0, 0];
    const at = (x: number, y: number) => [
        m[0] * x + m[2] * y + m[4],
        m[1] * x + m[3] * y + m[5],
    ];
    const context: any = {
        calls,
        globalAlpha: 1,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        save: () => undefined,
        restore: () => undefined,
        setTransform: (...values: number[]) => {
            m = values;
        },
        beginPath: () => calls.push(['beginPath']),
        closePath: () => calls.push(['closePath']),
        moveTo: (x: number, y: number) => calls.push(['moveTo', ...at(x, y)]),
        lineTo: (x: number, y: number) => calls.push(['lineTo', ...at(x, y)]),
        arcTo: () => undefined,
        rect: (x: number, y: number, w: number, h: number) =>
            calls.push(['rect', ...at(x, y), ...at(x + w, y + h)]),
        ellipse: (x: number, y: number, rx: number, ry: number) =>
            calls.push(['ellipse', ...at(x, y), rx * m[0], ry * m[3]]),
        arc: (x: number, y: number, r: number) =>
            calls.push(['arc', ...at(x, y), r * m[0]]),
        fill: () =>
            calls.push(['fill', context.fillStyle, context.globalAlpha]),
        stroke: () =>
            calls.push([
                'stroke',
                context.strokeStyle,
                context.lineWidth * m[0],
            ]),
        fillText: (text: string, x: number, y: number) =>
            calls.push(['fillText', text, ...at(x, y)]),
    };
    return context;
}

describe('drawAnnotationScene', () => {
    it('draws shapes through the slide mapping at the snapshot scale', () => {
        const context = recordingContext();
        drawAnnotationScene(
            context,
            {
                // Two image pixels per screen pixel, slide shifted by (10, 20).
                affine: { a: 0.5, b: 0, c: 0, d: 0.5, e: 10, f: 20 },
                shapes: [
                    {
                        shape: {
                            kind: 'rectangle',
                            x: 100,
                            y: 200,
                            width: 40,
                            height: 60,
                        },
                        color: '#ef4444',
                    },
                    {
                        shape: {
                            kind: 'line',
                            points: [
                                { x: 0, y: 0 },
                                { x: 20, y: 0 },
                            ],
                        },
                        color: '#00ff00',
                    },
                ],
                points: [{ x: 40, y: 60, color: '#0000ff' }],
                labels: [
                    {
                        id: 'r',
                        text: 'Tumor',
                        x: 60,
                        y: 120,
                        width: 40,
                        height: 16,
                    },
                ],
                fillOpacity: 0.2,
            },
            2
        );
        const calls = context.calls;
        // Screen (60, 120)-(80, 150), at 2 canvas pixels per screen pixel.
        expect(calls).toContainEqual(['rect', 120, 240, 160, 300]);
        expect(calls).toContainEqual(['fill', '#ef4444', 0.2]);
        // Outlines are 2 screen pixels wide at any zoom.
        expect(calls).toContainEqual(['stroke', '#ef4444', 4]);
        // A line is not filled.
        const line = calls.findIndex(
            (call: Call) => call[0] === 'moveTo' && call[1] === 20
        );
        expect(calls[line + 1]).toEqual(['lineTo', 40, 40]);
        expect(calls[line + 2]).toEqual(['stroke', '#00ff00', 4]);
        // A point marker: 5 screen pixels, at its screen place.
        expect(calls).toContainEqual(['arc', 60, 100, 10]);
        expect(calls).toContainEqual(['fill', '#0000ff', 1]);
        expect(calls).toContainEqual(['fillText', 'Tumor', 126, 264]);
    });

    it('leaves the fill out for outlines only', () => {
        const context = recordingContext();
        drawAnnotationScene(
            context,
            {
                affine: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
                shapes: [
                    {
                        shape: { kind: 'ellipse', cx: 5, cy: 5, rx: 3, ry: 2 },
                        color: '#ef4444',
                    },
                ],
                points: [],
                labels: [],
                fillOpacity: 0,
            },
            1
        );
        expect(
            context.calls.filter((call: Call) => call[0] === 'fill')
        ).toEqual([]);
        expect(context.calls).toContainEqual(['ellipse', 5, 5, 3, 2]);
    });
});

describe('WsiAnnotationController.drawSnapshot', () => {
    function controllerWith(items: Array<[string, string, string, string]>) {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).annotations = items.map(([id, layer, color, svg]) =>
            (controller as any).fromApi(
                {
                    id,
                    body: {
                        label: id,
                        layer_name: layer,
                        type: `${layer}|${color}`,
                    },
                    target: { selector: { type: 'SvgSelector', value: svg } },
                    version: 1,
                    created_by: 'user',
                },
                'slide1'
            )
        );
        // Two image pixels per screen pixel, image (0, 0) at the top left.
        jest.spyOn(controller as any, 'screenPoint').mockImplementation(
            (point: any) => ({
                x: point.x / 2,
                y: point.y / 2,
            })
        );
        return controller;
    }
    const drawn = (controller: WsiAnnotationController) => {
        const context = recordingContext();
        controller.drawSnapshot(context, 1.5);
        return context.calls;
    };

    it('draws the shown annotations where the slide shows them', () => {
        const controller = controllerWith([
            [
                'tumor-1',
                'Tumor',
                '#ef4444',
                '<svg><rect x="100" y="40" width="20" height="10" /></svg>',
            ],
            [
                'mitosis',
                'Counts',
                '#00aa00',
                '<svg><circle cx="80" cy="60" r="0" /></svg>',
            ],
        ]);
        const calls = drawn(controller);
        // Screen (50, 20)-(60, 25) at 1.5 canvas pixels per screen pixel.
        expect(calls).toContainEqual(['rect', 75, 30, 90, 37.5]);
        expect(calls).toContainEqual(['stroke', '#ef4444', 3]);
        expect(calls).toContainEqual(['arc', 60, 45, 7.5]);
        expect(calls).toContainEqual(['fill', '#00aa00', 1]);
    });

    it('leaves out hidden layers, and everything when all are hidden', () => {
        const controller = controllerWith([
            [
                'tumor-1',
                'Tumor',
                '#ef4444',
                '<svg><rect x="100" y="40" width="20" height="10" /></svg>',
            ],
            [
                'margin-1',
                'Margin',
                '#123456',
                '<svg><polygon points="0,0 40,0 40,40" /></svg>',
            ],
        ]);
        controller.toggleLayerVisibility('Tumor');
        let calls = drawn(controller);
        expect(calls.some((call: Call) => call[0] === 'rect')).toBe(false);
        expect(calls).toContainEqual(['stroke', '#123456', 3]);

        controller.toggleHideAll();
        expect(drawn(controller)).toEqual([]);
        controller.toggleHideAll();
        controller.toggleSoloLayer('Tumor');
        calls = drawn(controller);
        expect(calls).toContainEqual(['rect', 75, 30, 90, 37.5]);
        expect(calls.some((call: Call) => call[1] === '#123456')).toBe(false);
    });
});

describe('composeSnapshot', () => {
    it('copies the slide and draws over it at the measured pixel ratio', () => {
        const drawImage = jest.fn();
        const getContext = jest
            .spyOn(HTMLCanvasElement.prototype, 'getContext')
            .mockReturnValue({ drawImage } as any);
        const slide = document.createElement('canvas');
        slide.width = 300;
        slide.height = 200;
        Object.defineProperty(slide, 'clientWidth', { value: 150 });
        const draw = jest.fn();

        const copy = composeSnapshot(slide, draw);

        expect(copy).not.toBe(slide);
        expect([copy.width, copy.height]).toEqual([300, 200]);
        expect(drawImage).toHaveBeenCalledWith(slide, 0, 0);
        expect(draw).toHaveBeenCalledWith({ drawImage }, 2);
        getContext.mockRestore();
    });

    it('fills the background before the slide, so the area outside it is not black', () => {
        const calls: string[] = [];
        const context = {
            set fillStyle(value: string) {
                calls.push(`fillStyle ${value}`);
            },
            fillRect: (...args: number[]) =>
                calls.push(`fillRect ${args.join(',')}`),
            drawImage: () => calls.push('drawImage'),
        };
        const getContext = jest
            .spyOn(HTMLCanvasElement.prototype, 'getContext')
            .mockReturnValue(context as any);
        const slide = document.createElement('canvas');
        slide.width = 30;
        slide.height = 20;
        composeSnapshot(slide, undefined, 'rgb(232, 232, 232)');
        expect(calls).toEqual([
            'fillStyle rgb(232, 232, 232)',
            'fillRect 0,0,30,20',
            'drawImage',
        ]);
        getContext.mockRestore();
    });

    it('takes the background from the nearest opaque ancestor', () => {
        const stage = document.createElement('div');
        stage.style.background = '#e8e8e8';
        const container = document.createElement('div');
        container.style.background = 'transparent';
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);
        stage.appendChild(container);
        document.body.appendChild(stage);
        expect(backgroundBehind(canvas, '#fff')).toBe('rgb(232, 232, 232)');
        stage.remove();
        container.removeChild(canvas);
        expect(backgroundBehind(canvas, '#fff')).toBe('#fff');
    });

    it('downloads the view on the stage background, with or without annotations', () => {
        const fillRect = jest.fn();
        const styles: string[] = [];
        const context = {
            set fillStyle(value: string) {
                styles.push(value);
            },
            fillRect,
            drawImage: jest.fn(),
        };
        const getContext = jest
            .spyOn(HTMLCanvasElement.prototype, 'getContext')
            .mockReturnValue(context as any);
        const toBlob = jest
            .spyOn(HTMLCanvasElement.prototype, 'toBlob')
            .mockImplementation(() => undefined);
        const canvas = document.createElement('canvas');
        canvas.width = 40;
        canvas.height = 10;
        const controller = new WsiViewerController(
            {} as any,
            { hierarchy: null, selectedSlide: null } as any,
            () => Promise.resolve(null)
        );
        (controller as any).osdViewer = {
            drawer: { canvas },
            viewport: {
                getCenter: () => ({ x: 0.5, y: 0.5 }),
                viewportToImageCoordinates: () => ({ x: 5, y: 6 }),
            },
        };
        (controller as any).osdSlideMounted = true;
        controller.downloadView();
        expect(styles[0]).toBe('#e8e8e8');
        expect(fillRect).toHaveBeenCalledWith(0, 0, 40, 10);
        const downloaded = toBlob.mock.instances[0] as any;
        expect(downloaded).not.toBe(canvas);
        getContext.mockRestore();
        toBlob.mockRestore();
    });
});
