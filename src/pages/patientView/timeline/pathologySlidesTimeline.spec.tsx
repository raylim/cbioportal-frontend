/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { Portal } from 'react-overlays';
import {
    configureTracks,
    TimelineEvent,
    TimelineTrackSpecification,
} from 'cbioportal-clinical-timeline';
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import SampleManager from 'pages/patientView/SampleManager';
import { buildBaseConfig, sortTracks } from './timeline_helpers';
import { configureWsiViewerRuntime } from 'cbioportal-wsi-viewer';
import {
    loadPathologySlideEvents,
    pathologySlideGroupMarker,
    pathologySlideMarkerSample,
    pathologySlidesTrackConfig,
    UNMATCHED_MARKER_COLOR,
} from './pathologySlidesTimeline';
import { ISampleMetaDeta } from './TimelineWrapper';

function event(
    eventType: string,
    days: number,
    attributes: Record<string, string>
): ClinicalEvent {
    return {
        eventType,
        startNumberOfDaysSinceDiagnosis: days,
        attributes: Object.entries(attributes).map(([key, value]) => ({
            key,
            value,
        })),
    } as ClinicalEvent;
}

// react-router 5 typings predate React 18's implicit-children removal.
const TestRouter = MemoryRouter as React.ComponentType<
    React.PropsWithChildren<{ initialEntries: string[] }>
>;
const TestPortal = (Portal as unknown) as React.ComponentType<
    React.PropsWithChildren<{ container: HTMLElement }>
>;

const SAMPLE = 'P-0000081-T02-IM6';
const LINKOUT =
    '/patient/wsiHESlides?studyId=mskimpact&caseId=P-0000081&stainFilter=hne&matchLevel=PART&sampleId=P-0000081-T02-IM6';

function slide(attributes: Record<string, string>, days = 920) {
    return event('PATHOLOGY SLIDES', days, {
        SAMPLE_ID: SAMPLE,
        SUBTYPE: 'H&E',
        MATCH_LEVEL: 'PART',
        SPECIMEN: 'Part 1',
        IMAGE_COUNT: '1',
        NON_SERVABLE_IMAGE_COUNT: '0',
        TOTAL_IMAGE_COUNT: '1',
        IMAGE_IDS: '["496610"]',
        LINKOUT,
        ...attributes,
    });
}

const CASE_META: ISampleMetaDeta = {
    color: { [SAMPLE]: '#ff0000', 'P-0000081-T01-IM3': '#0000ff' },
    label: { [SAMPLE]: '2', 'P-0000081-T01-IM3': '1' },
    index: { [SAMPLE]: 1, 'P-0000081-T01-IM3': 0 },
};

const SEQUENCING = event('Sequencing', 962, { SAMPLE_ID: SAMPLE });

function configuredTracks(slides: ClinicalEvent[]) {
    const data = [...slides, SEQUENCING];
    const config = buildBaseConfig({} as SampleManager, CASE_META, [
        pathologySlidesTrackConfig(CASE_META, data),
    ]);
    const tracks = sortTracks(config, data);
    configureTracks(tracks, config);
    return tracks;
}

function pathologyRoot(slides: ClinicalEvent[]): TimelineTrackSpecification {
    return configuredTracks(slides).find(t => t.type === 'PATHOLOGY SLIDES')!;
}

/** The stain row of the PATHOLOGY SLIDES track (H&E unless given). */
function pathologyTrack(
    slides: ClinicalEvent[],
    stain = 'H&E'
): TimelineTrackSpecification {
    return pathologyRoot(slides).tracks!.find(t => t.type === stain)!;
}

function renderTooltip(track: TimelineTrackSpecification, item: TimelineEvent) {
    let location: { pathname: string; search: string } | undefined;
    render(
        <TestRouter initialEntries={['/patient/summary']}>
            <TestPortal container={document.body}>
                {track.renderTooltip!(item)}
            </TestPortal>
            <Route
                path="*"
                render={props => {
                    location = props.location;
                    return null;
                }}
            />
        </TestRouter>
    );
    return () => location;
}

