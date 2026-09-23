/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { WsiAgentProposalOverlay } from './WsiAgentProposalOverlay';
import { WsiAgentProposal } from './wsiAgent';
import { WsiAnnotationController } from './wsiAnnotationController';

describe('WsiAgentProposalOverlay', () => {
    it('projects pending proposals without capturing viewer pointer events', async () => {
        const controller = ({
            getAgentViewerElementSize: () => ({ width: 1000, height: 800 }),
            getAgentViewerElementPoint: (point: { x: number; y: number }) =>
                point,
        } as unknown) as WsiAnnotationController;
        const proposal: WsiAgentProposal = {
            id: 'proposal-1',
            session_id: 'session-1',
            action_type: 'annotation_batch',
            study_id: 'study-1',
            slide_id: 'slide-1',
            payload: {
                color: '#ff0000',
                context: {
                    viewport: {
                        slide_width: 1000,
                        slide_height: 800,
                        source_fingerprint: 'source-v2',
                        capture_id: 'capture-1',
                        viewer_generation: 1,
                    },
                },
                annotations: [
                    {
                        geometry_version: 2,
                        coordinate_space: 'slide_pixels',
                        source_fingerprint: 'source-v2',
                        capture_id: 'capture-1',
                        viewer_generation: 1,
                        geometry_type: 'rectangle',
                        points: [
                            { x: 100, y: 100 },
                            { x: 300, y: 100 },
                            { x: 300, y: 300 },
                            { x: 100, y: 300 },
                        ],
                        color: '#ff0000',
                    },
                    {
                        geometry_version: 2,
                        coordinate_space: 'slide_pixels',
                        source_fingerprint: 'source-v2',
                        capture_id: 'capture-1',
                        viewer_generation: 1,
                        geometry_type: 'rectangle',
                        points: [
                            { x: 400, y: 100 },
                            { x: 600, y: 300 },
                        ],
                        color: '#00ff00',
                    },
                ],
            },
            status: 'pending',
            created_at: '2026-09-01T00:00:00Z',
        };

        let renderer!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(
                <WsiAgentProposalOverlay
                    controller={controller}
                    proposals={[proposal]}
                />
            );
            await new Promise(resolve => setTimeout(resolve, 5));
        });

        const overlay = renderer.root.findByProps({
            'data-testid': 'wsi-agent-proposal-overlay',
        });
        expect(overlay.props.style.pointerEvents).toBe('none');
        expect(overlay.findAllByType('rect').map(rect => rect.props)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    x: 100,
                    y: 100,
                    width: 200,
                    height: 200,
                    stroke: '#ff0000',
                }),
                expect.objectContaining({
                    x: 400,
                    y: 100,
                    width: 200,
                    height: 200,
                    stroke: '#00ff00',
                }),
            ])
        );
        renderer.unmount();
    });

    it('reprojects annotations on viewer changes instead of polling stale positions', async () => {
        let notifyViewerChange = () => {};
        let offset = 0;
        const controller = ({
            getAgentViewerElementSize: () => ({ width: 1000, height: 800 }),
            getAgentViewerElementPoint: (point: { x: number; y: number }) => ({
                x: point.x + offset,
                y: point.y,
            }),
            subscribeAgentViewerChanges: (listener: () => void) => {
                notifyViewerChange = listener;
                return () => {};
            },
        } as unknown) as WsiAnnotationController;
        const proposal: WsiAgentProposal = {
            id: 'proposal-stable',
            session_id: 'session-1',
            action_type: 'create_annotation',
            study_id: 'study-1',
            slide_id: 'slide-1',
            payload: {
                context: {
                    viewport: {
                        slide_width: 1000,
                        slide_height: 800,
                        source_fingerprint: 'source-v2',
                        capture_id: 'capture-1',
                        viewer_generation: 1,
                    },
                },
                geometry_type: 'rectangle',
                geometry_version: 2,
                coordinate_space: 'slide_pixels',
                source_fingerprint: 'source-v2',
                capture_id: 'capture-1',
                viewer_generation: 1,
                points: [
                    { x: 100, y: 100 },
                    { x: 300, y: 300 },
                ],
            },
            status: 'pending',
            created_at: '2026-09-01T00:00:00Z',
        };

        let renderer!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(
                <WsiAgentProposalOverlay
                    controller={controller}
                    proposals={[proposal]}
                />
            );
            await new Promise(resolve => setTimeout(resolve, 5));
        });

        const rect = () =>
            renderer.root.findByType('rect').props as {
                x: number;
                y: number;
            };
        expect(rect().x).toBe(100);
        offset = 50;
        await act(async () => {
            notifyViewerChange();
            await new Promise(resolve => setTimeout(resolve, 30));
        });
        expect(rect().x).toBe(150);
        renderer.unmount();
    });
});
