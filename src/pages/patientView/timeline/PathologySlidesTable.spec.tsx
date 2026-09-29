/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import PathologySlidesTable from './PathologySlidesTable';

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

const LINKOUT =
    '/patient/wsiHESlides?studyId=mskimpact&caseId=P-0000081&stainFilter=ihc&matchLevel=PART&sampleId=P-0000081-T02-IM6';

const slides = [
    event('PATHOLOGY SLIDES', 920, {
        SAMPLE_ID: 'P-0000081-T02-IM6',
        SUBTYPE: 'IHC',
        MATCH_LEVEL: 'PART',
        SPECIMEN: 'Part 1',
        IMAGE_COUNT: '4',
        TOTAL_IMAGE_COUNT: '4',
        IMAGE_IDS: '["1","2","3","4"]',
        LINKOUT,
    }),
    event('PATHOLOGY SLIDES', 920, {
        SAMPLE_ID: 'P-0000081-T02-IM6',
        SUBTYPE: 'H&E',
        MATCH_LEVEL: 'BLOCK',
        SPECIMEN: 'Part 6 / Block Block 1',
        IMAGE_COUNT: '0',
        TOTAL_IMAGE_COUNT: '1',
        IMAGE_IDS: '[]',
        LINKOUT: '',
    }),
];
const sequencing = event('Sequencing', 962, {
    SAMPLE_ID: 'P-0000081-T02-IM6',
});

describe('PathologySlidesTable', () => {
    it('renders readable columns and an in-app Open link', () => {
        let location: { pathname: string; search: string } | undefined;
        render(
            <TestRouter initialEntries={['/patient/clinicalData']}>
                <PathologySlidesTable
                    events={slides}
                    clinicalEvents={[...slides, sequencing]}
                    showCopyDownload={false}
                />
                <Route
                    path="*"
                    render={props => {
                        location = props.location;
                        return null;
                    }}
                />
            </TestRouter>
        );

        const headers = screen
            .getAllByRole('columnheader')
            .map(th => th.textContent);
        expect(headers).toEqual([
            'Procedure',
            'Sample',
            'vs sequencing',
            'Stain',
            'Match',
            'Specimen',
            'Slides',
            '',
        ]);

        // Sorted by stain within the same procedure day and sample.
        const [, hneRow, ihcRow] = screen.getAllByRole('row');
        expect(within(ihcRow).getByText('d+920')).toBeTruthy();
        expect(within(ihcRow).getByText('42 d before (d+962)')).toBeTruthy();
        expect(within(ihcRow).getByText('4 of 4 viewable')).toBeTruthy();
        expect(within(hneRow).getByText('Part 6 / Block 1')).toBeTruthy();
        expect(within(hneRow).getByText('Block')).toBeTruthy();
        expect(within(hneRow).queryByRole('link')).toBeNull();

        const link = within(ihcRow).getByRole('link', {
            name: 'Open IHC slides for P-0000081-T02-IM6',
        });
        fireEvent.click(link);
        expect(location?.pathname).toBe('/patient/wsiHESlides');
        expect(location?.search).toBe(LINKOUT.split('/patient/wsiHESlides')[1]);
    });
});
