/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WsiAnnotationController } from './wsiAnnotationController';
import { runInAction } from 'mobx';
import {
    layerDeleteMessage,
    readableTextColor,
    WsiAnnotationLayersPanel,
    WsiAnnotationPanel,
} from './wsiAnnotationControls';
import { WsiAnnotationToolbar } from './wsiAnnotationToolbar';
import {
    configureWsiViewerRuntime,
    resetWsiViewerRuntime,
} from './wsiViewerConfig';

function controllerWith(items: any[]): WsiAnnotationController {
    const controller = new WsiAnnotationController(
        'https://tiles.example',
        'study1'
    );
    (controller as any).slideKey = '0123456789ab';
    (controller as any).annotations = items.map(item =>
        (controller as any).fromApi(item, '0123456789ab')
    );
    return controller;
}

function apiItem(id: string, body: Record<string, unknown>) {
    return {
        id,
        body: { label: id, layer_name: 'Default', color: '#ef4444', ...body },
        target: {
            selector: { type: 'FragmentSelector', value: 'xywh=pixel:1,2,3,4' },
        },
        version: 1,
        created_by: 'user',
    };
}

describe('WsiAnnotationPanel', () => {
    beforeEach(() => window.localStorage.clear());

    it("shows a color's name only when it is not a layer's", () => {
        const controller = controllerWith([
            apiItem('named', { type: 'Mitosis|#f97316', color: '#f97316' }),
            apiItem('own-layer', { type: 'Default|#3b82f6' }),
            apiItem('other-layer', {
                type: 'Tumor|#ef4444',
            }),
            apiItem('tumor', { layer_name: 'Tumor', type: 'Tumor|#ef4444' }),
        ]);
        render(<WsiAnnotationPanel controller={controller} />);
        const badges = (id: string) =>
            screen.getByTestId(`annotation-row-${id}`).textContent;
        expect(badges('named')).toContain('Mitosis');
        expect(badges('own-layer')).not.toMatch(/DefaultDefault/);
        expect(badges('other-layer')).not.toContain('Tumor');
    });

    it('marks assistant annotations and offers accept and reject until reviewed', () => {
        const controller = controllerWith([
            apiItem('ai-1', { provenance: { source: 'agent' } }),
            apiItem('ai-2', {
                provenance: { source: 'agent', review_status: 'accepted' },
            }),
            apiItem('mine', {}),
        ]);
        const accept = jest
            .spyOn(controller, 'acceptAnnotation')
            .mockResolvedValue(undefined);
        const reject = jest
            .spyOn(controller, 'rejectAnnotation')
            .mockResolvedValue(undefined);
        render(<WsiAnnotationPanel controller={controller} />);

        expect(screen.getByTestId('annotation-ai-badge-ai-1').textContent).toBe(
            'AI · unreviewed'
        );
        expect(screen.getByTestId('annotation-ai-badge-ai-2').textContent).toBe(
            'AI · accepted'
        );
        expect(screen.queryByTestId('annotation-ai-badge-mine')).toBeNull();
        expect(screen.queryByTestId('accept-annotation-ai-2')).toBeNull();

        fireEvent.click(screen.getByLabelText('Accept AI annotation ai-1'));
        fireEvent.click(screen.getByLabelText('Reject AI annotation ai-1'));
        expect(accept).toHaveBeenCalledWith('ai-1');
        expect(reject).toHaveBeenCalledWith('ai-1');

        fireEvent.click(screen.getByTestId('annotation-hide-unreviewed-ai'));
        expect(screen.queryByTestId('annotation-row-ai-1')).toBeNull();
        expect(screen.getByTestId('annotation-row-ai-2')).toBeTruthy();
    });

    it('marks model-made annotations as AI and names the model in the badge tooltip', () => {
        const controller = controllerWith([
            apiItem('m-1', {
                provenance: { source: 'precomputed', model: 'luad-patterns' },
            }),
            apiItem('a-1', { provenance: { source: 'agent' } }),
        ]);
        render(<WsiAnnotationPanel controller={controller} />);

        const model = screen.getByTestId('annotation-ai-badge-m-1');
        expect(model.textContent).toBe('AI · unreviewed');
        expect(model.getAttribute('title')).toBe(
            'Made by a model (luad-patterns); not reviewed yet'
        );
        expect(
            screen.getByTestId('annotation-ai-badge-a-1').getAttribute('title')
        ).toBe('Made by the research assistant; not reviewed yet');
        expect(screen.getByTestId('accept-annotation-m-1')).toBeTruthy();
        expect(controller.unreviewedAiCount).toBe(2);

        fireEvent.click(screen.getByTestId('annotation-hide-unreviewed-ai'));
        expect(screen.queryByTestId('annotation-row-m-1')).toBeNull();
    });

    it("offers review of another user's AI annotation but not its edit or delete", () => {
        const controller = controllerWith([
            {
                ...apiItem('ai', { provenance: { source: 'precomputed' } }),
                created_by: 'loader',
            },
            { ...apiItem('theirs', {}), created_by: 'loader', visible_to: [] },
            { ...apiItem('mine', {}), created_by: 'me', visible_to: [] },
        ]);
        controller.setCurrentUser('me');
        render(<WsiAnnotationPanel controller={controller} />);

        expect(screen.getByTestId('accept-annotation-ai')).toBeTruthy();
        expect(screen.getByTestId('reject-annotation-ai')).toBeTruthy();
        ['ai', 'theirs'].forEach(id => {
            expect(screen.queryByTestId(`edit-label-${id}`)).toBeNull();
            expect(screen.queryByTestId(`delete-annotation-${id}`)).toBeNull();
            expect(
                screen.queryByTestId(`annotation-note-edit-${id}`)
            ).toBeNull();
        });
        expect(screen.getByTestId('annotation-visibility-theirs').tagName).toBe(
            'SPAN'
        );
        expect(screen.getByTestId('edit-label-mine')).toBeTruthy();
        expect(screen.getByTestId('delete-annotation-mine')).toBeTruthy();
        expect(screen.getByTestId('annotation-visibility-mine').tagName).toBe(
            'BUTTON'
        );
        expect(
            screen.getByTestId('reject-annotation-ai').getAttribute('title')
        ).toContain('keeps it as a review record');
    });

    it('offers the brush width in µm with a scale, and screen pixels without one', () => {
        const controller = controllerWith([]);
        controller.setTool('brush');
        const { rerender } = render(
            <WsiAnnotationToolbar controller={controller} />
        );
        let select = screen.getByTestId(
            'annotation-brush-width'
        ) as HTMLSelectElement;
        expect(select.getAttribute('aria-label')).toBe(
            'Brush width in screen pixels'
        );
        expect(select.value).toBe('16');
        expect(screen.getByTestId('annotation-brush-unit-note')).toBeTruthy();

        act(() => controller.setMppProvider(() => ({ x: 0.5, y: 0.5 })));
        rerender(<WsiAnnotationToolbar controller={controller} />);
        select = screen.getByTestId(
            'annotation-brush-width'
        ) as HTMLSelectElement;
        expect(select.getAttribute('aria-label')).toBe(
            'Brush width in micrometres'
        );
        expect(Array.from(select.options).map(o => o.textContent)).toEqual([
            '10 µm',
            '25 µm',
            '50 µm',
            '100 µm',
            '250 µm',
            '500 µm',
        ]);
        expect(select.value).toBe('50');
        expect(screen.queryByTestId('annotation-brush-unit-note')).toBeNull();
        fireEvent.change(select, { target: { value: '100' } });
        expect(controller.brushWidthUm).toBe(100);
    });

    it('shows whether each annotation is private or shared and switches it', () => {
        const controller = controllerWith([
            { ...apiItem('mine', {}), visible_to: null },
            { ...apiItem('ours', {}), visible_to: [] },
        ]);
        const setShared = jest
            .spyOn(controller, 'setAnnotationShared')
            .mockResolvedValue(undefined);
        render(<WsiAnnotationPanel controller={controller} />);

        const mine = screen.getByTestId('annotation-visibility-mine');
        const ours = screen.getByTestId('annotation-visibility-ours');
        expect(mine.textContent).toContain('Private');
        expect(ours.textContent).toContain('Shared');
        expect(mine.getAttribute('aria-label')).toContain('Share: mine');

        fireEvent.click(mine);
        fireEvent.click(ours);
        expect(setShared.mock.calls).toEqual([
            ['mine', true],
            ['ours', false],
        ]);
    });

    it('shows each annotation size, and says when the slide has no scale', () => {
        const controller = controllerWith([
            {
                ...apiItem('box', {}),
                target: {
                    selector: {
                        type: 'FragmentSelector',
                        value: 'xywh=pixel:0,0,100,200',
                    },
                },
            },
        ]);
        const { rerender } = render(
            <WsiAnnotationPanel controller={controller} />
        );
        expect(
            screen.getByTestId('annotation-measurement-box').textContent
        ).toBe('Area 20,000 px² · Perimeter 600 px');
        expect(
            screen.getByTestId('annotation-measurement-scale-note')
        ).toBeTruthy();

        controller.setMppProvider(() => ({ x: 0.5, y: 0.5 }));
        rerender(<WsiAnnotationPanel controller={controller} />);
        expect(
            screen.getByTestId('annotation-measurement-box').textContent
        ).toBe('Area 5,000 µm² · Perimeter 300 µm');
        expect(
            screen.queryByTestId('annotation-measurement-scale-note')
        ).toBeNull();
    });

    it('adds and edits a note separately from the label', () => {
        const controller = controllerWith([
            apiItem('a1', {}),
            apiItem('a2', { comment: 'Existing note' }),
        ]);
        const setNote = jest
            .spyOn(controller, 'setAnnotationNote')
            .mockResolvedValue(undefined);
        render(<WsiAnnotationPanel controller={controller} />);

        expect(screen.getByTestId('annotation-note-a2').textContent).toBe(
            'Existing note'
        );
        fireEvent.click(screen.getByLabelText('Add note for a1'));
        fireEvent.change(screen.getByLabelText('Note for a1'), {
            target: { value: '  Mitoses near margin  ' },
        });
        fireEvent.click(screen.getByTestId('annotation-note-save-a1'));
        expect(setNote).toHaveBeenCalledWith('a1', 'Mitoses near margin');

        fireEvent.click(screen.getByLabelText('Edit note for a2'));
        const input = screen.getByLabelText(
            'Note for a2'
        ) as HTMLTextAreaElement;
        expect(input.value).toBe('Existing note');
        fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
        expect(setNote).toHaveBeenLastCalledWith('a2', 'Existing note');
    });

    it('filters the list, counts labels and goes to an annotation', () => {
        const controller = controllerWith([
            apiItem('Tumor 1', { layer_name: 'Tumor', type: 'Tumor|#ef4444' }),
            apiItem('Tumor 2', { layer_name: 'Tumor', type: 'Tumor|#ef4444' }),
            apiItem('Stroma 1', {
                layer_name: 'Stroma',
                type: 'Stroma|#22c55e',
                comment: 'Tumor margin',
            }),
        ]);
        const zoom = jest
            .spyOn(controller, 'zoomToAnnotation')
            .mockReturnValue(true);
        render(<WsiAnnotationPanel controller={controller} />);

        expect(
            screen.getByTestId('annotation-count-layer-Tumor').textContent
        ).toBe('Tumor 2');
        expect(
            screen.getByTestId('annotation-count-label-Stroma').textContent
        ).toBe('Stroma 1');
        expect(screen.getAllByRole('listitem')).toHaveLength(3);

        fireEvent.change(screen.getByLabelText('Filter annotations by layer'), {
            target: { value: 'Stroma' },
        });
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
        fireEvent.click(screen.getByTestId('annotation-filter-clear'));

        // A label chip matches the label term exactly, not notes.
        const chip = screen.getByLabelText('Show only the 2 Tumor annotations');
        fireEvent.click(chip);
        expect(chip.getAttribute('aria-pressed')).toBe('true');
        expect(
            (screen.getByLabelText(
                'Filter annotations by label or note'
            ) as HTMLInputElement).value
        ).toBe('');
        expect(screen.getAllByRole('listitem')).toHaveLength(2);
        expect(screen.queryByTestId('annotation-row-Stroma 1')).toBeNull();

        fireEvent.click(screen.getByLabelText('Go to annotation Tumor 2'));
        expect(zoom).toHaveBeenCalledWith('Tumor 2');

        fireEvent.change(
            screen.getByLabelText('Filter annotations by label or note'),
            { target: { value: 'nothing' } }
        );
        expect(screen.getByRole('status').textContent).toBe(
            'No annotations match the filters.'
        );
    });

    it('tallies points per label and layer', () => {
        const point = (id: string, label: string, layer: string) => ({
            ...apiItem(id, { label, layer_name: layer }),
            target: {
                selector: {
                    type: 'SvgSelector',
                    value: '<svg><circle cx="1" cy="2" r="0" /></svg>',
                },
            },
        });
        const controller = controllerWith([
            point('p1', 'Mitosis', 'Counts'),
            point('p2', 'Mitosis', 'Counts'),
            point('p3', 'Lymphocyte', 'Counts'),
            apiItem('box', {}),
        ]);
        render(<WsiAnnotationPanel controller={controller} />);

        const tally = screen.getByTestId('annotation-point-tally');
        expect(tally.textContent).toContain('Point counts');
        expect(
            screen.getByTestId('annotation-point-tally-Counts-Mitosis')
                .textContent
        ).toBe('MitosisCounts2');
        expect(
            screen.getByTestId('annotation-point-tally-Counts-Lymphocyte')
                .textContent
        ).toBe('LymphocyteCounts1');
    });

    describe('label vocabulary', () => {
        afterEach(() => resetWsiViewerRuntime());
        const configure = (strict: boolean) =>
            configureWsiViewerRuntime({
                buildApiUrl: path => path,
                annotations: {
                    apiUrl: 'https://tiles.example',
                    labelVocabulary: ['Tumor', 'Stroma', 'Necrosis'],
                    labelVocabularyStrict: strict,
                },
            });

        it('offers the terms while allowing free text', () => {
            configure(false);
            const controller = controllerWith([
                apiItem('Fibrosis 1', { type: 'Fibrosis|#ef4444' }),
            ]);
            controller.setAnnotating(true);
            render(<WsiAnnotationToolbar controller={controller} />);

            const field = screen.getByLabelText(
                'Label for new annotations'
            ) as HTMLInputElement;
            expect(field.tagName).toBe('INPUT');
            const options = Array.from(
                document.querySelectorAll(
                    `#${field.getAttribute('list')} option`
                )
            ).map(option => option.getAttribute('value'));
            expect(options).toEqual([
                'Tumor',
                'Stroma',
                'Necrosis',
                'Fibrosis',
            ]);
            fireEvent.change(field, { target: { value: 'Custom term' } });
            expect(controller.activeLabel).toBe('Custom term');
        });

        it('limits labels to the terms when strict', () => {
            configure(true);
            const controller = controllerWith([apiItem('Old', {})]);
            controller.setAnnotating(true);
            const rename = jest
                .spyOn(controller, 'renameAnnotation')
                .mockResolvedValue(undefined);
            render(
                <>
                    <WsiAnnotationToolbar controller={controller} />
                    <WsiAnnotationPanel controller={controller} />
                </>
            );

            const field = screen.getByLabelText('Label for new annotations');
            expect(field.tagName).toBe('SELECT');
            fireEvent.change(field, { target: { value: 'Stroma' } });
            expect(controller.activeLabel).toBe('Stroma');

            fireEvent.click(screen.getByTestId('edit-label-Old'));
            const rowField = screen.getByLabelText('Label for Old');
            expect(rowField.tagName).toBe('SELECT');
            // The stored label is not a term: saving waits for a choice.
            expect(
                (screen.getByLabelText(
                    'Save label of Old'
                ) as HTMLButtonElement).disabled
            ).toBe(true);
            fireEvent.change(rowField, { target: { value: 'Necrosis' } });
            fireEvent.click(screen.getByLabelText('Save label of Old'));
            expect(rename).toHaveBeenCalledWith('Old', 'Necrosis');
        });
    });

    it('says how much a layer delete removes, and that others keep the layer', () => {
        expect(layerDeleteMessage('Tumor', { own: 0, others: 0 })).toBeNull();
        expect(layerDeleteMessage('Tumor', { own: 2, others: 0 })).toBe(
            'Delete layer "Tumor" and your 2 annotations in it?'
        );
        expect(layerDeleteMessage('Tumor', { own: 1, others: 3 })).toBe(
            'Delete layer "Tumor" and your 1 annotation in it? The layer stays on the slide while 3 annotations by other users are in it.'
        );
        expect(layerDeleteMessage('Tumor', { own: 0, others: 1 })).toBe(
            'Delete layer "Tumor"? None of its annotations are yours. The layer stays on the slide while 1 annotation by other users is in it.'
        );

        const controller = controllerWith([
            { ...apiItem('mine', { layer_name: 'Tumor' }), created_by: 'me' },
            {
                ...apiItem('theirs', { layer_name: 'Tumor' }),
                created_by: 'other',
            },
        ]);
        controller.setCurrentUser('me');
        const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
        render(<WsiAnnotationLayersPanel controller={controller} />);
        fireEvent.click(screen.getByLabelText('Delete layer Tumor'));
        expect(confirm).toHaveBeenCalledWith(
            'Delete layer "Tumor" and your 1 annotation in it? The layer stays on the slide while 1 annotation by other users is in it.'
        );
        confirm.mockRestore();
    });

    it('shows a failed load as an alert with Retry', async () => {
        const controller = controllerWith([]);
        runInAction(() => {
            controller.loadFailed = true;
            controller.error = 'Unable to load annotations.';
        });
        const retry = jest
            .spyOn(controller, 'retryLoad')
            .mockResolvedValue(undefined);
        render(<WsiAnnotationPanel controller={controller} />);
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toContain('Unable to load annotations.');
        fireEvent.click(screen.getByTestId('annotation-load-retry'));
        expect(retry).toHaveBeenCalled();
    });

    it('notes a slide without a scale before any annotation exists', () => {
        const controller = controllerWith([]);
        render(<WsiAnnotationPanel controller={controller} />);
        expect(
            screen.getByTestId('annotation-measurement-scale-note')
        ).toBeTruthy();
    });

    describe('accessibility', () => {
        it('names icon buttons by their target and hides the color dot', () => {
            const controller = controllerWith([
                apiItem('a1', { layer_name: 'Tumor' }),
            ]);
            render(
                <>
                    <WsiAnnotationLayersPanel controller={controller} />
                    <WsiAnnotationPanel controller={controller} />
                </>
            );
            expect(screen.getByLabelText('Edit label of a1')).toBeTruthy();
            expect(screen.getByLabelText('Delete annotation a1')).toBeTruthy();
            expect(screen.getByLabelText('Delete layer Tumor')).toBeTruthy();
            const dot = screen
                .getByTestId('annotation-row-a1')
                .querySelector('[data-annotation-color]')!;
            expect(dot.getAttribute('aria-hidden')).toBe('true');
            expect(dot.getAttribute('aria-label')).toBeNull();
        });

        it('picks black or white text for a color by its luminance', () => {
            expect(readableTextColor('#ffff00')).toBe('#000');
            expect(readableTextColor('#22c55e')).toBe('#000');
            expect(readableTextColor('#1f1f1f')).toBe('#fff');
            expect(readableTextColor('#7c3aed')).toBe('#fff');
            expect(readableTextColor('#fff')).toBe('#000');
            expect(readableTextColor('not a color')).toBe('#000');
            const controller = controllerWith([
                apiItem('y', { type: 'Yellow|#ffff00' }),
            ]);
            render(<WsiAnnotationPanel controller={controller} />);
            const badge = screen.getByText('Yellow');
            expect(badge.style.color).toBe('rgb(0, 0, 0)');
        });

        it('moves focus to the next row after a delete, and back to the row after accept', async () => {
            const controller = controllerWith([
                apiItem('a1', {}),
                apiItem('a2', { provenance: { source: 'agent' } }),
                apiItem('a3', {}),
            ]);
            jest.spyOn(controller, 'removeAnnotation').mockImplementation(
                async (id: string) =>
                    runInAction(() => {
                        controller.annotations = controller.annotations.filter(
                            item => item.id !== id
                        );
                    })
            );
            jest.spyOn(controller, 'acceptAnnotation').mockResolvedValue(
                undefined
            );
            render(<WsiAnnotationPanel controller={controller} />);

            await act(async () => {
                fireEvent.click(screen.getByLabelText('Delete annotation a1'));
            });
            expect(document.activeElement).toBe(
                screen.getByTestId('annotation-goto-a2')
            );

            await act(async () => {
                fireEvent.click(screen.getByTestId('accept-annotation-a2'));
            });
            expect(document.activeElement).toBe(
                screen.getByTestId('annotation-goto-a2')
            );
        });
    });

    it('shows the most common label groups, the rest behind "+N more"', () => {
        const items: any[] = [];
        const add = (label: string, n: number) => {
            for (let i = 0; i < n; i++) {
                items.push(apiItem(`${label}-${i}`, { label }));
            }
        };
        // Model labels with tile counts group under their base term.
        [13, 9, 11].forEach((tiles, i) =>
            add(`Solid region (${tiles} tiles)`, 3 - i)
        );
        [
            'Grade 1',
            'Grade 2',
            'Grade 3',
            'A',
            'B',
            'C',
            'D',
            'E',
            'F',
        ].forEach((label, i) => add(label, i < 3 ? 2 : 1));
        const controller = controllerWith(items);
        render(<WsiAnnotationPanel controller={controller} />);
        const chips = () =>
            screen
                .getAllByTestId(/^annotation-count-label-/)
                .map(chip => chip.textContent);

        expect(chips()).toEqual([
            'Solid region 6',
            'Grade 1 2',
            'Grade 2 2',
            'Grade 3 2',
            'A 1',
            'B 1',
            'C 1',
            'D 1',
            '+2 more',
        ]);
        fireEvent.click(screen.getByText('+2 more'));
        expect(chips()).toHaveLength(11);
        expect(chips()[10]).toBe('Show fewer');
        fireEvent.click(screen.getByText('Show fewer'));
        expect(chips()).toHaveLength(9);

        fireEvent.click(
            screen.getByLabelText('Show only the 6 Solid region annotations')
        );
        expect(screen.getAllByRole('listitem')).toHaveLength(6);
    });
});
