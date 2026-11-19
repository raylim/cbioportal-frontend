/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { addTag, normalizeTag, tagSummary } from './wsiSlideNotes';
import { WsiSlideNotesPanel } from './wsiSlideNotesPanel';
import {
    attachTestController,
    flush,
    TEST_SLIDE_KEY,
    TEST_STUDY,
    TestAnnotationService,
    TestServiceOptions,
} from './wsiAnnotationTestService';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

describe('tags', () => {
    it('normalizes and validates tags as the service does', () => {
        expect(normalizeTag('  margin   involved ')).toBe('margin involved');
        expect(normalizeTag('QC/2026#1')).toBe('QC/2026#1');
        expect(normalizeTag('Ünïcode-tag')).toBe('Ünïcode-tag');
        expect(normalizeTag('_starts-with-underscore')).toBeNull();
        expect(normalizeTag('bad!')).toBeNull();
        expect(normalizeTag('x'.repeat(41))).toBeNull();
        expect(addTag(['QC'], 'qc')).toEqual(['QC']);
        expect(addTag(['QC'], 'LUAD')).toEqual(['QC', 'LUAD']);
        const note = (tags: string[]) => ({ tags } as any);
        expect(
            tagSummary([note(['QC', 'LUAD']), note(['QC']), note(['adeno'])])
        ).toEqual([
            { tag: 'QC', count: 2 },
            { tag: 'adeno', count: 1 },
            { tag: 'LUAD', count: 1 },
        ]);
    });
});

