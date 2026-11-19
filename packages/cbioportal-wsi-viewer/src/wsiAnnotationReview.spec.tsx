/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { runInAction } from 'mobx';
import { createOSDAnnotator } from '@annotorious/openseadragon';
import {
    WSI_REVIEW_UNSUPPORTED_MESSAGE,
    WsiAnnotationController,
} from './wsiAnnotationController';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { WsiAnnotationPanel } from './wsiAnnotationControls';
import { WsiAnnotationReviewCard } from './wsiAnnotationReview';
import { WsiAnnotationToolbar } from './wsiAnnotationToolbar';
import { WsiAnnotationOverlay } from './wsiAnnotationOverlay';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

const SLIDE_KEY = '0123456789ab';
const USER = 'reviewer';

/** A rectangle annotation as the service returns it. */
function row(
    id: string,
    x: number,
    y: number,
    provenance: Record<string, unknown> | null = { source: 'precomputed' },
    extra: Record<string, unknown> = {}
) {
    return {
        id,
        body: {
            label: `Label ${id}`,
            comment: '',
            layer_name: 'Model',
            color: '#ef4444',
            type: 'Model|#ef4444',
            provenance,
        },
        target: {
            selector: {
                type: 'FragmentSelector',
                value: `xywh=pixel:${x},${y},100,50`,
            },
        },
        version: 1,
        created_by: 'loader',
        ...extra,
    };
}

/** Reviewed by the in-memory service: the next version, with the decision. */
function reviewed(item: any, decision: string) {
    return {
        ...item,
        version: item.version + 1,
        body: {
            ...item.body,
            provenance: {
                ...item.body.provenance,
                review_status: decision === 'accept' ? 'accepted' : 'rejected',
            },
        },
    };
}

/**
 * A controller on a slide with three unreviewed AI annotations, one manual
 * and one accepted, attached to a stand-in viewer. The service answers
 * reviews from `rows`; `respond` can answer instead.
 */
function setup(
    options: {
        user?: string;
        respond?: (url: URL, init: RequestInit) => any;
    } = {}
) {
    const rows: Record<string, any> = {
        far: row('far', 3000, 3000),
        mid: row('mid', 400, 300),
        first: row('first', 0, 0),
        manual: row('manual', 50, 50, null),
        done: row('done', 60, 60, {
            source: 'agent',
            review_status: 'accepted',
        }),
    };
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(input as string);
        const custom = options.respond?.(url, init || {});
        if (custom) return custom;
        const [, , id, action] = url.pathname.split('/');
        if ((init?.method || 'GET') === 'GET') {
            return {
                ok: true,
                status: 200,
                json: async () =>
                    Object.values(rows).filter(
                        item =>
                            item.body.provenance?.review_status !== 'rejected'
                    ),
            } as Response;
        }
        if (action === 'review') {
            const sent = JSON.parse(init!.body as string);
            rows[id] = reviewed(rows[id], sent.decision);
            return {
                ok: true,
                status: 200,
                json: async () => rows[id],
            } as Response;
        }
        return { ok: false, status: 500 } as Response;
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
    controller.setCurrentUser(options.user || USER);
    (controller as any).slideKey = SLIDE_KEY;
    (controller as any).annotations = Object.values(rows).map(item =>
        (controller as any).fromApi(item, SLIDE_KEY)
    );
    const handlers: Record<string, (event: any) => void> = {};
    controller.attachViewer(
        {
            element: document.createElement('div'),
            addHandler: (name: string, handler: any) =>
                (handlers[name] = handler),
            removeHandler: jest.fn(),
        },
        {},
        SLIDE_KEY
    );
    const zoom = jest
        .spyOn(controller, 'zoomToAnnotation')
        .mockReturnValue(true);
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
    const canvasKey = (key: string) => {
        const event = {
            originalEvent: new KeyboardEvent('keydown', { key }),
            preventDefaultAction: false,
        };
        handlers['canvas-key'](event);
        return event.preventDefaultAction;
    };
    return { controller, rows, zoom, press, canvasKey, annotator };
}

/** Lets pending service answers and reactions settle. */
const settle = () =>
    act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));
    });

