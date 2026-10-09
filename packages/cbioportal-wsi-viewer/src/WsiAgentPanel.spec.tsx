/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { fireEvent, render } from '@testing-library/react';
import { WsiAgentPanel } from './WsiAgentPanel';
import { WsiAgentContext, WsiAgentProposal } from './wsiAgent';

const context: WsiAgentContext = {
    study_id: 'study-a',
    patient_id: 'patient-a',
    sample_id: 'sample-a',
    slide_id: 'slide-a',
    filters: {},
    slide_metadata: {},
    patient_context: {},
    existing_annotations: [],
    viewport: {
        slide_width: 1000,
        slide_height: 1000,
        image_width: 100,
        image_height: 100,
        source_fingerprint: 'source-v2',
        capture_id: 'capture-1',
        viewer_generation: 1,
    },
};

const proposal: WsiAgentProposal = {
    id: 'proposal-a',
    session_id: 'browser-session',
    action_type: 'create_annotation',
    study_id: 'study-a',
    slide_id: 'slide-a',
    payload: {
        geometry_type: 'rectangle',
        points: [
            { x: 100, y: 100 },
            { x: 300, y: 300 },
        ],
        label: 'candidate region',
        layer_name: 'AI review',
        rationale: 'Visible pattern for researcher review.',
    },
    status: 'pending',
    created_at: '2026-01-01T00:00:00Z',
};

const followUpProposal: WsiAgentProposal = {
    ...proposal,
    id: 'proposal-b',
    payload: {
        ...proposal.payload,
        label: 'follow-up region',
    },
};

function responseWithJson(value: unknown) {
    return {
        ok: true,
        status: 200,
        json: async () => value,
    };
}

function streamResponse(value: string) {
    let complete = false;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: async () => {
                    if (complete) return { done: true, value: undefined };
                    complete = true;
                    return {
                        done: false,
                        value: new Uint8Array(
                            Array.from(value).map(character =>
                                character.charCodeAt(0)
                            )
                        ),
                    };
                },
            }),
        },
    };
}