describe('Slide notes', () => {
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

    const stored = (
        id: string,
        creator: string,
        text: string,
        tags: string[],
        visibleTo: string[] | null
    ) => ({
        id,
        slide_id: TEST_SLIDE_KEY,
        study_id: TEST_STUDY,
        text,
        tags,
        created_by: creator,
        visible_to: visibleTo,
        version: 1,
        created_at: '2026-11-18T10:00:00Z',
        updated_at: '2026-11-18T10:00:00Z',
    });

    async function setup(options: TestServiceOptions = {}) {
        const service = new TestAnnotationService([], options);
        service.notes.set(
            'n1',
            stored('n1', 'other', 'Margin involved', ['QC', 'LUAD'], [])
        );
        service.notes.set('n2', stored('n2', 'me', 'Recut?', ['QC'], null));
        service.notes.set(
            'n3',
            stored('n3', 'other', 'Private to other', ['secret'], null)
        );
        service.install();
        const harness = await attachTestController(service);
        cleanup.push(harness.cleanup);
        return { service, ...harness };
    }

    const notesListed = () =>
        Array.from(
            screen
                .getByTestId('slide-notes-list')
                .querySelectorAll('[data-testid^="slide-note-text-"]')
        ).map(item => item.textContent);

    it('loads when shown, lists the notes with the tag summary, and filters by tag', async () => {
        const { controller, service } = await setup();
        // Nothing is fetched until the section shows.
        expect(
            service.calls.filter(call => call.path.includes('slide-notes'))
        ).toHaveLength(0);
        render(<WsiSlideNotesPanel controller={controller} />);
        await flush();
        const get = service.calls.find(call =>
            call.path.endsWith('/slide-notes')
        )!;
        expect(get.query.get('slide_id')).toBe(TEST_SLIDE_KEY);
        expect(get.query.getAll('studyId')).toEqual([TEST_STUDY]);
        expect(controller.slideNotes.route).toBe(true);
        expect(notesListed()).toEqual(['Margin involved', 'Recut?']);
        expect(
            screen.getByTestId('slide-note-sharing-n2').textContent
        ).toContain('Private');
        const summary = screen.getByTestId('slide-notes-tag-summary');
        expect(
            within(summary)
                .getAllByRole('button')
                .map(button => button.textContent)
        ).toEqual(['QC 2', 'LUAD 1']);
        fireEvent.click(screen.getByTestId('slide-notes-tag-LUAD'));
        expect(
            screen
                .getByTestId('slide-notes-tag-LUAD')
                .getAttribute('aria-pressed')
        ).toBe('true');
        expect(notesListed()).toEqual(['Margin involved']);
        fireEvent.click(screen.getByTestId('slide-notes-tag-LUAD'));
        expect(notesListed()).toHaveLength(2);
        // Only the user's own note can be changed.
        expect(screen.queryByTestId('slide-note-edit-button-n1')).toBeNull();
        expect(screen.getByTestId('slide-note-edit-button-n2')).toBeTruthy();
    });

    it('never adds a note to a slide opened while its answer was read', async () => {
        const { controller, service } = await setup();
        await controller.slideNotes.load();
        // The POST is answered, but its body is read only after another
        // slide opens.
        let readBody: () => void = () => undefined;
        const gate = new Promise<void>(resolve => (readBody = resolve));
        const serviceFetch = global.fetch;
        global.fetch = jest.fn(async (input: any, init?: RequestInit) => {
            const answer: any = await serviceFetch(input, init);
            if (init?.method !== 'POST') return answer;
            return {
                ...answer,
                clone: () => answer.clone(),
                json: () => gate.then(() => answer.json()),
            };
        }) as any;
        const created = controller.slideNotes.create({
            text: 'For the first slide',
            tags: [],
            shared: true,
        });
        await flush();
        controller.beginSlide('fedcba987654');
        await controller.slideNotes.load();
        readBody();
        expect(await created).toBe(false);
        expect(controller.slideNotes.slideKey).toBe('fedcba987654');
        expect(
            controller.slideNotes.notes.map(note => note.text)
        ).not.toContain('For the first slide');
        expect(controller.slideNotes.busy).toBe(false);
    });

    it('adds a note with tags, edits and deletes the own one', async () => {
        const { controller, service } = await setup();
        render(<WsiSlideNotesPanel controller={controller} />);
        await flush();
        const text = screen.getByTestId(
            'slide-note-new-text'
        ) as HTMLTextAreaElement;
        const tags = screen.getByTestId(
            'slide-note-new-tags'
        ) as HTMLInputElement;
        // Suggestions are the slide's tags.
        const list = document.getElementById(tags.getAttribute('list')!)!;
        expect(
            Array.from(list.querySelectorAll('option')).map(
                option => option.value
            )
        ).toEqual(['QC', 'LUAD']);
        fireEvent.change(text, { target: { value: 'Tumor at the margin' } });
        fireEvent.change(tags, { target: { value: 'margin' } });
        fireEvent.keyDown(tags, { key: 'Enter' });
        fireEvent.change(tags, { target: { value: 'QC,' } });
        fireEvent.change(tags, { target: { value: 'bad!' } });
        fireEvent.keyDown(tags, { key: 'Enter' });
        expect(screen.getByRole('alert').textContent).toContain(
            'A tag is 1–40 letters'
        );
        fireEvent.change(tags, { target: { value: '' } });
        expect(
            (screen.getByTestId('slide-note-new-sharing') as HTMLSelectElement)
                .value
        ).toBe('shared');
        fireEvent.click(screen.getByTestId('slide-note-new-submit'));
        await flush();
        const post = service.calls.find(call => call.method === 'POST')!;
        expect(post.path).toBe('/wsi/slide-notes');
        expect(post.body).toEqual({
            slide_id: TEST_SLIDE_KEY,
            study_id: TEST_STUDY,
            text: 'Tumor at the margin',
            tags: ['margin', 'QC'],
            visible_to: [],
        });
        expect(notesListed()).toEqual([
            'Margin involved',
            'Recut?',
            'Tumor at the margin',
        ]);
        expect(text.value).toBe('');
        expect(document.activeElement).toBe(text);
        expect(screen.getByTestId('slide-notes-tag-QC').textContent).toBe(
            'QC 3'
        );

        // Edit the own note: text, a tag removed, made shared.
        fireEvent.click(screen.getByTestId('slide-note-edit-button-n2'));
        const editText = screen.getByTestId('slide-note-edit-n2-text');
        expect(document.activeElement).toBe(editText);
        fireEvent.change(editText, { target: { value: 'Recut ordered' } });
        fireEvent.click(screen.getByLabelText('Remove tag QC'));
        fireEvent.change(screen.getByTestId('slide-note-edit-n2-sharing'), {
            target: { value: 'shared' },
        });
        fireEvent.click(screen.getByTestId('slide-note-edit-n2-submit'));
        await flush();
        const put = service.calls.find(call => call.method === 'PUT')!;
        expect(put.path).toBe('/wsi/slide-notes/n2');
        expect(put.body).toEqual({
            version: 1,
            text: 'Recut ordered',
            tags: [],
            visible_to: [],
        });
        expect(screen.getByTestId('slide-note-text-n2').textContent).toBe(
            'Recut ordered'
        );
        expect(screen.getByTestId('slide-note-n2').textContent).toContain(
            '(edited)'
        );
        await flush();
        expect(document.activeElement).toBe(
            screen.getByTestId('slide-note-edit-button-n2')
        );

        // Delete it, with its version; the focus goes to the new note.
        fireEvent.click(screen.getByTestId('slide-note-delete-n2'));
        await flush();
        const del = service.calls.find(call => call.method === 'DELETE')!;
        expect(del.path).toBe('/wsi/slide-notes/n2');
        expect(del.query.get('version')).toBe('2');
        expect(screen.queryByTestId('slide-note-n2')).toBeNull();
        expect(document.activeElement).toBe(text);
    });

    it('reloads after a conflict, and says so', async () => {
        const { controller, service } = await setup();
        render(<WsiSlideNotesPanel controller={controller} />);
        await flush();
        service.notes.set('n2', {
            ...service.notes.get('n2'),
            text: 'Changed elsewhere',
            version: 2,
        });
        const note = controller.slideNotes.notes.find(
            item => item.id === 'n2'
        )!;
        await controller.slideNotes.update(note, {
            text: 'Mine',
            tags: [],
            shared: false,
        });
        await flush();
        expect(screen.getByTestId('slide-notes-error').textContent).toContain(
            'The note was changed elsewhere; reloaded the notes.'
        );
        expect(screen.getByTestId('slide-note-text-n2').textContent).toBe(
            'Changed elsewhere'
        );
    });

    it('hides the section on a service without slide notes', async () => {
        const { controller } = await setup({ missing: ['slideNotes'] });
        const { container } = render(
            <WsiSlideNotesPanel controller={controller} />
        );
        await flush();
        expect(controller.slideNotes.route).toBe(false);
        expect(container.textContent).toBe('');
    });
});
