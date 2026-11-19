/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createOSDAnnotator } from '@annotorious/openseadragon';
import {
    WSI_LINKED_ANNOTATION_MISSING,
    WsiAnnotationController,
} from './wsiAnnotationController';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { WsiAnnotationPanel } from './wsiAnnotationControls';
import { WsiAnnotationFocusBar } from './wsiAnnotationOverlay';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

const SLIDE_KEY = '0123456789ab';

function row(
    id: string,
    x: number,
    y: number,
    layer = 'Default',
    provenance: Record<string, unknown> | null = null
) {
    return {
        id,
        body: {
            label: `Label ${id}`,
            comment: '',
            layer_name: layer,
            color: '#ef4444',
            type: `${layer}|#ef4444`,
            provenance,
        },
        target: {
            selector: {
                type: 'FragmentSelector',
                value: `xywh=pixel:${x},${y},50,50`,
            },
        },
        version: 1,
        created_by: 'user',
    };
}

const ROWS = [
    row('c', 900, 900),
    row('a', 0, 0),
    row('b', 200, 0, 'Tumor'),
    row('ai', 400, 400, 'Model', { source: 'precomputed' }),
];

/**
 * A controller whose slide loads `ROWS` from the service, attached to a
 * stand-in viewer with a viewport.
 */
async function setup(
    options: { requested?: string; attachFirst?: boolean } = {}
) {
    (createOSDAnnotator as jest.Mock).mockReturnValue({
        on: jest.fn(),
        setVisible: jest.fn(),
        setAnnotations: jest.fn(),
        setStyle: jest.fn(),
        setUserSelectAction: jest.fn(),
        cancelDrawing: jest.fn(),
        setDrawingEnabled: jest.fn(),
        cancelSelected: jest.fn(),
    });
    jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ROWS,
    } as Response);
    const controller = new WsiAnnotationController(
        'https://tiles.example',
        'study1'
    );
    const zoom = jest
        .spyOn(controller, 'zoomToAnnotation')
        .mockReturnValue(true);
    if (options.requested) controller.requestAnnotation(options.requested);
    const attach = () =>
        controller.attachViewer(
            {
                element: document.createElement('div'),
                viewport: {},
                addHandler: jest.fn(),
                removeHandler: jest.fn(),
            },
            {},
            SLIDE_KEY
        );
    controller.beginSlide(SLIDE_KEY);
    if (options.attachFirst) attach();
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    if (!options.attachFirst) attach();
    const press = (key: string, init: KeyboardEventInit = {}) =>
        act(() => {
            document.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                    ...init,
                })
            );
        });
    return { controller, zoom, press };
}

