/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { action } from 'mobx';
import TestRenderer, { act } from 'react-test-renderer';
import WSIViewer, {
    WSI_METADATA_COLLAPSED_KEY,
    WSI_NAV_COLLAPSED_KEY,
} from './WSIViewer';

jest.mock('./wsiOpenSeadragonLoader', () => ({
    loadOpenSeadragon: jest.fn(),
}));

const hierarchy = {
    patient_id: 'P-1',
    samples: [
        {
            sample_id: 'S-1',
            parts: [
                {
                    part_number: '1',
                    blocks: [
                        {
                            block_number: '1',
                            block_label: 'A1',
                            slides: [
                                {
                                    slide_key: 'slide-a',
                                    stain_name: 'H&E',
                                    stain_group: 'H&E',
                                    is_hne: true,
                                    is_ihc: false,
                                    can_serve_tiles: true,
                                    block_label: 'A1',
                                    block_number: '1',
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

function makeViewer(extraProps: Record<string, unknown> = {}) {
    const instance = new (WSIViewer as any)({
        tileServerUrl: 'https://tiles.example.com',
        patientId: 'P-1',
        height: 500,
        ...extraProps,
    });
    instance.controller.forceResize = jest.fn();
    action(() => {
        instance.hierarchy = hierarchy;
        instance.loading = false;
    })();
    return instance;
}

function byTestId(instance: any, testId: string) {
    return TestRenderer.create(instance.render()).root.findAll(
        (node: any) => node.props['data-testid'] === testId
    );
}

describe('WSIViewer hideable panels', () => {
    beforeEach(() => {
        window.localStorage.clear();
        jest.spyOn(window, 'requestAnimationFrame').mockImplementation(
            (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            }
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('shows both panels with hide buttons by default', () => {
        const viewer = makeViewer();
        expect(byTestId(viewer, 'wsi-nav-hide').length).toBeGreaterThan(0);
        expect(byTestId(viewer, 'wsi-metadata-hide').length).toBeGreaterThan(0);
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(0);
        expect(byTestId(viewer, 'wsi-metadata-rail')).toHaveLength(0);
    });

    it('hides and restores the slide list, remembering the choice', () => {
        const viewer = makeViewer();
        act(() => viewer.hideNav());

        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(1);
        expect(byTestId(viewer, 'wsi-nav-hide')).toHaveLength(0);
        expect(window.localStorage.getItem(WSI_NAV_COLLAPSED_KEY)).toBe('1');
        expect(viewer.controller.forceResize).toHaveBeenCalled();
        // A new viewer, such as the next patient, opens with the list hidden.
        expect(byTestId(makeViewer(), 'wsi-nav-rail')).toHaveLength(1);

        act(() => viewer.showNav());
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(0);
        expect(window.localStorage.getItem(WSI_NAV_COLLAPSED_KEY)).toBeNull();
    });

    it('hides the details sidebar and its resize handle', () => {
        const viewer = makeViewer();
        act(() => viewer.hideMetadata());

        expect(byTestId(viewer, 'wsi-metadata-rail')).toHaveLength(1);
        expect(byTestId(viewer, 'wsi-metadata-sidebar')).toHaveLength(0);
        expect(byTestId(viewer, 'wsi-metadata-resize-handle')).toHaveLength(0);
        expect(window.localStorage.getItem(WSI_METADATA_COLLAPSED_KEY)).toBe(
            '1'
        );
        expect(viewer.controller.forceResize).toHaveBeenCalled();
    });

    it('renders expanded when browser storage is blocked', () => {
        jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const viewer = makeViewer();
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(0);

        act(() => viewer.hideNav());
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(1);
    });

    it('shows the slide count on the hidden slide list rail', () => {
        const viewer = makeViewer();
        act(() => viewer.hideNav());
        const rail = byTestId(viewer, 'wsi-nav-rail')[0];
        expect(
            rail.findAll((node: any) => node.children?.includes?.('1')).length
        ).toBeGreaterThan(0);
    });

    it("merges the host's hidden panels into the slide list rail", () => {
        const onExpand = jest.fn();
        const viewer = makeViewer({
            leadingRailSections: [
                {
                    title: 'Patients',
                    detail: '12',
                    expandLabel: 'Show patient list',
                    onExpand,
                    testId: 'host-rail',
                },
            ],
        });
        // Not shown while the slide list is open.
        expect(byTestId(viewer, 'host-rail')).toHaveLength(0);

        act(() => viewer.hideNav());
        const rail = byTestId(viewer, 'wsi-nav-rail')[0];
        const hostSection = rail.findAll(
            (node: any) => node.props['data-testid'] === 'host-rail'
        );
        expect(hostSection).toHaveLength(1);
        // A click anywhere on the section shows the host's panel.
        act(() => hostSection[0].props.onClick());
        expect(onExpand).toHaveBeenCalledTimes(1);
    });

    it("keeps the rail and the host's sections while slides load or fail", () => {
        const viewer = makeViewer({
            leadingRailSections: [
                {
                    title: 'Patients',
                    expandLabel: 'Show patient list',
                    onExpand: () => {},
                    testId: 'host-rail',
                },
            ],
        });
        act(() => viewer.hideNav());

        action(() => {
            viewer.loading = true;
        })();
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(1);
        expect(byTestId(viewer, 'host-rail')).toHaveLength(1);

        action(() => {
            viewer.loading = false;
            viewer.hierarchy = null;
            viewer.error = 'Slides could not be loaded';
        })();
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(1);
        expect(byTestId(viewer, 'host-rail')).toHaveLength(1);
    });

    it('toggles the panels with | and . unless the user is typing', () => {
        const viewer = makeViewer();
        const key = (k: string, target: unknown = document.body) =>
            act(() => viewer.handlePanelKey({ key: k, target } as any));

        key('|');
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(1);
        key('|');
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(0);

        key('.');
        expect(byTestId(viewer, 'wsi-metadata-rail')).toHaveLength(1);

        key('.', document.createElement('input'));
        expect(byTestId(viewer, 'wsi-metadata-rail')).toHaveLength(1);
    });

    it('ignores the panel keys while the host hides the viewer', () => {
        const viewer = makeViewer({ hidden: true });
        act(() =>
            viewer.handlePanelKey({ key: '|', target: document.body } as any)
        );
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(0);
    });

    it('follows the host when the hidden state is controlled', () => {
        window.localStorage.setItem(WSI_NAV_COLLAPSED_KEY, '1');
        const onNavCollapsedChange = jest.fn();
        const viewer = makeViewer({
            navCollapsed: false,
            onNavCollapsedChange,
        });
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(0);

        act(() => viewer.hideNav());
        expect(onNavCollapsedChange).toHaveBeenCalledWith(true);
        // The host decides; the stored choice is not touched.
        expect(byTestId(viewer, 'wsi-nav-rail')).toHaveLength(0);
        expect(window.localStorage.getItem(WSI_NAV_COLLAPSED_KEY)).toBe('1');
    });
});

describe('WSIViewer list filters in the URL', () => {
    beforeEach(() => {
        window.history.replaceState(null, '', '/patient?caseId=P-1');
    });

    it('opens with the filters from a shared link', () => {
        window.location.hash = 'wsi:slide=slide-a&stain=ihc&match=block';
        const viewer = makeViewer({ initialStainFilter: 'hne' });
        expect(viewer.stainFilter).toBe('ihc');
        expect(viewer.matchFilter).toBe('block');
    });

    it('writes filter changes to the hash, keeping the slide', () => {
        window.location.hash = 'wsi:slide=slide-a';
        const viewer = makeViewer();
        // Only the URL sync is under test; don't load slides.
        viewer.controller.loadHierarchy = jest.fn();
        viewer.controller.dispose = jest.fn();
        viewer.controller.selectSlide = jest.fn(async () => undefined);
        viewer.controller.clearSelectedSlide = jest.fn();
        viewer.componentDidMount();
        try {
            act(() => viewer.handleFilterChange('hne'));
            expect(window.location.hash).toBe('#wsi:slide=slide-a&stain=hne');
            act(() => viewer.handleFilterChange('all'));
            expect(window.location.hash).toBe('#wsi:slide=slide-a');
        } finally {
            viewer.componentWillUnmount();
        }
    });

    it('keeps its filters while hidden or when the hash is not its own', () => {
        window.location.hash = 'wsi:slide=slide-a&stain=ihc';
        const hidden = makeViewer({ hidden: true });
        hidden.controller.selectSlide = jest.fn(async () => undefined);
        expect(hidden.stainFilter).toBe('ihc');
        window.location.hash = 'wsi:slide=slide-a';
        act(() => hidden.handleHashChange());
        expect(hidden.stainFilter).toBe('ihc');

        window.location.hash = 'wsi:slide=slide-a&stain=ihc';
        const shown = makeViewer();
        shown.controller.selectSlide = jest.fn(async () => undefined);
        window.location.hash = 'summary';
        act(() => shown.handleHashChange());
        expect(shown.stainFilter).toBe('ihc');
    });

    it('leaves the hash alone when it switches patients', () => {
        window.location.hash = 'wsi:slide=slide-a&x=1&y=2&z=1.000000';
        const viewer = makeViewer();
        viewer.controller.dispose();
        expect(window.location.hash).toBe(
            '#wsi:slide=slide-a&x=1&y=2&z=1.000000'
        );
    });

    it('takes the filters back from the hash after Back or Forward', () => {
        const viewer = makeViewer();
        window.location.hash = 'wsi:slide=slide-a&match=unmatched';
        act(() => viewer.applyFiltersFromHash());
        expect(viewer.matchFilter).toBe('unmatched');
        expect(viewer.stainFilter).toBe('all');
    });
});