describe('AI review queue', () => {
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
    const track = (controller: WsiAnnotationController) => {
        cleanup.push(() => controller.detachViewer());
        return controller;
    };

    it('steps through unreviewed AI annotations from the top left, nearest next', () => {
        const { controller, zoom } = setup();
        track(controller);
        expect(controller.reviewableAi.map(item => item.id).sort()).toEqual([
            'far',
            'first',
            'mid',
        ]);
        expect(controller.startReview()).toBe(true);
        expect(controller.reviewQueue!.ids).toEqual(['first', 'mid', 'far']);
        expect(controller.reviewQueue!.currentId).toBe('first');
        expect(controller.focusedAnnotationId).toBe('first');
        expect(zoom).toHaveBeenLastCalledWith('first');
        expect(controller.reviewProgress).toEqual({ reviewed: 0, total: 3 });

        controller.reviewStep(1);
        expect(controller.reviewQueue!.currentId).toBe('mid');
        controller.reviewStep(1);
        controller.reviewStep(1);
        // Wraps around to the first one still unreviewed.
        expect(controller.reviewQueue!.currentId).toBe('first');
        controller.reviewStep(-1);
        expect(controller.reviewQueue!.currentId).toBe('far');
        expect(zoom).toHaveBeenLastCalledWith('far');
    });

    it('accepts and rejects with the review route, advancing and counting', async () => {
        const { controller, rows } = setup();
        track(controller);
        controller.startReview();

        await controller.reviewDecide('accept');
        const calls = (global.fetch as jest.Mock).mock.calls as Array<
            [string, RequestInit]
        >;
        expect(new URL(calls[0][0]).pathname).toBe('/annotations/first/review');
        expect(JSON.parse(calls[0][1].body as string)).toEqual({
            decision: 'accept',
            version: 1,
        });
        expect(controller.reviewQueue!.message).toBe('Accepted "Label first".');
        expect(controller.reviewQueue!.currentId).toBe('mid');
        expect(controller.reviewProgress).toEqual({ reviewed: 1, total: 3 });

        await controller.reviewDecide('reject');
        expect(rows.mid.body.provenance.review_status).toBe('rejected');
        expect(controller.annotations.map(item => item.id)).not.toContain(
            'mid'
        );
        expect(controller.reviewQueue!.currentId).toBe('far');
        expect(controller.reviewProgress).toEqual({ reviewed: 2, total: 3 });

        await controller.reviewDecide('accept');
        expect(controller.reviewQueue!.currentId).toBeNull();
        expect(controller.focusedAnnotationId).toBeNull();
        expect(controller.reviewProgress).toEqual({ reviewed: 3, total: 3 });
        // Reviews are not on the undo history.
        expect(controller.undoStack).toEqual([]);

        controller.exitReview();
        expect(controller.reviewQueue).toBeNull();
    });

    it('stays on the annotation after a conflict reloads the slide', async () => {
        let conflicts = 1;
        const { controller } = setup({
            respond: (url, init) => {
                if (
                    init.method === 'POST' &&
                    url.pathname.endsWith('/review') &&
                    conflicts-- > 0
                ) {
                    return {
                        ok: false,
                        status: 409,
                        clone() {
                            return this;
                        },
                        json: async () => ({ detail: 'Version conflict' }),
                    };
                }
                return null;
            },
        });
        track(controller);
        controller.startReview();
        controller.reviewStep(1);

        expect(await controller.reviewDecide('accept')).toBe(false);
        expect(controller.reviewQueue!.currentId).toBe('mid');
        expect(controller.reviewQueue!.message).toBe(
            'Annotation changed elsewhere; reloaded latest data.'
        );
        expect(controller.reviewQueue!.busy).toBe(false);

        // The retry goes through and moves on.
        expect(await controller.reviewDecide('accept')).toBe(true);
        expect(controller.reviewQueue!.currentId).toBe('far');
    });

    it('moves on when someone else reviewed the annotation meanwhile', async () => {
        const { controller, rows } = setup({
            respond: (url, init) => {
                if (
                    init.method === 'POST' &&
                    url.pathname.endsWith('/review')
                ) {
                    rows.first = reviewed(rows.first, 'accept');
                    return {
                        ok: false,
                        status: 409,
                        clone() {
                            return this;
                        },
                        json: async () => ({ detail: 'Version conflict' }),
                    };
                }
                return null;
            },
        });
        track(controller);
        controller.startReview();
        await controller.reviewDecide('reject');
        expect(controller.reviewQueue!.currentId).toBe('mid');
        expect(controller.reviewProgress.reviewed).toBe(1);
    });

    it('says why the queue cannot open: loading, read-only, signed out, no review route', () => {
        const { controller } = setup();
        track(controller);
        runInAction(() => (controller.loading = true));
        expect(controller.reviewUnavailable).toBe('Loading annotations…');
        expect(controller.startReview()).toBe(false);
        runInAction(() => {
            controller.loading = false;
            controller.accessIssue = 'forbidden';
        });
        expect(controller.reviewUnavailable).toMatch(/read-only/);
        runInAction(() => (controller.accessIssue = 'signedOut'));
        expect(controller.reviewUnavailable).toBe(
            'Sign in to view and edit annotations.'
        );
        runInAction(() => {
            controller.accessIssue = null;
            controller.reviewRoute = false;
        });
        // Without the review route only an annotation's creator reviews it.
        expect(controller.reviewUnavailable).toBe(
            WSI_REVIEW_UNSUPPORTED_MESSAGE
        );
        controller.setCurrentUser('loader');
        expect(controller.reviewUnavailable).toBeNull();
        expect(controller.reviewableAi).toHaveLength(3);
    });

    it('ends the queue when access is lost, saying so', async () => {
        const { controller } = setup({
            respond: (_url, init) =>
                init.method === 'POST'
                    ? { ok: false, status: 401, clone: () => null }
                    : null,
        });
        track(controller);
        controller.startReview();
        expect(await controller.reviewDecide('accept')).toBe(false);
        expect(controller.reviewQueue!.currentId).toBeNull();
        expect(controller.reviewQueue!.message).toBe(
            'Sign in to view and edit annotations.'
        );
    });

    it('takes no key while the host hides the viewer (another tab)', async () => {
        const { controller, press } = setup();
        track(controller);
        controller.setAnnotating(true);
        const decide = jest
            .spyOn(controller, 'reviewDecide')
            .mockResolvedValue(true);
        controller.startReview();
        controller.setViewerHidden(true);
        press('x');
        press('x');
        press('a');
        press('s');
        press('z', { ctrlKey: true });
        press('h');
        expect(decide).not.toHaveBeenCalled();
        expect(controller.reviewQueue!.currentId).toBe('first');
        expect(controller.hideAll).toBe(false);
        expect(controller.toolShortcutsActive).toBe(false);
        controller.setViewerHidden(false);
        press('x');
        press('x');
        expect(decide).toHaveBeenLastCalledWith('reject');
    });

    it('rejects nothing for a key pressed on another tab of the page', async () => {
        const { controller, rows } = setup();
        track(controller);
        controller.startReview();
        expect(controller.reviewQueue!.currentId).toBe('first');
        // Another tab is shown: the host hides the viewer (kept mounted),
        // and the focus is on that tab's link, outside the viewer.
        controller.setViewerHidden(true);
        const elsewhere = document.createElement('a');
        elsewhere.href = '#summary';
        document.body.appendChild(elsewhere);
        elsewhere.focus();
        act(() => {
            elsewhere.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'x',
                    bubbles: true,
                    cancelable: true,
                })
            );
            elsewhere.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'x',
                    bubbles: true,
                    cancelable: true,
                })
            );
        });
        await settle();
        elsewhere.remove();
        expect(rows.first.body.provenance.review_status).toBeUndefined();
        expect(controller.reviewQueue!.currentId).toBe('first');
    });

    it('takes A, X, S and the arrows before the tool shortcuts while open; X asks first', async () => {
        const { controller, press, canvasKey } = setup();
        track(controller);
        controller.setAnnotating(true);
        const decide = jest
            .spyOn(controller, 'reviewDecide')
            .mockResolvedValue(true);
        controller.startReview();

        // One X only asks; Esc takes it back; X then Enter (or X) rejects.
        press('x');
        expect(decide).not.toHaveBeenCalled();
        expect(controller.rejectArmed).toBe('first');
        press('Escape');
        expect(controller.rejectArmed).toBeNull();
        expect(controller.reviewQueue).not.toBeNull();
        press('x');
        press('Enter');
        expect(decide).toHaveBeenLastCalledWith('reject');
        expect(controller.activeTool).toBeNull();
        // R is not a review key: it never rejects.
        press('r');
        expect(decide).toHaveBeenCalledTimes(1);
        expect(controller.rejectArmed).toBeNull();
        press('A');
        expect(decide).toHaveBeenLastCalledWith('accept');
        press('s');
        expect(controller.reviewQueue!.currentId).toBe('mid');
        press('ArrowRight');
        expect(controller.reviewQueue!.currentId).toBe('far');
        press('ArrowLeft');
        expect(controller.reviewQueue!.currentId).toBe('mid');
        // Tool keys do nothing while reviewing.
        press('l');
        expect(controller.activeTool).toBeNull();
        // OpenSeadragon does not pan or rotate with the review keys.
        expect(canvasKey('a')).toBe(true);
        expect(canvasKey('ArrowLeft')).toBe(true);
        expect(canvasKey('x')).toBe(true);

        // Not while typing, and not for a key a control already took.
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'a', bubbles: true })
        );
        input.remove();
        const taken = new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            cancelable: true,
        });
        taken.preventDefault();
        document.dispatchEvent(taken);
        expect(decide).toHaveBeenCalledTimes(2);
        expect(controller.reviewQueue!.currentId).toBe('mid');

        press('Escape');
        expect(controller.reviewQueue).toBeNull();
        // Closed, R picks the Shape tool again.
        press('r');
        expect(controller.activeTool).toBe('rectangle');
    });

    it('shows the annotation under review even when its kind is hidden', () => {
        const { controller } = setup();
        track(controller);
        controller.toggleHideUnreviewedAi();
        expect(
            controller.shownAnnotations.some(item => item.id === 'first')
        ).toBe(false);
        controller.startReview();
        expect(controller.shownAnnotations.map(item => item.id)).toContain(
            'first'
        );
        expect(controller.shownAnnotations.map(item => item.id)).not.toContain(
            'mid'
        );
    });

    it('highlights the annotation under review on the slide', () => {
        const { controller } = setup();
        track(controller);
        jest.spyOn(controller as any, 'screenPoint').mockImplementation(
            (point: any) => ({
                x: point.x / 2,
                y: point.y / 2,
            })
        );
        render(<WsiAnnotationOverlay controller={controller} />);
        expect(screen.queryByTestId('annotation-overlay')).toBeNull();
        act(() => {
            controller.startReview();
        });
        expect(controller.focusedBox).toEqual({
            x: 0,
            y: 0,
            width: 50,
            height: 25,
        });
        const highlight = screen.getByTestId('annotation-focus-highlight');
        const rect = highlight.querySelector('rect')!;
        expect(rect.getAttribute('width')).toBe('62');
        expect(
            screen.getByTestId('annotation-overlay').getAttribute('aria-hidden')
        ).toBe('true');
    });
});

