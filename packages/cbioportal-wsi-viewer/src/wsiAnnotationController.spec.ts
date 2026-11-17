/**
 * @jest-environment jsdom
 */

import {
    batchItemErrors,
    chunkBySize,
    labelTerm,
    POINT_SAVE_DELAY_MS,
    pointSelectorSvg,
    WSI_REVIEW_FALLBACK_NOTICE,
    WSI_REVIEW_UNSUPPORTED_MESSAGE,
    WsiAnnotationController,
} from './wsiAnnotationController';
import { createOSDAnnotator } from '@annotorious/openseadragon';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { parseAnnotationShape } from './wsiAnnotationGeometryUtils';
import {
    configureWsiViewerRuntime,
    resetWsiViewerRuntime,
} from './wsiViewerConfig';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

function apiAnnotation(
    id: string,
    version = 1,
    label = id,
    layer = 'Default',
    type = '#3b82f6'
) {
    return {
        id,
        body: { label, comment: layer, type },
        target: {
            selector: {
                type: 'FragmentSelector',
                value: 'xywh=pixel:1,2,3,4',
            },
        },
        version,
        created_by: 'user',
    };
}

const SLIDE_KEY = '0123456789ab';

describe('WsiAnnotationController', () => {
    // Viewers attach synchronously once the Annotorious chunk has loaded.
    beforeAll(() => loadAnnotorious());

    beforeEach(() => {
        jest.restoreAllMocks();
        window.localStorage.clear();
        global.fetch = jest.fn() as typeof fetch;
    });

    it('calls the service with the session cookie, the study and the CSRF header on writes', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
            if (init?.method === 'DELETE') {
                return { ok: true, status: 204 } as Response;
            }
            if (init?.method === 'POST' || init?.method === 'PUT') {
                return {
                    ok: true,
                    json: async () => apiAnnotation('a1', 2),
                } as Response;
            }
            return {
                ok: true,
                json: async () => [apiAnnotation('a1')],
            } as Response;
        });
        const controller = new WsiAnnotationController(
            'https://annotations.example/wsi/',
            'study 1'
        );

        controller.beginSlide(SLIDE_KEY);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(controller.annotations[0].id).toBe('a1');
        await (controller as any).createAnnotation({
            id: 'client-a',
            body: [],
            target: {
                source: SLIDE_KEY,
                selector: {
                    type: 'FragmentSelector',
                    value: 'xywh=pixel:1,2,3,4',
                },
            },
        });
        await (controller as any).updateAnnotation(controller.annotations[0]);
        await controller.removeAnnotation('a1');

        const calls = (global.fetch as jest.Mock).mock.calls as Array<
            [string, RequestInit]
        >;
        expect(calls.map(([, init]) => init.method || 'GET')).toEqual([
            'GET',
            'POST',
            'PUT',
            'DELETE',
        ]);
        const paths = calls.map(([url]) => new URL(url).pathname);
        expect(paths).toEqual([
            '/wsi/annotations',
            '/wsi/annotations',
            '/wsi/annotations/a1',
            '/wsi/annotations/a1',
        ]);
        calls.forEach(([url, init]) => {
            const query = new URL(url).searchParams;
            expect(query.getAll('studyId')).toEqual(['study 1']);
            expect(init.credentials).toBe('include');
            const headers = init.headers as Headers;
            expect(headers.has('Authorization')).toBe(false);
            const write = (init.method || 'GET') !== 'GET';
            expect(headers.get('X-Requested-With')).toBe(
                write ? 'XMLHttpRequest' : null
            );
            expect(headers.get('Content-Type')).toBe(
                init.body ? 'application/json' : null
            );
        });
        expect(new URL(calls[0][0]).searchParams.has('study_id')).toBe(false);
        expect(new URL(calls[0][0]).searchParams.get('slide_id')).toBe(
            SLIDE_KEY
        );
        expect(JSON.parse(calls[1][1].body as string).study_id).toBe('study 1');
    });

    it('sends nothing without a study', async () => {
        const controller = new WsiAnnotationController(
            'https://annotations.example',
            undefined
        );

        controller.beginSlide(SLIDE_KEY);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(global.fetch).not.toHaveBeenCalled();
        expect(controller.error).toBe('Unable to load annotations.');
    });

    it('sends the opaque slide key as the service slide_id on loads and writes', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
            if (init?.method === 'POST') {
                return {
                    ok: true,
                    json: async () => apiAnnotation('saved'),
                } as Response;
            }
            return { ok: true, json: async () => [] } as Response;
        });
        const controller = new WsiAnnotationController(
            'https://annotations.example',
            'study1'
        );

        controller.beginSlide(SLIDE_KEY);
        await new Promise(resolve => setTimeout(resolve, 0));
        await (controller as any).createAnnotation({
            id: 'client-a',
            body: [],
            target: {
                source: SLIDE_KEY,
                selector: {
                    type: 'FragmentSelector',
                    value: 'xywh=pixel:1,2,3,4',
                },
            },
        });

        const [load, create] = (global.fetch as jest.Mock).mock.calls;
        const loadUrl = new URL(load[0]);
        expect(loadUrl.searchParams.get('slide_id')).toBe(SLIDE_KEY);
        expect(loadUrl.search).not.toMatch(/slide_key|image_?id/i);
        const payload = JSON.parse(create[1].body);
        expect(payload.slide_id).toBe(SLIDE_KEY);
        expect(payload).not.toHaveProperty('slide_key');
        expect(JSON.stringify(payload)).not.toMatch(/image_?id/i);
    });

    it('ignores an out-of-order response from a previous slide', async () => {
        let resolveFirst!: (response: Response) => void;
        let resolveSecond!: (response: Response) => void;
        jest.spyOn(global, 'fetch')
            .mockImplementationOnce(
                () =>
                    new Promise(resolve => {
                        resolveFirst = resolve;
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise(resolve => {
                        resolveSecond = resolve;
                    })
            );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );

        controller.beginSlide('slide1');
        controller.beginSlide('slide2');
        await new Promise(resolve => setTimeout(resolve, 0));
        resolveSecond({
            ok: true,
            json: async () => [apiAnnotation('new')],
        } as Response);
        await new Promise(resolve => setTimeout(resolve, 0));
        resolveFirst({
            ok: true,
            json: async () => [apiAnnotation('old')],
        } as Response);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(
            controller.annotations.map(annotation => annotation.id)
        ).toEqual(['new']);
    });

    it('does not attach a delayed write to the next slide', async () => {
        let resolveWrite!: (response: Response) => void;
        const writeResponse = new Promise<Response>(resolve => {
            resolveWrite = resolve;
        });
        jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
            if (init?.method === 'POST') return writeResponse;
            return { ok: true, json: async () => [] } as Response;
        });
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );

        controller.beginSlide('slide-a');
        await new Promise(resolve => setTimeout(resolve, 0));
        const pendingWrite = (controller as any).createAnnotation({
            id: 'client-a',
            body: [
                {
                    type: 'TextualBody',
                    value: 'AI region',
                    purpose: 'commenting',
                },
            ],
            target: {
                source: 'slide-a',
                selector: {
                    type: 'FragmentSelector',
                    value: 'xywh=pixel:1,2,3,4',
                },
            },
            layerName: 'AI review',
            color: '#f5a623',
            colorName: 'AI review',
        });
        controller.beginSlide('slide-b');
        resolveWrite({
            ok: true,
            json: async () => apiAnnotation('saved-on-a'),
        } as Response);
        await pendingWrite;

        expect(controller.annotations).toEqual([]);
    });

    it('does not reload the next slide after a stale conflict response', async () => {
        let resolveUpdate!: (response: Response) => void;
        jest.spyOn(global, 'fetch').mockImplementation((url, init) => {
            if (init?.method === 'PUT') {
                return new Promise(resolve => {
                    resolveUpdate = resolve;
                });
            }
            return Promise.resolve({
                ok: true,
                json: async () => [],
            } as Response);
        });
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );

        controller.beginSlide('slide-a');
        await new Promise(resolve => setTimeout(resolve, 0));
        (controller as any).annotations = [
            (controller as any).fromApi(apiAnnotation('a1'), 'slide-a'),
        ];
        const update = (controller as any).updateAnnotation(
            (controller as any).annotations[0]
        );
        await new Promise(resolve => setTimeout(resolve, 0));
        controller.beginSlide('slide-b');
        resolveUpdate({ ok: false, status: 409 } as Response);
        await update;

        expect(controller.error).toBeNull();
        expect(controller.annotations).toEqual([]);
        expect(
            (global.fetch as jest.Mock).mock.calls.filter(
                call => call[1]?.method === undefined
            )
        ).toHaveLength(2);
    });

    it('asks a signed-out user to sign in and turns editing off', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: false,
            status: 401,
        } as Response);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );

        controller.beginSlide('slide1');
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(controller.loading).toBe(false);
        expect(controller.annotations).toEqual([]);
        expect(controller.accessIssue).toBe('signedOut');
        expect(controller.canEdit).toBe(false);
        expect(controller.error).toBe('Sign in to view and edit annotations.');
        controller.setTool('rectangle');
        expect(controller.activeTool).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('makes annotations read-only when a write is refused, without retrying', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) =>
            init?.method === 'PUT'
                ? ({ ok: false, status: 403 } as Response)
                : ({
                      ok: true,
                      json: async () => [apiAnnotation('a1')],
                  } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.beginSlide('slide1');
        await new Promise(resolve => setTimeout(resolve, 0));

        await controller.renameAnnotation('a1', 'renamed');

        expect(controller.accessIssue).toBe('forbidden');
        expect(controller.canEdit).toBe(false);
        expect(controller.error).toBe(
            'Annotations are read-only: you do not have access to this study.'
        );
        // The saved annotation stays; the refused edit is not reloaded or retried.
        expect(controller.annotations.map(item => item.body[0].value)).toEqual([
            'a1',
        ]);
        expect(
            (global.fetch as jest.Mock).mock.calls.map(
                ([, init]) => init?.method || 'GET'
            )
        ).toEqual(['GET', 'PUT']);

        // Further edits are not sent.
        await controller.removeAnnotation('a1');
        await controller.renameAnnotation('a1', 'again');
        expect(global.fetch).toHaveBeenCalledTimes(2);

        // A new study tries again.
        controller.setContext('https://tiles.example', 'study2');
        expect(controller.accessIssue).toBeNull();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('drops a refused new annotation', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) =>
            init?.method === 'POST'
                ? ({ ok: false, status: 403 } as Response)
                : ({ ok: true, json: async () => [] } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.beginSlide(SLIDE_KEY);
        await new Promise(resolve => setTimeout(resolve, 0));
        (controller as any).annotations = [
            {
                id: 'client-a',
                body: [
                    {
                        type: 'TextualBody',
                        value: 'new',
                        purpose: 'commenting',
                    },
                ],
                target: { source: SLIDE_KEY, selector: {} },
            },
        ];

        await (controller as any).createAnnotation(
            (controller as any).annotations[0]
        );

        expect(controller.annotations).toEqual([]);
        expect(controller.accessIssue).toBe('forbidden');
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('stores the server version after an update', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => apiAnnotation('a1', 2, 'renamed'),
        } as Response);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).annotations = [
            (controller as any).fromApi(apiAnnotation('a1', 1), 'slide1'),
        ];
        (controller as any).slideKey = 'slide1';

        await (controller as any).updateAnnotation(
            (controller as any).annotations[0]
        );

        expect(controller.annotations[0].version).toBe(2);
        expect((global.fetch as jest.Mock).mock.calls[0][1].body).toContain(
            '"version":1'
        );
    });

    it('applies the active layer and color and auto-labels native shapes', async () => {
        const handlers: Record<string, (...args: any[]) => void> = {};
        const annotator = {
            on: jest.fn((name: string, handler: (...args: any[]) => void) => {
                handlers[name] = handler;
            }),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setFilter: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            setEnabled: jest.fn(),
        };
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => apiAnnotation('saved', 1, 'Tumor 1'),
        } as Response);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        controller.addLayer('Tumor');
        controller.setActiveNamedColor('Tumor', '#ef4444');
        const viewerElement = document.createElement('div');
        controller.attachViewer({ element: viewerElement }, {}, 'slide1');
        jest.spyOn(
            controller as any,
            'imagePoint'
        ).mockImplementation((x: number, y: number) => ({ x, y }));

        controller.setTool('ellipse');
        viewerElement.dispatchEvent(
            new MouseEvent('pointerdown', { clientX: 10, clientY: 20 })
        );
        viewerElement.dispatchEvent(
            new MouseEvent('pointermove', { clientX: 30, clientY: 50 })
        );
        expect(controller.customDrawPreview).toMatchObject({
            tool: 'ellipse',
            start: { x: 10, y: 20 },
            current: { x: 30, y: 50 },
        });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(controller.customDrawPreview).toBeNull();

        handlers.createAnnotation({
            id: 'client-1',
            body: [],
            target: {
                source: 'slide1',
                selector: {
                    type: 'FragmentSelector',
                    value: 'xywh=pixel:1,2,3,4',
                },
            },
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        const payload = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[0][1].body
        );
        expect(payload.body).toEqual({
            label: 'Tumor 1',
            comment: '',
            type: 'Tumor|#ef4444',
            layer_name: 'Tumor',
            color: '#ef4444',
            provenance: null,
        });
        expect(controller.activeTool).toBeNull();
    });

    it('creates rectangles by drag and polygons by clicking points', async () => {
        const annotator = {
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setFilter: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            cancelDrawing: jest.fn(),
        };
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => apiAnnotation('saved'),
        } as Response);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        const viewerElement = document.createElement('div');
        const annotationCanvas = document.createElement('canvas');
        annotationCanvas.className = 'a9s-gl-canvas';
        viewerElement.appendChild(annotationCanvas);
        controller.attachViewer({ element: viewerElement }, {}, 'slide1');
        jest.spyOn(
            controller as any,
            'imagePoint'
        ).mockImplementation((x: number, y: number) => ({ x, y }));

        const pointer = (type: string, x: number, y: number) =>
            viewerElement.dispatchEvent(
                new MouseEvent(type, {
                    bubbles: true,
                    button: 0,
                    clientX: x,
                    clientY: y,
                })
            );

        const dragTools = [
            ['rectangle', '<rect'],
            ['ellipse', '<ellipse'],
            ['circle', '<ellipse'],
            ['line', '<line'],
        ] as const;
        for (const [tool] of dragTools) {
            controller.setTool(tool);
            pointer('pointerdown', 10, 20);
            pointer('pointermove', 60, 80);
            pointer('pointerup', 60, 80);
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(controller.activeTool).toBeNull();
            expect(viewerElement.style.cursor).toBe('');
            expect(annotationCanvas.style.pointerEvents).toBe('auto');
        }

        controller.setTool('polygon');
        for (const [x, y] of [
            [100, 100],
            [160, 100],
            [160, 160],
            [100, 100],
        ]) {
            pointer('pointerdown', x, y);
            pointer('pointerup', x, y);
        }
        await new Promise(resolve => setTimeout(resolve, 0));

        const requests = (global.fetch as jest.Mock).mock.calls.map(call =>
            JSON.parse(call[1].body)
        );
        expect(requests).toHaveLength(5);
        dragTools.forEach(([, selectorTag], index) => {
            expect(requests[index].target.selector.value).toContain(
                selectorTag
            );
        });
        expect(requests[2].target.selector.value).toContain('rx="25" ry="25"');
        expect(requests[4].target.selector.value).toContain('<polygon');
        expect(controller.activeTool).toBeNull();
        expect(viewerElement.style.cursor).toBe('');
        expect(annotationCanvas.style.pointerEvents).toBe('auto');
    });

    it('removes hidden layers from the Annotorious overlay', () => {
        const annotator = {
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            cancelSelected: jest.fn(),
        };
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(apiAnnotation('default-1'), 'slide1'),
            (controller as any).fromApi(
                apiAnnotation(
                    'tumor-1',
                    1,
                    'Tumor 1',
                    'Tumor',
                    'Tumor|#ef4444'
                ),
                'slide1'
            ),
        ];

        controller.attachViewer(
            { element: document.createElement('div') },
            {},
            'slide1'
        );
        const visibleAnnotationIds = () => {
            const calls = annotator.setAnnotations.mock.calls;
            return calls[calls.length - 1][0].map(
                (annotation: { id: string }) => annotation.id
            );
        };
        expect(visibleAnnotationIds()).toEqual(['default-1', 'tumor-1']);

        (controller as any).showAnnotationTooltip(
            (controller as any).annotations[1],
            new MouseEvent('click', { clientX: 10, clientY: 20 })
        );
        expect(controller.annotationTooltip?.layerName).toBe('Tumor');

        controller.toggleLayerVisibility('Tumor');
        expect(controller.visibleAnnotationCount).toBe(1);
        expect(visibleAnnotationIds()).toEqual(['default-1']);
        expect(annotator.cancelSelected).toHaveBeenCalledTimes(1);
        expect(controller.annotationTooltip).toBeNull();

        controller.toggleLayerVisibility('Tumor');
        expect(controller.visibleAnnotationCount).toBe(2);
        expect(visibleAnnotationIds()).toEqual(['default-1', 'tumor-1']);
    });

    it('keeps a hidden layer out of the overlay after annotations reload', async () => {
        const annotator = {
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            cancelSelected: jest.fn(),
        };
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => [
                apiAnnotation('default-1'),
                apiAnnotation(
                    'tumor-1',
                    1,
                    'Tumor 1',
                    'Tumor',
                    'Tumor|#ef4444'
                ),
            ],
        } as Response);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.toggleLayerVisibility('Tumor');
        controller.beginSlide('slide1');
        controller.attachViewer(
            { element: document.createElement('div') },
            {},
            'slide1'
        );

        await new Promise(resolve => setTimeout(resolve, 0));

        const calls = annotator.setAnnotations.mock.calls;
        expect(
            calls[calls.length - 1][0].map(
                (annotation: { id: string }) => annotation.id
            )
        ).toEqual(['default-1']);
        expect(controller.visibleAnnotationCount).toBe(1);
    });

    function attachDrawingController() {
        const annotator = {
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            cancelDrawing: jest.fn(),
        };
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        const viewerElement = document.createElement('div');
        controller.attachViewer({ element: viewerElement }, {}, 'slide1');
        jest.spyOn(
            controller as any,
            'imagePoint'
        ).mockImplementation((x: number, y: number) => ({ x, y }));
        const pointer = (type: string, x: number, y: number) =>
            viewerElement.dispatchEvent(
                new MouseEvent(type, {
                    bubbles: true,
                    button: 0,
                    clientX: x,
                    clientY: y,
                })
            );
        return { controller, pointer };
    }

    it('keeps a pending save when a conflicting update reloads the slide', async () => {
        let resolveCreate: (response: Response) => void = () => undefined;
        let createSignal: AbortSignal | undefined;
        jest.spyOn(global, 'fetch').mockImplementation(
            (_url: RequestInfo | URL, init?: RequestInit) => {
                if (init?.method === 'POST') {
                    createSignal = init.signal || undefined;
                    return new Promise<Response>(resolve => {
                        resolveCreate = resolve;
                    });
                }
                if (init?.method === 'PUT') {
                    return Promise.resolve({
                        ok: false,
                        status: 409,
                    } as Response);
                }
                return Promise.resolve({
                    ok: true,
                    json: async () => [apiAnnotation('a1', 2)],
                } as Response);
            }
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.beginSlide('slide1');
        await new Promise(resolve => setTimeout(resolve, 0));

        const create = (controller as any).createAnnotation({
            id: 'client-1',
            body: [],
            target: {
                source: 'slide1',
                selector: {
                    type: 'FragmentSelector',
                    value: 'xywh=pixel:1,2,3,4',
                },
            },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        await controller.renameAnnotation('a1', 'renamed');
        expect(createSignal?.aborted).toBe(false);

        resolveCreate({
            ok: true,
            json: async () => apiAnnotation('saved'),
        } as Response);
        await create;

        expect(controller.annotations.map(item => item.id)).toEqual([
            'a1',
            'saved',
        ]);
        expect(controller.error).toBe(
            'Annotation changed elsewhere; reloaded latest data.'
        );
    });

    it('reloads the current slide for a new study and drops the old one', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(
            (url: RequestInfo | URL) =>
                Promise.resolve({
                    ok: true,
                    json: async () =>
                        String(url).includes('studyId=study2')
                            ? [apiAnnotation('b1')]
                            : [apiAnnotation('a1')],
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.beginSlide('slide1');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(controller.annotations.map(item => item.id)).toEqual(['a1']);

        controller.setContext('https://tiles.example', 'study2');
        expect(controller.annotations).toEqual([]);
        expect(controller.loading).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(controller.annotations.map(item => item.id)).toEqual(['b1']);
        expect(
            (global.fetch as jest.Mock).mock.calls[1][0] as string
        ).toContain('studyId=study2');
    });

    it('clears the previous annotations when pending requests are invalidated', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => [apiAnnotation('a1')],
        } as Response);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.beginSlide('slide1');
        await new Promise(resolve => setTimeout(resolve, 0));

        controller.invalidatePendingRequests();

        expect(controller.annotations).toEqual([]);
        expect(controller.loading).toBe(false);
    });

    it('releases the drawing tool before the save completes', () => {
        jest.spyOn(global, 'fetch').mockReturnValue(
            new Promise<Response>(() => undefined)
        );
        const { controller, pointer } = attachDrawingController();

        controller.setTool('rectangle');
        pointer('pointerdown', 10, 20);
        pointer('pointerup', 60, 80);

        expect(controller.activeTool).toBeNull();
    });

    it('closes a polygon by double-click without duplicating the last vertex', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => apiAnnotation('saved'),
        } as Response);
        const { controller, pointer } = attachDrawingController();

        controller.setTool('polygon');
        for (const [x, y] of [
            [100, 100],
            [160, 100],
            [160, 160],
            [160, 160],
        ]) {
            pointer('pointerdown', x, y);
            pointer('pointerup', x, y);
        }
        pointer('dblclick', 160, 160);
        await new Promise(resolve => setTimeout(resolve, 0));

        const request = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[0][1].body
        );
        expect(request.target.selector.value).toContain(
            'points="100,100 160,100 160,160"'
        );
    });

    it('keeps the polygon preview when a click turns into a drag', () => {
        const { controller, pointer } = attachDrawingController();

        controller.setTool('polygon');
        pointer('pointerdown', 100, 100);
        pointer('pointerup', 100, 100);
        pointer('pointerdown', 160, 100);
        pointer('pointerup', 200, 160);

        expect(controller.customDrawPreview).toMatchObject({
            tool: 'polygon',
            points: [{ x: 100, y: 100 }],
        });
    });

    it('reads layer_name, and a legacy layer kept in comment', () => {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        const read = (body: Record<string, unknown>) =>
            (controller as any).fromApi(
                { ...apiAnnotation('a1'), body },
                'slide1'
            );

        // Written by this viewer: the layer and the note are separate.
        expect(
            read({
                label: 'x',
                comment: 'Check margin',
                layer_name: 'Tumor',
                color: '#ef4444',
            })
        ).toMatchObject({ layerName: 'Tumor', note: 'Check margin' });
        expect(
            read({
                label: 'x',
                comment: 'One-line note',
                layer_name: 'Default',
                color: '#2F80ED',
            })
        ).toMatchObject({ layerName: 'Default', note: 'One-line note' });
        // Written before layer_name: the service stored its defaults.
        expect(
            read({
                label: 'x',
                comment: 'Stroma',
                type: 'Stroma|#22c55e',
                layer_name: 'Default',
                color: '#2f80ed',
            })
        ).toMatchObject({
            layerName: 'Stroma',
            note: '',
            color: '#22c55e',
        });
        expect(read({ label: 'x', comment: 'Stroma' })).toMatchObject({
            layerName: 'Stroma',
            note: '',
        });
    });

    it('round-trips a note on a row with provenance but no layer or color', async () => {
        // Another writer sent no layer_name or color: the service stored its
        // defaults. The one-line comment stays a note through an edit.
        const stored = {
            label: 'Mitosis',
            comment: 'Check the margin',
            type: '',
            layer_name: 'Default',
            color: '#2f80ed',
            provenance: { source: 'script', run: 'r1' },
        };
        jest.spyOn(global, 'fetch').mockImplementation(
            async (_url, init) =>
                ({
                    ok: true,
                    json: async () => ({
                        ...apiAnnotation('a1', 2),
                        body: JSON.parse(init!.body as string).body,
                    }),
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                { ...apiAnnotation('a1'), body: stored },
                'slide1'
            ),
        ];
        expect(controller.annotations[0]).toMatchObject({
            layerName: 'Default',
            note: 'Check the margin',
        });

        await controller.renameAnnotation('a1', 'Mitotic figure');

        const sent = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[0][1].body
        );
        expect(sent.body).toMatchObject({
            label: 'Mitotic figure',
            comment: 'Check the margin',
            layer_name: 'Default',
            provenance: { source: 'script', run: 'r1' },
        });
        expect(controller.annotations[0]).toMatchObject({
            note: 'Check the margin',
            version: 2,
        });
    });

    it("keeps a legacy row's comment on an edit until its note is edited", async () => {
        jest.spyOn(global, 'fetch').mockImplementation(
            async (_url, init) =>
                ({
                    ok: true,
                    json: async () => ({
                        ...apiAnnotation('a1', 2),
                        body: JSON.parse(init!.body as string).body,
                    }),
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                {
                    ...apiAnnotation('a1'),
                    body: {
                        label: 'x',
                        comment: 'Stroma',
                        type: 'Stroma|#22c55e',
                        layer_name: 'Default',
                        color: '#2f80ed',
                        provenance: null,
                    },
                },
                'slide1'
            ),
        ];
        expect(controller.annotations[0]).toMatchObject({
            layerName: 'Stroma',
            note: '',
        });

        await controller.renameAnnotation('a1', 'Renamed');
        const sentFirst = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[0][1].body
        );
        // The stored comment goes back as it was: never an empty note.
        expect(sentFirst.body).toMatchObject({
            label: 'Renamed',
            comment: 'Stroma',
            layer_name: 'Stroma',
        });

        await controller.setAnnotationNote('a1', 'Now a real note');
        const sentSecond = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[1][1].body
        );
        expect(sentSecond.body).toMatchObject({
            comment: 'Now a real note',
            layer_name: 'Stroma',
        });
    });

    it('keeps the note and provenance when an edit is saved', async () => {
        const provenance = { source: 'agent', proposal_id: 'p1' };
        jest.spyOn(global, 'fetch').mockImplementation(
            async () =>
                ({
                    ok: true,
                    json: async () => ({
                        ...apiAnnotation('a1', 2, 'renamed'),
                        body: {
                            label: 'renamed',
                            comment: 'note',
                            layer_name: 'Tumor',
                            color: '#ef4444',
                            type: 'Tumor|#ef4444',
                            provenance,
                        },
                    }),
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                {
                    ...apiAnnotation('a1'),
                    body: {
                        label: 'old',
                        comment: 'note',
                        layer_name: 'Tumor',
                        color: '#ef4444',
                        type: 'Tumor|#ef4444',
                        provenance,
                    },
                },
                'slide1'
            ),
        ];

        await controller.renameAnnotation('a1', 'renamed');

        const sent = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[0][1].body
        );
        expect(sent.body).toEqual({
            label: 'renamed',
            comment: 'note',
            type: 'Tumor|#ef4444',
            layer_name: 'Tumor',
            color: '#ef4444',
            provenance,
        });
        expect(controller.annotations[0]).toMatchObject({
            layerName: 'Tumor',
            note: 'note',
            provenance,
        });
    });

    const agentBody = {
        label: 'AI tumor',
        comment: '',
        layer_name: 'AI review',
        color: '#ef4444',
        type: 'AI review|#ef4444',
        provenance: { source: 'precomputed', model: 'm1' },
    };

    function reviewController(user = 'reviewer') {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.setCurrentUser(user);
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                {
                    ...apiAnnotation('ai-1', 3),
                    body: agentBody,
                    created_by: 'loader',
                },
                'slide1'
            ),
            (controller as any).fromApi(
                {
                    ...apiAnnotation('ai-2', 1),
                    body: agentBody,
                    created_by: 'loader',
                },
                'slide1'
            ),
            (controller as any).fromApi(
                { ...apiAnnotation('theirs'), created_by: 'loader' },
                'slide1'
            ),
            (controller as any).fromApi(
                { ...apiAnnotation('mine'), created_by: user },
                'slide1'
            ),
        ];
        return controller;
    }

    it("lets any user review another user's AI annotation with the review route", async () => {
        jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
            const sent = JSON.parse(init!.body as string);
            const id = new URL(url as string).pathname.split('/')[2];
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    ...apiAnnotation(id, sent.version + 1),
                    created_by: 'loader',
                    body: {
                        ...agentBody,
                        provenance: {
                            ...agentBody.provenance,
                            review_status:
                                sent.decision === 'accept'
                                    ? 'accepted'
                                    : 'rejected',
                            reviewed_by: 'reviewer',
                        },
                    },
                }),
            } as Response;
        });
        const controller = reviewController();
        const byId = (id: string) =>
            controller.annotations.find(item => item.id === id)!;
        expect(controller.canReview(byId('ai-1'))).toBe(true);
        expect(controller.canModify(byId('ai-1'))).toBe(false);
        expect(controller.canModify(byId('theirs'))).toBe(false);
        expect(controller.canReview(byId('theirs'))).toBe(false);
        expect(controller.canModify(byId('mine'))).toBe(true);
        expect(controller.unreviewedAiCount).toBe(2);

        await controller.acceptAnnotation('ai-1');
        const [acceptUrl, acceptInit] = (global.fetch as jest.Mock).mock
            .calls[0] as [string, RequestInit];
        expect(acceptInit.method).toBe('POST');
        expect(new URL(acceptUrl).pathname).toBe('/annotations/ai-1/review');
        expect(new URL(acceptUrl).searchParams.get('studyId')).toBe('study1');
        expect((acceptInit.headers as Headers).get('X-Requested-With')).toBe(
            'XMLHttpRequest'
        );
        expect(JSON.parse(acceptInit.body as string)).toEqual({
            decision: 'accept',
            version: 3,
        });
        expect(byId('ai-1').version).toBe(4);
        expect(byId('ai-1').provenance).toMatchObject({
            review_status: 'accepted',
        });
        expect(controller.reviewRoute).toBe(true);
        expect(controller.unreviewedAiCount).toBe(1);

        await controller.rejectAnnotation('ai-2');
        const [rejectUrl, rejectInit] = (global.fetch as jest.Mock).mock
            .calls[1] as [string, RequestInit];
        expect(new URL(rejectUrl).pathname).toBe('/annotations/ai-2/review');
        expect(JSON.parse(rejectInit.body as string)).toEqual({
            decision: 'reject',
            version: 1,
        });
        expect(controller.annotations.map(item => item.id)).toEqual([
            'ai-1',
            'theirs',
            'mine',
        ]);
        expect(controller.error).toBeNull();
        // Reviews are not on the undo history.
        expect(controller.canUndo).toBe(false);
    });

    it('falls back to the creator-only update and delete without a review route', async () => {
        const noRoute = {
            ok: false,
            status: 404,
            clone() {
                return this;
            },
            json: async () => ({ detail: 'Not Found' }),
        };
        jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
            if (init?.method === 'PUT') {
                const sent = JSON.parse(init.body as string);
                return {
                    ok: true,
                    json: async () => ({
                        ...apiAnnotation('ai-1', 4),
                        created_by: 'loader',
                        body: sent.body,
                    }),
                } as Response;
            }
            if (init?.method === 'DELETE') {
                return { ok: true, status: 204 } as Response;
            }
            return (noRoute as unknown) as Response;
        });

        // Another user's AI annotation cannot be reviewed without the route.
        const other = reviewController('reviewer');
        await other.acceptAnnotation('ai-1');
        expect(other.reviewRoute).toBe(false);
        expect(other.error).toBe(WSI_REVIEW_UNSUPPORTED_MESSAGE);
        expect(
            (global.fetch as jest.Mock).mock.calls.map(
                ([, init]) => init.method
            )
        ).toEqual(['POST']);
        expect(other.canReview(other.annotations[1])).toBe(false);

        // Its creator still accepts with a versioned PUT and rejects by deleting.
        (global.fetch as jest.Mock).mockClear();
        const creator = reviewController('loader');
        await creator.acceptAnnotation('ai-1');
        const calls = (global.fetch as jest.Mock).mock.calls as Array<
            [string, RequestInit]
        >;
        expect(calls.map(([, init]) => init.method)).toEqual(['POST', 'PUT']);
        const sent = JSON.parse(calls[1][1].body as string);
        expect(sent.version).toBe(3);
        expect(sent.body.provenance).toMatchObject({
            source: 'precomputed',
            review_status: 'accepted',
        });
        // Done: a note on how it was recorded, not an error, and not undoable.
        expect(creator.error).toBeNull();
        expect(creator.notice).toBe(WSI_REVIEW_FALLBACK_NOTICE.accept);
        expect(creator.undoStack).toEqual([]);

        await creator.rejectAnnotation('ai-2');
        expect(calls.map(([, init]) => init.method)).toEqual([
            'POST',
            'PUT',
            'DELETE',
        ]);
        expect(new URL(calls[2][0]).pathname).toBe('/annotations/ai-2');
        expect(creator.annotations.map(item => item.id)).not.toContain('ai-2');
        expect(creator.error).toBeNull();
        expect(creator.notice).toBe(WSI_REVIEW_FALLBACK_NOTICE.reject);
        expect(creator.undoStack).toEqual([]);
    });

    it('falls back without a review route when the service answers 405', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
            if (init?.method === 'DELETE') {
                return { ok: true, status: 204 } as Response;
            }
            return { ok: false, status: 405 } as Response;
        });
        const creator = reviewController('loader');
        expect(await creator.rejectAnnotation('ai-1')).toBeUndefined();
        expect(creator.reviewRoute).toBe(false);
        const methods = (global.fetch as jest.Mock).mock.calls.map(
            ([, init]) => init.method
        );
        expect(methods).toEqual(['POST', 'DELETE']);
        expect(creator.annotations.map(item => item.id)).not.toContain('ai-1');
        expect(creator.notice).toBe(WSI_REVIEW_FALLBACK_NOTICE.reject);
    });

    it("does not decide the review route from a 404 that is not the service's JSON", async () => {
        const responses: any[] = [
            {
                ok: false,
                status: 404,
                clone() {
                    return this;
                },
                json: async () => {
                    throw new SyntaxError('Unexpected token <');
                },
            },
            { ok: true, json: async () => [] },
        ];
        jest.spyOn(global, 'fetch').mockImplementation(
            async () => responses.shift() as Response
        );
        const controller = reviewController('loader');
        await controller.acceptAnnotation('ai-1');
        expect(controller.reviewRoute).toBeNull();
        expect(controller.error).toBe('Unable to save the review.');
        // No fallback write was sent.
        expect(
            (global.fetch as jest.Mock).mock.calls.map(
                ([, init]) => init?.method || 'GET'
            )
        ).toEqual(['POST', 'GET']);
    });

    it('reloads when the reviewed annotation is gone or changed', async () => {
        const responses: any[] = [
            {
                ok: false,
                status: 404,
                clone() {
                    return this;
                },
                json: async () => ({ detail: 'Annotation not found' }),
            },
            { ok: true, json: async () => [] },
            {
                ok: false,
                status: 409,
                clone() {
                    return this;
                },
                json: async () => ({ detail: 'Version conflict' }),
            },
            { ok: true, json: async () => [] },
        ];
        jest.spyOn(global, 'fetch').mockImplementation(
            async () => responses.shift() as Response
        );
        const controller = reviewController();
        await controller.acceptAnnotation('ai-1');
        expect(controller.reviewRoute).toBeNull();
        expect(controller.error).toBe(
            'The annotation was deleted elsewhere; reloaded latest data.'
        );

        (controller as any).annotations = reviewController().annotations;
        await controller.rejectAnnotation('ai-2');
        expect(controller.error).toBe(
            'Annotation changed elsewhere; reloaded latest data.'
        );
    });

    it('offers edit and delete on every annotation when the user is unknown', () => {
        const controller = reviewController();
        controller.setCurrentUser(undefined);
        expect(
            controller.annotations.every(item => controller.canModify(item))
        ).toBe(true);
    });

    it('does not show AI annotations that were rejected in review', async () => {
        const body = (provenance: Record<string, unknown>) => ({
            label: 'Tumor',
            layer_name: 'Model',
            color: '#ef4444',
            provenance,
        });
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => [
                {
                    ...apiAnnotation('kept'),
                    body: body({ source: 'precomputed' }),
                },
                {
                    ...apiAnnotation('gone'),
                    body: body({
                        source: 'precomputed',
                        review_status: 'rejected',
                    }),
                },
            ],
        } as Response);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.beginSlide(SLIDE_KEY);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(controller.annotations.map(item => item.id)).toEqual(['kept']);
        expect(controller.unreviewedAiCount).toBe(1);
    });

    it('hides unreviewed AI annotations on request', () => {
        const annotator = {
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            cancelSelected: jest.fn(),
        };
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                {
                    ...apiAnnotation('ai'),
                    body: {
                        label: 'AI',
                        layer_name: 'Default',
                        color: '#ef4444',
                        provenance: { source: 'agent' },
                    },
                },
                'slide1'
            ),
            (controller as any).fromApi(apiAnnotation('mine'), 'slide1'),
        ];
        controller.attachViewer(
            { element: document.createElement('div') },
            {},
            'slide1'
        );
        const shownIds = () =>
            annotator.setAnnotations.mock.calls[
                annotator.setAnnotations.mock.calls.length - 1
            ][0].map((annotation: { id: string }) => annotation.id);
        expect(shownIds()).toEqual(['ai', 'mine']);

        controller.toggleHideUnreviewedAi();
        expect(shownIds()).toEqual(['mine']);
        expect(controller.visibleAnnotationCount).toBe(1);
        expect(annotator.cancelSelected).toHaveBeenCalled();

        controller.toggleHideUnreviewedAi();
        expect(shownIds()).toEqual(['ai', 'mine']);
    });

    it("keeps the study editable when the service refuses another user's annotation", async () => {
        const refusal = {
            ok: false,
            status: 403,
            json: async () => ({
                detail: 'Only the creator may update this annotation',
            }),
        };
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ...refusal,
            clone: () => refusal,
        } as any);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(apiAnnotation('theirs'), 'slide1'),
        ];

        await controller.renameAnnotation('theirs', 'renamed');

        expect(controller.accessIssue).toBeNull();
        expect(controller.canEdit).toBe(true);
        expect(controller.error).toBe(
            'Only its creator can change this annotation.'
        );
        expect(controller.annotations[0].body[0].value).toBe('theirs');
    });

    it('shares new annotations by default, or keeps them private', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(
            async (_url, init) =>
                ({
                    ok: true,
                    json: async () => ({
                        ...apiAnnotation('saved'),
                        visible_to: JSON.parse(init!.body as string).visible_to,
                    }),
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = SLIDE_KEY;
        const draft = (id: string) => ({
            id,
            body: [],
            target: {
                source: SLIDE_KEY,
                selector: {
                    type: 'FragmentSelector',
                    value: 'xywh=pixel:1,2,3,4',
                },
            },
        });
        expect(controller.defaultShared).toBe(true);

        await (controller as any).createAnnotation(draft('client-1'));
        controller.setDefaultShared(false);
        await (controller as any).createAnnotation(draft('client-2'));

        const sent = (global.fetch as jest.Mock).mock.calls.map(
            ([, init]) => JSON.parse(init.body).visible_to
        );
        expect(sent).toEqual([[], null]);
        expect(controller.annotations[0].visibleTo).toBeNull();
        // The choice is remembered for the next viewer.
        expect(
            new WsiAnnotationController('https://tiles.example', 'study1')
                .defaultShared
        ).toBe(false);
    });

    it('switches an annotation between private and shared with its version', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(
            async (_url, init) =>
                ({
                    ok: true,
                    json: async () => ({
                        ...apiAnnotation('a1', 2),
                        visible_to: JSON.parse(init!.body as string).visible_to,
                    }),
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                { ...apiAnnotation('a1'), visible_to: [] },
                'slide1'
            ),
        ];

        await controller.setAnnotationShared('a1', false);

        const sent = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[0][1].body
        );
        expect(sent).toMatchObject({ visible_to: null, version: 1 });
        expect(controller.annotations[0].visibleTo).toBeNull();

        // A row without visible_to keeps its stored value on an update.
        (controller as any).annotations = [
            (controller as any).fromApi(apiAnnotation('a2'), 'slide1'),
        ];
        await controller.renameAnnotation('a2', 'renamed');
        expect(
            JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body)
        ).not.toHaveProperty('visible_to');
    });

    it('measures annotations with the slide scale, and shows a live line length', () => {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        const line = (controller as any).fromApi(
            {
                ...apiAnnotation('line'),
                target: {
                    selector: {
                        type: 'SvgSelector',
                        value:
                            '<svg><line x1="0" y1="0" x2="300" y2="400" /></svg>',
                    },
                },
            },
            'slide1'
        );
        expect(controller.measurementOf(line)).toEqual({
            unit: 'px',
            length: 500,
        });

        let mpp: { x: number; y: number } | undefined = { x: 0.5, y: 0.5 };
        controller.setMppProvider(() => mpp);
        expect(controller.measurementOf(line)).toEqual({
            unit: 'um',
            length: 250,
        });
        mpp = { x: 0, y: 0 };
        expect(controller.mpp).toBeUndefined();
        mpp = { x: 0.25, y: 0.25 };

        const viewerElement = document.createElement('div');
        (createOSDAnnotator as jest.Mock).mockReturnValue({
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            cancelDrawing: jest.fn(),
        });
        controller.attachViewer({ element: viewerElement }, {}, 'slide1');
        jest.spyOn(controller as any, 'imagePoint').mockImplementation(
            (x: number, y: number) => ({
                x: x * 10,
                y: y * 10,
            })
        );
        controller.setTool('line');
        const pointer = (type: string, x: number, y: number) =>
            viewerElement.dispatchEvent(
                new MouseEvent(type, { button: 0, clientX: x, clientY: y })
            );
        pointer('pointerdown', 0, 0);
        pointer('pointermove', 30, 40);
        // 500 image pixels at 0.25 µm per pixel.
        expect(controller.drawPreviewMeasurement).toBe('Length 125 µm');
        controller.setTool('rectangle');
        pointer('pointerdown', 0, 0);
        pointer('pointermove', 10, 20);
        // 100 x 200 image pixels at 0.25 µm per pixel.
        expect(controller.drawPreviewMeasurement).toBe('Area 1,250 µm²');
    });

    it('saves a note in comment with the version, apart from the label', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(
            async (_url, init) =>
                ({
                    ok: true,
                    json: async () => ({
                        ...apiAnnotation('a1', 2),
                        body: JSON.parse(init!.body as string).body,
                    }),
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                apiAnnotation('a1', 1, 'Tumor 1', 'Tumor'),
                'slide1'
            ),
        ];

        await controller.setAnnotationNote('a1', 'Necrotic center.\nRecheck.');
        // An unchanged note is not saved again.
        await controller.setAnnotationNote('a1', 'Necrotic center.\nRecheck.');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[0][1].body
        );
        expect(sent.version).toBe(1);
        expect(sent.body).toMatchObject({
            label: 'Tumor 1',
            comment: 'Necrotic center.\nRecheck.',
            layer_name: 'Tumor',
        });
        expect(controller.annotations[0]).toMatchObject({
            note: 'Necrotic center.\nRecheck.',
            layerName: 'Tumor',
            version: 2,
        });
    });

    it('filters the list by layer, author, text and AI, and counts layers and labels', () => {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        const item = (
            id: string,
            label: string,
            layer: string,
            creator: string,
            extra: Record<string, unknown> = {}
        ) =>
            (controller as any).fromApi(
                {
                    ...apiAnnotation(id),
                    created_by: creator,
                    body: {
                        label,
                        layer_name: layer,
                        color: '#ef4444',
                        // Auto-labels: a color's name and a number.
                        type: `${layer}|#ef4444`,
                        ...extra,
                    },
                },
                'slide1'
            );
        (controller as any).annotations = [
            item('t1', 'Tumor 1', 'Tumor', 'ana'),
            item('t2', 'Tumor 2', 'Tumor', 'ben', { comment: 'margin' }),
            item('s1', 'Stroma 1', 'Stroma', 'ana'),
            item('ai', 'Tumor', 'AI', 'ana', {
                provenance: { source: 'agent' },
            }),
        ];
        const ids = () => controller.listedAnnotations.map(a => a.id);

        expect(controller.authors).toEqual(['ana', 'ben']);
        expect(Array.from(controller.listedLayerCounts)).toEqual([
            ['Tumor', 2],
            ['Stroma', 1],
            ['AI', 1],
        ]);
        expect(Array.from(controller.listedLabelCounts)).toEqual([
            ['Tumor', 3],
            ['Stroma', 1],
        ]);

        controller.setListFilter({ layer: 'Tumor' });
        expect(ids()).toEqual(['t1', 't2']);
        controller.setListFilter({ author: 'ben' });
        expect(ids()).toEqual(['t2']);
        controller.clearListFilter();
        controller.setListFilter({ text: 'MARGIN' });
        expect(ids()).toEqual(['t2']);
        controller.setListFilter({ text: '', ai: 'unreviewed' });
        expect(ids()).toEqual(['ai']);
        controller.setListFilter({ ai: 'human' });
        expect(ids()).toEqual(['t1', 't2', 's1']);
        expect(Array.from(controller.listedLabelCounts)).toEqual([
            ['Tumor', 2],
            ['Stroma', 1],
        ]);

        // A new slide starts unfiltered.
        controller.beginSlide('slide2');
        expect(controller.listFilter.ai).toBe('all');
        expect(labelTerm('Necrosis 12', ['Necrosis'])).toBe('Necrosis');
        expect(labelTerm('Necrosis 12')).toBe('Necrosis 12');
        expect(labelTerm('42', ['42'])).toBe('42');
    });

    it('keeps graded labels apart, and counts only auto-labels under their base', () => {
        configureWsiViewerRuntime({
            buildApiUrl: path => path,
            annotations: {
                apiUrl: 'https://tiles.example',
                labelVocabulary: ['Grade 1', 'Grade 2'],
            },
        });
        try {
            const controller = new WsiAnnotationController(
                'https://tiles.example',
                'study1'
            );
            const item = (id: string, label: string, type = '') =>
                (controller as any).fromApi(
                    {
                        ...apiAnnotation(id),
                        body: {
                            label,
                            layer_name: 'Default',
                            color: '#ef4444',
                            type,
                        },
                    },
                    'slide1'
                );
            (controller as any).annotations = [
                item('g1', 'Grade 1'),
                item('g2', 'Grade 2'),
                item('g3', 'Grade 2'),
                item('p3', 'Gleason pattern 3'),
                item('p4', 'Gleason pattern 4'),
                item('t1', 'Tumor 1', 'Tumor|#ef4444'),
                item('t2', 'Tumor 2', 'Tumor|#ef4444'),
            ];
            expect(Array.from(controller.listedLabelCounts)).toEqual([
                ['Grade 1', 1],
                ['Grade 2', 2],
                ['Gleason pattern 3', 1],
                ['Gleason pattern 4', 1],
                ['Tumor', 2],
            ]);
            // Even a vocabulary term that looks like an auto-label.
            expect(labelTerm('Tumor 1', ['Tumor'], ['Tumor 1'])).toBe(
                'Tumor 1'
            );
            const classes = controller
                .exportGeoJson('all')
                .features.map(
                    (feature: any) => feature.properties.classification.name
                );
            expect(classes).toEqual([
                'Grade 1',
                'Grade 2',
                'Grade 2',
                'Gleason pattern 3',
                'Gleason pattern 4',
                'Tumor',
                'Tumor',
            ]);
        } finally {
            resetWsiViewerRuntime();
        }
    });

    it('zooms the slide to an annotation with a margin', () => {
        (createOSDAnnotator as jest.Mock).mockReturnValue({
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
        });
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                {
                    ...apiAnnotation('box'),
                    target: {
                        selector: {
                            type: 'FragmentSelector',
                            value: 'xywh=pixel:1000,2000,400,200',
                        },
                    },
                },
                'slide1'
            ),
        ];
        const viewport = {
            imageToViewportRectangle: jest.fn(rect => ({ viewport: rect })),
            fitBounds: jest.fn(),
        };
        class Rect {
            constructor(
                public x: number,
                public y: number,
                public width: number,
                public height: number
            ) {}
        }
        controller.attachViewer(
            { element: document.createElement('div'), viewport },
            { Rect },
            'slide1'
        );

        expect(controller.zoomToAnnotation('box')).toBe(true);
        expect(viewport.imageToViewportRectangle).toHaveBeenCalledWith(
            new Rect(800, 1800, 800, 600)
        );
        expect(viewport.fitBounds).toHaveBeenCalledWith({
            viewport: new Rect(800, 1800, 800, 600),
        });
        expect(controller.zoomToAnnotation('missing')).toBe(false);
    });

    it('drops points on click, counts them at once and keeps the tool on', async () => {
        const annotator = {
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            cancelDrawing: jest.fn(),
        };
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        let saved = 0;
        jest.spyOn(global, 'fetch').mockImplementation(
            async (_url, init) =>
                ({
                    ok: true,
                    status: 201,
                    json: async () =>
                        JSON.parse(init!.body as string).annotations.map(
                            (item: any) => ({
                                ...item,
                                id: `saved-${++saved}`,
                                version: 1,
                                created_by: 'user',
                            })
                        ),
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = SLIDE_KEY;
        controller.addLayer('Counts');
        controller.addNamedColor('Mitosis', '#ef4444');
        const viewerElement = document.createElement('div');
        controller.attachViewer({ element: viewerElement }, {}, SLIDE_KEY);
        jest.spyOn(
            controller as any,
            'imagePoint'
        ).mockImplementation((x: number, y: number) => ({ x, y }));
        const click = (x: number, y: number, toX = x, toY = y) => {
            viewerElement.dispatchEvent(
                new MouseEvent('pointerdown', {
                    button: 0,
                    clientX: x,
                    clientY: y,
                })
            );
            viewerElement.dispatchEvent(
                new MouseEvent('pointerup', {
                    button: 0,
                    clientX: toX,
                    clientY: toY,
                })
            );
        };

        controller.setTool('point');
        click(10, 20);
        click(30, 40, 32, 41);
        // A drag pans the slide instead.
        click(50, 50, 120, 90);

        expect(controller.activeTool).toBe('point');
        expect(controller.activePointCount).toBe(2);
        expect(controller.pointTally).toEqual([
            { layer: 'Counts', label: 'Mitosis', color: '#ef4444', count: 2 },
        ]);
        // Points dropped close together are saved in one batch request.
        expect(global.fetch).not.toHaveBeenCalled();
        await controller.flushPoints();
        const calls = (global.fetch as jest.Mock).mock.calls;
        expect(calls).toHaveLength(1);
        expect(new URL(calls[0][0]).pathname).toBe('/annotations/batch');
        const bodies = JSON.parse(calls[0][1].body).annotations;
        expect(bodies).toHaveLength(2);
        expect(bodies[0].target.selector).toEqual({
            type: 'SvgSelector',
            value: '<svg><circle cx="10" cy="20" r="0" /></svg>',
        });
        expect(bodies[0].body).toMatchObject({
            label: 'Mitosis',
            layer_name: 'Counts',
        });
        expect(controller.annotations.map(item => item.id)).toEqual([
            'saved-1',
            'saved-2',
        ]);
        expect(controller.pointTally[0].count).toBe(2);
        // Points never go to Annotorious.
        annotator.setAnnotations.mock.calls.forEach(([shapes]) =>
            expect(shapes).toEqual([])
        );
    });

    it('writes a point as a circle of radius 0, rounded to 0.01 pixel', () => {
        expect(pointSelectorSvg({ x: 10.126, y: 20.004 })).toBe(
            '<svg><circle cx="10.13" cy="20" r="0" /></svg>'
        );
    });

    it('stays fast with hundreds of points', () => {
        const annotator = {
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
        };
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        jest.spyOn(global, 'fetch').mockImplementation(
            () => new Promise(() => undefined)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = SLIDE_KEY;
        (controller as any).annotations = Array.from({ length: 50 }, (_, i) =>
            (controller as any).fromApi(apiAnnotation(`shape-${i}`), SLIDE_KEY)
        );
        controller.attachViewer(
            { element: document.createElement('div') },
            {},
            SLIDE_KEY
        );
        const setCalls = annotator.setAnnotations.mock.calls.length;

        const started = Date.now();
        for (let i = 0; i < 500; i++) {
            (controller as any).createPoint({ x: i, y: i });
        }
        const elapsed = Date.now() - started;

        expect(controller.pointTally[0].count).toBe(500);
        // Annotorious keeps its 50 shapes; points are drawn on their own layer.
        expect(annotator.setAnnotations.mock.calls.length).toBe(setCalls);
        expect(elapsed).toBeLessThan(2000);
    });

    it('saves a freehand stroke as a simplified polygon and a brush stroke as its outline', async () => {
        (createOSDAnnotator as jest.Mock).mockReturnValue({
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            cancelDrawing: jest.fn(),
        });
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => apiAnnotation('saved'),
        } as Response);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        const viewerElement = document.createElement('div');
        controller.attachViewer({ element: viewerElement }, {}, 'slide1');
        // Two image pixels per screen pixel.
        jest.spyOn(controller as any, 'imagePoint').mockImplementation(
            (x: number, y: number) => ({
                x: x * 2,
                y: y * 2,
            })
        );
        const pointer = (type: string, x: number, y: number) =>
            viewerElement.dispatchEvent(
                new MouseEvent(type, { button: 0, clientX: x, clientY: y })
            );
        // A square traced with many samples along each side.
        const trace = () => {
            pointer('pointerdown', 0, 0);
            for (const [x0, y0, x1, y1] of [
                [0, 0, 100, 0],
                [100, 0, 100, 100],
                [100, 100, 0, 100],
                [0, 100, 0, 0],
            ]) {
                for (let t = 1; t <= 20; t++) {
                    pointer(
                        'pointermove',
                        x0 + ((x1 - x0) * t) / 20,
                        y0 + ((y1 - y0) * t) / 20
                    );
                }
            }
        };

        controller.setTool('freehand');
        trace();
        expect(controller.customDrawPreview?.points?.length).toBe(81);
        pointer('pointerup', 0, 0);
        await new Promise(resolve => setTimeout(resolve, 0));
        let sent = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[0][1].body
        );
        expect(sent.target.selector.value).toBe(
            '<svg><polygon points="0,0 200,0 200,200 0,200" /></svg>'
        );
        expect(controller.activeTool).toBeNull();

        controller.setTool('brush');
        controller.setBrushWidth(10);
        pointer('pointerdown', 0, 0);
        pointer('pointermove', 50, 0);
        pointer('pointerup', 100, 0);
        await new Promise(resolve => setTimeout(resolve, 0));
        sent = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
        const shape = parseAnnotationShape(sent.target.selector)!;
        expect(shape.kind).toBe('polygon');
        const ys = (shape as any).points.map((p: any) => p.y);
        // 10 screen pixels wide at 2 image pixels per screen pixel.
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 1);

        // A scribble with no area is dropped.
        controller.setTool('freehand');
        pointer('pointerdown', 0, 0);
        pointer('pointermove', 50, 0);
        pointer('pointerup', 100, 0);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('paints the same width of tissue in µm at every zoom when the slide has a scale', async () => {
        (createOSDAnnotator as jest.Mock).mockReturnValue({
            on: jest.fn(),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
            setDrawingEnabled: jest.fn(),
            cancelDrawing: jest.fn(),
        });
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => apiAnnotation('saved'),
        } as Response);
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.setMppProvider(() => ({ x: 0.25, y: 0.25 }));
        (controller as any).slideKey = 'slide1';
        const viewerElement = document.createElement('div');
        controller.attachViewer({ element: viewerElement }, {}, 'slide1');
        let imagePerScreen = 2;
        jest.spyOn(controller as any, 'imagePoint').mockImplementation(
            (x: number, y: number) => ({
                x: x * imagePerScreen,
                y: y * imagePerScreen,
            })
        );
        const pointer = (type: string, x: number, y: number) =>
            viewerElement.dispatchEvent(
                new MouseEvent(type, { button: 0, clientX: x, clientY: y })
            );

        controller.setTool('brush');
        expect(controller.brushInMicrons).toBe(true);
        expect(controller.brushWidth).toBe(50);
        controller.setBrushWidth(25);
        expect(controller.brushWidthUm).toBe(25);

        const bandHeights: number[] = [];
        for (const zoom of [2, 8]) {
            imagePerScreen = zoom;
            controller.setTool('brush');
            pointer('pointermove', 10, 10);
            // 25 µm at 0.25 µm/px is 100 image pixels: 50 or 12.5 on screen.
            expect(controller.brushCursor!.diameter).toBeCloseTo(100 / zoom, 5);
            pointer('pointerdown', 0, 0);
            expect(controller.customDrawPreview!.strokeWidth).toBeCloseTo(
                100 / zoom,
                5
            );
            pointer('pointermove', 50, 0);
            pointer('pointerup', 100, 0);
            await new Promise(resolve => setTimeout(resolve, 0));
            const calls = (global.fetch as jest.Mock).mock.calls;
            const sent = JSON.parse(calls[calls.length - 1][1].body);
            const ys = (parseAnnotationShape(
                sent.target.selector
            ) as any).points.map((p: any) => p.y);
            bandHeights.push(Math.max(...ys) - Math.min(...ys));
        }
        expect(bandHeights[0]).toBeCloseTo(100, 1);
        expect(bandHeights[1]).toBeCloseTo(100, 1);
        expect(controller.brushCursor).toBeNull();
    });

    it('falls back to a brush width in screen pixels without a slide scale', () => {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        expect(controller.brushInMicrons).toBe(false);
        expect(controller.brushWidth).toBe(16);
        controller.setBrushWidth(32);
        expect(controller.brushWidthPx).toBe(32);
        expect(controller.brushWidthUm).toBe(50);
        controller.setMppProvider(() => ({ x: 0.5, y: 0.5 }));
        expect(controller.brushWidth).toBe(50);
    });

    describe('label vocabulary', () => {
        const configure = (labelVocabulary?: string[], strict?: boolean) =>
            configureWsiViewerRuntime({
                buildApiUrl: path => path,
                annotations: {
                    apiUrl: 'https://tiles.example',
                    labelVocabulary,
                    labelVocabularyStrict: strict,
                },
            });
        afterEach(() => resetWsiViewerRuntime());

        it('suggests the vocabulary and used labels, and allows free text', () => {
            configure([' Tumor', 'Stroma', 'Tumor', '']);
            const controller = new WsiAnnotationController(
                'https://tiles.example',
                'study1'
            );
            (controller as any).annotations = [
                (controller as any).fromApi(
                    apiAnnotation(
                        'a',
                        1,
                        'Fibrosis 2',
                        'Default',
                        'Fibrosis|#aa0000'
                    ),
                    'slide1'
                ),
                (controller as any).fromApi(
                    apiAnnotation(
                        'b',
                        1,
                        'Stroma 1',
                        'Default',
                        'Stroma|#22c55e'
                    ),
                    'slide1'
                ),
            ];
            expect(controller.labelVocabulary).toEqual(['Tumor', 'Stroma']);
            expect(controller.strictLabels).toBe(false);
            expect(controller.labelSuggestions).toEqual([
                'Tumor',
                'Stroma',
                'Fibrosis',
            ]);
            expect(controller.isAllowedLabel('Anything')).toBe(true);

            // Without an active label, new shapes are auto-labelled.
            expect((controller as any).newShapeLabel()).toBe('Default 1');
            controller.setActiveLabel('  Necrosis ');
            expect((controller as any).newShapeLabel()).toBe('Necrosis');
            expect(controller.activePointLabel).toBe('Necrosis');
        });

        it('allows only vocabulary labels when strict', async () => {
            configure(['Tumor', 'Stroma'], true);
            jest.spyOn(global, 'fetch').mockResolvedValue({
                ok: true,
                json: async () => apiAnnotation('a1', 2, 'Stroma'),
            } as Response);
            const controller = new WsiAnnotationController(
                'https://tiles.example',
                'study1'
            );
            (controller as any).slideKey = 'slide1';
            (controller as any).annotations = [
                (controller as any).fromApi(
                    apiAnnotation('a1', 1, 'Old label'),
                    'slide1'
                ),
            ];
            expect(controller.strictLabels).toBe(true);
            expect(controller.labelSuggestions).toEqual(['Tumor', 'Stroma']);
            expect((controller as any).newShapeLabel()).toBe('Tumor');
            controller.setActiveLabel('Free text');
            expect((controller as any).newShapeLabel()).toBe('Tumor');
            controller.setActiveLabel('Stroma');
            expect(controller.activePointLabel).toBe('Stroma');

            await controller.renameAnnotation('a1', 'Free text');
            expect(global.fetch).not.toHaveBeenCalled();
            await controller.renameAnnotation('a1', 'Stroma');
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it('names the feature, not the part, of an import label outside a strict vocabulary', async () => {
            configure(['Mitosis'], true);
            const controller = new WsiAnnotationController(
                'https://tiles.example',
                'study1'
            );
            (controller as any).slideKey = SLIDE_KEY;
            const file = new File(
                [
                    JSON.stringify({
                        type: 'FeatureCollection',
                        features: [
                            {
                                type: 'Feature',
                                properties: { name: 'Mitosis' },
                                geometry: {
                                    type: 'MultiPoint',
                                    coordinates: [
                                        [1, 1],
                                        [2, 2],
                                    ],
                                },
                            },
                            {
                                type: 'Feature',
                                properties: { name: 'Free text' },
                                geometry: {
                                    type: 'MultiPoint',
                                    coordinates: [
                                        [3, 3],
                                        [4, 4],
                                    ],
                                },
                            },
                        ],
                    }),
                ],
                'cells.geojson'
            );
            await controller.previewImport(file);
            expect(controller.importPreview!.drafts).toHaveLength(2);
            expect(controller.importPreview!.skipped).toEqual([
                { index: 1, reason: 'label not in the vocabulary' },
            ]);
        });

        it('ignores strict without a vocabulary', () => {
            configure([], true);
            const controller = new WsiAnnotationController(
                'https://tiles.example',
                'study1'
            );
            expect(controller.strictLabels).toBe(false);
            expect(controller.isAllowedLabel('Anything')).toBe(true);
        });
    });

    it('exports the slide or its visible layers as GeoJSON', () => {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = SLIDE_KEY;
        controller.setMppProvider(() => ({ x: 0.5, y: 0.5 }));
        (controller as any).annotations = [
            (controller as any).fromApi(
                {
                    ...apiAnnotation('a1', 1, 'Tumor 1'),
                    body: {
                        label: 'Tumor 1',
                        layer_name: 'Regions',
                        color: '#ef4444',
                        type: 'Tumor|#ef4444',
                        comment: 'note',
                    },
                },
                SLIDE_KEY
            ),
            (controller as any).fromApi(
                {
                    ...apiAnnotation('p1', 1, 'Mitosis'),
                    target: {
                        selector: {
                            type: 'SvgSelector',
                            value: '<svg><circle cx="5" cy="6" r="0" /></svg>',
                        },
                    },
                },
                SLIDE_KEY
            ),
        ];

        const all = controller.exportGeoJson('all');
        expect(all.wsi.slide_key).toBe(SLIDE_KEY);
        expect(all.features.map(feature => feature.geometry.type)).toEqual([
            'Polygon',
            'Point',
        ]);
        expect(all.features[0].properties).toMatchObject({
            name: 'Tumor 1',
            classification: { name: 'Tumor', color: [239, 68, 68] },
            layer: 'Regions',
            note: 'note',
            // 3 x 4 pixels at 0.5 µm per pixel.
            measurements: { 'Area µm^2': 3, 'Perimeter µm': 7 },
        });

        controller.toggleLayerVisibility('Regions');
        expect(
            controller.exportGeoJson('visible').features.map(f => f.id)
        ).toEqual(['p1']);
    });

    it('previews a GeoJSON import and creates its annotations on confirmation', async () => {
        let saved = 0;
        jest.spyOn(global, 'fetch').mockImplementation(
            async (_url, init) =>
                ({
                    ok: true,
                    status: 201,
                    json: async () =>
                        JSON.parse(init!.body as string).annotations.map(
                            (item: any) => ({
                                ...item,
                                id: `saved-${++saved}`,
                                version: 1,
                                created_by: 'user',
                            })
                        ),
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = SLIDE_KEY;
        const file = new File(
            [
                JSON.stringify({
                    type: 'FeatureCollection',
                    features: [
                        {
                            type: 'Feature',
                            geometry: {
                                type: 'Polygon',
                                coordinates: [
                                    [
                                        [0, 0],
                                        [10, 0],
                                        [10, 10],
                                        [0, 0],
                                    ],
                                ],
                            },
                            properties: {
                                classification: {
                                    name: 'Tumor',
                                    color: [255, 0, 0],
                                },
                                layer: 'QuPath',
                                note: 'imported',
                            },
                        },
                        {
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [4, 5] },
                            properties: {},
                        },
                        {
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: ['x'] },
                            properties: {},
                        },
                    ],
                }),
            ],
            'cells.geojson'
        );

        await controller.previewImport(file);

        expect(global.fetch).not.toHaveBeenCalled();
        expect(controller.importPreview).toMatchObject({
            fileName: 'cells.geojson',
            counts: { point: 1, line: 0, polygon: 1 },
            skipped: [{ index: 2, reason: 'invalid coordinates' }],
        });

        const created = await controller.confirmImport();

        expect(created).toHaveLength(2);
        // One undo removes the whole import.
        expect(controller.undoLabel).toBe('Undo create of 2 annotations');
        expect(controller.importPreview).toBeNull();
        expect(controller.importProgress).toBeNull();
        // One batch request for the whole import.
        const calls = (global.fetch as jest.Mock).mock.calls;
        expect(calls).toHaveLength(1);
        expect(new URL(calls[0][0]).pathname).toBe('/annotations/batch');
        expect(calls[0][1].method).toBe('POST');
        const bodies = JSON.parse(calls[0][1].body).annotations;
        expect(bodies[0].body).toMatchObject({
            label: 'Tumor',
            layer_name: 'QuPath',
            comment: 'imported',
            color: '#ff0000',
            type: 'Tumor|#ff0000',
        });
        expect(bodies[0].target.selector.value).toBe(
            '<svg><polygon points="0,0 10,0 10,10" /></svg>'
        );
        expect(bodies[1].target.selector.value).toBe(
            '<svg><circle cx="4" cy="5" r="0" /></svg>'
        );
        expect(bodies[1].body.layer_name).toBe('Default');
        expect(controller.annotations).toHaveLength(2);
    });

    describe('batch saves', () => {
        const pointDraft = (controller: WsiAnnotationController, i: number) =>
            (controller as any).draftAnnotation(
                pointSelectorSvg({ x: i, y: i }),
                `P${i}`
            );
        const savedRows = (init: RequestInit, from = 0) =>
            JSON.parse(init.body as string).annotations.map(
                (item: any, k: number) => ({
                    ...item,
                    id: `saved-${from + k}`,
                    version: 1,
                    created_by: 'user',
                })
            );
        const newController = () => {
            const controller = new WsiAnnotationController(
                'https://tiles.example',
                'study1'
            );
            (controller as any).slideKey = SLIDE_KEY;
            return controller;
        };

        it('splits large saves into requests of at most 100 annotations', async () => {
            let next = 0;
            jest.spyOn(global, 'fetch').mockImplementation(
                async (_url, init) => {
                    const rows = savedRows(init!, next);
                    next += rows.length;
                    return {
                        ok: true,
                        status: 201,
                        json: async () => rows,
                    } as Response;
                }
            );
            const controller = newController();
            const drafts = Array.from({ length: 250 }, (_, i) =>
                pointDraft(controller, i)
            );
            const progress: number[] = [];
            const results = await (controller as any).saveAnnotations(drafts, {
                onProgress: (done: number) => progress.push(done),
            });
            const sizes = (global.fetch as jest.Mock).mock.calls.map(
                ([, init]) => JSON.parse(init.body).annotations.length
            );
            expect(sizes).toEqual([100, 100, 50]);
            expect(progress).toEqual([100, 200, 250]);
            expect(results.every((r: any) => r.annotation)).toBe(true);
            expect(results[249].annotation.id).toBe('saved-249');
            expect(controller.batchRoute).toBe(true);
        });

        it('reports the items a 422 names and saves the rest again', async () => {
            const responses = [
                {
                    ok: false,
                    status: 422,
                    json: async () => ({
                        detail: [
                            {
                                loc: [
                                    'body',
                                    'annotations',
                                    1,
                                    'AnnotationIn',
                                    'body',
                                    'label',
                                ],
                                msg: 'too long',
                            },
                        ],
                    }),
                },
            ];
            jest.spyOn(global, 'fetch').mockImplementation(
                async (_url, init) =>
                    (responses.shift() || {
                        ok: true,
                        status: 201,
                        json: async () => savedRows(init!),
                    }) as Response
            );
            const controller = newController();
            const drafts = [0, 1, 2].map(i => pointDraft(controller, i));
            const results = await (controller as any).saveAnnotations(drafts);

            expect(results.map((r: any) => r.reason)).toEqual([
                undefined,
                'body.label: too long',
                undefined,
            ]);
            const retried = JSON.parse(
                (global.fetch as jest.Mock).mock.calls[1][1].body
            ).annotations;
            expect(retried.map((item: any) => item.body.label)).toEqual([
                'P0',
                'P2',
            ]);
        });

        it('imports what it can, as one undo step, and names what failed', async () => {
            jest.spyOn(global, 'fetch').mockImplementation(
                async (_url, init) => {
                    const items = JSON.parse(init!.body as string).annotations;
                    if (items.length === 3) {
                        return {
                            ok: false,
                            status: 422,
                            json: async () => ({
                                detail: [
                                    {
                                        loc: ['body', 'annotations', 0],
                                        msg: 'invalid',
                                    },
                                ],
                            }),
                        } as Response;
                    }
                    return {
                        ok: true,
                        status: 201,
                        json: async () => savedRows(init!),
                    } as Response;
                }
            );
            const controller = newController();
            controller.importPreview = {
                fileName: 'cells.geojson',
                drafts: [0, 1, 2].map(i => ({
                    kind: 'point' as const,
                    svg: pointSelectorSvg({ x: i, y: i }),
                    label: `P${i}`,
                })),
                counts: { point: 3, line: 0, polygon: 0 },
                skipped: [],
            } as any;
            const saved = await controller.confirmImport();

            expect(saved).toHaveLength(2);
            expect(controller.annotations).toHaveLength(2);
            expect(controller.undoLabel).toBe('Undo create of 2 annotations');
            expect(controller.error).toBe(
                'Imported 2 of 3 annotations; 1 could not be saved (#1: invalid).'
            );
            (global.fetch as jest.Mock).mockResolvedValue({
                ok: true,
                status: 204,
            } as Response);
            await controller.undo();
            expect(controller.annotations).toHaveLength(0);
        });

        it('falls back to single saves when the service has no batch route', async () => {
            let next = 0;
            jest.spyOn(global, 'fetch').mockImplementation(
                async (url, init) => {
                    if (new URL(url as string).pathname.endsWith('/batch')) {
                        return { ok: false, status: 404 } as Response;
                    }
                    return {
                        ok: true,
                        status: 201,
                        json: async () => ({
                            ...JSON.parse(init!.body as string),
                            id: `single-${next++}`,
                            version: 1,
                        }),
                    } as Response;
                }
            );
            const controller = newController();
            const drafts = [0, 1, 2].map(i => pointDraft(controller, i));
            let results = await (controller as any).saveAnnotations(drafts);
            expect(controller.batchRoute).toBe(false);
            expect(results.map((r: any) => r.annotation.id).sort()).toEqual([
                'single-0',
                'single-1',
                'single-2',
            ]);
            // Later saves go straight to single POSTs.
            (global.fetch as jest.Mock).mockClear();
            results = await (controller as any).saveAnnotations(drafts);
            const paths = (global.fetch as jest.Mock).mock.calls.map(
                ([url]) => new URL(url).pathname
            );
            expect(paths).toEqual([
                '/annotations',
                '/annotations',
                '/annotations',
            ]);
        });

        it('saves dropped points after a pause, on tool change and when the page is hidden', async () => {
            jest.useFakeTimers();
            try {
                jest.spyOn(global, 'fetch').mockImplementation(
                    async (_url, init) =>
                        ({
                            ok: true,
                            status: 201,
                            json: async () => savedRows(init!),
                        } as Response)
                );
                const controller = newController();
                (controller as any).createPoint({ x: 1, y: 1 });
                (controller as any).createPoint({ x: 2, y: 2 });
                expect(global.fetch).not.toHaveBeenCalled();
                jest.advanceTimersByTime(POINT_SAVE_DELAY_MS);
                expect(global.fetch).toHaveBeenCalledTimes(1);

                (controller as any).createPoint({ x: 3, y: 3 });
                controller.setTool(null);
                expect(global.fetch).toHaveBeenCalledTimes(2);

                (controller as any).createPoint({ x: 4, y: 4 });
                (controller as any).handlePageHide();
                const calls = (global.fetch as jest.Mock).mock.calls;
                expect(calls).toHaveLength(3);
                expect(calls[2][1].keepalive).toBe(true);
            } finally {
                jest.useRealTimers();
            }
        });

        it('sends unsent points before another slide opens, and undo waits for them', async () => {
            jest.spyOn(global, 'fetch').mockImplementation(
                async (_url, init) =>
                    ({
                        ok: true,
                        status: 201,
                        json: async () =>
                            init?.method === 'POST' ? savedRows(init!) : [],
                    } as Response)
            );
            const controller = newController();
            (controller as any).createPoint({ x: 1, y: 1 });
            await controller.undo();
            // The point was saved, then its creation undone.
            const methods = (global.fetch as jest.Mock).mock.calls.map(
                ([, init]) => init.method || 'GET'
            );
            expect(methods).toEqual(['POST', 'DELETE']);

            (global.fetch as jest.Mock).mockClear();
            (controller as any).createPoint({ x: 2, y: 2 });
            controller.beginSlide('ba9876543210');
            const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
            expect(new URL(url).pathname).toBe('/annotations/batch');
            expect(init.keepalive).toBe(true);
            expect(init.signal).toBeUndefined();
            expect(JSON.parse(init.body).annotations[0].slide_id).toBe(
                SLIDE_KEY
            );
        });

        it.each([
            ['unknown', null],
            ['missing', false],
        ])(
            'sends unsent points as single POSTs, all at once, before another slide opens when the batch route is %s',
            (_name, route) => {
                // A service without the batch route: a batch would be lost.
                jest.spyOn(global, 'fetch').mockImplementation(
                    async (url, init) =>
                        new URL(String(url)).pathname.endsWith('/batch')
                            ? ({ ok: false, status: 404 } as Response)
                            : ({
                                  ok: true,
                                  status: 201,
                                  json: async () => [],
                              } as Response)
                );
                const controller = newController();
                controller.batchRoute = route as boolean | null;
                for (let i = 0; i < 6; i++) {
                    (controller as any).createPoint({ x: i, y: i });
                }
                controller.beginSlide('ba9876543210');

                const posts = (global.fetch as jest.Mock).mock.calls.filter(
                    ([, init]) => init?.method === 'POST'
                );
                expect(posts).toHaveLength(6);
                posts.forEach(([url, init]) => {
                    expect(new URL(url).pathname).toBe('/annotations');
                    expect(init.keepalive).toBe(true);
                    expect(init.signal).toBeUndefined();
                    expect(JSON.parse(init.body).slide_id).toBe(SLIDE_KEY);
                });
            }
        );

        it('sends every unsent point at once when the page hides and the batch route is unknown', async () => {
            // Answers never come: the page is gone.
            jest.spyOn(global, 'fetch').mockImplementation(
                () => new Promise<Response>(() => undefined)
            );
            const controller = newController();
            expect(controller.batchRoute).toBeNull();
            for (let i = 0; i < 10; i++) {
                (controller as any).createPoint({ x: i, y: i });
            }
            (controller as any).handlePageHide();
            await Promise.resolve();
            await Promise.resolve();

            const calls = (global.fetch as jest.Mock).mock.calls;
            expect(calls).toHaveLength(10);
            calls.forEach(([url, init]) => {
                expect(new URL(url).pathname).toBe('/annotations');
                expect(init.keepalive).toBe(true);
            });
        });

        it('applies an edit or delete made during a point save to the saved point', async () => {
            jest.useFakeTimers();
            try {
                let answerBatch!: () => void;
                jest.spyOn(global, 'fetch').mockImplementation((url, init) => {
                    const path = new URL(String(url)).pathname;
                    if (path.endsWith('/batch')) {
                        const rows = savedRows(init!);
                        return new Promise<Response>(resolve => {
                            answerBatch = () =>
                                resolve({
                                    ok: true,
                                    status: 201,
                                    json: async () => rows,
                                } as Response);
                        });
                    }
                    if (init?.method === 'DELETE') {
                        return Promise.resolve({
                            ok: true,
                            status: 204,
                        } as Response);
                    }
                    const sent = JSON.parse(init!.body as string);
                    return Promise.resolve({
                        ok: true,
                        json: async () => ({
                            id: decodeURIComponent(path.split('/')[2]),
                            body: sent.body,
                            target: sent.target,
                            version: sent.version + 1,
                            created_by: 'user',
                        }),
                    } as Response);
                });
                const controller = newController();
                (controller as any).createPoint({ x: 1, y: 1 });
                (controller as any).createPoint({ x: 2, y: 2 });
                jest.advanceTimersByTime(POINT_SAVE_DELAY_MS);
                expect(global.fetch).toHaveBeenCalledTimes(1);

                const [first, second] = controller.annotations;
                const deleting = controller.removeAnnotation(first.id);
                const renaming = controller.renameAnnotation(
                    second.id,
                    'Renamed'
                );
                await Promise.resolve();
                // Nothing goes out with a draft id while the save is open.
                expect(global.fetch).toHaveBeenCalledTimes(1);
                expect(controller.annotations[1].body[0].value).toBe('Renamed');

                answerBatch();
                await deleting;
                await renaming;

                const calls = (global.fetch as jest.Mock).mock.calls.map(
                    ([url, init]) =>
                        `${init.method || 'GET'} ${new URL(url).pathname}`
                );
                expect(calls).toEqual([
                    'POST /annotations/batch',
                    'DELETE /annotations/saved-0',
                    'PUT /annotations/saved-1',
                ]);
                const put = JSON.parse(
                    (global.fetch as jest.Mock).mock.calls[2][1].body
                );
                expect(put.body.label).toBe('Renamed');
                expect(put.version).toBe(1);
                expect(
                    controller.annotations.map(item => [
                        item.id,
                        item.body[0].value,
                    ])
                ).toEqual([['saved-1', 'Renamed']]);
                expect(controller.error).toBeNull();
            } finally {
                jest.useRealTimers();
            }
        });

        it('keeps points refused for access on the slide, marked unsaved, and retries them', async () => {
            let signedIn = false;
            jest.spyOn(global, 'fetch').mockImplementation(
                async (_url, init) =>
                    (signedIn
                        ? {
                              ok: true,
                              status: 201,
                              json: async () => savedRows(init!),
                          }
                        : { ok: false, status: 401 }) as Response
            );
            const controller = newController();
            (controller as any).createPoint({ x: 1, y: 1 });
            (controller as any).createPoint({ x: 2, y: 2 });
            await controller.flushPoints();

            expect(controller.accessIssue).toBe('signedOut');
            expect(controller.annotations).toHaveLength(2);
            expect(controller.annotations.every(item => item.unsaved)).toBe(
                true
            );
            expect(controller.unsavedPointMessage).toBe(
                '2 points were not saved.'
            );

            signedIn = true;
            await controller.retryUnsavedPoints();
            expect(controller.accessIssue).toBeNull();
            expect(controller.annotations.map(item => item.id)).toEqual([
                'saved-0',
                'saved-1',
            ]);
            expect(controller.unsavedPointMessage).toBeNull();
        });

        it('reports points it could not send before another slide opens', () => {
            jest.spyOn(global, 'fetch').mockImplementation(
                async () => ({ ok: true, json: async () => [] } as Response)
            );
            const controller = newController();
            (controller as any).createPoint({ x: 1, y: 1 });
            // Another request was refused meanwhile: writes are off.
            controller.accessIssue = 'forbidden';
            controller.beginSlide('ba9876543210');

            const posts = (global.fetch as jest.Mock).mock.calls.filter(
                ([, init]) => init?.method === 'POST'
            );
            expect(posts).toHaveLength(0);
            expect(controller.unsavedPointMessage).toBe(
                '1 point was not saved on the previous slide.'
            );
            controller.dismissPointsLeftUnsaved();
            expect(controller.unsavedPointMessage).toBeNull();
        });

        it('edits and deletes an unsent point without a request', async () => {
            jest.spyOn(global, 'fetch').mockImplementation(
                async (_url, init) =>
                    ({
                        ok: true,
                        status: 201,
                        json: async () => savedRows(init!),
                    } as Response)
            );
            const controller = newController();
            (controller as any).createPoint({ x: 1, y: 1 });
            (controller as any).createPoint({ x: 2, y: 2 });
            const [first, second] = controller.annotations;
            await controller.renameAnnotation(first.id, 'Renamed');
            await controller.removeAnnotation(second.id);
            expect(global.fetch).not.toHaveBeenCalled();
            await controller.flushPoints();
            const sent = JSON.parse(
                (global.fetch as jest.Mock).mock.calls[0][1].body
            ).annotations;
            expect(sent.map((item: any) => item.body.label)).toEqual([
                'Renamed',
            ]);
            expect(controller.annotations.map(item => item.id)).toEqual([
                'saved-0',
            ]);
        });
    });

    describe('chunkBySize and batchItemErrors', () => {
        it('groups by count and size, an oversized item alone', () => {
            expect(chunkBySize([1, 1, 1, 1, 1], 2, 100)).toEqual([
                [0, 1],
                [2, 3],
                [4],
            ]);
            expect(chunkBySize([40, 40, 200, 10], 10, 100)).toEqual([
                [0, 1],
                [2],
                [3],
            ]);
            expect(chunkBySize([], 10, 100)).toEqual([]);
        });

        it('reads per-item errors from a 422 detail', () => {
            expect(
                Array.from(
                    batchItemErrors([
                        {
                            loc: ['body', 'annotations', 2, 'slide_id'],
                            msg: 'bad',
                        },
                        {
                            loc: ['body', 'annotations', 2, 'body'],
                            msg: 'second',
                        },
                        { loc: ['body', 'annotations', 0], msg: 'missing' },
                        { loc: ['body', 'slide_id'], msg: 'scope' },
                    ]).entries()
                )
            ).toEqual([
                [2, 'slide_id: bad'],
                [0, 'missing'],
            ]);
            expect(batchItemErrors('A batch must contain one study').size).toBe(
                0
            );
        });
    });

    it('refuses a file over the import size limit before reading it', async () => {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = SLIDE_KEY;
        const file = new File(['{}'], 'huge.geojson');
        Object.defineProperty(file, 'size', { value: 26 * 1024 * 1024 });
        const read = jest.fn();
        (file as any).text = read;
        await controller.previewImport(file);
        expect(read).not.toHaveBeenCalled();
        expect(controller.importError).toBe(
            'The file is 26.0 MB; import files of at most 25 MB.'
        );
        expect(controller.importPreview).toBeNull();
    });

    it('reports a file that is not JSON', async () => {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = SLIDE_KEY;
        await controller.previewImport(new File(['{nope'], 'bad.json'));
        expect(controller.importError).toBe('The file is not valid JSON.');
        expect(controller.importPreview).toBeNull();
    });

    describe('undo', () => {
        /** A service that stores annotations and checks versions. */
        function fakeService() {
            const rows = new Map<string, any>();
            let next = 0;
            jest.spyOn(global, 'fetch').mockImplementation(
                async (url, init) => {
                    const method = init?.method || 'GET';
                    const id = decodeURIComponent(
                        new URL(String(url)).pathname.split('/')[2] || ''
                    );
                    const sent = init?.body
                        ? JSON.parse(init.body as string)
                        : null;
                    if (method === 'POST') {
                        const row = {
                            ...sent,
                            id: `row-${++next}`,
                            version: 1,
                            created_by: 'user',
                        };
                        rows.set(row.id, row);
                        return { ok: true, json: async () => row } as Response;
                    }
                    if (method === 'PUT') {
                        const row = rows.get(id);
                        if (row.version !== sent.version) {
                            return { ok: false, status: 409 } as Response;
                        }
                        const updated = {
                            ...row,
                            body: sent.body,
                            target: sent.target,
                            visible_to:
                                'visible_to' in sent
                                    ? sent.visible_to
                                    : row.visible_to,
                            version: row.version + 1,
                        };
                        rows.set(id, updated);
                        return {
                            ok: true,
                            json: async () => updated,
                        } as Response;
                    }
                    if (method === 'DELETE') {
                        rows.delete(id);
                        return { ok: true, status: 204 } as Response;
                    }
                    return {
                        ok: true,
                        json: async () => Array.from(rows.values()),
                    } as Response;
                }
            );
            return rows;
        }

        function controllerOnSlide() {
            const controller = new WsiAnnotationController(
                'https://tiles.example',
                'study1'
            );
            (controller as any).slideKey = SLIDE_KEY;
            return controller;
        }

        const rect = {
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            type: 'Annotation',
            id: 'client-1',
            body: [
                {
                    type: 'TextualBody',
                    value: 'Tumor',
                    purpose: 'commenting',
                },
            ],
            target: {
                source: SLIDE_KEY,
                selector: {
                    type: 'FragmentSelector',
                    value: 'xywh=pixel:1,2,3,4',
                },
            },
            layerName: 'Regions',
            note: 'keep me',
        };

        it('undoes a create by deleting it', async () => {
            const rows = fakeService();
            const controller = controllerOnSlide();
            await (controller as any).createAnnotation(rect);
            expect(rows.size).toBe(1);
            expect(controller.undoLabel).toBe('Undo create');

            expect(await controller.undo()).toBe(true);
            expect(rows.size).toBe(0);
            expect(controller.annotations).toEqual([]);
            expect(controller.canUndo).toBe(false);
        });

        it('undoes an edit by saving the previous version with the current version number', async () => {
            const rows = fakeService();
            const controller = controllerOnSlide();
            const saved = await (controller as any).createAnnotation(rect);
            await controller.renameAnnotation(saved.id, 'Stroma');
            await controller.setAnnotationNote(saved.id, 'changed');
            expect(rows.get(saved.id).version).toBe(3);

            await controller.undo();
            expect(rows.get(saved.id).body).toMatchObject({
                label: 'Stroma',
                comment: 'keep me',
            });
            expect(rows.get(saved.id).version).toBe(4);
            await controller.undo();
            expect(rows.get(saved.id).body).toMatchObject({
                label: 'Tumor',
                comment: 'keep me',
                layer_name: 'Regions',
            });
            expect(controller.annotations[0].body[0].value).toBe('Tumor');
            expect(controller.undoLabel).toBe('Undo create');
        });

        it('undoes a delete by creating it again, and keeps later undos working', async () => {
            const rows = fakeService();
            const controller = controllerOnSlide();
            const saved = await (controller as any).createAnnotation({
                ...rect,
                visibleTo: null,
            });
            await controller.renameAnnotation(saved.id, 'Renamed');
            await controller.removeAnnotation(saved.id);
            expect(rows.size).toBe(0);
            expect(controller.undoLabel).toBe('Undo delete');

            await controller.undo();
            expect(rows.size).toBe(1);
            const [recreated] = Array.from(rows.values());
            expect(recreated.id).not.toBe(saved.id);
            expect(recreated.body).toMatchObject({
                label: 'Renamed',
                comment: 'keep me',
                layer_name: 'Regions',
            });
            expect(recreated.visible_to).toBeNull();
            // The rename's undo now applies to the re-created annotation.
            await controller.undo();
            expect(rows.get(recreated.id).body.label).toBe('Tumor');
            await controller.undo();
            expect(rows.size).toBe(0);
        });

        it('undoes a layer delete as one step', async () => {
            const rows = fakeService();
            const controller = controllerOnSlide();
            await (controller as any).createAnnotation(rect, false);
            await (controller as any).createAnnotation(
                { ...rect, id: 'client-2' },
                false
            );
            await controller.deleteLayer('Regions');
            expect(rows.size).toBe(0);
            expect(controller.undoLabel).toBe('Undo delete of 2 annotations');
            await controller.undo();
            expect(rows.size).toBe(2);
            expect(controller.canUndo).toBe(false);
        });

        it('undoes with Ctrl+Z or Cmd+Z, but not while typing', async () => {
            const rows = fakeService();
            (createOSDAnnotator as jest.Mock).mockReturnValue({
                on: jest.fn(),
                setVisible: jest.fn(),
                setAnnotations: jest.fn(),
                setStyle: jest.fn(),
            });
            const controller = controllerOnSlide();
            controller.attachViewer(
                { element: document.createElement('div') },
                {},
                SLIDE_KEY
            );
            await (controller as any).createAnnotation(rect);
            await (controller as any).createAnnotation({
                ...rect,
                id: 'client-2',
            });

            const input = document.createElement('input');
            document.body.appendChild(input);
            input.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'z',
                    ctrlKey: true,
                    bubbles: true,
                })
            );
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(rows.size).toBe(2);
            input.remove();

            document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })
            );
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(rows.size).toBe(1);
            document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Z', metaKey: true })
            );
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(rows.size).toBe(0);
        });

        it('forgets the history on another slide', async () => {
            fakeService();
            const controller = controllerOnSlide();
            await (controller as any).createAnnotation(rect);
            controller.beginSlide('fedcba987654');
            expect(controller.canUndo).toBe(false);
        });
    });

    it('saves a dragged vertex as a geometry edit that keeps the rest', async () => {
        const handlers: Record<string, (...args: any[]) => void> = {};
        (createOSDAnnotator as jest.Mock).mockReturnValue({
            on: jest.fn((name: string, handler: (...args: any[]) => void) => {
                handlers[name] = handler;
            }),
            setVisible: jest.fn(),
            setAnnotations: jest.fn(),
            setStyle: jest.fn(),
        });
        jest.spyOn(global, 'fetch').mockImplementation(
            async (_url, init) =>
                ({
                    ok: true,
                    json: async () => ({
                        ...apiAnnotation('poly', 2),
                        ...JSON.parse(init!.body as string),
                        version: 2,
                    }),
                } as Response)
        );
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                {
                    ...apiAnnotation('poly'),
                    body: {
                        label: 'Tumor',
                        comment: 'note',
                        layer_name: 'Regions',
                        color: '#ef4444',
                        provenance: { source: 'agent' },
                    },
                    target: {
                        selector: {
                            type: 'SvgSelector',
                            value:
                                '<svg><polygon points="0,0 10,0 10,10" /></svg>',
                        },
                    },
                },
                'slide1'
            ),
        ];
        controller.attachViewer(
            { element: document.createElement('div') },
            {},
            'slide1'
        );

        // Annotorious reports the edited shape without the viewer's fields.
        handlers.updateAnnotation({
            id: 'poly',
            body: [],
            target: {
                source: 'slide1',
                selector: {
                    type: 'SvgSelector',
                    value: '<svg><polygon points="0,0 20,0 10,10" /></svg>',
                },
            },
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        const sent = JSON.parse(
            (global.fetch as jest.Mock).mock.calls[0][1].body
        );
        expect(sent.target.selector.value).toContain('20,0');
        expect(sent.version).toBe(1);
        expect(sent.body).toMatchObject({
            label: 'Tumor',
            comment: 'note',
            layer_name: 'Regions',
            provenance: { source: 'agent' },
        });
        expect(controller.undoLabel).toBe('Undo edit');
    });

    it('only offers removal for unused user-added colors', () => {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.addNamedColor('Tumor', '#ef4444');
        controller.addNamedColor('Stroma', '#22c55e');
        (controller as any).annotations = [
            (controller as any).fromApi(
                apiAnnotation('a1', 1, 'a1', 'Default', 'Stroma|#22c55e'),
                'slide1'
            ),
            (controller as any).fromApi(
                apiAnnotation('a2', 1, 'a2', 'Default', 'Necrosis|#f97316'),
                'slide1'
            ),
        ];

        expect(controller.canRemoveNamedColor('Default', '#3b82f6')).toBe(
            false
        );
        expect(controller.canRemoveNamedColor('Tumor', '#ef4444')).toBe(true);
        expect(controller.canRemoveNamedColor('Stroma', '#22c55e')).toBe(false);
        expect(controller.canRemoveNamedColor('Necrosis', '#f97316')).toBe(
            false
        );
    });
});
