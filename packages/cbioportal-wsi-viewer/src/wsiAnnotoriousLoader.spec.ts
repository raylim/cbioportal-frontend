/**
 * @jest-environment jsdom
 */

import { createOSDAnnotator } from '@annotorious/openseadragon';
import { WsiAnnotationController } from './wsiAnnotationController';
import { getLoadedAnnotorious } from './wsiAnnotoriousLoader';

jest.mock('@annotorious/openseadragon', () => ({
    createOSDAnnotator: jest.fn(),
    W3CImageFormat: jest.fn(() => ({})),
}));

// Annotorious is not loaded until a controller attaches its first viewer.
describe('WsiAnnotationController before Annotorious loads', () => {
    function makeController() {
        const controller = new WsiAnnotationController(
            'https://tiles.example',
            's1',
            () => Promise.resolve('token')
        );
        (controller as any).slideKey = 'slide1';
        return controller;
    }

    beforeEach(() => {
        (createOSDAnnotator as jest.Mock).mockReset();
    });

    const annotator = {
        on: jest.fn(),
        destroy: jest.fn(),
        setVisible: jest.fn(),
        setAnnotations: jest.fn(),
        setFilter: jest.fn(),
        setStyle: jest.fn(),
        setDrawingEnabled: jest.fn(),
    };

    it('attaches only the latest viewer once the chunk resolves', async () => {
        expect(getLoadedAnnotorious()).toBeNull();
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        const controller = makeController();
        const replaced = { element: document.createElement('div') };
        const current = { element: document.createElement('div') };

        controller.attachViewer(replaced, {}, 'slide1');
        controller.attachViewer(current, {}, 'slide1');
        expect(createOSDAnnotator).not.toHaveBeenCalled();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(getLoadedAnnotorious()).not.toBeNull();
        expect(createOSDAnnotator).toHaveBeenCalledTimes(1);
        expect((createOSDAnnotator as jest.Mock).mock.calls[0][0]).toBe(
            current
        );
        expect((controller as any).annotorious).toBe(annotator);
        controller.detachViewer();
    });

    it('attaches synchronously once the chunk has loaded', () => {
        (createOSDAnnotator as jest.Mock).mockReturnValue(annotator);
        const controller = makeController();

        controller.attachViewer(
            { element: document.createElement('div') },
            {},
            'slide1'
        );

        expect(createOSDAnnotator).toHaveBeenCalledTimes(1);
        expect((controller as any).annotorious).toBe(annotator);
        controller.detachViewer();
        expect((controller as any).annotorious).toBeNull();
    });
});