describe('pathologySlideMarkerSample', () => {
    it("maps matched events to their sample's color and number", () => {
        expect(pathologySlideMarkerSample(slide({}), CASE_META)).toEqual({
            sampleId: SAMPLE,
            color: '#ff0000',
            label: '2',
        });
    });

    it('returns null for unmatched events and samples outside the patient', () => {
        expect(
            pathologySlideMarkerSample(
                slide({ MATCH_LEVEL: 'Unmatched' }),
                CASE_META
            )
        ).toBeNull();
        expect(
            pathologySlideMarkerSample(
                slide({ SAMPLE_ID: 'P-OTHER' }),
                CASE_META
            )
        ).toBeNull();
    });
});

describe('pathologySlideGroupMarker', () => {
    const sample1 = {
        sampleId: 'P-0000081-T01-IM3',
        color: '#0000ff',
        label: '1',
    };
    const sample2 = { sampleId: SAMPLE, color: '#ff0000', label: '2' };

    it('uses one sample marker when every event has the same sample', () => {
        expect(
            pathologySlideGroupMarker(
                [slide({}), slide({ SUBTYPE: 'IHC' })],
                CASE_META
            )
        ).toEqual({ kind: 'sample', sample: sample2, count: 2 });
    });

    it('deduplicates samples of a mixed group and skips unmatched events', () => {
        expect(
            pathologySlideGroupMarker(
                [
                    slide({}),
                    slide({ SUBTYPE: 'IHC' }),
                    slide({ SAMPLE_ID: 'P-0000081-T01-IM3' }),
                    slide({ MATCH_LEVEL: 'Unmatched' }),
                ],
                CASE_META
            )
        ).toEqual({ kind: 'samples', samples: [sample2, sample1], count: 4 });
        expect(
            pathologySlideGroupMarker(
                [slide({}), slide({ MATCH_LEVEL: 'Unmatched' })],
                CASE_META
            )
        ).toEqual({ kind: 'samples', samples: [sample2], count: 2 });
    });

    it('marks groups without a patient sample as unmatched', () => {
        expect(
            pathologySlideGroupMarker(
                [
                    slide({ MATCH_LEVEL: 'Unmatched' }),
                    slide({ SAMPLE_ID: 'P-OTHER' }),
                ],
                CASE_META
            )
        ).toEqual({ kind: 'unmatched', count: 2 });
    });
});

