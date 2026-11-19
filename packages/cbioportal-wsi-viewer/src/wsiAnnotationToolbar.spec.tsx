/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { runInAction } from 'mobx';
import { WsiAnnotationController } from './wsiAnnotationController';
import { WsiAnnotationToolbar } from './wsiAnnotationToolbar';

function controllerWith(items: any[] = []): WsiAnnotationController {
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

function apiItem(id: string, body: Record<string, unknown> = {}) {
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

const byTestId = (id: string) => screen.getByTestId(id);

describe('WsiAnnotationToolbar', () => {
    beforeEach(() => window.localStorage.clear());

    it('shows only Annotate and the ⋯ menu until Annotate is on, and remembers it', () => {
        const controller = controllerWith();
        const { unmount } = render(
            <WsiAnnotationToolbar controller={controller} />
        );
        const bar = byTestId('wsi-annotation-toolbar');
        expect(bar.getAttribute('role')).toBe('toolbar');
        expect(bar.getAttribute('aria-label')).toBe('Annotation tools');
        const toggle = byTestId('annotation-mode-toggle');
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(screen.queryByTestId('annotation-tools')).toBeNull();
        expect(screen.queryByTestId('annotation-drawing-as')).toBeNull();
        expect(screen.queryByTestId('annotation-undo')).toBeNull();
        expect(byTestId('annotation-more-menu-button')).toBeTruthy();

        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(byTestId('annotation-tools')).toBeTruthy();
        expect(
            byTestId('annotation-tool-select').getAttribute('aria-pressed')
        ).toBe('true');
        expect(byTestId('annotation-drawing-as')).toBeTruthy();
        unmount();

        render(<WsiAnnotationToolbar controller={controllerWith()} />);
        expect(
            byTestId('annotation-mode-toggle').getAttribute('aria-pressed')
        ).toBe('true');
    });

    it('disables Annotate with the reason while loading, signed out or read-only', () => {
        const controller = controllerWith();
        controller.setAnnotating(true);
        runInAction(() => (controller.loading = true));
        render(<WsiAnnotationToolbar controller={controller} />);
        const toggle = byTestId('annotation-mode-toggle');
        const status = () => byTestId('wsi-annotation-access-notice');
        expect(toggle.getAttribute('aria-disabled')).toBe('true');
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(toggle.getAttribute('title')).toBe('Loading annotations…');
        expect(status().getAttribute('role')).toBe('status');
        expect(screen.queryByTestId('annotation-tools')).toBeNull();
        fireEvent.click(toggle);
        expect(controller.annotating).toBe(true);

        act(() => {
            runInAction(() => {
                controller.loading = false;
                controller.accessIssue = 'signedOut';
            });
        });
        expect(toggle.getAttribute('title')).toBe(
            'Sign in to view and edit annotations.'
        );
        expect(status().textContent).toBe(
            'Sign in to view and edit annotations.'
        );
        act(() => {
            runInAction(() => (controller.accessIssue = 'forbidden'));
        });
        expect(status().textContent).toContain('read-only');
        // Export and the shortcuts stay; sharing and import go.
        fireEvent.click(byTestId('annotation-more-menu-button'));
        expect(byTestId('annotation-export-all')).toBeTruthy();
        expect(byTestId('annotation-shortcuts')).toBeTruthy();
        expect(
            screen.queryByTestId('annotation-default-sharing-shared')
        ).toBeNull();
        expect(screen.queryByTestId('annotation-import')).toBeNull();

        act(() => {
            runInAction(() => (controller.accessIssue = null));
        });
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByTestId('wsi-annotation-access-notice')).toBeNull();
    });

    it('opens a tool menu from the keyboard, remembers its last tool and returns focus', () => {
        const controller = controllerWith();
        controller.setAnnotating(true);
        render(<WsiAnnotationToolbar controller={controller} />);
        const main = byTestId('annotation-tool-shape');
        const caret = byTestId('annotation-tool-shape-menu');
        expect(main.getAttribute('aria-label')).toBe('Shape: Rectangle (R)');
        expect(caret.getAttribute('aria-haspopup')).toBe('menu');
        expect(caret.getAttribute('aria-expanded')).toBe('false');

        caret.focus();
        fireEvent.keyDown(caret, { key: 'ArrowDown' });
        const menu = screen.getByRole('menu', { name: 'Shape tools' });
        expect(caret.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(
            byTestId('annotation-tool-rectangle')
        );
        fireEvent.keyDown(menu, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(
            byTestId('annotation-tool-ellipse')
        );
        fireEvent.keyDown(menu, { key: 'End' });
        expect(document.activeElement).toBe(byTestId('annotation-tool-circle'));
        fireEvent.keyDown(menu, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(
            byTestId('annotation-tool-rectangle')
        );
        fireEvent.keyDown(menu, { key: 'ArrowUp' });
        fireEvent.click(document.activeElement!);

        expect(controller.activeTool).toBe('circle');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(caret);
        expect(main.getAttribute('aria-label')).toBe('Shape: Circle');
        expect(main.getAttribute('aria-pressed')).toBe('true');
        expect(main.getAttribute('title')).toContain('Esc for Select');

        // One click goes back to Select, the next draws a circle again.
        fireEvent.click(main);
        expect(controller.activeTool).toBeNull();
        fireEvent.click(main);
        expect(controller.activeTool).toBe('circle');

        // Escape closes the menu and returns focus to its button.
        fireEvent.click(byTestId('annotation-tool-outline-menu'));
        const outline = screen.getByRole('menu', { name: 'Outline tools' });
        expect(
            Array.from(outline.querySelectorAll('[role="menuitemradio"]')).map(
                item => item.textContent
            )
        ).toEqual([
            'PolygonP',
            'FreehandF',
            'BrushB',
            'Smart brushShift+B',
            'Magic wandW',
        ]);
        fireEvent.keyDown(outline, { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(
            byTestId('annotation-tool-outline-menu')
        );

        // A press outside closes it without moving focus.
        fireEvent.click(byTestId('annotation-tool-outline-menu'));
        fireEvent.mouseDown(document.body);
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('moves between controls with the arrow keys, Home and End, with one Tab stop', () => {
        const controller = controllerWith();
        controller.setAnnotating(true);
        render(<WsiAnnotationToolbar controller={controller} />);
        const bar = byTestId('wsi-annotation-toolbar');
        const toggle = byTestId('annotation-mode-toggle');
        toggle.focus();
        fireEvent.keyDown(toggle, { key: 'ArrowRight' });
        expect(document.activeElement).toBe(byTestId('annotation-tool-select'));
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
        expect(document.activeElement).toBe(toggle);
        fireEvent.keyDown(toggle, { key: 'End' });
        expect(document.activeElement).toBe(
            byTestId('annotation-more-menu-button')
        );
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
        expect(document.activeElement).toBe(toggle);
        // Fields keep their own arrow keys.
        const label = byTestId('annotation-active-label');
        label.focus();
        fireEvent.keyDown(label, { key: 'ArrowLeft' });
        expect(document.activeElement).toBe(label);
        // One Tab stop: the control last focused; the others are -1.
        const stops = () =>
            Array.from(
                bar.querySelectorAll<HTMLElement>('[data-toolbar-item]')
            ).filter(item => item.tabIndex === 0);
        expect(stops()).toEqual([label]);
        act(() => toggle.focus());
        expect(stops()).toEqual([toggle]);
        // The tolerance's help is an info icon and the slider's description.
        act(() => controller.setTool('wand'));
        const tolerance = byTestId('annotation-tissue-tolerance');
        expect(
            document.getElementById(
                tolerance.getAttribute('aria-describedby')!
            )!.textContent
        ).toContain('How far a color may be from the clicked color');
        expect(byTestId('annotation-tissue-tolerance-info')).toBeTruthy();
        // Every control has an accessible name.
        bar.querySelectorAll('button').forEach(button =>
            expect(
                button.getAttribute('aria-label') || button.textContent
            ).toBeTruthy()
        );
    });

    it('shows the brush width only with the brush, and the point count only with points', () => {
        const controller = controllerWith();
        controller.setAnnotating(true);
        render(<WsiAnnotationToolbar controller={controller} />);
        expect(screen.queryByTestId('annotation-brush-width')).toBeNull();
        act(() => controller.setTool('brush'));
        expect(byTestId('annotation-brush-width')).toBeTruthy();
        expect(
            byTestId('annotation-tool-outline').getAttribute('aria-label')
        ).toBe('Outline: Brush (B)');
        act(() => controller.setTool('point'));
        expect(screen.queryByTestId('annotation-brush-width')).toBeNull();
        expect(byTestId('annotation-point-count').textContent).toBe('Point: 0');
    });

    it('draws as the chosen layer, in the layer color, which the swatch changes', () => {
        const controller = controllerWith([
            apiItem('m1', {
                layer_name: 'Model',
                color: '#dc2626',
                type: 'Model|#dc2626',
            }),
        ]);
        controller.setAnnotating(true);
        render(<WsiAnnotationToolbar controller={controller} />);
        const layer = byTestId('annotation-active-layer') as HTMLSelectElement;
        expect(Array.from(layer.options).map(o => o.value)).toEqual([
            'Default',
            'Model',
        ]);
        const swatch = byTestId('annotation-color-swatch');
        expect(swatch.getAttribute('aria-label')).toBe(
            'Color of layer Default: Default'
        );
        fireEvent.change(layer, { target: { value: 'Model' } });
        expect(controller.activeLayer).toBe('Model');
        expect(controller.activeColor).toBe('#dc2626');
        expect(swatch.getAttribute('aria-label')).toBe(
            'Color of layer Model: Model'
        );

        // A palette color becomes the layer's color.
        fireEvent.click(swatch);
        expect(swatch.getAttribute('aria-expanded')).toBe('true');
        const popover = screen.getByRole('dialog', {
            name: 'Color of layer Model',
        });
        expect(document.activeElement).toBe(byTestId('annotation-color-Model'));
        fireEvent.click(byTestId('annotation-color-Default'));
        expect(controller.activeColor).toBe('#3b82f6');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(swatch);
        expect(controller.layerColor('Model').hex).toBe('#3b82f6');
        expect(popover).toBeTruthy();

        // A custom color joins the palette and colors the layer.
        fireEvent.click(swatch);
        fireEvent.change(screen.getByLabelText('Custom annotation color'), {
            target: { value: '#00aa00' },
        });
        fireEvent.change(
            screen.getByLabelText('Custom annotation color name'),
            { target: { value: 'Stroma' } }
        );
        fireEvent.click(byTestId('save-annotation-color'));
        expect(controller.activeColorName).toBe('Stroma');
        expect(controller.layerColor('Model')).toEqual({
            name: 'Stroma',
            hex: '#00aa00',
        });

        // Escape closes the palette and returns focus to the swatch.
        fireEvent.click(swatch);
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(swatch);
    });

    it('offers sharing, export, import and the shortcuts in the ⋯ menu', async () => {
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
        render(<WsiAnnotationToolbar controller={controller} />);
        const more = byTestId('annotation-more-menu-button');
        expect(more.getAttribute('aria-label')).toBe('More annotation actions');
        expect(more.getAttribute('aria-haspopup')).toBe('menu');

        // Sharing of new annotations: a pair of radio items.
        fireEvent.click(more);
        const shared = byTestId('annotation-default-sharing-shared');
        expect(shared.getAttribute('role')).toBe('menuitemradio');
        expect(shared.getAttribute('aria-checked')).toBe('true');
        expect(document.activeElement).toBe(shared);
        fireEvent.click(byTestId('annotation-default-sharing-private'));
        expect(controller.defaultShared).toBe(false);
        expect(document.activeElement).toBe(more);
        fireEvent.click(more);
        expect(
            byTestId('annotation-default-sharing-private').getAttribute(
                'aria-checked'
            )
        ).toBe('true');

        fireEvent.click(byTestId('annotation-export-all'));
        expect(download).toHaveBeenCalledWith('all');
        fireEvent.click(more);
        expect(screen.queryByTestId('annotation-export-visible')).toBeNull();
        fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

        act(() => controller.toggleLayerVisibility('Stroma'));
        fireEvent.click(more);
        expect(byTestId('annotation-export-visible').textContent).toBe(
            'Export visible layers (1) as GeoJSON'
        );
        fireEvent.click(byTestId('annotation-export-visible'));
        expect(download).toHaveBeenLastCalledWith('visible');

        // Import… opens the file picker; the preview shows on the bar.
        const picker = byTestId('annotation-import-file') as HTMLInputElement;
        const pick = jest.spyOn(picker, 'click');
        fireEvent.click(more);
        fireEvent.click(byTestId('annotation-import'));
        expect(pick).toHaveBeenCalled();
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

        // The shortcut help opens from the menu and closes on Escape.
        fireEvent.click(more);
        fireEvent.click(byTestId('annotation-shortcuts'));
        const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
        expect(help.textContent).toContain('Freehand');
        expect(help.textContent).toContain('Ctrl+Shift+Z');
        fireEvent.keyDown(help, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(more);
    });

    it('undoes and redoes from the bar, naming the step', () => {
        const controller = controllerWith();
        controller.setAnnotating(true);
        const undo = jest.spyOn(controller, 'undo').mockResolvedValue(true);
        const redo = jest.spyOn(controller, 'redo').mockResolvedValue(true);
        render(<WsiAnnotationToolbar controller={controller} />);
        const undoButton = byTestId('annotation-undo') as HTMLButtonElement;
        const redoButton = byTestId('annotation-redo') as HTMLButtonElement;
        expect(undoButton.disabled).toBe(true);
        expect(undoButton.getAttribute('aria-label')).toBe(
            'Nothing to undo (Ctrl+Z)'
        );
        expect(redoButton.getAttribute('aria-label')).toBe(
            'Nothing to redo (Ctrl+Shift+Z)'
        );

        act(() => {
            runInAction(() => {
                controller.undoStack = [{ kind: 'create', ids: ['a', 'b'] }];
                controller.redoStack = [{ kind: 'update', before: {} as any }];
            });
        });
        expect(undoButton.getAttribute('aria-label')).toBe(
            'Undo create of 2 annotations (Ctrl+Z)'
        );
        expect(redoButton.getAttribute('title')).toBe(
            'Redo edit (Ctrl+Shift+Z or Ctrl+Y)'
        );
        fireEvent.click(undoButton);
        fireEvent.click(redoButton);
        expect(undo).toHaveBeenCalled();
        expect(redo).toHaveBeenCalled();
    });
});
