/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createOSDAnnotator } from '@annotorious/openseadragon';
import { WsiAnnotationController } from './wsiAnnotationController';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { WsiAnnotationPanel } from './wsiAnnotationControls';
import { WsiAnnotationToolbar } from './wsiAnnotationToolbar';
import { WsiAnnotationOverlay } from './wsiAnnotationOverlay';
import { runLimited, shapeContainsPoint } from './wsiAnnotationSpatial';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

const SLIDE_KEY = '0123456789ab';
const USER = 'me';

function row(
    id: string,
    xywh: string,
    options: {
        creator?: string;
        layer?: string;
        provenance?: Record<string, unknown> | null;
    } = {}
) {
    const layer = options.layer || 'Default';
    return {
        id,
        body: {
            label: `Label ${id}`,
            comment: '',
            layer_name: layer,
            color: '#ef4444',
            type: `${layer}|#ef4444`,
            provenance: options.provenance ?? null,
        },
        target: {
            selector: { type: 'FragmentSelector', value: `xywh=pixel:${xywh}` },
        },
        version: 1,
        created_by: options.creator || USER,
        visible_to: [],
    };
}

/**
 * Two of the user's annotations, another user's, and an unreviewed AI
 * one, on a stand-in viewer with one screen pixel per image pixel. The
 * in-memory service applies PUTs, DELETEs and reviews.
 */
function setup() {
    const rows: Record<string, any> = {
        mine1: row('mine1', '0,0,100,100'),
        mine2: row('mine2', '200,0,100,100'),
        theirs: row('theirs', '400,0,100,100', { creator: 'other' }),
        ai: row('ai', '600,0,100,100', {
            creator: 'loader',
            layer: 'Model',
            provenance: { source: 'precomputed' },
        }),
    };
    let inFlight = 0;
    let maxInFlight = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 0));
        inFlight -= 1;
        const url = new URL(input as string);
        const [, , id, action] = url.pathname.split('/');
        const method = init?.method || 'GET';
        const sent = init?.body ? JSON.parse(init.body as string) : null;
        const json = (status: number, value: unknown) =>
            ({
                ok: status < 300,
                status,
                clone() {
                    return this;
                },
                json: async () => value,
            } as any);
        if (method === 'GET') return json(200, Object.values(rows));
        // A service without the bulk batch routes (see wsiAnnotationBatch.spec).
        if (method === 'POST' && /^batch-/.test(id || '')) {
            return json(405, { detail: 'Method Not Allowed' });
        }
        if (method === 'POST' && id && action === 'review') {
            rows[id] = {
                ...rows[id],
                version: rows[id].version + 1,
                body: {
                    ...rows[id].body,
                    provenance: {
                        ...rows[id].body.provenance,
                        review_status:
                            sent.decision === 'accept'
                                ? 'accepted'
                                : 'rejected',
                    },
                },
            };
            return json(200, rows[id]);
        }
        if (method === 'POST') {
            const created = {
                ...sent,
                id: `new-${Object.keys(rows).length}`,
                created_by: USER,
                version: 1,
            };
            rows[created.id] = created;
            return json(201, created);
        }
        if (rows[id]?.created_by !== USER) {
            return json(403, { detail: 'Only the creator may change it' });
        }
        if (method === 'PUT') {
            rows[id] = {
                ...rows[id],
                body: sent.body,
                visible_to:
                    'visible_to' in sent
                        ? sent.visible_to
                        : rows[id].visible_to,
                version: rows[id].version + 1,
            };
            return json(200, rows[id]);
        }
        delete rows[id];
        return json(204, null);
    });
    const annotator = {
        on: jest.fn(),
        setVisible: jest.fn(),
        setAnnotations: jest.fn(),
        setStyle: jest.fn(),
        setUserSelectAction: jest.fn(),
        cancelDrawing: jest.fn(),
        setDrawingEnabled: jest.fn(),
        cancelSelected: jest.fn(),
    };
    (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
    const controller = new WsiAnnotationController(
        'https://tiles.example',
        'study1'
    );
    controller.setCurrentUser(USER);
    (controller as any).slideKey = SLIDE_KEY;
    (controller as any).annotations = Object.values(rows).map(item =>
        (controller as any).fromApi(item, SLIDE_KEY)
    );
    const element = document.createElement('div');
    element.setPointerCapture = jest.fn();
    document.body.appendChild(element);
    controller.attachViewer(
        { element, addHandler: jest.fn(), removeHandler: jest.fn() },
        {},
        SLIDE_KEY
    );
    jest.spyOn(
        controller as any,
        'imagePoint'
    ).mockImplementation((x: any, y: any) => ({ x, y }));
    jest.spyOn(
        controller as any,
        'screenPoint'
    ).mockImplementation((point: any) => ({ x: point.x, y: point.y }));
    const pointer = (
        type: string,
        x: number,
        y: number,
        init: MouseEventInit = {}
    ) => {
        const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: x,
            clientY: y,
            ...init,
        });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        act(() => {
            element.dispatchEvent(event);
        });
        return event;
    };
    const press = (
        key: string,
        init: KeyboardEventInit = {},
        target: EventTarget = document
    ) =>
        act(() => {
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                    ...init,
                })
            );
        });
    const writes = () =>
        (global.fetch as jest.Mock).mock.calls
            .filter(([, init]) => (init?.method || 'GET') !== 'GET')
            .map(([url, init]) => [init.method, new URL(url).pathname]);
    return {
        controller,
        rows,
        annotator,
        element,
        pointer,
        press,
        writes,
        maxInFlight: () => maxInFlight,
        cleanup: () => {
            controller.detachViewer();
            element.remove();
        },
    };
}

