/**
 * @jest-environment jsdom
 */
import { act } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { POINT_UNDO_GROUP_MS } from './wsiAnnotationController';
import {
    attachTestController,
    TestAnnotationService,
    TestServiceOptions,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

describe('Point drops undo together', () => {
    beforeAll(() => loadAnnotorious());
    let cleanup: Array<() => void> = [];
    let now = 1_000_000;
    beforeEach(() => {
        jest.restoreAllMocks();
        window.localStorage.clear();
        now = 1_000_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => {
        cleanup.forEach(run => run());
        cleanup = [];
    });

    async function setup(options: TestServiceOptions = {}) {
        const service = new TestAnnotationService([], options).install();
        const harness = await attachTestController(service);
        cleanup.push(harness.cleanup);
        harness.controller.setAnnotating(true);
        harness.controller.setTool('point');
        const drop = (x: number, wait = 400) => {
            now += wait;
            harness.pointer('pointerdown', x, 10);
            harness.pointer('pointerup', x, 10);
        };
        const flushPoints = () =>
            act(async () => {
                await harness.controller.flushPoints();
            });
        return { service, ...harness, drop, flushPoints };
    }

    it('undoes a run of drops in one step, and redoes it in one', async () => {
        const { controller, service, drop, flushPoints } = await setup();
        drop(10);
        drop(20);
        await flushPoints();
        // A later save of the same run joins the same step.
        drop(30);
        await flushPoints();
        expect(service.rows.size).toBe(3);
        expect(controller.undoStack).toHaveLength(1);
        expect(controller.undoLabel).toBe('Undo create of 3 points');

        // Each point stays its own annotation.
        const ids = controller.annotations.map(item => item.id);
        expect(new Set(ids).size).toBe(3);

        await act(async () => {
            await controller.undo();
        });
        expect(service.rows.size).toBe(0);
        expect(controller.annotations).toHaveLength(0);
        const deletes = service.calls.filter(
            call => call.path === '/wsi/annotations/batch-delete'
        );
        expect(deletes).toHaveLength(1);
        expect(deletes[0].body.items.map((item: any) => item.id)).toEqual(ids);
        expect(controller.redoLabel).toBe('Redo create of 3 points');

        await act(async () => {
            await controller.redo();
        });
        expect(service.rows.size).toBe(3);
        // Redo restores the points under their ids, in one batch restore.
        expect(controller.annotations.map(item => item.id).sort()).toEqual(
            [...ids].sort()
        );
        const restores = service.calls.filter(
            call => call.path === '/wsi/annotations/batch-restore'
        );
        expect(restores).toHaveLength(1);
        expect(restores[0].body.items.map((item: any) => item.id)).toEqual(ids);
        expect(
            service.calls.filter(call => call.path === '/wsi/annotations/batch')
        ).toHaveLength(2);
        expect(controller.undoLabel).toBe('Undo create of 3 points');
        await act(async () => {
            await controller.undo();
        });
        expect(service.rows.size).toBe(0);
    });

    it('creates a run again with new ids on a service without restores', async () => {
        const { controller, service, drop, flushPoints } = await setup({
            missing: ['restore'],
        });
        drop(10);
        drop(20);
        await flushPoints();
        const ids = controller.annotations.map(item => item.id);
        await act(async () => {
            await controller.undo();
        });
        await act(async () => {
            await controller.redo();
        });
        expect(service.rows.size).toBe(2);
        expect(
            service.calls.filter(
                call => call.path === '/wsi/annotations/batch-restore'
            )
        ).toHaveLength(1);
        expect(
            service.calls.filter(call => call.path === '/wsi/annotations/batch')
        ).toHaveLength(2);
        const again = controller.annotations.map(item => item.id);
        expect(again.some(id => ids.includes(id))).toBe(false);
        expect(controller.restoreRoute).toBe(false);
        expect(controller.bulkRoutes.restore).toBe(false);
        // The history follows the new ids.
        await act(async () => {
            await controller.undo();
        });
        expect(service.rows.size).toBe(0);
    });

    it('starts a new step after a pause, a tool change or another change', async () => {
        const { controller, drop, flushPoints } = await setup();
        drop(10);
        drop(20);
        // A pause longer than the window starts a new run.
        drop(30, POINT_UNDO_GROUP_MS + 1);
        await flushPoints();
        expect(
            controller.undoStack.map(entry => (entry as any).ids.length)
        ).toEqual([2, 1]);

        // Picking the tool again starts a new run.
        controller.cancelDrawing();
        controller.setTool('point');
        drop(40);
        await flushPoints();
        expect(controller.undoStack).toHaveLength(3);

        // Another change in between ends the run; the point is edited alone.
        const point = controller.annotations[controller.annotations.length - 1];
        await act(async () => {
            await controller.renameAnnotation(point.id, 'Mitosis');
        });
        drop(50);
        await flushPoints();
        expect(controller.undoStack.map(entry => entry.kind)).toEqual([
            'create',
            'create',
            'create',
            'update',
            'create',
        ]);
        expect(
            controller.annotations.find(item => item.id === point.id)!.body[0]
                .value
        ).toBe('Mitosis');
    });

    it('undoes a run one point at a time on a service without batch deletes', async () => {
        const { controller, service, drop, flushPoints } = await setup({
            missing: ['batchDelete'],
        });
        drop(10);
        drop(20);
        await flushPoints();
        await act(async () => {
            await controller.undo();
        });
        expect(service.rows.size).toBe(0);
        expect(
            service.writes().filter(([method]) => method === 'DELETE')
        ).toHaveLength(2);
        expect(controller.bulkRoutes.delete).toBe(false);
    });
});
