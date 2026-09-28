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
import { pathologySlideMarkerSample } from './pathologySlidesTimeline';
import SampleMarker from './SampleMarker';
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

function pathologyTrack(slides: ClinicalEvent[]): TimelineTrackSpecification {
    const data = [...slides, SEQUENCING];
    const config = buildBaseConfig({} as SampleManager, CASE_META, data);
    const tracks = sortTracks(config, data);
    configureTracks(tracks, config);
    return tracks.find(t => t.type === 'PATHOLOGY SLIDES')!;
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

describe('PATHOLOGY SLIDES timeline track', () => {
    it('draws a matched event as its numbered sample marker', () => {
        const track = pathologyTrack([slide({})]);
        const marker = track.renderEvents!(track.items, 10) as JSX.Element;
        expect(marker.type).toBe(SampleMarker);
        expect(marker.props).toMatchObject({
            color: '#ff0000',
            label: '2',
            y: 10,
        });
        expect(track.eventColorGetter!(track.items[0])).toBe('#ff0000');
    });

    it('uses default rendering for unmatched and overlapping events', () => {
        const unmatched = pathologyTrack([slide({ MATCH_LEVEL: 'Unmatched' })]);
        expect(unmatched.renderEvents!(unmatched.items, 10)).toBeNull();
        expect(unmatched.eventColorGetter!(unmatched.items[0])).toBeUndefined();

        const overlapping = pathologyTrack([
            slide({}),
            slide({ SUBTYPE: 'IHC' }),
        ]);
        expect(overlapping.renderEvents!(overlapping.items, 10)).toBeNull();
    });

    it('orders simultaneous events by sample number, then stain', () => {
        const track = pathologyTrack([
            slide({ SUBTYPE: 'IHC' }),
            slide({ MATCH_LEVEL: 'Unmatched' }),
            slide({ SAMPLE_ID: 'P-0000081-T01-IM3' }),
            slide({}),
        ]);
        const sorted = track.sortSimultaneousEvents!(track.items);
        expect(
            sorted.map(e =>
                e.event.attributes
                    .filter(a =>
                        ['SAMPLE_ID', 'SUBTYPE', 'MATCH_LEVEL'].includes(a.key)
                    )
                    .map(a => a.value)
                    .join(' ')
            )
        ).toEqual([
            'P-0000081-T01-IM3 H&E PART',
            `${SAMPLE} H&E PART`,
            `${SAMPLE} IHC PART`,
            `${SAMPLE} H&E Unmatched`,
        ]);
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