describe('Selecting annotations and bulk actions', () => {
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
    const attached = () => {
        const result = setup();
        cleanup.push(result.cleanup);
        return result;
    };
    const ids = (controller: WsiAnnotationController) =>
        controller.selectedAnnotations.map(item => item.id);

    it('selects by Shift+click and Shift+drag with Select, and clears with Esc', () => {
        const { controller, pointer, press } = attached();
        // Shift+click toggles the shape under the pointer.
        const down = pointer('pointerdown', 50, 50, { shiftKey: true });
        expect(down.defaultPrevented).toBe(true);
        pointer('pointerup', 51, 50, { shiftKey: true });
        expect(ids(controller)).toEqual(['mine1']);
        pointer('pointerdown', 450, 50, { shiftKey: true });
        pointer('pointerup', 450, 50, { shiftKey: true });
        expect(ids(controller)).toEqual(['mine1', 'theirs']);
        pointer('pointerdown', 50, 50, { shiftKey: true });
        pointer('pointerup', 50, 50, { shiftKey: true });
        expect(ids(controller)).toEqual(['theirs']);

        // Shift+drag adds what lies wholly inside the box.
        pointer('pointerdown', 150, -10, { shiftKey: true });
        pointer('pointermove', 400, 80, { shiftKey: true });
        expect(controller.selectionDragBox).toEqual({
            x: 150,
            y: -10,
            width: 250,
            height: 90,
        });
        pointer('pointermove', 720, 120, { shiftKey: true });
        pointer('pointerup', 720, 120, { shiftKey: true });
        expect(controller.selectionDragBox).toBeNull();
        expect(ids(controller)).toEqual(['mine2', 'theirs', 'ai']);

        press('Escape');
        expect(ids(controller)).toEqual([]);

        // Not while a drawing tool is on.
        controller.setTool('rectangle');
        pointer('pointerdown', 50, 50, { shiftKey: true });
        pointer('pointerup', 50, 50, { shiftKey: true });
        expect(ids(controller)).toEqual([]);
    });

    it('selects all the list shows with Ctrl/Cmd+A, only from the viewer', () => {
        const { controller, press, element } = attached();
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        press('a', { ctrlKey: true }, outside);
        expect(ids(controller)).toEqual([]);
        const root = document.createElement('div');
        root.setAttribute('data-wsi-viewer-root', '');
        const inside = document.createElement('button');
        root.appendChild(inside);
        document.body.appendChild(root);
        controller.setListFilter({ layer: 'Default' });
        press('a', { metaKey: true }, inside);
        expect(ids(controller)).toEqual(['mine1', 'mine2', 'theirs']);
        // With the focus nowhere, only while Annotate is on.
        controller.clearSelection();
        press('a', { ctrlKey: true }, document.body);
        expect(ids(controller)).toEqual([]);
        controller.setAnnotating(true);
        press('a', { ctrlKey: true }, document.body);
        expect(ids(controller)).toHaveLength(3);
        outside.remove();
        root.remove();
        expect(element).toBeTruthy();
    });

    it("relabels the user's own as one undo step, and says how many were skipped", async () => {
        const { controller, rows, writes } = attached();
        controller.selectAllListed();
        await act(async () => {
            await controller.bulkRelabel('Tumor');
        });
        // Without the batch route (a 405), one request each.
        expect(writes()).toEqual([
            ['POST', '/annotations/batch-update'],
            ['PUT', '/annotations/mine1'],
            ['PUT', '/annotations/mine2'],
        ]);
        expect(controller.bulkRoutes.update).toBe(false);
        expect(rows.mine1.body.label).toBe('Tumor');
        expect(rows.theirs.body.label).toBe('Label theirs');
        expect(controller.bulkMessage).toBe(
            'Relabelled 2 annotations; skipped 2 that are not yours.'
        );
        expect(controller.undoLabel).toBe('Undo edit of 2 annotations');

        await act(async () => {
            await controller.undo();
        });
        expect(rows.mine1.body.label).toBe('Label mine1');
        expect(rows.mine2.body.label).toBe('Label mine2');
        expect(controller.redoLabel).toBe('Redo edit of 2 annotations');
        await act(async () => {
            await controller.redo();
        });
        expect(rows.mine2.body.label).toBe('Tumor');
    });

    it('moves to a layer and sets the sharing of the own ones', async () => {
        const { controller, rows } = attached();
        controller.select(['mine1', 'theirs']);
        await act(async () => {
            await controller.bulkMoveToLayer('Stroma');
        });
        expect(rows.mine1.body.layer_name).toBe('Stroma');
        expect(rows.theirs.body.layer_name).toBe('Default');
        expect(controller.layerNames).toContain('Stroma');
        await act(async () => {
            await controller.bulkSetShared(false);
        });
        expect(rows.mine1.visible_to).toBeNull();
        expect(controller.bulkMessage).toBe(
            'Made private 1 annotation; skipped 1 that is not yours.'
        );
    });

    it('accepts or rejects only unreviewed AI ones, not on the undo history', async () => {
        const { controller, writes } = attached();
        controller.selectAllListed();
        await act(async () => {
            await controller.bulkReview('reject');
        });
        expect(writes()).toEqual([
            ['POST', '/annotations/batch-review'],
            ['POST', '/annotations/ai/review'],
        ]);
        expect(controller.bulkMessage).toBe(
            'Rejected 1 annotation; skipped 3 that are not unreviewed AI annotations you can review.'
        );
        expect(controller.annotations.map(item => item.id)).not.toContain('ai');
        expect(controller.canUndo).toBe(false);
    });

    it('deletes as one undo step, a few requests at a time', async () => {
        const { controller, rows, maxInFlight } = attached();
        for (let i = 0; i < 9; i++) {
            const item = row(`extra${i}`, `${i * 10},500,5,5`);
            rows[item.id] = item;
            (controller as any).annotations = [
                ...controller.annotations,
                (controller as any).fromApi(item, SLIDE_KEY),
            ];
        }
        controller.selectAllListed();
        await act(async () => {
            await controller.bulkDelete();
        });
        expect(Object.keys(rows).sort()).toEqual(['ai', 'theirs']);
        expect(maxInFlight()).toBe(4);
        expect(controller.bulkMessage).toBe(
            'Deleted 11 annotations; skipped 2 that are not yours.'
        );
        expect(controller.selectedAnnotations.map(item => item.id)).toEqual([
            'theirs',
            'ai',
        ]);
        expect(controller.undoLabel).toBe('Undo delete of 11 annotations');
    });

    it('shows the bulk bar with counts, row checkboxes and selection frames', async () => {
        const { controller } = attached();
        render(
            <>
                <WsiAnnotationToolbar controller={controller} />
                <WsiAnnotationPanel controller={controller} />
                <WsiAnnotationOverlay controller={controller} />
            </>
        );
        expect(screen.queryByTestId('annotation-bulk-bar')).toBeNull();
        fireEvent.click(screen.getByLabelText('Select Label mine1'));
        fireEvent.click(screen.getByLabelText('Select Label theirs'));
        fireEvent.click(screen.getByLabelText('Select Label ai'));
        const bar = screen.getByRole('group', {
            name: 'Selected annotations',
        });
        expect(screen.getByTestId('annotation-bulk-count').textContent).toBe(
            '3 selected'
        );
        const relabel = screen.getByTestId(
            'annotation-bulk-relabel'
        ) as HTMLButtonElement;
        expect(relabel.textContent).toBe('Relabel (1)');
        expect(relabel.title).toBe(
            'Relabel 1 of 3 selected (2 not yours are skipped)'
        );
        expect(screen.getByTestId('annotation-bulk-accept').textContent).toBe(
            'Accept (1)'
        );
        expect(
            screen.getByTestId('annotation-selection-frame-mine1')
        ).toBeTruthy();
        expect(bar).toBeTruthy();

        const bulkRelabel = jest
            .spyOn(controller, 'bulkRelabel')
            .mockResolvedValue({ done: 1, skipped: 2, failed: 0 });
        fireEvent.change(
            screen.getByLabelText('New label for the selected annotations'),
            { target: { value: 'Necrosis' } }
        );
        fireEvent.click(relabel);
        expect(bulkRelabel).toHaveBeenCalledWith('Necrosis');

        const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
        const bulkDelete = jest.spyOn(controller, 'bulkDelete');
        fireEvent.click(screen.getByTestId('annotation-bulk-delete'));
        expect(confirm).toHaveBeenCalledWith(
            'Delete 1 annotation? (2 not yours are skipped) Undo can bring it back.'
        );
        expect(bulkDelete).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('annotation-bulk-clear'));
        expect(screen.queryByTestId('annotation-bulk-bar')).toBeNull();
        expect(screen.queryByTestId('annotation-selection-frames')).toBeNull();
    });

    it('lists the selection keys in the shortcut help', () => {
        const { controller } = attached();
        render(<WsiAnnotationToolbar controller={controller} />);
        fireEvent.click(screen.getByTestId('annotation-more-menu-button'));
        fireEvent.click(screen.getByTestId('annotation-shortcuts'));
        const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
            .textContent;
        expect(help).toContain('Shift+drag');
        expect(help).toContain('Select all the list shows');
    });
});