describe('PATHOLOGY SLIDES timeline track', () => {
    function renderMarker(slides: ClinicalEvent[]) {
        const track = pathologyTrack(slides);
        const { container } = render(
            <svg>{track.renderEvents!(track.items, 10)}</svg>
        );
        return {
            track,
            texts: Array.from(container.querySelectorAll('text')).map(
                t => t.textContent
            ),
            fills: Array.from(
                container.querySelectorAll('circle, ellipse, rect')
            ).map(el => el.getAttribute('fill')),
        };
    }

    it('draws a matched event as its numbered sample marker', () => {
        const { track, texts, fills } = renderMarker([slide({})]);
        expect(texts).toEqual(['2']);
        expect(fills).toEqual(['#ff0000']);
        expect(track.eventColorGetter!(track.items[0])).toBe('#ff0000');
    });

    it("draws a same-sample group as the sample's marker with a count", () => {
        const { texts, fills } = renderMarker([
            slide({}),
            slide({ SPECIMEN: 'Part 2' }),
            slide({ MATCH_LEVEL: 'BLOCK' }),
        ]);
        expect(texts).toEqual(['2', '3']);
        expect(fills).toEqual(['#ff0000']);
    });

    it('lists each sample once in a mixed group', () => {
        const mixed = renderMarker([
            slide({}),
            slide({ SPECIMEN: 'Part 2' }),
            slide({ SAMPLE_ID: 'P-0000081-T01-IM3' }),
        ]);
        // The sample tracks' multi-sample marker writes consecutive
        // numbers as a range.
        expect(mixed.texts).toEqual(['1-2', '3']);

        const withUnmatched = renderMarker([
            slide({}),
            slide({ SPECIMEN: 'Part 2' }),
            slide({ MATCH_LEVEL: 'Unmatched' }),
        ]);
        expect(withUnmatched.texts).toEqual(['2', '3']);
        expect(withUnmatched.fills).not.toContain(UNMATCHED_MARKER_COLOR);
    });

    it('draws unmatched events as grey markers', () => {
        const single = renderMarker([slide({ MATCH_LEVEL: 'Unmatched' })]);
        expect(single.texts).toEqual([]);
        expect(single.fills).toEqual([UNMATCHED_MARKER_COLOR]);
        expect(single.track.eventColorGetter!(single.track.items[0])).toBe(
            UNMATCHED_MARKER_COLOR
        );

        const stack = renderMarker([
            slide({ MATCH_LEVEL: 'Unmatched' }),
            slide({ MATCH_LEVEL: 'Unmatched', SPECIMEN: 'Part 2' }),
        ]);
        expect(stack.texts).toEqual(['2']);
        expect(stack.fills).toContain(UNMATCHED_MARKER_COLOR);
        expect(stack.fills).not.toContain('#ff0000');
    });

    it('orders simultaneous events by sample number', () => {
        const track = pathologyTrack([
            slide({ MATCH_LEVEL: 'Unmatched' }),
            slide({ SAMPLE_ID: 'P-0000081-T01-IM3' }),
            slide({}),
        ]);
        const sorted = track.sortSimultaneousEvents!(track.items);
        expect(
            sorted.map(e =>
                e.event.attributes
                    .filter(a => ['SAMPLE_ID', 'MATCH_LEVEL'].includes(a.key))
                    .map(a => a.value)
                    .join(' ')
            )
        ).toEqual([
            'P-0000081-T01-IM3 PART',
            `${SAMPLE} PART`,
            `${SAMPLE} Unmatched`,
        ]);
    });

    it('splits the track into stain rows: H&E, IHC, then the rest', () => {
        const root = pathologyRoot([
            slide({ SUBTYPE: 'Unknown' }),
            slide({ SUBTYPE: 'IHC' }),
            slide({ SUBTYPE: 'Special stain' }),
            slide({}),
        ]);
        expect(root.items).toEqual([]);
        expect(root.tracks!.map(t => t.type)).toEqual([
            'H&E',
            'IHC',
            'Special stain',
            'Unknown',
        ]);
        root.tracks!.forEach(t => {
            expect(t.renderEvents).toBeDefined();
            expect(t.renderTooltip).toBeDefined();
            expect(t.items).toHaveLength(1);
        });
    });

    it('places the track right after sequencing', () => {
        const types = configuredTracks([
            slide({}),
            event('Treatment', 10, { TREATMENT_TYPE: 'Medical Therapy' }),
            event('Status', 5, { STATUS: 'Alive' }),
        ]).map(t => t.type);
        expect(types.indexOf('PATHOLOGY SLIDES')).toBe(
            types.indexOf('SEQUENCING') + 1
        );
    });

    it('renders a readable tooltip with an in-app Open slides link', () => {
        const track = pathologyTrack([slide({})]);
        const location = renderTooltip(track, track.items[0]);

        expect(
            screen.getByText('Pathology slides · H&E · Part-matched')
        ).toBeTruthy();
        expect(screen.getByText(SAMPLE)).toBeTruthy();
        expect(
            screen.getByText('d+920 — 42 d before sequencing (d+962)')
        ).toBeTruthy();
        expect(screen.getByText('1 of 1 viewable')).toBeTruthy();
        expect(screen.queryByText(/IMAGE_IDS|496610"/)).toBeNull();

        // The timeline renders tooltips in a portal; the router context
        // still reaches the link, so it navigates without a page load.
        fireEvent.click(screen.getByRole('link', { name: /Open H&E slides/ }));
        expect(location()?.pathname).toBe('/patient/wsiHESlides');
        expect(location()?.search).toBe(
            LINKOUT.split('/patient/wsiHESlides')[1]
        );
    });

    it('omits Open slides when nothing is viewable or LINKOUT is empty', () => {
        const track = pathologyTrack([
            slide({ IMAGE_COUNT: '0' }),
            slide({ LINKOUT: '' }, 921),
        ]);
        renderTooltip(track, track.items[0]);
        renderTooltip(track, track.items[1]);
        expect(screen.getByText('0 of 1 viewable')).toBeTruthy();
        expect(screen.queryByRole('link')).toBeNull();
    });

    it('describes unmatched slides in the tooltip', () => {
        const track = pathologyTrack([slide({ MATCH_LEVEL: 'Unmatched' })]);
        renderTooltip(track, track.items[0]);
        expect(
            screen.getByText('Unmatched (not linked to a sequenced sample)')
        ).toBeTruthy();
        expect(screen.getByText('d+920')).toBeTruthy();
    });
});

describe('loadPathologySlideEvents', () => {
    const hierarchy = {
        referenceSampleId: SAMPLE,
        sampleGroups: [
            {
                sampleId: SAMPLE,
                parts: [
                    {
                        partNumber: '1',
                        partDesignator: '',
                        partType: '',
                        partDescription: '',
                        subspecialty: '',
                        pathDxTitle: '',
                        blocks: [
                            {
                                blockNumber: '1',
                                blockLabel: 'Block 1',
                                slides: [
                                    {
                                        imageId: '496610',
                                        stainName: 'H&E',
                                        stainGroup: 'initial',
                                        isHne: true,
                                        isIhc: false,
                                        magnification: '40x',
                                        fileSizeBytes: null,
                                        canServeTiles: true,
                                        barcode: '',
                                        slideType: 'H&E',
                                        sampleId: SAMPLE,
                                        matchLevel: 'PART',
                                        specimenKey: 'part::part:1',
                                        procedureDateDays: 920,
                                        timepointSource:
                                            'Recorded procedure date relative to first tumor sequencing',
                                        procedureDateKind: 'RECORDED',
                                        procedureDateSource: 'procedure',
                                        procedureDateReason: null,
                                        procedureDateStatus: 'AVAILABLE',
                                        procedureCoordinateSystem:
                                            'patient_first_tumor_sequencing_day_zero',
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };

    it('builds timeline events linking to the Pathology Slides tab', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(hierarchy),
        });
        configureWsiViewerRuntime({
            buildApiUrl: (path: string) => `https://portal.example/${path}`,
            authEnabled: false,
            fetchImpl,
        });

        const slides = await loadPathologySlideEvents(
            'mskimpact',
            'P-0000081',
            'user-1'
        );

        expect(fetchImpl.mock.calls[0][0]).toBe(
            'https://portal.example/api/wsi/v2/hierarchy/mskimpact/P-0000081'
        );
        const track = pathologyTrack(slides);
        const location = renderTooltip(track, track.items[0]);
        expect(
            screen.getByText('d+920 — 42 d before sequencing (d+962)')
        ).toBeTruthy();
        fireEvent.click(screen.getByRole('link', { name: /Open H&E slides/ }));
        expect(location()?.pathname).toBe('/patient/wsiHESlides');
        expect(location()?.search).toBe(
            '?studyId=mskimpact&caseId=P-0000081&stainFilter=hne&matchLevel=PART&specimenKey=part%3A%3Apart%3A1&sampleId=P-0000081-T02-IM6&timepointDays=920'
        );
    });
});
