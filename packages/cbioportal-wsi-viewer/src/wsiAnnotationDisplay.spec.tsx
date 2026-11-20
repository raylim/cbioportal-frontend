/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createOSDAnnotator } from '@annotorious/openseadragon';
import {
    DEFAULT_FILL_OPACITY,
    WsiAnnotationController,
} from './wsiAnnotationController';
import { loadAnnotorious } from './wsiAnnotoriousLoader';
import { WsiAnnotationLayersPanel } from './wsiAnnotationControls';
import { WsiAnnotationToolbar } from './wsiAnnotationToolbar';
import { WsiAnnotationOverlay } from './wsiAnnotationOverlay';
import { placeSlideLabels, SLIDE_LABEL_LIMIT } from './wsiAnnotationSpatial';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

const SLIDE_KEY = '0123456789ab';

function row(
    id: string,
    layer: string,
    xywh: string,
    label = `Label ${id}`,
    selector?: string
) {
    return {
        id,
        body: {
            label,
            comment: '',
            layer_name: layer,
            color: '#ef4444',
            type: `${layer}|#ef4444`,
            provenance: null,
        },
        target: {
            selector: selector
                ? { type: 'SvgSelector', value: selector }
                : { type: 'FragmentSelector', value: `xywh=pixel:${xywh}` },
        },
        version: 1,
        created_by: 'user',
    };
}

/** A controller with three layers' annotations, attached to a stand-in viewer. */
function setup() {
    const annotator = {
        on: jest.fn(),
        setVisible: jest.fn(),
        setAnnotations: jest.fn(),
        setStyle: jest.fn(),
        setUserSelectAction: jest.fn(),
        cancelDrawing: jest.fn(),
        setDrawingEnabled: jest.fn(),
        cancelSelected: jest.fn(),
    };
    (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
    const controller = new WsiAnnotationController(
        'https://tiles.example',
        'study1'
    );
    (controller as any).slideKey = SLIDE_KEY;
    (controller as any).annotations = [
        row('big', 'Tumor', '0,0,400,200', 'Tumor region'),
        row('small', 'Tumor', '1000,1000,20,20', 'Tiny'),
        row('overlap', 'Stroma', '10,10,300,100', 'Stroma band'),
        row('far', 'Stroma', '600,0,200,200', 'Stroma far'),
        row(
            'pt',
            'Default',
            '',
            'Mitosis',
            '<svg><circle cx="50" cy="50" r="0" /></svg>'
        ),
    ].map(item => (controller as any).fromApi(item, SLIDE_KEY));
    const element = document.createElement('div');
    controller.attachViewer(
        { element, addHandler: jest.fn(), removeHandler: jest.fn() },
        {},
        SLIDE_KEY
    );
    // One screen pixel per image pixel.
    jest.spyOn(
        controller as any,
        'screenPoint'
    ).mockImplementation((point: any) => ({ x: point.x, y: point.y }));
    const press = (key: string, init: KeyboardEventInit = {}) =>
        act(() => {
            document.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    bubbles: true,
                    cancelable: true,
                    ...init,
                })
            );
        });
    return { controller, annotator, press };
}

