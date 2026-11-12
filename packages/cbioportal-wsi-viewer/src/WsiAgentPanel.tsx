import * as React from 'react';
import {
    WsiAgentContext,
    WsiAgentProposal,
    WsiAgentSseEvent,
} from './wsiAgent';
import {
    WsiServiceAccessIssue,
    wsiServiceAccessIssue,
    wsiServiceFetch,
} from './wsiServiceRequest';

interface AgentMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
}

interface ApplyResult {
    success: boolean;
    detail: string;
}

interface CommitResult {
    action: WsiAgentProposal;
    annotations: Array<Record<string, unknown>>;
    idempotent?: boolean;
}

interface Props {
    apiUrl: string;
    /** The study every request is authorized for. */
    studyId: string;
    getContext: () => WsiAgentContext | null | Promise<WsiAgentContext | null>;
    applyProposal: (proposal: WsiAgentProposal) => Promise<ApplyResult>;
    onCommittedAnnotations?: (
        annotations: Array<Record<string, unknown>>
    ) => void;
    onProposal?: (proposal: WsiAgentProposal) => void;
}

const assistantMessage: AgentMessage = {
    id: 'wsi-agent-welcome',
    role: 'assistant',
    content:
        'I can summarize the current viewport, help navigate, and propose coarse annotations for review.',
};

function proposalSummary(proposal: WsiAgentProposal): string {
    const payload = proposal.payload;
    if (proposal.action_type === 'annotation_batch') {
        const annotations = Array.isArray(payload.annotations)
            ? payload.annotations.length
            : 0;
        return `Create ${annotations} ${payload.layer_name ||
            'AI review'} annotations`;
    }
    if (proposal.action_type === 'create_annotation') {
        return `Create ${payload.label ||
            'annotation'} on ${payload.layer_name ||
            'Default'} (${payload.geometry_type || 'region'})`;
    }
    if (proposal.action_type === 'viewer_action') {
        return `Viewer action: ${payload.action || 'update view'}`;
    }
    if (proposal.action_type === 'update_annotation') {
        return `Update annotation ${payload.annotation_id || ''}`;
    }
    return `Delete annotation ${payload.annotation_id || ''}`;
}

const ACCESS_MESSAGES: Record<WsiServiceAccessIssue, string> = {
    signedOut: 'Sign in to use the research assistant.',
    forbidden:
        'You do not have access to the research assistant for this study.',
};

/** A 401 or 403 from the service; the panel stops sending requests. */
class AccessRefusedError extends Error {
    constructor(readonly issue: WsiServiceAccessIssue) {
        super(ACCESS_MESSAGES[issue]);
    }
}

function refuseAccess(response: Response): void {
    const issue = wsiServiceAccessIssue(response.status);
    if (issue) throw new AccessRefusedError(issue);
}

function parseSseBuffer(
    buffer: string
): {
    events: WsiAgentSseEvent[];
    remainder: string;
} {
    const chunks = buffer.split(/\r?\n\r?\n/);
    const remainder = chunks.pop() || '';
    const events = chunks
        .map(chunk => {
            const event = chunk.match(/^event:\s*(.+)$/m)?.[1] || 'message';
            const data = chunk.match(/^data:\s*(.+)$/m)?.[1];
            if (!data) return null;
            try {
                return { event, data: JSON.parse(data) } as WsiAgentSseEvent;
            } catch (_) {
                return null;
            }
        })
        .filter((event): event is WsiAgentSseEvent => event !== null);
    return { events, remainder };
}

