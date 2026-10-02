/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { render } from '@testing-library/react';
import PatientWsiSlidesTab, {
    parseTimepointDays,
    wsiSlidesTabScopeFromQuery,
} from './PatientWsiSlidesTab';

const mockEntryPoint = jest.fn((_props: Record<string, unknown>) => null);

jest.mock('shared/components/wsiViewer/wsiAppConfig', () => ({
    AppWsiViewer: (props: Record<string, unknown>) => mockEntryPoint(props),
}));

const LINK_QUERY = {
    sampleId: 'P-1-T01',
    stainFilter: 'ihc',
    matchLevel: 'PART',
    specimenKey: 'part::1',
};

describe('wsiSlidesTabScopeFromQuery', () => {
    it('maps pathology slide link params to viewer props', () => {
        expect(wsiSlidesTabScopeFromQuery(LINK_QUERY)).toEqual({
            preferredSampleId: 'P-1-T01',
            pathologyFilter: {
                sampleId: 'P-1-T01',
                matchLevel: 'PART',
                specimenKey: 'part::1',
            },
            initialStainFilter: 'ihc',
        });
    });

    it('only prefers the sample when no link scope is given', () => {
        expect(wsiSlidesTabScopeFromQuery({ sampleId: 'P-1-T01' })).toEqual({
            preferredSampleId: 'P-1-T01',
            pathologyFilter: undefined,
            initialStainFilter: undefined,
        });
        expect(wsiSlidesTabScopeFromQuery({})).toEqual({
            preferredSampleId: undefined,
            pathologyFilter: undefined,
            initialStainFilter: undefined,
        });
    });

    it('accepts only the viewer stain filters', () => {
        expect(
            wsiSlidesTabScopeFromQuery({ stainFilter: 'HNE' })
                .initialStainFilter
        ).toBe('hne');
        expect(
            wsiSlidesTabScopeFromQuery({ stainFilter: 'other' })
                .initialStainFilter
        ).toBe('other');
        expect(
            wsiSlidesTabScopeFromQuery({ stainFilter: 'unknown' })
                .initialStainFilter
        ).toBe('unknown');
        expect(
            wsiSlidesTabScopeFromQuery({ stainFilter: 'all' })
                .initialStainFilter
        ).toBeUndefined();
        expect(
            wsiSlidesTabScopeFromQuery({ stainFilter: 'bogus' })
                .initialStainFilter
        ).toBeUndefined();
    });

    it('drops the link scope when the hash names a slide', () => {
        expect(wsiSlidesTabScopeFromQuery(LINK_QUERY, 'slide-9')).toEqual({
            preferredSampleId: 'P-1-T01',
        });
    });
});

describe('timepointDays link param', () => {
    it('parses a procedure day or undated', () => {
        expect(parseTimepointDays('920')).toBe(920);
        expect(parseTimepointDays('-21')).toBe(-21);
        expect(parseTimepointDays('undated')).toBe('undated');
        expect(parseTimepointDays('UNDATED')).toBe('undated');
        expect(parseTimepointDays('9.5')).toBeUndefined();
        expect(parseTimepointDays('x')).toBeUndefined();
        expect(parseTimepointDays(undefined)).toBeUndefined();
    });

    it('scopes the viewer to the day unless the hash names a slide', () => {
        expect(
            wsiSlidesTabScopeFromQuery({ timepointDays: 'undated' })
                .initialTimepointDays
        ).toBe('undated');
        expect(
            wsiSlidesTabScopeFromQuery(
                { ...LINK_QUERY, timepointDays: '57' },
                '3658364'
            ).initialTimepointDays
        ).toBeUndefined();
    });
});

describe('PatientWsiSlidesTab', () => {
    afterEach(() => {
        mockEntryPoint.mockClear();
        window.history.replaceState(null, '', '/');
    });

    const baseProps = {
        patientId: 'P-1',
        studyId: 'study',
        tileServerUrl: 'https://tiles.example',
        height: 600,
    };

    it('passes the URL scope to the viewer', () => {
        render(<PatientWsiSlidesTab {...baseProps} query={LINK_QUERY} />);
        expect(mockEntryPoint).toHaveBeenLastCalledWith(
            expect.objectContaining({
                patientId: 'P-1',
                preferredSampleId: 'P-1-T01',
                pathologyFilter: {
                    sampleId: 'P-1-T01',
                    matchLevel: 'PART',
                    specimenKey: 'part::1',
                },
                initialStainFilter: 'ihc',
            })
        );
    });

    it('passes a timepoint day to the viewer', () => {
        render(
            <PatientWsiSlidesTab
                {...baseProps}
                query={{ ...LINK_QUERY, timepointDays: '-136' }}
            />
        );
        expect(mockEntryPoint).toHaveBeenLastCalledWith(
            expect.objectContaining({ initialTimepointDays: -136 })
        );
    });

    it('passes the clinical events to the viewer', () => {
        const clinicalEvents = [
            {
                eventType: 'SEQUENCING',
                startNumberOfDaysSinceDiagnosis: 0,
                attributes: [{ key: 'SAMPLE_ID', value: 'P-1-T01' }],
            },
        ] as any[];
        render(
            <PatientWsiSlidesTab
                {...baseProps}
                query={{}}
                clinicalEvents={clinicalEvents}
            />
        );
        const props =
            mockEntryPoint.mock.calls[mockEntryPoint.mock.calls.length - 1][0];
        expect(props.clinicalEvents).toBe(clinicalEvents);
    });

    it('lets a hash slide deep link take precedence', () => {
        window.history.replaceState(null, '', '/#wsi:slide=slide-9');
        render(<PatientWsiSlidesTab {...baseProps} query={LINK_QUERY} />);
        const props =
            mockEntryPoint.mock.calls[mockEntryPoint.mock.calls.length - 1][0];
        expect(props.pathologyFilter).toBeUndefined();
        expect(props.initialStainFilter).toBeUndefined();
        expect(props.preferredSampleId).toBe('P-1-T01');
    });
});