describe('Display controls', () => {
    beforeAll(() => loadAnnotorious());
    let detach: Array<() => void> = [];
    beforeEach(() => {
        jest.restoreAllMocks();
        window.localStorage.clear();
    });
    afterEach(() => {
        detach.forEach(run => run());
        detach = [];
    });
    const attached = () => {
        const result = setup();
        detach.push(() => result.controller.detachViewer());
        return result;
    };
    const lastStyle = (annotator: any) =>
        annotator.setStyle.mock.calls[
            annotator.setStyle.mock.calls.length - 1
        ][0];

    it('sets the fill opacity and outlines-only on the shapes, and remembers them', () => {
        const { controller, annotator } = attached();
        const shape = controller.annotations[0];
        expect(lastStyle(annotator)(shape).fillOpacity).toBe(
            DEFAULT_FILL_OPACITY
        );
        controller.setFillOpacity(0.55);
        expect(lastStyle(annotator)(shape)).toMatchObject({
            fillOpacity: 0.55,
            stroke: '#ef4444',
        });
        controller.setOutlineOnly(true);
        expect(lastStyle(annotator)(shape).fillOpacity).toBe(0);
        controller.setShowSlideLabels(true);

        const next = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        expect(next.fillOpacity).toBe(0.55);
        expect(next.outlineOnly).toBe(true);
        expect(next.showSlideLabels).toBe(true);
        // Hiding all is not remembered.
        controller.toggleHideAll();
        expect(
            new WsiAnnotationController('https://tiles.example', 'study1')
                .hideAll
        ).toBe(false);

        jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const blocked = new WsiAnnotationController(
            'https://tiles.example',
            'study1'
        );
        expect(blocked.fillOpacity).toBe(DEFAULT_FILL_OPACITY);
        expect(() => blocked.setFillOpacity(0.3)).not.toThrow();
        expect(blocked.fillOpacity).toBe(0.3);
    });

    it('hides all annotations with H, Annotate on or off, but not while typing', () => {
        const { controller, annotator, press } = attached();
        expect(controller.annotating).toBe(false);
        press('h');
        expect(controller.hideAll).toBe(true);
        expect(annotator.setVisible).toHaveBeenLastCalledWith(false);
        // The list still lists them.
        expect(controller.listedAnnotations).toHaveLength(5);
        controller.setAnnotating(true);
        press('H');
        expect(controller.hideAll).toBe(false);
        expect(annotator.setVisible).toHaveBeenLastCalledWith(true);

        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'h', bubbles: true })
        );
        input.remove();
        press('h', { ctrlKey: true });
        expect(controller.hideAll).toBe(false);
    });

    it('shows one layer alone, and the layers hidden before when it ends', () => {
        const { controller } = attached();
        controller.toggleLayerVisibility('Default');
        controller.toggleSoloLayer('Tumor');
        expect(controller.soloLayer).toBe('Tumor');
        expect(controller.shownAnnotations.map(item => item.id)).toEqual([
            'big',
            'small',
        ]);
        // Another layer alone instead; ending it restores the start.
        controller.toggleSoloLayer('Stroma');
        expect(controller.shownAnnotations.map(item => item.id)).toEqual([
            'overlap',
            'far',
        ]);
        controller.toggleSoloLayer('Stroma');
        expect(controller.soloLayer).toBeNull();
        expect(Array.from(controller.hiddenLayerNames)).toEqual(['Default']);

        // Showing a layer by hand ends showing one alone.
        controller.toggleSoloLayer('Tumor');
        controller.toggleLayerVisibility('Stroma');
        expect(controller.soloLayer).toBeNull();
        expect(controller.hiddenLayerNames.has('Stroma')).toBe(false);
    });

    it('places labels at large enough shapes without overlaps, and not when hidden', () => {
        const { controller } = attached();
        expect(controller.slideLabels).toEqual([]);
        controller.setShowSlideLabels(true);
        const labels = controller.slideLabels;
        // The largest first; "Stroma band" would overlap "Tumor region";
        // "Tiny" is too small; points get none.
        expect(labels.map(label => label.text)).toEqual([
            'Tumor region',
            'Stroma far',
        ]);
        expect(labels[0]).toMatchObject({ x: 2, y: 2 });
        controller.toggleHideAll();
        expect(controller.slideLabels).toEqual([]);
        controller.toggleHideAll();
        controller.toggleLayerVisibility('Tumor');
        expect(controller.slideLabels.map(label => label.text)).toEqual([
            'Stroma far',
            'Stroma band',
        ]);
    });

    it('draws the labels over the slide, and keeps them out of the GeoJSON', () => {
        const { controller } = attached();
        const before = JSON.stringify(controller.exportGeoJson('all'));
        render(<WsiAnnotationOverlay controller={controller} />);
        act(() => controller.setShowSlideLabels(true));
        const label = screen.getByTestId('annotation-slide-label-big');
        expect(label.textContent).toBe('Tumor region');
        expect(label.querySelector('text')!.getAttribute('fill')).toBe('#fff');
        expect(
            screen.getByTestId('annotation-overlay').getAttribute('aria-hidden')
        ).toBe('true');
        expect(JSON.stringify(controller.exportGeoJson('all'))).toBe(before);
    });

    it('caps and shortens labels', () => {
        const many = Array.from({ length: 400 }, (_, i) => ({
            id: `a${i}`,
            text: i === 0 ? 'x'.repeat(80) : `L${i}`,
            box: {
                x: (i % 20) * 100,
                y: Math.floor(i / 20) * 40,
                width: 50,
                height: 30,
            },
        }));
        const placed = placeSlideLabels(many, null);
        expect(placed).toHaveLength(SLIDE_LABEL_LIMIT);
        const long = placed.find(label => label.id === 'a0')!;
        expect(long.text).toHaveLength(40);
        expect(long.text.endsWith('…')).toBe(true);
        // Off screen is left out.
        expect(
            placeSlideLabels(
                [
                    {
                        id: 'off',
                        text: 'Off',
                        box: { x: 900, y: 0, width: 50, height: 50 },
                    },
                ],
                { width: 800, height: 600 }
            )
        ).toEqual([]);
    });

    it('opens the Display popover from the toolbar, Annotate on or off', () => {
        const { controller } = attached();
        render(
            <>
                <WsiAnnotationToolbar controller={controller} />
                <WsiAnnotationLayersPanel controller={controller} />
            </>
        );
        const button = screen.getByTestId('annotation-display-button');
        expect(button.getAttribute('aria-haspopup')).toBe('dialog');
        fireEvent.click(button);
        const popover = screen.getByRole('dialog', { name: 'Display' });
        const slider = screen.getByLabelText(
            'Fill opacity'
        ) as HTMLInputElement;
        expect(document.activeElement).toBe(slider);
        expect(slider.value).toBe('20');
        fireEvent.change(slider, { target: { value: '65' } });
        expect(controller.fillOpacity).toBe(0.65);
        expect(slider.getAttribute('aria-valuetext')).toBe('65%');
        fireEvent.click(screen.getByTestId('annotation-outline-only'));
        expect(controller.outlineOnly).toBe(true);
        expect(slider.disabled).toBe(true);
        fireEvent.click(screen.getByTestId('annotation-slide-labels'));
        expect(controller.showSlideLabels).toBe(true);
        fireEvent.click(screen.getByTestId('annotation-hide-all'));
        expect(controller.hideAll).toBe(true);
        expect(button.getAttribute('aria-label')).toBe(
            'Display (annotations hidden)'
        );

        // Solo from a layer row; ended from the popover.
        fireEvent.click(screen.getByTestId('layer-solo-Stroma'));
        expect(
            screen.getByTestId('layer-solo-Stroma').getAttribute('aria-pressed')
        ).toBe('true');
        expect(screen.getByTestId('annotation-solo-status').textContent).toBe(
            'Showing only layer Stroma. Show all layers'
        );
        fireEvent.click(screen.getByTestId('annotation-solo-end'));
        expect(controller.soloLayer).toBeNull();

        fireEvent.keyDown(popover, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Display' })).toBeNull();
        expect(document.activeElement).toBe(button);
    });

    it('lists H in the shortcut help', () => {
        const { controller } = attached();
        render(<WsiAnnotationToolbar controller={controller} />);
        fireEvent.click(screen.getByTestId('annotation-more-menu-button'));
        fireEvent.click(screen.getByTestId('annotation-shortcuts'));
        expect(
            screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
                .textContent
        ).toContain('Hide or show all annotations on the slide');
    });
});
