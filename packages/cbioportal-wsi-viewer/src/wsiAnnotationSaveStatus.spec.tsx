/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import {
    LIVE_COUNT_THROTTLE_MS,
    useThrottled,
    WsiAnnotationToolbar,
} from './wsiAnnotationToolbar';
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

describe('The save status', () => {
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

    async function setup(refuse = false) {
        let refusing = refuse;
        const service = new TestAnnotationService(
            [serviceRow('a1', '0,0,9,9')],
            {
                override: request =>
                    refusing && request.path.endsWith('/batch')
                        ? { status: 403, body: { detail: 'Forbidden' } }
                        : undefined,
            }
        ).install();
        const harness = await attachTestController(service);
        cleanup.push(harness.cleanup);
        render(<WsiAnnotationToolbar controller={harness.controller} />);
        return {
            service,
            ...harness,
            stopRefusing: () => (refusing = false),
        };
    }

    const status = () => screen.getByTestId('annotation-save-status');
    const live = () => screen.getByTestId('annotation-save-status-live');

    it('counts what is waiting and being sent, then says Saved', async () => {
        const { controller, service, pointer } = await setup();
        // The live region is on the page before anything is saved.
        expect(live().getAttribute('role')).toBe('status');
        expect(status().getAttribute('aria-hidden')).toBe('true');
        expect(status().getAttribute('data-state')).toBe('idle');
        expect(status().textContent).toBe('');

        controller.setAnnotating(true);
        controller.setTool('point');
        for (const x of [10, 20, 30]) {
            pointer('pointerdown', x, 10);
            pointer('pointerup', x, 10);
        }
        // Shown at once; announced as it starts, then as it settles (see
        // useThrottled below), not at every point.
        expect(status().textContent).toBe('Saving… 3');
        expect(live().textContent).toBe('Saving… 1');
        service.hold = true;
        let flushed = false;
        void controller.flushPoints().then(() => (flushed = true));
        await act(async () => {
            await Promise.resolve();
        });
        // Sent in one batch of three, not answered yet.
        expect(status().textContent).toBe('Saving… 3');
        expect(status().getAttribute('data-state')).toBe('saving');
        service.release();
        await flush();
        expect(flushed).toBe(true);
        expect(status().textContent).toBe('Saved');
        expect(status().getAttribute('title')).toBe('All changes are saved');

        // An edit counts one.
        service.hold = true;
        const rename = controller.renameAnnotation('a1', 'Tumor');
        await act(async () => {
            await Promise.resolve();
        });
        expect(status().textContent).toBe('Saving… 1');
        service.release();
        await act(async () => {
            await rename;
        });
        expect(status().textContent).toBe('Saved');

        // With Annotate off, "Saved" goes; saving would still show.
        act(() => controller.setAnnotating(false));
        expect(status().getAttribute('data-state')).toBe('idle');
    });

    it('says how many points were not saved, and Retry sends them again', async () => {
        const { controller, service, pointer, stopRefusing } = await setup(
            true
        );
        controller.setAnnotating(true);
        controller.setTool('point');
        pointer('pointerdown', 10, 10);
        pointer('pointerup', 10, 10);
        pointer('pointerdown', 20, 10);
        pointer('pointerup', 20, 10);
        await act(async () => {
            await controller.flushPoints();
        });
        expect(status().textContent).toBe('2 not saved');
        expect(status().getAttribute('data-state')).toBe('unsaved');
        const retry = screen.getByTestId('annotation-save-status-retry');
        expect(retry.getAttribute('aria-label')).toBe('Retry saving 2 points');

        stopRefusing();
        fireEvent.click(retry);
        await flush();
        expect(status().textContent).toBe('Saved');
        expect(screen.queryByTestId('annotation-save-status-retry')).toBeNull();
        expect(
            service.writes().filter(([, path]) => path.endsWith('/batch'))
        ).toHaveLength(2);
    });
});

describe('useThrottled', () => {
    function Probe({ value }: { value: string }) {
        const shown = useThrottled(
            value,
            LIVE_COUNT_THROTTLE_MS,
            (a, b) => a.replace(/\d+/g, '') !== b.replace(/\d+/g, '')
        );
        return <span data-testid="probe">{shown}</span>;
    }

    it('passes a changing count at most once per interval, the last one always, and a new kind at once', () => {
        jest.useFakeTimers('modern');
        try {
            const view = render(<Probe value="Saving… 1" />);
            const shown = () => screen.getByTestId('probe').textContent;
            expect(shown()).toBe('Saving… 1');
            view.rerender(<Probe value="Saving… 2" />);
            view.rerender(<Probe value="Saving… 3" />);
            expect(shown()).toBe('Saving… 1');
            act(() => {
                jest.advanceTimersByTime(LIVE_COUNT_THROTTLE_MS);
            });
            expect(shown()).toBe('Saving… 3');
            view.rerender(<Probe value="Saving… 4" />);
            view.rerender(<Probe value="Saved" />);
            expect(shown()).toBe('Saved');
        } finally {
            jest.useRealTimers();
        }
    });
});