describe('AI review card', () => {
    beforeAll(() => loadAnnotorious());
    beforeEach(() => {
        jest.restoreAllMocks();
        window.localStorage.clear();
    });

    function controllerWith(user = USER) {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        controller.setCurrentUser(user);
        (controller as any).slideKey = SLIDE_KEY;
        (controller as any).annotations = [
            row('first', 0, 0, { source: 'precomputed', model: 'luad' }, {}),
            row('mid', 400, 300, { source: 'agent' }),
        ].map(item => {
            const annotation = (controller as any).fromApi(item, SLIDE_KEY);
            return item.id === 'first'
                ? { ...annotation, note: 'Check the margin' }
                : annotation;
        });
        return controller;
    }

    it('opens from the sidebar, takes the focus, shows the annotation and gives the focus back', () => {
        const controller = controllerWith();
        jest.spyOn(controller, 'zoomToAnnotation').mockReturnValue(true);
        render(
            <>
                <WsiAnnotationPanel controller={controller} />
                <WsiAnnotationReviewCard controller={controller} />
            </>
        );
        const start = screen.getByTestId('annotation-review-start');
        expect(start.textContent).toBe('Review AI (2)');
        start.focus();
        fireEvent.click(start);

        const card = screen.getByRole('dialog', {
            name: 'Review AI annotations',
        });
        const accept = screen.getByTestId('annotation-review-accept');
        expect(document.activeElement).toBe(accept);
        expect(accept.getAttribute('aria-keyshortcuts')).toBe('A');
        expect(screen.getByTestId('annotation-review-label').textContent).toBe(
            'Label first'
        );
        expect(screen.getByTestId('annotation-review-origin').textContent).toBe(
            'Made by a model (luad) · Layer Model'
        );
        expect(
            screen.getByTestId('annotation-review-measurement').textContent
        ).toMatch(/^Area .*Perimeter/);
        expect(screen.getByTestId('annotation-review-note').textContent).toBe(
            'Check the margin'
        );
        const progress = screen.getByTestId('annotation-review-progress');
        expect(progress.getAttribute('role')).toBe('status');
        expect(progress.textContent).toBe('0 of 2 reviewed');
        expect(card.textContent).toContain('X reject (X again to confirm)');

        const decide = jest
            .spyOn(controller, 'reviewDecide')
            .mockResolvedValue(true);
        // Reject asks first: the button becomes Confirm reject, with Cancel
        // and what a reject does.
        const reject = screen.getByTestId('annotation-review-reject');
        fireEvent.click(reject);
        expect(decide).not.toHaveBeenCalled();
        expect(reject.textContent).toBe('Confirm rejectX');
        const help = screen.getByTestId('annotation-review-reject-help');
        expect(help.getAttribute('role')).toBe('alert');
        expect(help.textContent).toBe(
            'Reject "Label first"? It is hidden for everyone (the service keeps it as a review record); this cannot be undone. Press X or Enter to confirm, Esc to cancel.'
        );
        expect(reject.getAttribute('aria-describedby')).toBe(help.id);
        fireEvent.click(screen.getByTestId('annotation-review-reject-cancel'));
        expect(controller.rejectArmed).toBeNull();
        fireEvent.click(reject);
        fireEvent.click(reject);
        expect(decide).toHaveBeenCalledWith('reject');
        fireEvent.click(screen.getByTestId('annotation-review-skip'));
        expect(screen.getByTestId('annotation-review-label').textContent).toBe(
            'Label mid'
        );

        fireEvent.click(screen.getByTestId('annotation-review-exit'));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(start);
    });

    it('ignores clicks while a decision is saving', () => {
        const controller = controllerWith();
        jest.spyOn(controller, 'zoomToAnnotation').mockReturnValue(true);
        controller.startReview();
        render(<WsiAnnotationReviewCard controller={controller} />);
        const decide = jest.spyOn(controller, 'reviewDecide');
        act(() => {
            runInAction(() => {
                controller.reviewQueue = {
                    ...controller.reviewQueue!,
                    busy: true,
                };
            });
        });
        const accept = screen.getByTestId('annotation-review-accept');
        expect(accept.getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(accept);
        expect(decide).not.toHaveBeenCalled();
    });

    it('says when all are reviewed, with Done in focus', () => {
        const controller = controllerWith();
        jest.spyOn(controller, 'zoomToAnnotation').mockReturnValue(true);
        controller.startReview();
        render(<WsiAnnotationReviewCard controller={controller} />);
        act(() => {
            runInAction(() => {
                (controller as any).annotations = controller.annotations.map(
                    item => ({
                        ...item,
                        provenance: {
                            ...item.provenance,
                            review_status: 'accepted',
                        },
                    })
                );
            });
            controller.reviewStep(1);
        });
        expect(
            screen.getByTestId('annotation-review-done').textContent
        ).toContain('All 2 AI annotations reviewed.');
        expect(document.activeElement).toBe(
            screen.getByTestId('annotation-review-finish')
        );
        expect(
            screen.getByTestId('annotation-review-progress').textContent
        ).toBe('2 of 2 reviewed');
    });

    it('disables the entry with the reason when the user cannot review', () => {
        const controller = controllerWith();
        runInAction(() => (controller.accessIssue = 'forbidden'));
        render(<WsiAnnotationPanel controller={controller} />);
        const start = screen.getByTestId('annotation-review-start');
        expect(start.getAttribute('aria-disabled')).toBe('true');
        expect(start.getAttribute('title')).toMatch(/read-only/);
        fireEvent.click(start);
        expect(controller.reviewQueue).toBeNull();
    });

    it('opens from the ⋯ menu, and lists the review keys in the shortcut help', () => {
        const controller = controllerWith();
        jest.spyOn(controller, 'zoomToAnnotation').mockReturnValue(true);
        render(<WsiAnnotationToolbar controller={controller} />);
        const more = screen.getByTestId('annotation-more-menu-button');
        fireEvent.click(more);
        const item = screen.getByTestId('annotation-review-start-menu');
        expect(item.textContent).toBe('Review AI annotations (2)…');
        fireEvent.click(item);
        expect(controller.reviewQueue?.currentId).toBe('first');

        fireEvent.click(more);
        fireEvent.click(screen.getByTestId('annotation-shortcuts'));
        const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
        expect(help.textContent).toContain('Reviewing AI annotations');
        expect(help.textContent).toContain('X or Enter again rejects');
    });
});
