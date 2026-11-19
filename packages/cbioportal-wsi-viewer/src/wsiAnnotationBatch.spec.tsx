/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { WsiAnnotationBulkBar } from './wsiAnnotationBulkBar';
import { WSI_REVIEW_UNDO_NOTICE } from './wsiAnnotationController';
import {
    attachTestController,
    flush,
    serviceRow,
    TestAnnotationService,
    TestServiceOptions,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

describe('Bulk actions over the batch routes', () => {
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

    async function setup(rows: any[], options: TestServiceOptions = {}) {
        const service = new TestAnnotationService(rows, options).install();
        const harness = await attachTestController(service);
        cleanup.push(harness.cleanup);
        return { service, ...harness };
    }

    const mine = (n: number) =>
        Array.from({ length: n }, (_, i) =>
            serviceRow(`m${i}`, `${i * 10},0,5,5`, { label: `Cell ${i}` })
        );
    const batches = (service: TestAnnotationService, kind: string) =>
        service.calls.filter(
            call => call.path === `/wsi/annotations/batch-${kind}`
        );

    it('relabels in batches of 100, as one undo step', async () => {
        const { controller, service } = await setup([
            ...mine(150),
            serviceRow('theirs', '0,50,5,5', { creator: 'other' }),
        ]);
        controller.selectAllListed();
        await act(async () => {
            await controller.bulkRelabel('Tumor');
        });
        const sent = batches(service, 'update');
        expect(sent.map(call => call.body.items.length)).toEqual([100, 50]);
        expect(sent[0].body.items[0]).toMatchObject({
            id: 'm0',
            version: 1,
            body: { label: 'Tumor', layer_name: 'Default' },
            target: { selector: { type: 'FragmentSelector' } },
            visible_to: [],
        });
        expect(service.writes()).toHaveLength(2);
        expect(service.rows.get('m149').body.label).toBe('Tumor');
        expect(service.rows.get('theirs').body.label).toBe('Label theirs');
        expect(controller.bulkRoutes.update).toBe(true);
        expect(
            controller.annotations.find(item => item.id === 'm3')!.version
        ).toBe(2);
        expect(controller.bulkMessage).toBe(
            'Relabelled 150 annotations; skipped 1 that is not yours.'
        );
        expect(controller.undoLabel).toBe('Undo edit of 150 annotations');
        await act(async () => {
            await controller.undo();
        });
        expect(service.rows.get('m149').body.label).toBe('Cell 149');
        expect(controller.undoStack).toHaveLength(0);
    });

    it('deletes in one batch, as one undo step', async () => {
        const { controller, service } = await setup(mine(3));
        controller.selectAllListed();
        await act(async () => {
            await controller.bulkDelete();
        });
        expect(service.writes()).toEqual([
            ['POST', '/wsi/annotations/batch-delete'],
        ]);
        expect(batches(service, 'delete')[0].body.items).toEqual([
            { id: 'm0', version: 1 },
            { id: 'm1', version: 1 },
            { id: 'm2', version: 1 },
        ]);
        expect(service.rows.size).toBe(0);
        expect(controller.annotations).toHaveLength(0);
        expect(controller.undoLabel).toBe('Undo delete of 3 annotations');
        await act(async () => {
            await controller.undo();
        });
        expect(service.rows.size).toBe(3);
    });

    it('accepts and rejects in batches, off the undo history', async () => {
        const ai = (id: string) =>
            serviceRow(id, '0,0,5,5', {
                creator: 'loader',
                provenance: { source: 'model' },
            });
        const { controller, service } = await setup([
            ai('ai1'),
            ai('ai2'),
            ai('ai3'),
            ...mine(1),
        ]);
        controller.select(['ai1', 'ai2', 'm0']);
        await act(async () => {
            await controller.bulkReview('accept');
        });
        expect(batches(service, 'review')[0].body.items).toEqual([
            { id: 'ai1', version: 1, decision: 'accept' },
            { id: 'ai2', version: 1, decision: 'accept' },
        ]);
        expect(controller.reviewRoute).toBe(true);
        expect(
            controller.annotations.find(item => item.id === 'ai1')!.provenance
        ).toMatchObject({ review_status: 'accepted', reviewed_by: 'me' });
        expect(controller.bulkMessage).toBe(
            'Accepted 2 annotations; skipped 1 that is not unreviewed AI annotations you can review.'
        );
        controller.select(['ai3'], false);
        await act(async () => {
            await controller.bulkReview('reject');
        });
        expect(controller.annotations.map(item => item.id)).not.toContain(
            'ai3'
        );
        expect(controller.canUndo).toBe(false);
    });

    it('asks before a bulk reject, and Undo after a review leaves earlier edits', async () => {
        const ai = (id: string) =>
            serviceRow(id, '0,0,5,5', {
                creator: 'loader',
                provenance: { source: 'model' },
            });
        const { controller, service } = await setup([
            ai('ai1'),
            ai('ai2'),
            ...mine(1),
        ]);
        // An earlier edit of the user's, on the undo history.
        await act(async () => {
            await controller.renameAnnotation('m0', 'Renamed');
        });
        controller.select(['ai1', 'ai2']);
        render(<WsiAnnotationBulkBar controller={controller} />);
        const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
        fireEvent.click(screen.getByTestId('annotation-bulk-actions'));
        fireEvent.click(screen.getByTestId('annotation-bulk-reject'));
        expect(confirm).toHaveBeenCalledWith(
            "Reject 2 AI annotations? They are hidden for everyone; the service keeps them as a review record. Reviews can't be undone."
        );
        expect(batches(service, 'review')).toHaveLength(0);
        confirm.mockReturnValue(true);
        fireEvent.click(screen.getByTestId('annotation-bulk-actions'));
        fireEvent.click(screen.getByTestId('annotation-bulk-reject'));
        await flush();
        expect(batches(service, 'review')).toHaveLength(1);
        // The bar says a review cannot be undone.
        expect(
            screen.getByTestId('annotation-bulk-undo-note').textContent
        ).toBe("Reviews can't be undone.");
        // Undo says reviews cannot be undone instead of renaming m0 back.
        expect(controller.canUndo).toBe(true);
        await act(async () => {
            expect(await controller.undo()).toBe(false);
        });
        expect(controller.notice).toBe(WSI_REVIEW_UNDO_NOTICE);
        expect(service.rows.get('m0')!.body.label).toBe('Renamed');
        // Pressed again, it undoes the earlier edit.
        await act(async () => {
            expect(await controller.undo()).toBe(true);
        });
        expect(service.rows.get('m0')!.body.label).toBe('Cell 0');
    });

    it('reports conflicts, reloads those rows and saves the rest', async () => {
        const { controller, service } = await setup(mine(3));
        // m1 changed elsewhere since it loaded.
        service.rows.set('m1', {
            ...service.rows.get('m1'),
            body: { ...service.rows.get('m1').body, label: 'Changed' },
            version: 2,
        });
        controller.selectAllListed();
        await act(async () => {
            await controller.bulkMoveToLayer('Stroma');
        });
        await flush();
        const sent = batches(service, 'update');
        expect(sent.map(call => call.body.items.map((i: any) => i.id))).toEqual(
            [
                ['m0', 'm1', 'm2'],
                ['m0', 'm2'],
            ]
        );
        expect(service.rows.get('m0').body.layer_name).toBe('Stroma');
        expect(service.rows.get('m1').body.layer_name).toBe('Default');
        // The reloaded row shows as stored.
        expect(
            controller.annotations.find(item => item.id === 'm1')!.body[0].value
        ).toBe('Changed');
        expect(controller.bulkMessage).toBe(
            'Moved to "Stroma" 2 annotations; 1 could not be saved ("Cell 1": changed elsewhere; reloaded).'
        );
        expect(controller.undoLabel).toBe('Undo edit of 2 annotations');
    });

    it('names an annotation refused or missing, and saves the rest', async () => {
        const { controller, service } = await setup([
            ...mine(3),
            serviceRow('theirs', '0,50,5,5', { creator: 'other' }),
        ]);
        // With the user unknown, the viewer lets the service decide.
        controller.setCurrentUser(null);
        service.rows.delete('m2');
        controller.selectAllListed();
        await act(async () => {
            await controller.bulkSetShared(false);
        });
        await flush();
        const sent = batches(service, 'update');
        expect(sent.map(call => call.body.items.map((i: any) => i.id))).toEqual(
            [
                ['m0', 'm1', 'm2', 'theirs'],
                ['m0', 'm1', 'theirs'],
                ['m0', 'm1'],
            ]
        );
        expect(service.rows.get('m0').visible_to).toBeNull();
        expect(controller.bulkMessage).toBe(
            'Made private 2 annotations; 2 could not be saved ("Cell 2": Annotation not found; "Label theirs": Only the creator may change this annotation).'
        );
        // The missing one reloaded the slide.
        expect(controller.annotations.map(item => item.id)).not.toContain('m2');
    });

    it('falls back to one request each without the route', async () => {
        const { controller, service } = await setup(mine(2), {
            missing: ['batchDelete'],
        });
        controller.selectAllListed();
        await act(async () => {
            await controller.bulkDelete();
        });
        expect(service.writes()).toEqual([
            ['POST', '/wsi/annotations/batch-delete'],
            ['DELETE', '/wsi/annotations/m0'],
            ['DELETE', '/wsi/annotations/m1'],
        ]);
        expect(controller.bulkRoutes.delete).toBe(false);
        expect(controller.undoLabel).toBe('Undo delete of 2 annotations');
        // Later bulk deletes go one by one straight away.
        await act(async () => {
            await controller.undo();
        });
        controller.selectAllListed();
        const before = service.calls.length;
        await act(async () => {
            await controller.bulkDelete();
        });
        expect(
            service.calls
                .slice(before)
                .filter(call => call.path.includes('batch-delete'))
        ).toHaveLength(0);
    });
});
