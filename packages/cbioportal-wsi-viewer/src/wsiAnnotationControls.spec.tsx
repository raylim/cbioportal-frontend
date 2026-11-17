/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WsiAnnotationController } from './wsiAnnotationController';
import {
    WsiAnnotationPanel,
    WsiAnnotationToolbar,
} from './wsiAnnotationControls';
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
            apiItem('Tumor 1', { layer_name: 'Tumor' }),
            apiItem('Tumor 2', { layer_name: 'Tumor' }),
            apiItem('Stroma 1', { layer_name: 'Stroma' }),
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

        fireEvent.click(screen.getByLabelText('Show the 2 Tumor annotations'));
        expect(
            (screen.getByLabelText(
                'Filter annotations by label or note'
            ) as HTMLInputElement).value
        ).toBe('Tumor');
        expect(screen.getAllByRole('listitem')).toHaveLength(2);

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
            const controller = controllerWith([apiItem('Fibrosis 1', {})]);
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
                    'Save annotation label'
                ) as HTMLButtonElement).disabled
            ).toBe(true);
            fireEvent.change(rowField, { target: { value: 'Necrosis' } });
            fireEvent.click(screen.getByLabelText('Save annotation label'));
            expect(rename).toHaveBeenCalledWith('Old', 'Necrosis');
        });
    });

    it('exports and imports through the panel after a preview', async () => {
        const controller = controllerWith([
            apiItem('a1', { layer_name: 'Tumor' }),
            apiItem('a2', { layer_name: 'Stroma' }),
        ]);
        const download = jest
            .spyOn(controller, 'downloadGeoJson')
            .mockImplementation(() => undefined);
        const confirm = jest
            .spyOn(controller, 'confirmImport')
            .mockResolvedValue([]);
        render(<WsiAnnotationPanel controller={controller} />);

        fireEvent.click(
            screen.getByLabelText(
                'Export all 2 annotations of this slide as GeoJSON'
            )
        );
        expect(download).toHaveBeenCalledWith('all');
        expect(screen.queryByTestId('annotation-export-visible')).toBeNull();

        act(() => controller.toggleLayerVisibility('Stroma'));
        fireEvent.click(
            screen.getByLabelText(
                'Export the 1 annotation on visible layers as GeoJSON'
            )
        );
        expect(download).toHaveBeenLastCalledWith('visible');

        const file = new File(
            [
                JSON.stringify({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [1, 2] },
                    properties: { name: 'Mitosis' },
                }),
            ],
            'points.geojson'
        );
        fireEvent.change(screen.getByLabelText('GeoJSON file to import'), {
            target: { files: [file] },
        });
        const preview = await screen.findByTestId('annotation-import-preview');
        expect(preview.textContent).toContain(
            'points.geojson: 1 annotation (1 point)'
        );
        fireEvent.click(screen.getByText('Create 1 annotation'));
        expect(confirm).toHaveBeenCalled();
    });
});
