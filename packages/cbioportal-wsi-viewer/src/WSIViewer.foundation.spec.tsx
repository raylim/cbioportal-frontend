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

    describe('sample timeline', () => {
        function textOf(node: any): string {
            if (typeof node === 'string') {
                return node;
            }
            return (node?.children || []).map(textOf).join(' ');
        }

        function renderSelected(sampleTimelines?: Map<string, any>) {
            const slide = {
                ...testSlide('slide-a'),
                slide_timepoint_days: -242,
                slide_timepoint_source: 'Procedure date',
            };
            const instance = makeInstance(undefined, { sampleTimelines });
            action(() => {
                instance.hierarchy = hierarchyOf([slide]);
                instance.loading = false;
                instance.selectedSlide = slide;
                instance.selectedSample = instance.hierarchy.samples[0];
            })();
            return TestRenderer.create(instance.render());
        }

        it('shows the sample sequencing context in the list and pathology panel', () => {
            const rendered = renderSelected(
                new Map([['S-1', { acquisitionDays: -242, sequencingDays: 7 }]])
            );
            const sidebar = textOf(
                rendered.root.findByProps({
                    'data-testid': 'wsi-metadata-sidebar',
                })
            );
            expect(sidebar).toContain(
                'Timeline Procedure d-242 · acquired d-242 · sequenced d+7 (249 d later)'
            );

            expect(
                textOf(
                    rendered.root.findByProps({
                        'data-testid': 'wsi-sample-sequenced-S-1',
                    })
                )
            ).toBe('sequenced d+7');
            expect(
                textOf(
                    rendered.root.findByProps({
                        'data-testid': 'wsi-slide-item-slide-a',
                    })
                )
            ).toContain('Proc 249 d before sequencing');
        });

        it('keeps the patient-level display without timeline data', () => {
            const rendered = renderSelected();
            const sidebar = textOf(
                rendered.root.findByProps({
                    'data-testid': 'wsi-metadata-sidebar',
                })
            );
            expect(sidebar).toContain('Timeline Procedure d-242');
            expect(sidebar).not.toContain('sequenced');
            expect(
                textOf(
                    rendered.root.findByProps({
                        'data-testid': 'wsi-slide-item-slide-a',
                    })
                )
            ).toContain('Proc d-242');
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
});
