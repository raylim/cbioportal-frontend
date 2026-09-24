import React from 'react';
import TestRenderer from 'react-test-renderer';
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import ClinicalEventsTables from './ClinicalEventsTables';
import { buildTimelineEventsSignature } from './pathologyTimelineUtils';
import * as pathologyTimelineUtils from './pathologyTimelineUtils';
import { groupTimelineData } from './timelineDataUtils';
import { usePathologyAugmentedClinicalEventsState } from './usePathologyAugmentedClinicalEvents';

const mockLazyMobXTable = jest.fn();

jest.mock('./usePathologyAugmentedClinicalEvents');
jest.mock('./timelineDataUtils', () => ({
    groupTimelineData: jest.fn(() => ({})),
}));
jest.mock('shared/components/lazyMobXTable/LazyMobXTable', () => {
    return class MockLazyMobXTable extends React.Component {
        render() {
            mockLazyMobXTable(this.props);
            return null;
        }
    };
});
jest.mock('config/config', () => ({
    getServerConfig: () => ({
        skin_hide_download_controls: 'SHOW_ALL',
    }),
}));

describe('ClinicalEventsTables', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLazyMobXTable.mockClear();
        mockLazyMobXTable.mockImplementation(() => null);
    });

    it('does not rebuild grouped table data when rerendered with equivalent augmented events', () => {
        const clinicalEvents = ([
            {
                eventType: 'TREATMENT',
                patientId: 'P-1',
                studyId: 'study',
                startNumberOfDaysSinceDiagnosis: 1,
            },
        ] as unknown) as ClinicalEvent[];
        const clinicalEventsSignature = buildTimelineEventsSignature(
            clinicalEvents
        );
        const firstEvents = ([
            {
                eventType: 'PATHOLOGY SLIDES',
                patientId: 'P-1',
                studyId: 'study',
                attributes: [
                    { clinicalEventId: 0, key: 'SUBTYPE', value: 'H&E' },
                    { clinicalEventId: 0, key: 'IMAGE_COUNT', value: '1' },
                    {
                        clinicalEventId: 0,
                        key: 'NON_SERVABLE_IMAGE_COUNT',
                        value: '0',
                    },
                    {
                        clinicalEventId: 0,
                        key: 'TOTAL_IMAGE_COUNT',
                        value: '1',
                    },
                    { clinicalEventId: 0, key: 'SAMPLE_ID', value: 'S-1' },
                ],
                startNumberOfDaysSinceDiagnosis: 5,
                endNumberOfDaysSinceDiagnosis: 5,
                uniquePatientKey: 'patient-key',
                uniqueSampleKey: 'sample-key',
            },
        ] as unknown) as ClinicalEvent[];
        const firstEventsSignature = buildTimelineEventsSignature(firstEvents);
        const secondEvents = ([
            {
                eventType: 'PATHOLOGY SLIDES',
                patientId: 'P-1',
                studyId: 'study',
                attributes: [
                    { clinicalEventId: 0, key: 'SAMPLE_ID', value: 'S-1' },
                    {
                        clinicalEventId: 0,
                        key: 'TOTAL_IMAGE_COUNT',
                        value: '1',
                    },
                    {
                        clinicalEventId: 0,
                        key: 'NON_SERVABLE_IMAGE_COUNT',
                        value: '0',
                    },
                    { clinicalEventId: 0, key: 'IMAGE_COUNT', value: '1' },
                    { clinicalEventId: 0, key: 'SUBTYPE', value: 'H&E' },
                ],
                startNumberOfDaysSinceDiagnosis: 5,
                endNumberOfDaysSinceDiagnosis: 5,
                uniquePatientKey: 'patient-key',
                uniqueSampleKey: 'sample-key',
            },
        ] as unknown) as ClinicalEvent[];
        const props = {
            clinicalEvents,
            patientId: 'P-1',
            studyId: 'study',
            samples: [],
        };

        (usePathologyAugmentedClinicalEventsState as jest.Mock).mockReturnValue(
            {
                events: firstEvents,
                eventsSignature: firstEventsSignature,
            }
        );

        let renderer!: TestRenderer.ReactTestRenderer;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(
                React.createElement(ClinicalEventsTables, props)
            );
        });

        expect(usePathologyAugmentedClinicalEventsState).toHaveBeenCalledWith(
            expect.objectContaining({
                clinicalEvents,
                clinicalEventsSignature,
                includeUndatedPathology: expect.any(Boolean),
            })
        );
        expect(groupTimelineData).toHaveBeenCalledWith([]);
        expect(groupTimelineData).toHaveBeenCalledTimes(1);

        (usePathologyAugmentedClinicalEventsState as jest.Mock).mockReturnValue(
            {
                events: secondEvents,
                eventsSignature: firstEventsSignature,
            }
        );

        TestRenderer.act(() => {
            renderer.update(React.createElement(ClinicalEventsTables, props));
        });

        expect(groupTimelineData).toHaveBeenCalledTimes(1);
        expect(mockLazyMobXTable).toHaveBeenCalledTimes(2);
        const lazyMobXTableCalls = mockLazyMobXTable.mock.calls as any[];
        const firstProps = lazyMobXTableCalls[0][0];
        const secondProps = lazyMobXTableCalls[1][0];
        expect(firstProps.columns).toBe(secondProps.columns);
        expect(firstProps.data).toBe(secondProps.data);
        renderer.unmount();
    });

    it('forwards a caller-provided clinical-events signature to the augmentation hook', () => {
        const clinicalEvents = ([
            {
                eventType: 'TREATMENT',
                patientId: 'P-1',
                studyId: 'study',
                startNumberOfDaysSinceDiagnosis: 1,
            },
        ] as unknown) as ClinicalEvent[];
        const props = {
            clinicalEvents,
            clinicalEventsSignature: 'provided-signature',
            patientId: 'P-1',
            studyId: 'study',
            samples: [],
        };

        (usePathologyAugmentedClinicalEventsState as jest.Mock).mockReturnValue(
            {
                events: [],
                eventsSignature: '',
            }
        );

        TestRenderer.act(() => {
            TestRenderer.create(
                React.createElement(ClinicalEventsTables, props)
            );
        });

        expect(usePathologyAugmentedClinicalEventsState).toHaveBeenCalledWith(
            expect.objectContaining({
                clinicalEvents,
                clinicalEventsSignature: 'provided-signature',
            })
        );
    });

    it('does not rebuild the clinical-events signature when the caller provides one', () => {
        const buildTimelineEventsSignatureSpy = jest.spyOn(
            pathologyTimelineUtils,
            'buildTimelineEventsSignature'
        );
        const clinicalEvents = ([
            {
                eventType: 'TREATMENT',
                patientId: 'P-1',
                studyId: 'study',
                startNumberOfDaysSinceDiagnosis: 1,
            },
        ] as unknown) as ClinicalEvent[];
        const props = {
            clinicalEvents,
            clinicalEventsSignature: 'provided-signature',
            patientId: 'P-1',
            studyId: 'study',
            samples: [],
        };

        (usePathologyAugmentedClinicalEventsState as jest.Mock).mockReturnValue(
            {
                events: clinicalEvents,
                eventsSignature: 'augmented-signature',
            }
        );

        TestRenderer.act(() => {
            TestRenderer.create(
                React.createElement(ClinicalEventsTables, props)
            );
        });

        expect(buildTimelineEventsSignatureSpy).not.toHaveBeenCalled();
    });

    it('shows a warning when the hierarchy fails while keeping the table mounted', () => {
        const clinicalEvents = ([
            {
                eventType: 'TREATMENT',
                patientId: 'P-1',
                studyId: 'study',
                startNumberOfDaysSinceDiagnosis: 1,
            },
        ] as unknown) as ClinicalEvent[];
        (usePathologyAugmentedClinicalEventsState as jest.Mock).mockReturnValue(
            {
                events: clinicalEvents,
                eventsSignature: 'events',
                hierarchyLoadState: 'error',
                hierarchyError: new Error('server unavailable'),
            }
        );

        const renderer = TestRenderer.create(
            React.createElement(ClinicalEventsTables, {
                clinicalEvents,
                patientId: 'P-1',
                studyId: 'study',
                samples: [],
            })
        );

        expect(
            renderer.root.findAllByProps({
                'data-testid': 'wsi-clinical-data-load-error',
            })
        ).toHaveLength(1);
    });
});
