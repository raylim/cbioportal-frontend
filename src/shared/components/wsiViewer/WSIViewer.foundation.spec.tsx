/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { action } from 'mobx';
import TestRenderer from 'react-test-renderer';
import WSIViewer from './WSIViewer';
import { readWsiHashState } from './wsiViewStateUtils';

jest.mock('./wsiOpenSeadragonLoader', () => ({
    loadOpenSeadragon: jest.fn(),
    hasPreloadedOpenSeadragon: () => false,
}));

function makeInstance(url = 'https://tiles.example.com/patient/P-1') {
    return new (WSIViewer as any)({
        tileServerUrl: url.replace(/\/patient\/[^/]+\/?$/, ''),
        hierarchyUrl: `/api/wsi/v2/hierarchy/study/P-1`,
        patientId: 'P-1',
        height: 500,
    });
}

function makeSlide(image_id: string, can_serve_tiles = true): any {
    return {
        image_id,
        stain_name: 'H&E',
        stain_group: 'Histology',
        is_hne: true,
        is_ihc: false,
        magnification: '20x',
        file_size_bytes: '1000',
        can_serve_tiles,
        barcode: `${image_id}-barcode`,
        block_label: 'A1',
        block_number: '1',
    };
}

function makeHierarchy(slides: any[]): any {
    return {
        patient_id: 'P-1',
        samples: [
            {
                sample_id: 'S-1',
                cancer_type: 'Colon Cancer',
                cancer_type_detailed: 'Colon Adenocarcinoma',
                oncotree_code: 'COAD',
                primary_site: 'Colon',
                sample_type: 'Primary',
                parts: [
                    {
                        part_number: '1',
                        part_designator: 'A',
                        part_type: 'Resection',
                        part_description: 'Colon',
                        subspecialty: 'GI',
                        path_dx_title: 'Adenocarcinoma',
                        blocks: [
                            {
                                block_number: '1',
                                block_label: 'A1',
                                slides,
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

describe('WSIViewer foundation behavior', () => {
    afterEach(() => {
        window.location.hash = '';
    });

    it.each([
        [
            'removes a patient suffix',
            'https://tiles.example.com/patient/P-1',
            'https://tiles.example.com',
        ],
        [
            'preserves a path prefix',
            'https://tiles.example.com/api/v1/patient/P-1/',
            'https://tiles.example.com/api/v1',
        ],
        [
            'leaves an unscoped URL unchanged',
            'https://tiles.example.com',
            'https://tiles.example.com',
        ],
    ])('%s', (_name, url, expected) => {
        expect(makeInstance(url as string).tileServerBase).toBe(expected);
    });

    it('flattens only servable slides and removes duplicate image IDs', () => {
        const instance = makeInstance();
        const slide = makeSlide('slide-a');
        instance.hierarchy = makeHierarchy([
            slide,
            { ...slide },
            makeSlide('slide-b', false),
        ]);

        expect(
            instance.servableSlides.map((entry: any) => entry.slide.image_id)
        ).toEqual(['slide-a']);
        expect(instance.servableSlides[0].sample.sample_id).toBe('S-1');
    });

    it('returns an empty slide list before hierarchy data is loaded', () => {
        expect(makeInstance().servableSlides).toEqual([]);
    });

    it('renders loading and failure states without a hierarchy', () => {
        const instance = makeInstance();
        expect(
            TestRenderer.create(instance.render()).root.findByType('div')
        ).toBeTruthy();

        action(() => {
            instance.loading = false;
            instance.error = 'Hierarchy unavailable';
        })();
        const error = TestRenderer.create(instance.render());
        expect(error.root.findByType('div').children.join('')).toContain(
            'Hierarchy unavailable'
        );
    });

    it('parses a deep-link hash for a slide and viewport', () => {
        window.location.hash = '#wsi:slide=slide-a&x=120&y=240&z=3';
        expect(readWsiHashState()).toEqual({
            slideId: 'slide-a',
            x: 120,
            y: 240,
            z: 3,
        });
    });

    it('rejects unrelated or incomplete hashes', () => {
        window.location.hash = '#other=value';
        expect(readWsiHashState()).toBeNull();
        window.location.hash = '#wsi:slide=slide-a&x=bad&y=2&z=1';
        expect(readWsiHashState()).toBeNull();
    });

    it('applies approved viewer navigation actions through the controller', async () => {
        const instance = makeInstance();
        const slideA = makeSlide('slide-a');
        const slideB = makeSlide('slide-b');
        instance.hierarchy = makeHierarchy([slideA, slideB]);
        instance.selectedSlide = slideA;
        instance.selectedSample = instance.hierarchy.samples[0];
        instance.selectedMeta = { dimensions: { width: 1000, height: 800 } };
        const controller = {
            selectSlide: jest.fn(async (slide: any) => {
                instance.selectedSlide = slide;
                return { status: 'ready', slideId: slide.image_id };
            }),
            goToCoordinates: jest.fn(() => true),
            setZoom: jest.fn(() => true),
            captureAgentViewportAfterDraw: jest.fn(async () => ({
                slide_width: 1000,
                slide_height: 800,
                source_fingerprint: 'source-a',
                capture_id: 'capture-a',
                viewer_generation: 1,
            })),
        };
        instance.controller = controller as any;
        const context = {
            study_id: 'study-a',
            patient_id: 'P-1',
            slide_id: 'slide-a',
            filters: {},
            slide_metadata: {},
            patient_context: {},
            existing_annotations: [],
            viewport: {
                slide_width: 1000,
                slide_height: 800,
                source_fingerprint: 'source-a',
                capture_id: 'capture-a',
                viewer_generation: 1,
            },
        };
        (instance as any).getAgentContext = jest
            .fn()
            .mockResolvedValue(context);

        const proposal = (
            action: string,
            parameters: Record<string, unknown>
        ) => ({
            id: `proposal-${action}`,
            session_id: 'session-a',
            action_type: 'viewer_action',
            study_id: 'study-a',
            slide_id: 'slide-a',
            payload: {
                action,
                parameters,
                context: {
                    study_id: 'study-a',
                    patient_id: 'P-1',
                    slide_id: 'slide-a',
                    viewport: {
                        source_fingerprint: 'source-a',
                        viewer_generation: 1,
                    },
                },
            },
            status: 'pending',
            created_at: new Date().toISOString(),
        });

        await expect(
            (instance as any).applyAgentProposal(
                proposal('select_slide', { slide_id: 'slide-b' })
            )
        ).resolves.toMatchObject({ success: true });
        await expect(
            (instance as any).applyAgentProposal(
                proposal('go_to_coordinates', { x: 40, y: 50 })
            )
        ).resolves.toMatchObject({ success: true });
        await expect(
            (instance as any).applyAgentProposal(proposal('zoom', { zoom: 2 }))
        ).resolves.toMatchObject({ success: true });

        expect(controller.selectSlide).toHaveBeenCalledWith(
            slideB,
            instance.hierarchy.samples[0]
        );
        expect(controller.goToCoordinates).toHaveBeenCalledWith(40, 50);
        expect(controller.setZoom).toHaveBeenCalledWith(2);
    });

    it('does not report navigation success when slide readiness fails', async () => {
        const instance = makeInstance();
        const slideA = makeSlide('slide-a');
        const slideB = makeSlide('slide-b');
        instance.hierarchy = makeHierarchy([slideA, slideB]);
        instance.selectedSlide = slideA;
        instance.selectedSample = instance.hierarchy.samples[0];
        instance.selectedMeta = { dimensions: { width: 1000, height: 800 } };
        const controller = {
            selectSlide: jest.fn(async () => ({
                status: 'failed',
                slideId: 'slide-b',
                detail: 'Metadata failed',
            })),
        };
        instance.controller = controller as any;
        (instance as any).getAgentContext = jest.fn().mockResolvedValue({
            study_id: 'study-a',
            patient_id: 'P-1',
            slide_id: 'slide-a',
            filters: {},
            slide_metadata: {},
            patient_context: {},
            existing_annotations: [],
            viewport: {
                slide_width: 1000,
                slide_height: 800,
                source_fingerprint: 'source-a',
                capture_id: 'capture-a',
                viewer_generation: 1,
            },
        });
        const proposal = {
            id: 'proposal-failed',
            session_id: 'session-a',
            action_type: 'viewer_action',
            study_id: 'study-a',
            slide_id: 'slide-a',
            payload: {
                action: 'select_slide',
                parameters: { slide_id: 'slide-b' },
                context: {
                    study_id: 'study-a',
                    patient_id: 'P-1',
                    slide_id: 'slide-a',
                    viewport: {
                        source_fingerprint: 'source-a',
                        viewer_generation: 1,
                    },
                },
            },
            status: 'pending',
            created_at: new Date().toISOString(),
        };

        await expect(
            (instance as any).applyAgentProposal(proposal)
        ).resolves.toEqual({ success: false, detail: 'Metadata failed' });
    });

    it('rejects a viewport captured after the selected slide changes', async () => {
        const instance = makeInstance();
        const slideA = makeSlide('slide-a');
        const slideB = makeSlide('slide-b');
        instance.hierarchy = makeHierarchy([slideA, slideB]);
        instance.selectedSlide = slideA;
        instance.selectedSample = instance.hierarchy.samples[0];
        instance.selectedMeta = { dimensions: { width: 1000, height: 800 } };
        let resolveCapture!: (viewport: any) => void;
        instance.controller = {
            captureAgentViewportAfterDraw: jest.fn(
                () => new Promise(resolve => (resolveCapture = resolve))
            ),
        } as any;

        const contextPromise = (instance as any).getAgentContext();
        instance.selectedSlide = slideB;
        resolveCapture({
            slide_width: 1000,
            slide_height: 800,
            source_fingerprint: 'source-a',
            capture_id: 'capture-a',
            viewer_generation: 1,
        });

        await expect(contextPromise).resolves.toBeNull();
    });
});
