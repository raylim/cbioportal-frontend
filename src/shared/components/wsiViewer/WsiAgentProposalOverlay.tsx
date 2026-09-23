import * as React from 'react';
import {
    WsiAgentProposal,
    WsiAgentViewport,
    wsiAgentRectangleBounds,
} from './wsiAgent';
import { WsiAnnotationController } from './wsiAnnotationController';

interface OverlayShape {
    id: string;
    geometryType: 'rectangle' | 'polygon';
    points: Array<{ x: number; y: number }>;
    color: string;
}

interface Props {
    controller: WsiAnnotationController;
    proposals: WsiAgentProposal[];
}

function viewportForProposal(
    proposal: WsiAgentProposal
): WsiAgentViewport | null {
    const viewport = proposal.payload.context?.viewport as
        | WsiAgentViewport
        | undefined;
    if (
        !viewport ||
        !Number.isFinite(viewport.slide_width) ||
        !Number.isFinite(viewport.slide_height)
    ) {
        return null;
    }
    return viewport;
}

function getShapes(proposals: WsiAgentProposal[]): OverlayShape[] {
    const shapes: OverlayShape[] = [];
    proposals.forEach(proposal => {
        if (proposal.status !== 'pending' && proposal.status !== 'approved') {
            return;
        }
        const drafts =
            proposal.action_type === 'annotation_batch'
                ? proposal.payload.annotations
                : [proposal.payload];
        if (!Array.isArray(drafts)) return;
        const viewport = viewportForProposal(proposal);
        if (!viewport) return;
        drafts.forEach((value: unknown, index: number) => {
            if (!value || typeof value !== 'object') return;
            const draft = value as Record<string, unknown>;
            const geometryType = draft.geometry_type;
            const points = draft.points;
            if (
                draft.geometry_version !== 2 ||
                draft.coordinate_space !== 'slide_pixels' ||
                (geometryType !== 'rectangle' && geometryType !== 'polygon') ||
                !Array.isArray(points) ||
                points.length < (geometryType === 'polygon' ? 3 : 2)
            ) {
                return;
            }
            const imagePoints = points
                .filter(
                    (point: unknown): point is { x: number; y: number } =>
                        !!point &&
                        typeof point === 'object' &&
                        typeof (point as { x?: unknown }).x === 'number' &&
                        typeof (point as { y?: unknown }).y === 'number'
                )
                .map(point => point);
            if (imagePoints.length < (geometryType === 'polygon' ? 3 : 2)) {
                return;
            }
            shapes.push({
                id: `${proposal.id}-${index}`,
                geometryType,
                points: imagePoints,
                color:
                    typeof draft.color === 'string'
                        ? draft.color
                        : typeof proposal.payload.color === 'string'
                        ? proposal.payload.color
                        : '#f5a623',
            });
        });
    });
    return shapes;
}

export function WsiAgentProposalOverlay({ controller, proposals }: Props) {
    const [renderState, setRenderState] = React.useState<{
        width: number;
        height: number;
        shapes: OverlayShape[];
    }>({ width: 0, height: 0, shapes: [] });

    React.useEffect(() => {
        let frame: number | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let active = true;
        const update = () => {
            if (!active) return;
            const size = controller.getAgentViewerElementSize();
            const proposalShapes = getShapes(proposals)
                .map(shape => ({
                    ...shape,
                    points: shape.points
                        .map(point =>
                            controller.getAgentViewerElementPoint(point)
                        )
                        .filter(
                            (point): point is { x: number; y: number } =>
                                point !== null
                        ),
                }))
                .filter(
                    shape =>
                        shape.points.length >=
                        (shape.geometryType === 'polygon' ? 3 : 2)
                );
            const projected = proposalShapes.filter(
                shape =>
                    shape.points.length >=
                    (shape.geometryType === 'polygon' ? 3 : 2)
            );
            setRenderState({
                width: size.width,
                height: size.height,
                shapes: projected,
            });
        };

        const scheduleUpdate = () => {
            if (!active || frame !== null || timer !== null) return;
            if (typeof requestAnimationFrame === 'function') {
                frame = requestAnimationFrame(() => {
                    frame = null;
                    update();
                });
            } else {
                timer = setTimeout(() => {
                    timer = null;
                    update();
                }, 0);
            }
        };

        const unsubscribe =
            controller.subscribeAgentViewerChanges?.(scheduleUpdate) ||
            (() => {});
        scheduleUpdate();
        update();
        return () => {
            active = false;
            unsubscribe();
            if (frame !== null && typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(frame);
            }
            if (timer !== null) clearTimeout(timer);
        };
    }, [controller, proposals]);

    if (
        !renderState.width ||
        !renderState.height ||
        !renderState.shapes.length
    ) {
        return null;
    }

    return (
        <svg
            data-testid="wsi-agent-proposal-overlay"
            aria-hidden="true"
            viewBox={`0 0 ${renderState.width} ${renderState.height}`}
            style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                zIndex: 40,
                pointerEvents: 'none',
            }}
        >
            {renderState.shapes.map(shape => {
                if (shape.geometryType === 'rectangle') {
                    const bounds = wsiAgentRectangleBounds(shape.points);
                    if (!bounds) return null;
                    return (
                        <rect
                            key={shape.id}
                            x={bounds.x}
                            y={bounds.y}
                            width={bounds.width}
                            height={bounds.height}
                            fill={shape.color}
                            fillOpacity={0.12}
                            stroke={shape.color}
                            strokeWidth={2}
                        />
                    );
                }
                return (
                    <polygon
                        key={shape.id}
                        points={shape.points
                            .map(point => `${point.x},${point.y}`)
                            .join(' ')}
                        fill={shape.color}
                        fillOpacity={0.12}
                        stroke={shape.color}
                        strokeWidth={2}
                    />
                );
            })}
        </svg>
    );
}