describe('WsiAgentPanel', () => {
    it('does not apply a proposed annotation until Apply is pressed', async () => {
        if (!globalThis.TextDecoder) {
            Object.defineProperty(globalThis, 'TextDecoder', {
                value: require('util').TextDecoder,
            });
        }
        const originalFetch = globalThis.fetch;
        const fetchMock = jest.fn();
        globalThis.fetch = (fetchMock as unknown) as typeof fetch;
        fetchMock.mockResolvedValueOnce(
            streamResponse(
                `event: message.delta\ndata: {"text":"Review this region."}\n\nevent: proposal\ndata: ${JSON.stringify(
                    proposal
                )}\n\nevent: complete\ndata: {"proposal_ids":["proposal-a"]}\n\n`
            ) as Response
        );
        fetchMock.mockResolvedValueOnce(
            responseWithJson({
                action: {
                    ...proposal,
                    status: 'completed',
                    outcome: {
                        success: true,
                        detail: 'Annotations committed',
                        annotation_ids: [],
                    },
                },
                annotations: [],
            }) as Response
        );
        const applyProposal = jest.fn().mockResolvedValue({
            success: true,
            detail: 'Annotation created.',
        });
        const renderer = TestRenderer.create(
            <WsiAgentPanel
                apiUrl="/wsi"
                getContext={() => Promise.resolve(context)}
                getToken={async () => 'token'}
                applyProposal={applyProposal}
            />
        );
        expect(
            renderer.root.findAllByProps({
                'data-testid': 'wsi-agent-auto-approve-annotations',
            })
        ).toHaveLength(0);
        const input = renderer.root.findByProps({
            'aria-label': 'Ask the research assistant',
        });
        const form = renderer.root.findByType('form');
        act(() => {
            input.props.onChange({ target: { value: 'mark this region' } });
        });
        await act(async () => {
            form.props.onSubmit({ preventDefault: jest.fn() });
            await new Promise(resolve => setTimeout(resolve, 25));
        });
        expect(applyProposal).not.toHaveBeenCalled();

        const autoApprove = renderer.root.findByProps({
            'data-testid': 'wsi-agent-auto-approve-annotations',
        });
        expect(autoApprove.props.checked).toBe(false);
        expect(
            renderer.root
                .findByProps({
                    'data-testid': 'wsi-agent-proposal-proposal-a',
                })
                .findAllByType('label')[0].children
        ).toContain('Auto-approve');

        const apply = renderer.root.findByProps({
            'data-testid': 'wsi-agent-apply-proposal-a',
        });
        await act(async () => {
            apply.props.onClick();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(applyProposal).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][0]).toContain(
            '/agent/actions/proposal-a/commit-annotations'
        );
        expect(fetchMock.mock.calls[1][1]).toEqual(
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    source_fingerprint: 'source-v2',
                    viewer_generation: 1,
                    slide_id: 'slide-a',
                }),
            })
        );
        globalThis.fetch = originalFetch;
    });

    it('surfaces the backend configuration detail for a failed request', async () => {
        const originalFetch = globalThis.fetch;
        const fetchMock = jest.fn().mockResolvedValue({
            ok: false,
            status: 503,
            json: async () => ({
                detail: 'WSI research assistant is not configured',
            }),
        });
        globalThis.fetch = (fetchMock as unknown) as typeof fetch;
        const renderer = TestRenderer.create(
            <WsiAgentPanel
                apiUrl="/wsi"
                getContext={() => context}
                getToken={async () => 'token'}
                applyProposal={jest.fn()}
            />
        );
        const input = renderer.root.findByProps({
            'aria-label': 'Ask the research assistant',
        });
        const form = renderer.root.findByType('form');
        act(() => {
            input.props.onChange({ target: { value: 'summarize this' } });
        });
        await act(async () => {
            form.props.onSubmit({ preventDefault: jest.fn() });
            await new Promise(resolve => setTimeout(resolve, 25));
        });
        expect(
            renderer.root.findByProps({ role: 'alert' }).children.join('')
        ).toContain('WSI research assistant is not configured');
        globalThis.fetch = originalFetch;
    });

    it('surfaces a structured tool failure from the completion event', async () => {
        if (!globalThis.TextDecoder) {
            Object.defineProperty(globalThis, 'TextDecoder', {
                value: require('util').TextDecoder,
            });
        }
        const originalFetch = globalThis.fetch;
        const fetchMock = jest.fn().mockResolvedValue(
            streamResponse(
                'event: complete\ndata: ' +
                    JSON.stringify({
                        success: false,
                        error: {
                            code: 'retrieval_run_expired',
                            message:
                                'Run a fresh search before proposing annotations.',
                        },
                    }) +
                    '\n\n'
            )
        );
        globalThis.fetch = (fetchMock as unknown) as typeof fetch;
        const renderer = TestRenderer.create(
            <WsiAgentPanel
                apiUrl="/wsi"
                getContext={() => context}
                getToken={async () => 'token'}
                applyProposal={jest.fn()}
            />
        );
        const input = renderer.root.findByProps({
            'aria-label': 'Ask the research assistant',
        });
        const form = renderer.root.findByType('form');
        act(() => {
            input.props.onChange({ target: { value: 'annotate the results' } });
        });
        await act(async () => {
            form.props.onSubmit({ preventDefault: jest.fn() });
            await new Promise(resolve => setTimeout(resolve, 25));
        });
        expect(
            renderer.root.findByProps({ role: 'alert' }).children.join('')
        ).toContain('Run a fresh search before proposing annotations.');
        globalThis.fetch = originalFetch;
    });

    it('does not expose manual embedding search controls', () => {
        const renderer = TestRenderer.create(
            <WsiAgentPanel
                apiUrl="/wsi"
                getContext={() => context}
                getToken={async () => 'token'}
                applyProposal={jest.fn()}
            />
        );
        expect(
            renderer.root.findAllByProps({
                'data-testid': 'wsi-agent-research-tools',
            })
        ).toHaveLength(0);
        expect(
            renderer.root.findAllByProps({ 'aria-label': 'Research model' })
        ).toHaveLength(0);
        expect(
            renderer.root.findAllByProps({ 'aria-label': 'Find regions' })
        ).toHaveLength(0);
    });

    it('keeps the message pane pinned while responses stream', async () => {
        if (!globalThis.TextDecoder) {
            Object.defineProperty(globalThis, 'TextDecoder', {
                value: require('util').TextDecoder,
            });
        }
        const originalFetch = globalThis.fetch;
        const fetchMock = jest
            .fn()
            .mockResolvedValue(
                streamResponse(
                    'event: message.delta\ndata: {"text":"A long streamed response."}\n\nevent: complete\ndata: {}\n\n'
                ) as Response
            );
        globalThis.fetch = (fetchMock as unknown) as typeof fetch;
        const { container } = render(
            <WsiAgentPanel
                apiUrl="/wsi"
                getContext={() => context}
                getToken={async () => 'token'}
                applyProposal={jest.fn()}
            />
        );
        const messagePane = container.querySelector(
            '[data-testid="wsi-agent-messages"]'
        ) as HTMLDivElement;
        Object.defineProperty(messagePane, 'clientHeight', {
            configurable: true,
            value: 220,
        });
        Object.defineProperty(messagePane, 'scrollHeight', {
            configurable: true,
            value: 1000,
        });

        fireEvent.change(
            container.querySelector(
                'input[aria-label="Ask the research assistant"]'
            )!,
            { target: { value: 'summarize this' } }
        );
        await act(async () => {
            fireEvent.submit(container.querySelector('form')!);
            await new Promise(resolve => setTimeout(resolve, 25));
        });

        expect(messagePane.scrollTop).toBe(1000);
        globalThis.fetch = originalFetch;
    });

    it('auto-applies later annotation proposals after one approval', async () => {
        if (!globalThis.TextDecoder) {
            Object.defineProperty(globalThis, 'TextDecoder', {
                value: require('util').TextDecoder,
            });
        }
        const originalFetch = globalThis.fetch;
        const fetchMock = jest.fn();
        globalThis.fetch = (fetchMock as unknown) as typeof fetch;
        fetchMock.mockResolvedValueOnce(
            streamResponse(
                `event: proposal\ndata: ${JSON.stringify(
                    proposal
                )}\nevent: complete\ndata: {"proposal_ids":["proposal-a"]}\n\n`
            ) as Response
        );
        fetchMock.mockResolvedValueOnce(
            responseWithJson({
                action: { ...proposal, status: 'completed' },
                annotations: [],
            }) as Response
        );
        fetchMock.mockResolvedValueOnce(
            streamResponse(
                `event: proposal\ndata: ${JSON.stringify(
                    followUpProposal
                )}\nevent: complete\ndata: {"proposal_ids":["proposal-b"]}\n\n`
            ) as Response
        );
        fetchMock.mockResolvedValueOnce(
            responseWithJson({
                action: { ...followUpProposal, status: 'completed' },
                annotations: [],
            }) as Response
        );
        const applyProposal = jest.fn().mockResolvedValue({
            success: true,
            detail: 'Annotation created.',
        });
        const renderer = TestRenderer.create(
            <WsiAgentPanel
                apiUrl="/wsi"
                getContext={() => context}
                getToken={async () => 'token'}
                applyProposal={applyProposal}
            />
        );
        const input = renderer.root.findByProps({
            'aria-label': 'Ask the research assistant',
        });
        const form = renderer.root.findByType('form');
        act(() => {
            input.props.onChange({ target: { value: 'mark this region' } });
        });
        await act(async () => {
            form.props.onSubmit({ preventDefault: jest.fn() });
            await new Promise(resolve => setTimeout(resolve, 25));
        });

        act(() => {
            renderer.root
                .findByProps({
                    'data-testid': 'wsi-agent-auto-approve-annotations',
                })
                .props.onChange({ target: { checked: true } });
        });
        await act(async () => {
            renderer.root
                .findByProps({
                    'data-testid': 'wsi-agent-apply-proposal-a',
                })
                .props.onClick();
            await new Promise(resolve => setTimeout(resolve, 25));
        });

        act(() => {
            input.props.onChange({ target: { value: 'mark another region' } });
        });
        await act(async () => {
            form.props.onSubmit({ preventDefault: jest.fn() });
            await new Promise(resolve => setTimeout(resolve, 25));
        });
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 25));
        });

        expect(applyProposal).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(4);
        globalThis.fetch = originalFetch;
    });
});
