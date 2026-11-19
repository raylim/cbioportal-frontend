/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { WsiAnnotationPanel } from './wsiAnnotationControls';
import { WsiAnnotationBulkBar } from './wsiAnnotationBulkBar';
import { drawAnnotationScene } from './wsiAnnotationSnapshot';
import { WSI_SHAPE_REFUSED } from './wsiAnnotationController';
import {
    parseAnnotationShape,
    regionShape,
} from './wsiAnnotationGeometryUtils';
import {
    attachTestController,
    flush,
    pointRow,
    serviceRow,
    TestAnnotationService,
    TestServiceOptions,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

/** A 100×100 square at (x, y) as a polygon selector. */
const squareSvg = (x: number, y: number, size = 100) =>
    `<svg><polygon points="${x},${y} ${x + size},${y} ${x + size},${y +
        size} ${x},${y + size}" /></svg>`;

/** The 100×100 square at the origin with a 20×20 hole at (40, 40). */
const HOLED =
    '<svg><g><path fill-rule="evenodd" d="M 0,0 L 100,0 L 100,100 L 0,100 Z M 40,40 L 60,40 L 60,60 L 40,60 Z" /></g></svg>';

/** The same square after a 20×20 cut at (40, 40): the hole runs the other way. */
const CUT =
    '<svg><g><path fill-rule="evenodd" d="M 0,0 L 100,0 L 100,100 L 0,100 Z M 40,40 L 40,60 L 60,60 L 60,40 Z" /></g></svg>';

const AGENT = { source: 'agent', proposal_id: 'p1' };

describe('Shape editing: holes, merge, subtract, intersect, cut, split', () => {
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

    const stored = (service: TestAnnotationService, id: string) =>
        service.rows.get(id)!;
    const area = (controller: any, id: string) =>
        controller.measurementOf(
            controller.annotations.find((item: any) => item.id === id)
        )!.area;
    /** Draws a box from `from` to `to`, with Alt held at the end if asked. */
    const box = (
        harness: { pointer: (...args: any[]) => any },
        from: [number, number],
        to: [number, number],
        alt = false
    ) => {
        harness.pointer('pointerdown', ...from);
        harness.pointer('pointermove', ...to);
        harness.pointer('pointerup', ...to, { altKey: alt });
    };

    it('reads, measures, counts and hit-tests a region with a hole', async () => {
        const { controller } = await setup([
            serviceRow('holed', HOLED, { label: 'Tumor' }),
            pointRow('in', 10, 10),
            pointRow('hole', 45, 55),
        ]);
        const holed = controller.annotations.find(item => item.id === 'holed')!;
        expect(controller.shapeOf(holed)!.kind).toBe('multipolygon');
        expect(controller.measurementOf(holed)).toEqual({
            unit: 'px',
            area: 9600,
            perimeter: 480,
        });
        expect(controller.pointsInside(holed)!.total).toBe(1);
        // A click in the hole is on nothing; on the region it picks it.
        expect(controller.annotationAt({ x: 50, y: 50 })).toBeNull();
        expect(controller.annotationAt({ x: 20, y: 20 })!.id).toBe('holed');
        const feature = controller
            .exportGeoJson('all')
            .features.find(item => item.id === 'holed')!;
        expect(feature.geometry.type).toBe('Polygon');
        expect((feature.geometry.coordinates as any).length).toBe(2);
    });

    it('fills a holed region even-odd in the downloaded view', () => {
        const calls: string[] = [];
        const context: any = new Proxy(
            {},
            {
                get: (target: any, name: string) =>
                    name in target
                        ? target[name]
                        : (...args: any[]) =>
                              calls.push(`${name}(${args.join(',')})`),
                set: (target: any, name: string, value: any) => {
                    target[name] = value;
                    return true;
                },
            }
        );
        drawAnnotationScene(
            context,
            {
                affine: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
                shapes: [
                    {
                        shape: parseAnnotationShape({
                            type: 'SvgSelector',
                            value: HOLED,
                        })!,
                        color: '#ff0000',
                    },
                ],
                points: [],
                labels: [],
                fillOpacity: 0.2,
            },
            1
        );
        expect(calls.filter(call => call.startsWith('closePath'))).toHaveLength(
            2
        );
        expect(calls).toContain('fill(evenodd)');
    });

    it('cuts a hole with "Cut a hole…", as one undo step', async () => {
        const harness = await setup([
            serviceRow('mine', squareSvg(0, 0), { label: 'Tumor' }),
        ]);
        const { controller, service } = harness;
        controller.select(['mine']);
        controller.runShapeOp('cut');
        expect(controller.shapeEditMode).toBe('cut');
        expect(controller.activeTool).toBe('polygon');
        expect(controller.shapeEditHint).toBe(
            'Cut a hole: draw a shape inside "Tumor"; it is cut out. Esc stops.'
        );
        controller.setTool('rectangle');
        box(harness, [40, 40], [60, 60]);
        await flush();
        expect(service.writes()).toEqual([['PUT', '/wsi/annotations/mine']]);
        expect(stored(service, 'mine').target.selector.value).toBe(CUT);
        expect(area(controller, 'mine')).toBe(9600);
        expect(controller.bulkMessage).toBe('Cut the shape out of "Tumor".');
        // The cut stays on for the next hole.
        expect(controller.shapeEditMode).toBe('cut');
        expect(controller.undoLabel).toBe('Undo cut');
        await act(async () => {
            await controller.undo();
        });
        expect(stored(service, 'mine').target.selector.value).toBe(
            squareSvg(0, 0)
        );
        expect(area(controller, 'mine')).toBe(10000);
        expect(controller.redoLabel).toBe('Redo cut');
        await act(async () => {
            await controller.redo();
        });
        expect(area(controller, 'mine')).toBe(9600);
        // Esc stops the cut and goes back to Select.
        harness.press('Escape');
        expect(controller.shapeEditMode).toBeNull();
        expect(controller.activeTool).toBeNull();
    });

    it('cuts with Alt held as a shape ends, without saving the shape', async () => {
        const harness = await setup([serviceRow('mine', squareSvg(0, 0))]);
        const { controller, service } = harness;
        controller.select(['mine']);
        controller.setTool('rectangle');
        box(harness, [40, 40], [60, 60], true);
        await flush();
        expect(service.writes()).toEqual([['PUT', '/wsi/annotations/mine']]);
        expect(area(controller, 'mine')).toBe(9600);
        // Without Alt the next shape is saved as usual.
        box(harness, [200, 200], [260, 260]);
        await flush();
        expect(service.writes()[1]).toEqual(['POST', '/wsi/annotations']);
    });

    it('marks an AI region the user cuts "AI, edited", keeping its source', async () => {
        const harness = await setup([
            serviceRow('ai', squareSvg(0, 0), {
                label: 'Solid',
                provenance: AGENT,
            }),
        ]);
        const { controller, service } = harness;
        controller.select(['ai']);
        controller.runShapeOp('cut');
        controller.setTool('rectangle');
        box(harness, [40, 40], [60, 60]);
        await flush();
        expect(stored(service, 'ai').body.provenance).toEqual({
            ...AGENT,
            edited: true,
        });
        render(<WsiAnnotationPanel controller={controller} />);
        expect(screen.getByTestId('annotation-ai-badge-ai').textContent).toBe(
            'AI, edited · unreviewed'
        );
        // Undo puts the stored provenance back; the source never changes.
        await act(async () => {
            await controller.undo();
        });
        expect(stored(service, 'ai').body.provenance).toEqual(AGENT);
    });

    it("cuts another user's region into a new annotation of the user's", async () => {
        const harness = await setup([
            serviceRow('theirs', squareSvg(0, 0), {
                label: 'Theirs',
                creator: 'other',
            }),
        ]);
        const { controller, service } = harness;
        controller.select(['theirs']);
        controller.runShapeOp('cut');
        controller.setTool('rectangle');
        box(harness, [40, 40], [60, 60]);
        await flush();
        expect(service.writes()).toEqual([['POST', '/wsi/annotations/batch']]);
        expect(stored(service, 'theirs').version).toBe(1);
        const made = Array.from(service.rows.values()).find(
            row => row.id !== 'theirs'
        )!;
        expect(made.created_by).toBe('me');
        expect(made.body.label).toBe('Theirs');
        expect(made.body.provenance).toEqual({
            source: 'manual',
            operation: 'cut',
            derived_from: ['theirs'],
        });
        expect(made.target.selector.value).toBe(CUT);
        expect(controller.bulkMessage).toBe(
            'Cut the shape out of "Theirs". "Theirs" is not yours: the cut was saved as a new annotation of yours, and the original stays.'
        );
    });

    it('says when a cut misses or would remove the whole region', async () => {
        const harness = await setup([serviceRow('mine', squareSvg(0, 0))]);
        const { controller, service } = harness;
        controller.select(['mine']);
        controller.runShapeOp('cut');
        controller.setTool('rectangle');
        box(harness, [300, 300], [360, 360]);
        await flush();
        expect(controller.bulkMessage).toBe(
            'The shape does not overlap a selected region; nothing was cut.'
        );
        box(harness, [-10, -10], [120, 120]);
        await flush();
        expect(controller.bulkMessage).toBe(
            'The shape covers all of "Label mine"; nothing was cut.'
        );
        expect(service.writes()).toEqual([]);
    });

    it("merges the user's regions into a new one, deleting the originals; undo brings them back", async () => {
        const { controller, service } = await setup([
            serviceRow('a', squareSvg(0, 0), { label: 'A', layer: 'L1' }),
            serviceRow('b', squareSvg(50, 0), { label: 'B' }),
        ]);
        controller.select(['a', 'b']);
        await act(async () => {
            await controller.mergeSelected();
        });
        expect(service.rows.has('a')).toBe(false);
        expect(service.rows.has('b')).toBe(false);
        const merged = Array.from(service.rows.values());
        expect(merged).toHaveLength(1);
        expect(merged[0].body).toMatchObject({
            label: 'A',
            layer_name: 'L1',
            provenance: {
                source: 'manual',
                operation: 'merge',
                derived_from: ['a', 'b'],
            },
        });
        expect(merged[0].visible_to).toEqual([]);
        expect(area(controller, merged[0].id)).toBe(15000);
        expect(Array.from(controller.selectedIds)).toEqual([merged[0].id]);
        expect(controller.bulkMessage).toBe('Merged 2 regions into "A".');
        expect(controller.undoLabel).toBe('Undo merge');

        await act(async () => {
            await controller.undo();
        });
        const restored = Array.from(service.rows.values());
        expect(restored.map(row => row.body.label).sort()).toEqual(['A', 'B']);
        expect(restored.map(row => row.target.selector.value).sort()).toEqual(
            [squareSvg(0, 0), squareSvg(50, 0)].sort()
        );
        expect(controller.redoLabel).toBe('Redo merge');
        await act(async () => {
            await controller.redo();
        });
        expect(Array.from(service.rows.values())).toHaveLength(1);
        expect(controller.undoLabel).toBe('Undo merge');
    });

    it('asks before a merge deletes originals with comments', async () => {
        const { controller, service } = await setup([
            serviceRow('a', squareSvg(0, 0), { label: 'A' }),
            serviceRow('b', squareSvg(50, 0), { label: 'B' }),
        ]);
        service.comments.set('a', [
            {
                id: 'c1',
                annotation_id: 'a',
                author: 'other',
                body: 'Check this',
                created_at: '2026-11-18T10:00:00Z',
            },
        ]);
        await act(async () => {
            await controller.retryLoad();
        });
        controller.select(['a', 'b']);
        render(<WsiAnnotationBulkBar controller={controller} />);
        const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
        fireEvent.click(screen.getByTestId('annotation-bulk-actions'));
        fireEvent.click(screen.getByTestId('annotation-bulk-shape'));
        await act(async () => {
            fireEvent.click(screen.getByTestId('annotation-shape-op-merge'));
        });
        await flush();
        expect(confirm).toHaveBeenCalledWith(
            'Merge the selected regions? Your originals are deleted: "A" has 1 comment, all by other users. Merging deletes its comment thread, and Undo cannot bring the comments back.'
        );
        expect(service.writes()).toEqual([]);
    });

    it('takes a merge back when the originals cannot be deleted', async () => {
        const { controller, service } = await setup(
            [
                serviceRow('a', squareSvg(0, 0), { label: 'A' }),
                serviceRow('b', squareSvg(50, 0), { label: 'B' }),
            ],
            {
                override: request =>
                    request.path.endsWith('/batch-delete') &&
                    request.body.items.some((item: any) => item.id === 'b')
                        ? {
                              status: 403,
                              body: {
                                  detail: {
                                      msg: 'Only the creator can delete',
                                      index: 1,
                                      id: 'b',
                                  },
                              },
                          }
                        : undefined,
            }
        );
        controller.select(['a', 'b']);
        let merged = true;
        await act(async () => {
            merged = await controller.mergeSelected();
        });
        expect(merged).toBe(false);
        // The union was saved, then deleted again: only the originals stay.
        expect(Array.from(service.rows.keys()).sort()).toEqual(['a', 'b']);
        expect(
            controller.annotations.map((item: any) => item.id).sort()
        ).toEqual(['a', 'b']);
        expect(controller.bulkMessage).toBe(
            'The merged region was not saved (Delete refused: Only the creator can delete). What was saved of it was taken back, so nothing changed.'
        );
        expect(controller.canUndo).toBe(false);
    });

    it('takes a split back when the region changed elsewhere meanwhile', async () => {
        const harness = await setup(
            [serviceRow('mine', squareSvg(0, 0), { label: 'Tumor' })],
            {
                override: request =>
                    request.method === 'PUT' &&
                    request.path.endsWith('/annotations/mine')
                        ? {
                              status: 409,
                              body: { detail: 'Version conflict' },
                          }
                        : undefined,
            }
        );
        const { controller, service } = harness;
        controller.select(['mine']);
        controller.runShapeOp('split');
        box(harness, [30, -10], [30, 110]);
        await flush(6);
        expect(service.writes().map(([method]) => method)).toEqual([
            'POST',
            'PUT',
            'POST',
        ]);
        expect(service.writes()[2][1]).toBe('/wsi/annotations/batch-delete');
        // The new piece is gone again; the region is as stored.
        expect(Array.from(service.rows.keys())).toEqual(['mine']);
        expect(area(controller, 'mine')).toBe(10000);
        expect(controller.bulkMessage).toMatch(
            /^The split was not saved \(Annotation changed elsewhere; reloaded latest data\)\. What was saved of it was taken back/
        );
        expect(controller.canUndo).toBe(false);
    });

    it("says a shape the service refuses can't be saved, and shows it as stored", async () => {
        const harness = await setup(
            [serviceRow('mine', squareSvg(0, 0, 300), { label: 'Tumor' })],
            {
                override: request =>
                    request.method === 'PUT'
                        ? {
                              status: 422,
                              body: {
                                  detail: [
                                      {
                                          loc: ['body', 'target', 'selector'],
                                          msg: 'unsupported SVG',
                                      },
                                  ],
                              },
                          }
                        : undefined,
            }
        );
        const { controller } = harness;
        controller.select(['mine']);
        controller.runShapeOp('cut');
        controller.setTool('rectangle');
        box(harness, [40, 40], [60, 60]);
        await flush(6);
        expect(controller.error).toBe(WSI_SHAPE_REFUSED);
        expect(area(controller, 'mine')).toBe(90000);
    });

    it('applies two cuts drawn back to back, each on the saved shape', async () => {
        const harness = await setup([
            serviceRow('mine', squareSvg(0, 0, 300), { label: 'Tumor' }),
        ]);
        const { controller, service } = harness;
        controller.select(['mine']);
        controller.runShapeOp('cut');
        controller.setTool('rectangle');
        // The first cut's PUT is still in flight when the second is drawn.
        service.hold = true;
        box(harness, [40, 40], [60, 60]);
        await flush();
        box(harness, [200, 200], [220, 220]);
        await flush();
        service.release();
        await flush(6);
        expect(service.writes()).toEqual([
            ['PUT', '/wsi/annotations/mine'],
            ['PUT', '/wsi/annotations/mine'],
        ]);
        expect(controller.error).toBeNull();
        expect(area(controller, 'mine')).toBe(90000 - 400 - 400);
        expect(stored(service, 'mine').version).toBe(3);
    });

    it("keeps another user's shared region in a merge, and says so", async () => {
        const { controller, service } = await setup([
            serviceRow('mine', squareSvg(0, 0), { label: 'Mine' }),
            serviceRow('theirs', squareSvg(50, 0), {
                label: 'Theirs',
                creator: 'other',
                visibleTo: [],
            }),
        ]);
        controller.select(['theirs', 'mine']);
        await act(async () => {
            await controller.mergeSelected();
        });
        expect(service.rows.has('mine')).toBe(false);
        expect(service.rows.has('theirs')).toBe(true);
        const merged = Array.from(service.rows.values()).find(
            row => row.created_by === 'me'
        )!;
        // Labelled as the first selected; the default sharing, as not theirs.
        expect(merged.body.label).toBe('Theirs');
        expect(merged.body.provenance.derived_from).toEqual(['theirs', 'mine']);
        expect(controller.bulkMessage).toBe(
            'Merged 2 regions into "Theirs". Kept "Theirs": it is not yours, so it stays as it is.'
        );
    });

    it("keeps the user's own AI regions in a merge and marks the result AI, edited", async () => {
        const { controller, service } = await setup([
            serviceRow('ai', squareSvg(0, 0), {
                label: 'AI region',
                provenance: AGENT,
            }),
            serviceRow('mine', squareSvg(50, 0), { label: 'Mine' }),
        ]);
        controller.select(['ai', 'mine']);
        await act(async () => {
            await controller.mergeSelected();
        });
        expect(service.rows.has('ai')).toBe(true);
        expect(service.rows.has('mine')).toBe(false);
        const merged = Array.from(service.rows.values()).find(
            row => row.id !== 'ai'
        )!;
        expect(merged.body.provenance).toEqual({
            source: 'manual',
            operation: 'merge',
            derived_from: ['ai', 'mine'],
            derived_from_ai: true,
        });
        expect(controller.bulkMessage).toContain(
            'Kept your AI annotation "AI region": only the service\'s trusted writers can create AI annotations'
        );
        render(<WsiAnnotationPanel controller={controller} />);
        expect(
            screen.getByTestId(`annotation-ai-badge-${merged.id}`).textContent
        ).toBe('AI, edited');
        // Not a machine annotation: not in the review queue.
        expect(controller.reviewableAi.map(item => item.id)).toEqual(['ai']);
    });

    it('splits a region along a line: the largest piece in place, the rest new; undo', async () => {
        const harness = await setup([
            serviceRow('mine', squareSvg(0, 0), { label: 'Tumor' }),
        ]);
        const { controller, service } = harness;
        controller.select(['mine']);
        controller.runShapeOp('split');
        expect(controller.activeTool).toBe('line');
        expect(controller.shapeEditHint).toBe(
            'Split: draw a line across "Tumor", from edge to edge. Esc stops.'
        );
        box(harness, [30, -10], [30, 110]);
        await flush();
        expect(service.writes()).toEqual([
            ['POST', '/wsi/annotations/batch'],
            ['PUT', '/wsi/annotations/mine'],
        ]);
        const rows = Array.from(service.rows.values());
        expect(rows).toHaveLength(2);
        expect(area(controller, 'mine')).toBeCloseTo(6990, 0);
        const piece = rows.find(row => row.id !== 'mine')!;
        expect(area(controller, piece.id)).toBeCloseTo(2990, 0);
        expect(piece.body.label).toBe('Tumor');
        expect(piece.body.provenance).toMatchObject({
            operation: 'split',
            derived_from: ['mine'],
        });
        expect(controller.shapeEditMode).toBeNull();
        expect(controller.activeTool).toBeNull();
        expect(Array.from(controller.selectedIds).sort()).toEqual(
            ['mine', piece.id].sort()
        );
        expect(controller.bulkMessage).toBe('Split "Tumor" into 2 pieces.');
        await act(async () => {
            await controller.undo();
        });
        expect(Array.from(service.rows.keys())).toEqual(['mine']);
        expect(area(controller, 'mine')).toBe(10000);
    });

    it('does not split along a line that stops inside', async () => {
        const harness = await setup([serviceRow('mine', squareSvg(0, 0))]);
        const { controller, service } = harness;
        controller.select(['mine']);
        controller.runShapeOp('split');
        box(harness, [30, -10], [30, 50]);
        await flush();
        expect(service.writes()).toEqual([]);
        expect(controller.shapeEditMode).toBe('split');
        expect(controller.bulkMessage).toBe(
            'The line does not cut "Label mine" in two: draw it across the region, from edge to edge.'
        );
    });

    it('subtracts, intersects and separates parts', async () => {
        const { controller, service } = await setup([
            serviceRow('a', squareSvg(0, 0), { label: 'A' }),
            serviceRow('b', squareSvg(50, 0), { label: 'B' }),
            serviceRow('parts', regionPartsSvg(), {
                label: 'Parts',
                creator: 'other',
            }),
        ]);
        controller.select(['a', 'b']);
        await act(async () => {
            await controller.intersectSelected();
        });
        const overlap = Array.from(service.rows.values()).find(
            row => row.body.provenance?.operation === 'intersect'
        )!;
        expect(area(controller, overlap.id)).toBe(5000);
        expect(service.rows.has('a') && service.rows.has('b')).toBe(true);

        controller.select(['a', 'b'], false);
        await act(async () => {
            await controller.subtractSelected();
        });
        expect(area(controller, 'a')).toBe(5000);
        expect(controller.bulkMessage).toBe('Cut 1 region out of "A".');
        expect(area(controller, 'b')).toBe(10000);

        controller.select(['parts'], false);
        expect(controller.shapeOps.separate.enabled).toBe(true);
        await act(async () => {
            await controller.separateSelected();
        });
        const separated = Array.from(service.rows.values()).filter(
            row => row.body.provenance?.operation === 'separate'
        );
        expect(separated).toHaveLength(2);
        expect(service.rows.has('parts')).toBe(true);
        expect(controller.bulkMessage).toBe(
            'Separated 2 parts of 1 region. Kept "Parts": it is not yours, so it stays as it is.'
        );
    });

    it('offers the operations the selection allows in the selection bar', async () => {
        const { controller } = await setup([
            serviceRow('a', squareSvg(0, 0), { label: 'A' }),
            serviceRow('b', squareSvg(50, 0), { label: 'B' }),
            pointRow('p', 500, 500),
        ]);
        controller.select(['a', 'p']);
        render(<WsiAnnotationBulkBar controller={controller} />);
        // A submenu of Actions: it acts on a pick, not while arrowing.
        fireEvent.click(screen.getByTestId('annotation-bulk-actions'));
        const menu = screen.getByTestId('annotation-bulk-shape');
        expect(menu.getAttribute('aria-haspopup')).toBe('menu');
        fireEvent.click(menu);
        const option = (operation: string) =>
            screen.getByTestId(
                `annotation-shape-op-${operation}`
            ) as HTMLButtonElement;
        expect(option('merge').getAttribute('role')).toBe('menuitem');
        expect(option('merge').disabled).toBe(true);
        expect(option('cut').disabled).toBe(false);
        expect(option('split').textContent).toBe('Split "A" by a line…');
        act(() => controller.select(['b']));
        expect(option('merge').disabled).toBe(false);
        expect(option('merge').textContent).toBe('Merge 2 regions');
        expect(option('split').disabled).toBe(true);
        // Arrowing through the items does nothing; a pick runs it.
        fireEvent.keyDown(option('cut'), { key: 'ArrowDown' });
        expect(controller.shapeEditMode).toBeNull();
        await act(async () => {
            fireEvent.click(option('cut'));
        });
        expect(controller.shapeEditMode).toBe('cut');
        expect(screen.queryByTestId('annotation-bulk-shape-menu')).toBeNull();
        expect(screen.queryByTestId('annotation-bulk-actions-menu')).toBeNull();
        expect(
            screen.getByTestId('annotation-shape-edit-hint').textContent
        ).toContain('Cut a hole: draw a shape inside the 2 selected regions');
        fireEvent.click(screen.getByTestId('annotation-shape-edit-done'));
        expect(controller.shapeEditMode).toBeNull();
    });

    it('shows points inside only when there are any, or while counting', async () => {
        const { controller } = await setup(
            [
                serviceRow('empty', '0,0,100,100', { label: 'Empty' }),
                serviceRow(
                    'field',
                    '<svg><ellipse cx="500" cy="500" rx="10" ry="10" /></svg>',
                    { label: 'HPF 1' }
                ),
                pointRow('far', 900, 900),
            ],
            {}
        );
        const empty = controller.annotations.find(item => item.id === 'empty')!;
        const field = controller.annotations.find(item => item.id === 'field')!;
        expect(controller.pointsInside(empty)!.total).toBe(0);
        expect(controller.shownPointsInside(empty)).toBeNull();
        // A field always shows its count.
        expect(controller.shownPointsInside(field)!.total).toBe(0);
        render(<WsiAnnotationPanel controller={controller} />);
        expect(
            screen.queryByTestId('annotation-points-inside-empty')
        ).toBeNull();
        act(() => controller.setTool('point'));
        expect(
            screen.getByTestId('annotation-points-inside-empty').textContent
        ).toBe('Points inside: 0');
    });
});

/** Two 10×10 squares apart, as one multi-part region. */
function regionPartsSvg() {
    const shape = regionShape([
        [
            [
                { x: 300, y: 0 },
                { x: 310, y: 0 },
                { x: 310, y: 10 },
                { x: 300, y: 10 },
            ],
        ],
        [
            [
                { x: 400, y: 0 },
                { x: 410, y: 0 },
                { x: 410, y: 10 },
                { x: 400, y: 10 },
            ],
        ],
    ]);
    if (shape?.kind !== 'multipolygon') throw new Error('not two parts');
    return `<svg><g>${shape.polygons
        .map(
            rings =>
                `<path fill-rule="evenodd" d="${rings
                    .map(
                        ring =>
                            `M ${ring
                                .map(point => `${point.x},${point.y}`)
                                .join(' L ')} Z`
                    )
                    .join(' ')}" />`
        )
        .join('')}</g></svg>`;
}
