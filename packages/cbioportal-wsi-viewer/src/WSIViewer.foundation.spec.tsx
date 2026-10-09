/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { action } from 'mobx';
import TestRenderer from 'react-test-renderer';
import WSIViewer from './WSIViewer';
import { makeHierarchy, makeSample, makeSlide } from './wsiTestFixtures';
import { Slide } from './wsiViewerTypes';

jest.mock('./wsiOpenSeadragonLoader', () => ({
    loadOpenSeadragon: jest.fn(),
}));

function makeInstance(
    url = 'https://tiles.example.com/patient/P-1',
    extraProps: Record<string, unknown> = {}
) {
    return new (WSIViewer as any)({
        tileServerUrl: url.replace(/\/patient\/[^/]+\/?$/, ''),
        patientId: 'P-1',
        height: 500,
        ...extraProps,
    });
}

function testSlide(slide_key: string, can_serve_tiles = true) {
    return makeSlide({ slide_key, can_serve_tiles });
}

function hierarchyOf(slides: Slide[]) {
    return makeHierarchy([makeSample('S-1', slides)]);
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

    describe('requested slideKey', () => {
        const slides = () => [
            testSlide('slide-a'),
            testSlide('slide id/b #2'),
            testSlide('slide-c'),
        ];

        function loadedInstance(requestedSlideKey?: string) {
            const instance = makeInstance(undefined, { requestedSlideKey });
            action(() => {
                instance.hierarchy = hierarchyOf(slides());
                instance.loading = false;
            })();
            return instance;
        }

        it('selects the requested slide, including encoded IDs', () => {
            const instance = loadedInstance('slide id/b #2');

            expect(
                instance.chooseInitialServableSlide(instance.servableSlides)
                    .slide.slide_key
            ).toBe('slide id/b #2');
            expect(instance.requestedSlideUnavailable).toBe(false);
        });

        it('lets a hash selection win over the requested slide', () => {
            const instance = loadedInstance('slide id/b #2');
            window.location.hash = '#wsi:slide=slide-c&x=10&y=20&z=1';

            expect(
                instance.chooseInitialServableSlide(instance.servableSlides)
                    .slide.slide_key
            ).toBe('slide-c');
        });

        it('shows a notice and the default slide for an unknown ID', () => {
            const instance = loadedInstance('missing-slide');

            expect(
                instance.chooseInitialServableSlide(instance.servableSlides)
                    .slide.slide_key
            ).toBe('slide-a');
            expect(instance.requestedSlideUnavailable).toBe(true);
            const rendered = TestRenderer.create(instance.render());
            const notice = rendered.root.findByProps({
                'data-testid': 'wsi-requested-slide-unavailable',
            });
            expect(notice.findByType('span').children.join('')).toContain(
                'The requested slide is not available'
            );
        });

        it('treats a non-servable requested slide as unavailable', () => {
            const instance = makeInstance(undefined, {
                requestedSlideKey: 'slide-x',
            });
            action(() => {
                instance.hierarchy = hierarchyOf([
                    testSlide('slide-a'),
                    testSlide('slide-x', false),
                ]);
            })();

            expect(instance.requestedSlideUnavailable).toBe(true);
        });

        it('shows no notice without a requested slide', () => {
            expect(loadedInstance().requestedSlideUnavailable).toBe(false);
        });
    });

    describe('linked sample scope', () => {
        function scopedInstance(pathologyFilter?: Record<string, string>) {
            const instance = makeInstance(undefined, { pathologyFilter });
            action(() => {
                instance.hierarchy = hierarchyOf([testSlide('slide-a')]);
                instance.loading = false;
            })();
            return instance;
        }

        it('scopes the slide list to a sample-only link', () => {
            const instance = scopedInstance({ sampleId: 'S-1' });
            expect(instance.scopedSampleId).toBe('S-1');
            const rendered = TestRenderer.create(instance.render());
            expect(
                rendered.root.findAllByProps({
                    'data-testid': 'wsi-sample-scope',
                })
            ).toHaveLength(1);
        });

        it('does not hide other samples for a specimen or match-level link', () => {
            expect(
                scopedInstance({ sampleId: 'S-1', matchLevel: 'PART' })
                    .scopedSampleId
            ).toBeUndefined();
            expect(
                scopedInstance({ sampleId: 'S-1', specimenKey: 'part::1' })
                    .scopedSampleId
            ).toBeUndefined();
            expect(scopedInstance().scopedSampleId).toBeUndefined();
        });

        it('drops the scope once the link scope is cleared', () => {
            const instance = scopedInstance({ sampleId: 'S-1' });
            action(() => {
                instance.linkoutScopeActive = false;
            })();
            expect(instance.scopedSampleId).toBeUndefined();
        });
    });

    it('sends the slide key as slide_id and never an image ID, barcode or source', async () => {
        const slideKey = '0123456789abcdef0123456789abcdef';
        const instance = makeInstance('https://tiles.example.com/patient/P-1', {
            studyId: 'coad_msk_2025',
        });
        const slide = {
            ...testSlide(slideKey),
            image_id: 'leaked-image-id',
            barcode: 'S00-12345 A1',
        };
        instance.hierarchy = hierarchyOf([slide]);
        instance.selectedSlide = slide;
        instance.selectedSample = instance.hierarchy.samples[0];
        instance.selectedMeta = {
            dimensions: { width: 1000, height: 800 },
            levels: 2,
            level_dimensions: [
                { width: 1000, height: 800 },
                { width: 500, height: 400 },
            ],
            max_zoom: 10,
            tile_size: 256,
            source: 's3://bucket/leaked-image-id.svs',
            image_id: 'leaked-image-id',
        };
        instance.controller = {
            captureAgentViewportAfterDraw: jest.fn(async () => ({
                source_fingerprint: `wsi-v3:${slideKey}:1000x800:2:256`,
                capture_id: 'capture-a',
                viewer_generation: 1,
            })),
        } as any;

        const context = await (instance as any).getAgentContext();

        expect(context.slide_id).toBe(slideKey);
        expect(context.embedding_context.slide_ids).toEqual([slideKey]);
        expect(context).not.toHaveProperty('slide_key');
        expect(context.slide_metadata).toEqual({
            dimensions: { width: 1000, height: 800 },
            levels: 2,
            level_dimensions: [
                { width: 1000, height: 800 },
                { width: 500, height: 400 },
            ],
            max_zoom: 10,
            tile_size: 256,
        });
        const serialized = JSON.stringify(context);
        expect(serialized).not.toMatch(/image_?id|barcode|s3:/i);
        expect(serialized).not.toContain('leaked-image-id');
        expect(serialized).not.toContain('S00-12345');
    });

    it('applies approved viewer navigation actions through the controller', async () => {
        const instance = makeInstance();
        const slideA = testSlide('slide-a');
        const slideB = testSlide('slide-b');
        instance.hierarchy = hierarchyOf([slideA, slideB]);
        instance.selectedSlide = slideA;
        instance.selectedSample = instance.hierarchy.samples[0];
        instance.selectedMeta = { dimensions: { width: 1000, height: 800 } };
        const controller = {
            selectSlideAndWait: jest.fn(async (slide: any) => {
                instance.selectedSlide = slide;
                return { status: 'ready', slideKey: slide.slide_key };
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

        expect(controller.selectSlideAndWait).toHaveBeenCalledWith(
            slideB,
            instance.hierarchy.samples[0]
        );
        expect(controller.goToCoordinates).toHaveBeenCalledWith(40, 50);
        expect(controller.setZoom).toHaveBeenCalledWith(2);
    });

    it('does not report navigation success when slide readiness fails', async () => {
        const instance = makeInstance();
        const slideA = testSlide('slide-a');
        const slideB = testSlide('slide-b');
        instance.hierarchy = hierarchyOf([slideA, slideB]);
        instance.selectedSlide = slideA;
        instance.selectedSample = instance.hierarchy.samples[0];
        instance.selectedMeta = { dimensions: { width: 1000, height: 800 } };
        const controller = {
            selectSlideAndWait: jest.fn(async () => ({
                status: 'failed',
                slideKey: 'slide-b',
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
        const slideA = testSlide('slide-a');
        const slideB = testSlide('slide-b');
        instance.hierarchy = hierarchyOf([slideA, slideB]);
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
