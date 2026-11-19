/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { WsiAnnotationPanel } from './wsiAnnotationControls';
import {
    attachTestController,
    flush,
    serviceRow,
    TEST_STUDY,
    TestAnnotationService,
    TestServiceOptions,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

describe('Comment threads', () => {
    beforeAll(() => loadAnnotorious());
    let cleanup: Array<() => void> = [];
    beforeEach(() => {
        jest.restoreAllMocks();
        window.localStorage.clear();
        jest.spyOn(window, 'confirm').mockReturnValue(true);
    });
    afterEach(() => {
        cleanup.forEach(run => run());
        cleanup = [];
    });

    const comment = (id: string, author: string, body: string) => ({
        id,
        annotation_id: 'a1',
        study_id: TEST_STUDY,
        author,
        body,
        created_at: '2026-11-18T10:00:00Z',
        updated_at: '2026-11-18T10:00:00Z',
    });

    async function setup(options: TestServiceOptions = {}) {
        const service = new TestAnnotationService(
            [serviceRow('a1', '0,0,10,10', { label: 'Tumor' })],
            options
        );
        service.comments.set('a1', [
            comment('c1', 'other', 'Is this the margin?'),
            comment('c2', 'me', 'Yes, deep margin.'),
        ]);
        service.install();
        const harness = await attachTestController(service);
        cleanup.push(harness.cleanup);
        render(<WsiAnnotationPanel controller={harness.controller} />);
        return { service, ...harness };
    }

    const open = async () => {
        fireEvent.click(screen.getByTestId('annotation-comments-toggle-a1'));
        await flush();
    };

    it('reads the thread, adds, edits and deletes own comments, with the count', async () => {
        const { controller, service } = await setup();
        expect(controller.commentsAvailable).toBe(true);
        expect(
            screen.getByTestId('annotation-comment-count-a1').textContent
        ).toBe('2');
        const toggle = screen.getByTestId('annotation-comments-toggle-a1');
        expect(toggle.getAttribute('aria-label')).toBe('Comments on Tumor: 2');
        await open();
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(
            screen.getByTestId('annotation-comment-body-c1').textContent
        ).toBe('Is this the margin?');
        // Only the user's own comment can be changed.
        expect(screen.queryByTestId('annotation-comment-edit-c1')).toBeNull();
        expect(screen.getByTestId('annotation-comment-edit-c2')).toBeTruthy();
        const input = screen.getByTestId(
            'annotation-comment-input-a1'
        ) as HTMLTextAreaElement;
        expect(document.activeElement).toBe(input);

        // Ctrl+Enter posts; the field empties and keeps the focus.
        fireEvent.change(input, { target: { value: '  Agreed.  ' } });
        fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
        await flush();
        const posted = service.calls.find(call => call.method === 'POST')!;
        expect(posted.path).toBe('/wsi/annotations/a1/comments');
        expect(posted.body).toEqual({ body: 'Agreed.' });
        expect(input.value).toBe('');
        expect(document.activeElement).toBe(input);
        expect(
            screen.getByTestId('annotation-comment-count-a1').textContent
        ).toBe('3');
        const added = service.comments.get('a1')![2];
        expect(
            screen.getByTestId(`annotation-comment-body-${added.id}`)
                .textContent
        ).toBe('Agreed.');
        // The annotation's own note is untouched.
        expect(service.rows.get('a1').body.comment).toBe('');

        // Edit.
        fireEvent.click(screen.getByTestId('annotation-comment-edit-c2'));
        const edit = screen.getByTestId('annotation-comment-edit-input-c2');
        fireEvent.change(edit, {
            target: { value: 'Yes, deep margin, 1 mm.' },
        });
        fireEvent.click(
            screen.getByTestId('annotation-comment-edit-input-c2-save')
        );
        await flush();
        expect(
            screen.getByTestId('annotation-comment-body-c2').textContent
        ).toBe('Yes, deep margin, 1 mm.');
        expect(
            screen.getByTestId('annotation-comment-c2').textContent
        ).toContain('(edited)');

        // Delete, after a confirmation; the focus goes to the composer.
        fireEvent.click(screen.getByTestId('annotation-comment-delete-c2'));
        await flush();
        expect(screen.queryByTestId('annotation-comment-c2')).toBeNull();
        expect(
            screen.getByTestId('annotation-comment-count-a1').textContent
        ).toBe('2');
        expect(document.activeElement).toBe(input);
        expect(service.writes()).toEqual([
            ['POST', '/wsi/annotations/a1/comments'],
            ['PUT', '/wsi/annotations/a1/comments/c2'],
            ['DELETE', '/wsi/annotations/a1/comments/c2'],
        ]);

        // The tooltip gives the count.
        const click = (controller as any).annotorious.on.mock.calls.find(
            ([name]: [string]) => name === 'clickAnnotation'
        )[1];
        act(() => click(controller.annotations[0], { clientX: 1, clientY: 1 }));
        expect(controller.annotationTooltip?.comments).toBe('2 comments');
    });

    it('warns before a delete loses comments, and says undo cannot bring them back', async () => {
        const { controller, service } = await setup();
        const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
        // The thread is not loaded yet: the delete loads it to tell whose
        // comments they are.
        await act(async () => {
            fireEvent.click(screen.getByTestId('delete-annotation-a1'));
        });
        expect(confirm).toHaveBeenCalledWith(
            'Delete annotation "Tumor"? "Tumor" has 2 comments, 1 by other users. Deleting deletes its comment thread, and Undo cannot bring the comments back.'
        );
        expect(service.rows.has('a1')).toBe(true);
        confirm.mockReturnValue(true);
        await act(async () => {
            fireEvent.click(screen.getByTestId('delete-annotation-a1'));
        });
        await flush();
        expect(service.rows.has('a1')).toBe(false);
        await act(async () => {
            await controller.undo();
        });
        expect(controller.notice).toBe(
            '"Tumor" was created again as a new annotation; its 2 comments could not be restored.'
        );
    });

    it("pages a long thread with Show more, and shows the service's cap", async () => {
        const { controller, service } = await setup({ page: 2, cap: 4 });
        service.comments.set('a1', [
            comment('c1', 'other', 'One'),
            comment('c2', 'me', 'Two'),
            comment('c3', 'other', 'Three'),
        ]);
        await open();
        const bodies = () =>
            Array.from(
                document.querySelectorAll(
                    '[data-testid^="annotation-comment-body-"]'
                )
            ).map(item => item.textContent);
        // The first page, oldest first, and how many more there are.
        expect(bodies()).toEqual(['One', 'Two']);
        const more = screen.getByTestId('annotation-comments-more-a1');
        expect(more.textContent).toBe('Show more comments (1 more)');
        expect(
            service.calls[service.calls.length - 1].query.get('offset')
        ).toBeNull();
        await act(async () => {
            fireEvent.click(more);
        });
        await flush();
        expect(
            service.calls[service.calls.length - 1].query.get('offset')
        ).toBe('2');
        expect(bodies()).toEqual(['One', 'Two', 'Three']);
        expect(screen.queryByTestId('annotation-comments-more-a1')).toBeNull();
        expect(controller.threads.get('a1')!.total).toBe(3);
        // The fourth is the last the service takes; the fifth is refused
        // with its message.
        await act(async () => {
            expect(await controller.addComment('a1', 'Four')).toBe(true);
        });
        await act(async () => {
            expect(await controller.addComment('a1', 'Five')).toBe(false);
        });
        expect(controller.threads.get('a1')!.error).toBe(
            'An annotation holds at most 4 comments.'
        );
    });

    it("reports another user's comment refused, and a deleted annotation", async () => {
        const { controller, service } = await setup();
        await open();
        await act(async () => {
            await controller.editComment('a1', 'c1', 'Changed');
        });
        expect(
            screen.getByTestId('annotation-thread-error-a1').textContent
        ).toContain('Only its author can change this comment.');

        service.rows.delete('a1');
        await act(async () => {
            await controller.addComment('a1', 'Still there?');
        });
        await flush();
        expect(controller.annotations).toHaveLength(0);
        expect(controller.error).toBe(
            'The annotation was deleted or is no longer shared; reloaded latest data.'
        );
    });

    it('hides threads on a service without them', async () => {
        const { controller } = await setup({
            commentCounts: false,
            missing: ['comments'],
        });
        expect(controller.commentsAvailable).toBe(false);
        expect(
            screen.queryByTestId('annotation-comments-toggle-a1')
        ).toBeNull();
    });

    it('turns threads off when the route turns out to be missing', async () => {
        const { controller } = await setup({ missing: ['comments'] });
        expect(controller.commentsAvailable).toBe(true);
        await open();
        expect(controller.commentRoute).toBe(false);
        expect(
            screen.queryByTestId('annotation-comments-toggle-a1')
        ).toBeNull();
    });
});
