/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { annotationHistory } from './wsiAnnotationBody';
import { WsiAnnotationPanel } from './wsiAnnotationControls';
import { WsiAnnotationToolbar } from './wsiAnnotationToolbar';
import {
    attachTestController,
    serviceRow,
    TestAnnotationService,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

describe('annotationHistory', () => {
    it('lists creation, the review and the last change from the stored fields', () => {
        expect(
            annotationHistory({
                creator: 'alice',
                created: '2026-11-01T10:00:00Z',
                updated: '2026-11-01T10:00:00Z',
                version: 1,
            })
        ).toEqual([
            { what: 'Created', who: 'alice', when: '2026-11-01T10:00:00Z' },
        ]);
        // The last save was the review: credited to the reviewer.
        expect(
            annotationHistory({
                creator: 'loader',
                created: '2026-11-01T10:00:00Z',
                updated: '2026-11-02T09:00:01Z',
                version: 2,
                provenance: {
                    source: 'model',
                    model: 'luad-patterns',
                    review_status: 'accepted',
                    reviewed_by: 'bob',
                    reviewed_at: '2026-11-02T09:00:00Z',
                },
            })
        ).toEqual([
            {
                what: 'Created (by a model (luad-patterns))',
                who: 'loader',
                when: '2026-11-01T10:00:00Z',
            },
            { what: 'Accepted', who: 'bob', when: '2026-11-02T09:00:00Z' },
            {
                what: 'Last changed (version 2)',
                who: 'bob',
                when: '2026-11-02T09:00:01Z',
            },
        ]);
        // Edited after the review: only the creator may edit.
        expect(
            annotationHistory({
                creator: 'loader',
                updated: '2026-11-03T09:00:00Z',
                version: 3,
                provenance: {
                    source: 'model',
                    review_status: 'accepted',
                    reviewed_by: 'bob',
                    reviewed_at: '2026-11-02T09:00:00Z',
                },
            })[2]
        ).toEqual({
            what: 'Last changed (version 3)',
            who: 'loader',
            when: '2026-11-03T09:00:00Z',
        });
    });
});

describe('Showing mine, others and AI, and the history', () => {
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

    const rows = () => [
        serviceRow('mine', '0,0,10,10'),
        serviceRow('theirs', '20,0,10,10', { creator: 'other' }),
        serviceRow('ai', '40,0,10,10', {
            creator: 'loader',
            provenance: { source: 'precomputed' },
        }),
    ];

    async function setup(user?: string | null) {
        const service = new TestAnnotationService(rows()).install();
        const harness = await attachTestController(service);
        cleanup.push(harness.cleanup);
        if (user !== undefined) harness.controller.setCurrentUser(user);
        return { service, ...harness };
    }

    const drawn = (annotator: any) => {
        const calls = annotator.setAnnotations.mock.calls;
        return calls[calls.length - 1][0].map((item: any) => item.id);
    };

    it('filters what is drawn on the slide and listed by origin from the Display popover', async () => {
        const { controller, annotator } = await setup();
        render(
            <>
                <WsiAnnotationToolbar controller={controller} />
                <WsiAnnotationPanel controller={controller} />
            </>
        );
        expect(drawn(annotator)).toEqual(['mine', 'theirs', 'ai']);
        fireEvent.click(screen.getByTestId('annotation-display-button'));
        const others = screen.getByTestId('annotation-show-others');
        expect(others.closest('label')!.textContent).toBe('Other users’1');
        expect(
            screen.getByTestId('annotation-show-mine').closest('label')!
                .textContent
        ).toBe('Mine1');
        fireEvent.click(others);
        expect(drawn(annotator)).toEqual(['mine', 'ai']);
        expect(controller.listedAnnotations.map(item => item.id)).toEqual([
            'mine',
            'ai',
        ]);
        expect(screen.queryByTestId('annotation-row-theirs')).toBeNull();
        fireEvent.click(screen.getByTestId('annotation-show-ai'));
        expect(drawn(annotator)).toEqual(['mine']);

        // Closed, the eye has a dot for the changed setting.
        fireEvent.keyDown(screen.getByTestId('annotation-display-popover'), {
            key: 'Escape',
        });
        expect(
            screen
                .getByTestId('annotation-display-button')
                .querySelector('span')
        ).not.toBeNull();

        // A link to a hidden annotation shows its origin again.
        act(() => controller.requestAnnotation('theirs'));
        (controller as any).osdViewer = {
            ...(controller as any).osdViewer,
            viewport: {},
        };
        act(() => (controller as any).openRequestedAnnotation());
        expect(controller.shownOrigins.others).toBe(true);
        expect(drawn(annotator)).toEqual(['mine', 'theirs']);
    });

    it('offers Manual and AI when the user is unknown', async () => {
        const { controller } = await setup(null);
        render(<WsiAnnotationToolbar controller={controller} />);
        fireEvent.click(screen.getByTestId('annotation-display-button'));
        expect(screen.queryByTestId('annotation-show-others')).toBeNull();
        expect(
            screen.getByTestId('annotation-show-mine').closest('label')!
                .textContent
        ).toBe('Manual2');
    });

    it('shows who created and last changed an annotation, with its version', async () => {
        const { controller } = await setup();
        await controller.acceptAnnotation('ai');
        render(<WsiAnnotationPanel controller={controller} />);
        const toggle = screen.getByTestId('annotation-history-toggle-ai');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        const history = screen.getByTestId('annotation-history-ai');
        expect(toggle.getAttribute('aria-controls')).toBe(history.id);
        const items = Array.from(history.querySelectorAll('li')).map(
            item => item.textContent
        );
        expect(items[0]).toMatch(/^Created \(by a model\) by loader, /);
        expect(items[1]).toMatch(/^Accepted by me, /);
        expect(items[2]).toMatch(/^Last changed \(version 2\) by me, /);
        expect(history.textContent).toContain(
            'a full change log would need one in the service'
        );

        const click = (controller as any).annotorious.on.mock.calls.find(
            ([name]: [string]) => name === 'clickAnnotation'
        )[1];
        act(() =>
            click(
                controller.annotations.find(item => item.id === 'ai'),
                { clientX: 1, clientY: 1 }
            )
        );
        expect(controller.annotationTooltip?.history).toBe(
            'By loader · version 2'
        );
    });
});