export function WsiAgentPanel({
    apiUrl,
    studyId,
    getContext,
    applyProposal,
    onCommittedAnnotations,
    onProposal,
}: Props) {
    const [messages, setMessages] = React.useState<AgentMessage[]>([
        assistantMessage,
    ]);
    const [proposals, setProposals] = React.useState<WsiAgentProposal[]>([]);
    const [input, setInput] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const [busyProposalId, setBusyProposalId] = React.useState<string | null>(
        null
    );
    const [autoApproveAnnotations, setAutoApproveAnnotations] = React.useState(
        false
    );
    const [hasApprovedAnnotation, setHasApprovedAnnotation] = React.useState(
        false
    );
    const autoApplyAttempted = React.useRef(new Set<string>());
    const [error, setError] = React.useState<string | null>(null);
    // Set by a 401 or 403; the panel is then read-only for this study.
    const [
        accessIssue,
        setAccessIssue,
    ] = React.useState<WsiServiceAccessIssue | null>(null);
    React.useEffect(() => setAccessIssue(null), [apiUrl, studyId]);
    const showRequestError = React.useCallback(
        (requestError: unknown, fallback: string) => {
            if (requestError instanceof AccessRefusedError) {
                setAccessIssue(requestError.issue);
                setAutoApproveAnnotations(false);
            }
            setError(
                requestError instanceof Error ? requestError.message : fallback
            );
        },
        []
    );
    const sessionId = React.useRef(
        `browser-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 9)}`
    ).current;
    const messagesRef = React.useRef<HTMLDivElement | null>(null);
    const autoScrollMessages = React.useRef(true);
    const scrollMessagesToBottom = React.useCallback(() => {
        const element = messagesRef.current;
        if (element) element.scrollTop = element.scrollHeight;
    }, []);
    const onMessagesScroll = React.useCallback(() => {
        const element = messagesRef.current;
        if (!element) return;
        const distanceFromBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight;
        autoScrollMessages.current = distanceFromBottom <= 24;
    }, []);

    React.useEffect(() => {
        if (autoScrollMessages.current) scrollMessagesToBottom();
    }, [messages, scrollMessagesToBottom]);

    const upsertProposal = React.useCallback(
        (proposal: WsiAgentProposal) => {
            onProposal?.(proposal);
            setProposals(current => {
                const existing = current.findIndex(
                    item => item.id === proposal.id
                );
                if (existing < 0) return [...current, proposal];
                return current.map(item =>
                    item.id === proposal.id ? proposal : item
                );
            });
        },
        [onProposal]
    );

    const sendMessage = React.useCallback(async () => {
        const message = input.trim();
        if (!message || loading || accessIssue) return;
        const context = await getContext();
        if (!context) {
            setError('Open a viewable slide before using the assistant.');
            return;
        }
        setInput('');
        setError(null);
        autoScrollMessages.current = true;
        setLoading(true);
        const requestId = `request-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 10)}`;
        const userMessage: AgentMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: message,
        };
        const assistantId = `assistant-${Date.now()}`;
        setMessages(current => [
            ...current,
            userMessage,
            { id: assistantId, role: 'assistant', content: '' },
        ]);
        try {
            const response = await wsiServiceFetch(
                apiUrl,
                '/agent/chat',
                studyId,
                {
                    method: 'POST',
                    headers: { Accept: 'text/event-stream' },
                    body: JSON.stringify({
                        session_id: sessionId,
                        request_id: requestId,
                        message,
                        history: messages
                            .filter(
                                item =>
                                    item.id !== assistantMessage.id &&
                                    item.content
                            )
                            .slice(-20)
                            .map(item => ({
                                role: item.role,
                                content: item.content,
                            })),
                        context,
                    }),
                }
            );
            refuseAccess(response);
            if (!response.ok) {
                let detail: string | undefined;
                try {
                    const body = (await response.json()) as {
                        detail?: unknown;
                    };
                    if (typeof body.detail === 'string') detail = body.detail;
                } catch (_) {
                    // Use the status-based message when the server has no JSON detail.
                }
                throw new Error(
                    detail ||
                        (response.status === 404
                            ? 'The research assistant is not enabled on this stack.'
                            : `Assistant request failed (${response.status})`)
                );
            }
            if (!response.body)
                throw new Error('Assistant returned no stream.');
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const consume = (event: WsiAgentSseEvent) => {
                if (event.event === 'message.delta') {
                    const text = event.data?.text;
                    if (typeof text === 'string') {
                        setMessages(current =>
                            current.map(item =>
                                item.id === assistantId
                                    ? { ...item, content: item.content + text }
                                    : item
                            )
                        );
                    }
                } else if (event.event === 'proposal' && event.data?.id) {
                    upsertProposal(event.data as WsiAgentProposal);
                } else if (event.event === 'error') {
                    throw new Error(
                        event.data?.message || 'Assistant request failed.'
                    );
                } else if (
                    event.event === 'complete' &&
                    event.data?.success === false
                ) {
                    throw new Error(
                        event.data?.error?.message ||
                            'The assistant could not complete the requested tool action.'
                    );
                }
            };
            while (true) {
                const chunk = await reader.read();
                buffer += decoder.decode(chunk.value || new Uint8Array(), {
                    stream: !chunk.done,
                });
                const parsed = parseSseBuffer(buffer);
                buffer = parsed.remainder;
                parsed.events.forEach(consume);
                if (chunk.done) break;
            }
            const final = parseSseBuffer(`${buffer}\n\n`);
            final.events.forEach(consume);
        } catch (requestError) {
            showRequestError(requestError, 'Assistant request failed.');
        } finally {
            setLoading(false);
        }
    }, [
        accessIssue,
        apiUrl,
        getContext,
        input,
        loading,
        messages,
        sessionId,
        showRequestError,
        studyId,
        upsertProposal,
    ]);

    const rejectProposal = React.useCallback(
        async (proposal: WsiAgentProposal) => {
            setBusyProposalId(proposal.id);
            setError(null);
            try {
                const response = await wsiServiceFetch(
                    apiUrl,
                    `/agent/actions/${encodeURIComponent(proposal.id)}/reject`,
                    studyId,
                    { method: 'POST' }
                );
                refuseAccess(response);
                if (!response.ok)
                    throw new Error(`Reject failed (${response.status})`);
                const rejected = (await response.json()) as WsiAgentProposal;
                upsertProposal(rejected);
            } catch (requestError) {
                showRequestError(requestError, 'Reject failed.');
            } finally {
                setBusyProposalId(null);
            }
        },
        [apiUrl, showRequestError, studyId, upsertProposal]
    );

    const apply = React.useCallback(
        async (proposal: WsiAgentProposal) => {
            setBusyProposalId(proposal.id);
            setError(null);
            try {
                if (
                    proposal.action_type === 'create_annotation' ||
                    (proposal.action_type === 'annotation_batch' &&
                        onCommittedAnnotations)
                ) {
                    const context = await getContext();
                    const firstDraft =
                        proposal.action_type === 'annotation_batch' &&
                        Array.isArray(proposal.payload.annotations)
                            ? proposal.payload.annotations[0]
                            : proposal.payload;
                    const firstPayload = firstDraft as Record<string, unknown>;
                    const sourceFingerprint =
                        context?.viewport.source_fingerprint ||
                        firstPayload?.source_fingerprint;
                    const viewerGeneration =
                        context?.viewport.viewer_generation ??
                        firstPayload?.viewer_generation;
                    if (
                        !context ||
                        context.slide_id !== proposal.slide_id ||
                        typeof sourceFingerprint !== 'string' ||
                        typeof viewerGeneration !== 'number'
                    ) {
                        throw new Error(
                            'The slide source changed; ask the assistant to regenerate the proposal.'
                        );
                    }
                    const commit = await wsiServiceFetch(
                        apiUrl,
                        `/agent/actions/${encodeURIComponent(
                            proposal.id
                        )}/commit-annotations`,
                        studyId,
                        {
                            method: 'POST',
                            body: JSON.stringify({
                                source_fingerprint: sourceFingerprint,
                                viewer_generation: viewerGeneration,
                                slide_id: context.slide_id,
                            }),
                        }
                    );
                    refuseAccess(commit);
                    if (!commit.ok) {
                        let detail =
                            'Annotation commit failed (' + commit.status + ')';
                        try {
                            const body = (await commit.json()) as {
                                detail?: unknown;
                            };
                            if (typeof body.detail === 'string')
                                detail = body.detail;
                        } catch (_) {
                            // Keep the status-based error.
                        }
                        throw new Error(detail);
                    }
                    const committed = (await commit.json()) as CommitResult;
                    upsertProposal(committed.action);
                    setHasApprovedAnnotation(true);
                    const postCommitContext = await getContext();
                    const stillCurrent =
                        postCommitContext?.slide_id === proposal.slide_id &&
                        postCommitContext.viewport.source_fingerprint ===
                            sourceFingerprint &&
                        postCommitContext.viewport.viewer_generation ===
                            viewerGeneration;
                    if (stillCurrent) {
                        onCommittedAnnotations?.(committed.annotations || []);
                    }
                    return;
                }
                const approval = await wsiServiceFetch(
                    apiUrl,
                    `/agent/actions/${encodeURIComponent(proposal.id)}/apply`,
                    studyId,
                    { method: 'POST' }
                );
                refuseAccess(approval);
                if (!approval.ok)
                    throw new Error(`Apply failed (${approval.status})`);
                const approved = (await approval.json()) as WsiAgentProposal;
                const result = await applyProposal({
                    ...proposal,
                    ...approved,
                });
                const completed = await wsiServiceFetch(
                    apiUrl,
                    `/agent/actions/${encodeURIComponent(
                        proposal.id
                    )}/complete`,
                    studyId,
                    { method: 'POST', body: JSON.stringify(result) }
                );
                refuseAccess(completed);
                if (!completed.ok)
                    throw new Error(`Completion failed (${completed.status})`);
                upsertProposal((await completed.json()) as WsiAgentProposal);
                if (!result.success)
                    setError(result.detail || 'Unable to apply proposal.');
            } catch (requestError) {
                showRequestError(requestError, 'Apply failed.');
            } finally {
                setBusyProposalId(null);
            }
        },
        [
            apiUrl,
            applyProposal,
            getContext,
            onCommittedAnnotations,
            showRequestError,
            studyId,
            upsertProposal,
        ]
    );

    React.useEffect(() => {
        if (
            !autoApproveAnnotations ||
            !hasApprovedAnnotation ||
            busyProposalId !== null ||
            accessIssue
        ) {
            return;
        }
        const nextProposal = proposals.find(
            proposal =>
                proposal.status === 'pending' &&
                (proposal.action_type === 'create_annotation' ||
                    proposal.action_type === 'annotation_batch') &&
                !autoApplyAttempted.current.has(proposal.id)
        );
        if (!nextProposal) return;
        autoApplyAttempted.current.add(nextProposal.id);
        void apply(nextProposal);
    }, [
        accessIssue,
        apply,
        autoApproveAnnotations,
        busyProposalId,
        hasApprovedAnnotation,
        proposals,
    ]);

    const pendingAnnotationProposal = proposals.find(
        proposal =>
            proposal.status === 'pending' &&
            (proposal.action_type === 'create_annotation' ||
                proposal.action_type === 'annotation_batch')
    );

    return (
        <div
            data-testid="wsi-agent-panel"
            style={{ fontSize: 11, color: '#333' }}
        >
            <div
                style={{
                    padding: '8px 10px',
                    background: '#e8f1fb',
                    borderBottom: '1px solid #cbdff5',
                }}
            >
                <strong>Research assistant</strong>
                <div style={{ color: '#666', marginTop: 2 }}>
                    Research support only — not diagnostic.
                </div>
            </div>
            <div
                data-testid="wsi-agent-messages"
                ref={messagesRef}
                onScroll={onMessagesScroll}
                style={{
                    maxHeight: 220,
                    overflowY: 'auto',
                    padding: '6px 8px',
                }}
            >
                {messages.map(item => (
                    <div
                        key={item.id}
                        style={{
                            margin: '4px 0',
                            padding: '5px 7px',
                            borderRadius: 3,
                            background:
                                item.role === 'user' ? '#fff' : '#f0f0f0',
                            whiteSpace: 'pre-wrap',
                        }}
                    >
                        {item.content ||
                            (loading && item.role === 'assistant' ? '…' : '')}
                    </div>
                ))}
            </div>
            {proposals
                .filter(proposal => proposal.status === 'pending')
                .map(proposal => (
                    <div
                        key={proposal.id}
                        data-testid={`wsi-agent-proposal-${proposal.id}`}
                        style={{
                            margin: '4px 8px',
                            padding: 7,
                            border: '1px solid #f0ad4e',
                            background: '#fffaf0',
                            borderRadius: 3,
                        }}
                    >
                        <div style={{ fontWeight: 600 }}>
                            {proposalSummary(proposal)}
                        </div>
                        {proposal.action_type === 'annotation_batch' &&
                            Array.isArray(proposal.payload.annotations) && (
                                <div style={{ color: '#666', marginTop: 3 }}>
                                    Review the highlighted regions before
                                    applying this batch.
                                </div>
                            )}
                        {proposal.payload.rationale && (
                            <div style={{ color: '#666', marginTop: 3 }}>
                                {proposal.payload.rationale}
                            </div>
                        )}
                        {pendingAnnotationProposal?.id === proposal.id && (
                            <label
                                style={{
                                    display: 'block',
                                    marginTop: 6,
                                    color: '#666',
                                    cursor: 'pointer',
                                }}
                                title="Automatically apply later annotation proposals after this approval."
                            >
                                <input
                                    type="checkbox"
                                    data-testid="wsi-agent-auto-approve-annotations"
                                    checked={autoApproveAnnotations}
                                    onChange={event =>
                                        setAutoApproveAnnotations(
                                            event.target.checked
                                        )
                                    }
                                    style={{
                                        marginRight: 5,
                                        verticalAlign: 'middle',
                                    }}
                                />
                                Auto-approve
                            </label>
                        )}
                        <div style={{ marginTop: 6 }}>
                            <button
                                type="button"
                                className="btn btn-primary btn-xs"
                                disabled={
                                    busyProposalId !== null || !!accessIssue
                                }
                                onClick={() => void apply(proposal)}
                                data-testid={`wsi-agent-apply-${proposal.id}`}
                            >
                                Apply
                            </button>{' '}
                            <button
                                type="button"
                                className="btn btn-default btn-xs"
                                disabled={
                                    busyProposalId !== null || !!accessIssue
                                }
                                onClick={() => void rejectProposal(proposal)}
                            >
                                Reject
                            </button>
                        </div>
                    </div>
                ))}
            {error && (
                <div
                    role="alert"
                    style={{ color: '#a94442', padding: '3px 8px' }}
                >
                    {error}
                </div>
            )}
            <form
                onSubmit={event => {
                    event.preventDefault();
                    void sendMessage();
                }}
                style={{ display: 'flex', gap: 4, padding: 8 }}
            >
                <input
                    aria-label="Ask the research assistant"
                    value={input}
                    onChange={event => setInput(event.target.value)}
                    placeholder="Ask about this view…"
                    disabled={loading || !!accessIssue}
                    style={{ flex: 1, minWidth: 0 }}
                />
                <button
                    type="submit"
                    className="btn btn-primary btn-xs"
                    disabled={loading || !!accessIssue || !input.trim()}
                >
                    {loading ? '…' : 'Send'}
                </button>
            </form>
        </div>
    );
}