describe('shapeContainsPoint and runLimited', () => {
    it('hits areas, and lines and points within the tolerance', () => {
        const tri = {
            kind: 'polygon' as const,
            points: [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
                { x: 0, y: 100 },
            ],
        };
        expect(shapeContainsPoint(tri, { x: 10, y: 10 }, 2)).toBe(true);
        expect(shapeContainsPoint(tri, { x: 80, y: 80 }, 2)).toBe(false);
        const line = {
            kind: 'line' as const,
            points: [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
            ] as [any, any],
        };
        expect(shapeContainsPoint(line, { x: 50, y: 3 }, 4)).toBe(true);
        expect(shapeContainsPoint(line, { x: 50, y: 6 }, 4)).toBe(false);
        expect(
            shapeContainsPoint({ kind: 'point', x: 5, y: 5 }, { x: 8, y: 5 }, 4)
        ).toBe(true);
        expect(
            shapeContainsPoint(
                { kind: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5 },
                { x: 9, y: 0 },
                0
            )
        ).toBe(true);
    });

    it('runs at most the limit at once and keeps the order', async () => {
        let running = 0;
        let most = 0;
        const out = await runLimited([1, 2, 3, 4, 5, 6], 2, async n => {
            running += 1;
            most = Math.max(most, running);
            await new Promise(resolve => setTimeout(resolve, 0));
            running -= 1;
            return n * 2;
        });
        expect(out).toEqual([2, 4, 6, 8, 10, 12]);
        expect(most).toBe(2);
    });
});
