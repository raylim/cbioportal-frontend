/**
 * @jest-environment jsdom
 */

import { WsiAnnotationController } from './wsiAnnotationController';
import { createOSDAnnotator } from '@annotorious/openseadragon';
import { loadAnnotorious } from './wsiAnnotoriousLoader';

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

    it('accepts an assistant annotation with its version and rejects by deleting', async () => {
        const agentBody = {
            label: 'AI tumor',
            comment: '',
            layer_name: 'AI review',
            color: '#ef4444',
            type: 'AI review|#ef4444',
            provenance: { source: 'agent', proposal_id: 'p1' },
        };
        jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
            if (init?.method === 'PUT') {
                const sent = JSON.parse(init.body as string);
                return {
                    ok: true,
                    json: async () => ({
                        ...apiAnnotation('ai-1', 4),
                        body: sent.body,
                    }),
                } as Response;
            }
            return { ok: true, status: 204 } as Response;
        });
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        (controller as any).slideKey = 'slide1';
        (controller as any).annotations = [
            (controller as any).fromApi(
                { ...apiAnnotation('ai-1', 3), body: agentBody },
                'slide1'
            ),
            (controller as any).fromApi(
                { ...apiAnnotation('ai-2', 1), body: agentBody },
                'slide1'
            ),
            (controller as any).fromApi(apiAnnotation('mine'), 'slide1'),
        ];
        expect(controller.unreviewedAiCount).toBe(2);

        await controller.acceptAnnotation('ai-1');
        const put = (global.fetch as jest.Mock).mock.calls[0];
        expect(put[1].method).toBe('PUT');
        const sent = JSON.parse(put[1].body);
        expect(sent.version).toBe(3);
        expect(sent.body.provenance).toMatchObject({
            source: 'agent',
            proposal_id: 'p1',
            review_status: 'accepted',
        });
        expect(typeof sent.body.provenance.reviewed_at).toBe('string');
        expect(controller.unreviewedAiCount).toBe(1);
        expect(controller.annotations[0].version).toBe(4);

        await controller.rejectAnnotation('ai-2');
        const del = (global.fetch as jest.Mock).mock.calls[1];
        expect(del[1].method).toBe('DELETE');
        expect(new URL(del[0]).pathname).toBe('/annotations/ai-2');
        expect(controller.annotations.map(item => item.id)).toEqual([
            'ai-1',
            'mine',
        ]);
    });

    it('hides unreviewed assistant annotations on request', () => {
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