describe('Stepping through annotations and links to one', () => {
    beforeAll(() => loadAnnotorious());
    let cleanup: Array<() => void> = [];
    beforeEach(() => {
        jest.restoreAllMocks();
        window.localStorage.clear();
        global.fetch = jest.fn() as typeof fetch;
    });
    afterEach(() => {
        cleanup.forEach(run => run());
        cleanup = [];
    });
    const tracked = async (options = {}) => {
        const result = await setup(options);
        cleanup.push(() => result.controller.detachViewer());
        return result;
    };

    it('steps with ] and [ through the listed annotations, nearest next, Annotate off', async () => {
        const { controller, zoom, press } = await tracked();
        expect(controller.annotating).toBe(false);
        expect(controller.navigationOrder).toEqual(['a', 'b', 'ai', 'c']);
        press(']');
        expect(controller.focusedAnnotationId).toBe('a');
        expect(zoom).toHaveBeenLastCalledWith('a');
        press(']');
        expect(controller.navigationPosition).toEqual({ index: 1, total: 4 });
        press('[');
        press('[');
        // Wraps around.
        expect(controller.focusedAnnotationId).toBe('c');

        // Only those the list shows, under its filters.
        controller.setListFilter({ layer: 'Default' });
        expect(controller.navigationOrder).toEqual(['a', 'c']);
        press(']');
        expect(controller.focusedAnnotationId).toBe('a');

        press('Escape');
        expect(controller.focusedAnnotationId).toBeNull();

        // Not while typing, and not while reviewing.
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(
            new KeyboardEvent('keydown', { key: ']', bubbles: true })
        );
        input.remove();
        expect(controller.focusedAnnotationId).toBeNull();
        controller.clearListFilter();
        controller.startReview();
        press(']');
        expect(controller.focusedAnnotationId).toBe('ai');
    });

    it('opens a linked annotation once loaded, showing what hid it', async () => {
        window.localStorage.clear();
        const first = await setup({ requested: 'b', attachFirst: true });
        cleanup.push(() => first.controller.detachViewer());
        expect(first.controller.focusedAnnotationId).toBe('b');
        expect(first.zoom).toHaveBeenCalledWith('b');

        // Hidden by its layer, by "hide unreviewed" and by hide all.
        const { controller, zoom } = await tracked();
        controller.toggleLayerVisibility('Model');
        controller.toggleHideUnreviewedAi();
        controller.toggleHideAll();
        controller.requestAnnotation('ai');
        expect(controller.focusedAnnotationId).toBe('ai');
        expect(zoom).toHaveBeenLastCalledWith('ai');
        expect(controller.hiddenLayerNames.has('Model')).toBe(false);
        expect(controller.hideUnreviewedAi).toBe(false);
        expect(controller.hideAll).toBe(false);
        expect(controller.shownAnnotations.map(item => item.id)).toContain(
            'ai'
        );
        // Asked once: the slide reloading does not open it again.
        controller.clearFocus();
        await controller.retryLoad();
        expect(controller.focusedAnnotationId).toBeNull();
    });

    it("opens a linked annotation only on the link's slide, once, and tells the host", async () => {
        const { controller, zoom } = await tracked();
        const used = jest.fn();
        // A link to another slide: nothing opens here, nothing is reported.
        controller.requestAnnotation('b', 'fedcba987654', used);
        expect(controller.focusedAnnotationId).toBeNull();
        expect(controller.linkMessage).toBeNull();
        expect(used).not.toHaveBeenCalled();
        // On the link's slide it opens, and the host can drop it.
        controller.requestAnnotation('b', SLIDE_KEY, used);
        expect(controller.focusedAnnotationId).toBe('b');
        expect(zoom).toHaveBeenLastCalledWith('b');
        expect(used).toHaveBeenCalledTimes(1);
        // Used once: a reload does not open it again.
        controller.clearFocus();
        await controller.retryLoad();
        expect(controller.focusedAnnotationId).toBeNull();
        expect(used).toHaveBeenCalledTimes(1);
    });

    it('says when a linked annotation is missing, rejected or private', async () => {
        const { controller } = await tracked({ requested: 'gone' });
        expect(controller.focusedAnnotationId).toBeNull();
        expect(controller.linkMessage).toBe(WSI_LINKED_ANNOTATION_MISSING);
        render(<WsiAnnotationFocusBar controller={controller} />);
        expect(
            screen.getByTestId('annotation-link-message').getAttribute('role')
        ).toBe('status');
        fireEvent.click(screen.getByTestId('annotation-focus-close'));
        expect(controller.linkMessage).toBeNull();
    });

    it('copies a link made by the host, by slide key and annotation id', async () => {
        const { controller } = await tracked();
        expect(controller.annotationLink('a')).toBeNull();
        const builder = jest.fn(
            ({ slideKey, annotationId }) =>
                `https://portal.example/wsi?slideKey=${slideKey}&annotationId=${annotationId}`
        );
        controller.setLinkBuilder(builder);
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        });
        expect(await controller.copyAnnotationLink('a')).toBe(true);
        expect(builder).toHaveBeenCalledWith({
            slideKey: SLIDE_KEY,
            annotationId: 'a',
        });
        expect(writeText).toHaveBeenCalledWith(
            `https://portal.example/wsi?slideKey=${SLIDE_KEY}&annotationId=a`
        );
        expect(controller.linkMessage).toBe('Link to the annotation copied.');

        // Without the clipboard, the link is shown to copy by hand.
        writeText.mockRejectedValue(new Error('denied'));
        (document as any).execCommand = jest.fn(() => false);
        expect(await controller.copyAnnotationLink('b')).toBe(false);
        expect(controller.linkMessage).toMatch(/^Copy this link: https:/);
        expect(await controller.copyAnnotationLink('missing')).toBe(false);
    });

    it('shows the focused annotation in a bar with previous, next and Copy link', async () => {
        const { controller } = await tracked();
        controller.setLinkBuilder(() => 'https://portal.example/link');
        const copy = jest
            .spyOn(controller, 'copyAnnotationLink')
            .mockResolvedValue(true);
        render(
            <>
                <WsiAnnotationPanel controller={controller} />
                <WsiAnnotationFocusBar controller={controller} />
            </>
        );
        expect(screen.queryByTestId('annotation-focus-bar')).toBeNull();
        // A list row's label focuses its annotation too.
        fireEvent.click(screen.getByTestId('annotation-goto-b'));
        expect(controller.focusedAnnotationId).toBe('b');
        const status = screen.getByTestId('annotation-focus-status');
        expect(status.getAttribute('role')).toBe('status');
        expect(status.textContent).toBe('2 of 4: Label b');
        fireEvent.click(screen.getByTestId('annotation-focus-next'));
        expect(status.textContent).toBe('3 of 4: Label ai');
        fireEvent.click(screen.getByTestId('annotation-focus-previous'));
        expect(controller.focusedAnnotationId).toBe('b');
        fireEvent.click(screen.getByTestId('annotation-focus-copy-link'));
        expect(copy).toHaveBeenLastCalledWith('b');
        fireEvent.click(screen.getByTestId('copy-link-c'));
        expect(copy).toHaveBeenLastCalledWith('c');
        fireEvent.click(screen.getByTestId('annotation-focus-close'));
        expect(screen.queryByTestId('annotation-focus-bar')).toBeNull();

        act(() => controller.setLinkBuilder(null));
        expect(screen.queryByTestId('copy-link-c')).toBeNull();
    });
});
