import React from 'react';
import TestRenderer from 'react-test-renderer';
import PatientViewMutationsTab from './PatientViewMutationsTab';
import PatientViewMutationTable from './PatientViewMutationTable';
import WindowStore from 'shared/components/window/WindowStore';
import { buildTimelineEventsSignature } from '../timeline/pathologyTimelineUtils';
import * as MutationMapperUtils from 'shared/components/mutationMapper/MutationMapperUtils';

const vafChartWrapperMock = jest.fn<JSX.Element, [Record<string, unknown>]>(
    () => <div data-testid="vaf-chart-wrapper" />
);
const vafChartMountTracker = {
    mounts: 0,
    unmounts: 0,
};
const timelineWrapperMountTracker = {
    mounts: 0,
    unmounts: 0,
};

const timelineWrapperMock = jest.fn<
    JSX.Element,
    [{ clinicalEventsSignature?: string; clinicalSamples?: unknown }]
>(() => <div data-testid="timeline-wrapper" />);

jest.mock('pages/patientView/timeline/VAFChartWrapper', () => ({
    __esModule: true,
    default: (props: Record<string, unknown>) => {
        React.useEffect(() => {
            vafChartMountTracker.mounts += 1;
            return () => {
                vafChartMountTracker.unmounts += 1;
            };
        }, []);
        return vafChartWrapperMock(props);
    },
}));

jest.mock('pages/patientView/timeline/TimelineWrapper', () => ({
    __esModule: true,
    default: (props: {
        clinicalEventsSignature?: string;
        clinicalSamples?: unknown;
    }) => {
        React.useEffect(() => {
            timelineWrapperMountTracker.mounts += 1;
            return () => {
                timelineWrapperMountTracker.unmounts += 1;
            };
        }, []);
        return timelineWrapperMock(props);
    },
}));

function completeRemote<T>(result: T) {
    return {
        status: 'complete',
        isComplete: true,
        result,
    };
}

function pendingRemote() {
    return {
        status: 'pending',
        isComplete: false,
        result: undefined,
    };
}

function makeProps(overrides: Record<string, any> = {}) {
    return {
        patientViewPageStore: {
            clinicalEvents: completeRemote([
                {
                    eventType: 'TREATMENT',
                    patientId: 'P-1',
                    startNumberOfDaysSinceDiagnosis: 1,
                    studyId: 'study',
                },
            ]),
            clinicalDataGroupedBySample: completeRemote([
                {
                    id: 'S-1',
                    clinicalData: [
                        {
                            clinicalAttributeId: 'WSI_TIMEPOINT_DAYS',
                            value: '-5',
                        },
                    ],
                },
            ]),
            samples: completeRemote([
                {
                    patientId: 'P-1',
                    studyId: 'study',
                },
            ]),
            mutationMolecularProfileId: completeRemote('profile'),
            coverageInformation: completeRemote({ samples: {} }),
            mergedMutationDataIncludingUncalledFilteredByGene: [],
        },
        urlWrapper: {
            query: {
                genomicEvolutionSettings: {
                    showTimeline: 'true',
                },
            },
            updateURL: jest.fn(),
        },
        mutationTableColumnVisibility: {},
        onMutationTableColumnVisibilityToggled: jest.fn(),
        sampleManager: {
            sampleColors: {},
            sampleLabels: {},
            sampleIndex: {},
        },
        sampleIds: ['S-1'],
        ...overrides,
    } as any;
}

describe('PatientViewMutationsTab', () => {
    const originalWindowWidth = WindowStore.size.width;

    beforeEach(() => {
        timelineWrapperMock.mockClear();
        vafChartWrapperMock.mockClear();
        vafChartMountTracker.mounts = 0;
        vafChartMountTracker.unmounts = 0;
        timelineWrapperMountTracker.mounts = 0;
        timelineWrapperMountTracker.unmounts = 0;
        WindowStore.size.width = originalWindowWidth;
    });

    afterAll(() => {
        WindowStore.size.width = originalWindowWidth;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('does not render the timeline while grouped clinical samples are still pending', () => {
        const instance = new (PatientViewMutationsTab as any)(
            makeProps({
                patientViewPageStore: {
                    ...makeProps().patientViewPageStore,
                    clinicalDataGroupedBySample: pendingRemote(),
                },
            })
        );

        expect(instance.timeline.component).toBeNull();
        expect(timelineWrapperMock).not.toHaveBeenCalled();
    });

    it('passes grouped clinical samples to TimelineWrapper once complete', () => {
        const props = makeProps();
        const instance = new (PatientViewMutationsTab as any)(props);

        TestRenderer.act(() => {
            TestRenderer.create(<>{instance.timeline.component}</>);
        });

        expect(timelineWrapperMock).toHaveBeenCalledTimes(1);
        const firstCall = timelineWrapperMock.mock.calls[0];
        expect(firstCall).toBeDefined();
        expect(firstCall[0].clinicalSamples).toBe(
            props.patientViewPageStore.clinicalDataGroupedBySample.result
        );
        expect(firstCall[0].clinicalEventsSignature).toBe(
            buildTimelineEventsSignature(
                props.patientViewPageStore.clinicalEvents.result
            )
        );
    });

    it('passes the cached clinical-events signature to the VAF chart wrapper', () => {
        const props = makeProps();
        const instance = new (PatientViewMutationsTab as any)(props);

        TestRenderer.act(() => {
            TestRenderer.create(<>{instance.vafLineChart.component}</>);
        });

        expect(vafChartWrapperMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clinicalEventsSignature: buildTimelineEventsSignature(
                    props.patientViewPageStore.clinicalEvents.result
                ),
            })
        );
    });

    it('does not remount the VAF chart wrapper when the timeline toggle changes', () => {
        const firstInstance = new (PatientViewMutationsTab as any)(makeProps());
        let renderer: TestRenderer.ReactTestRenderer;

        TestRenderer.act(() => {
            renderer = TestRenderer.create(
                <>{firstInstance.vafLineChart.component}</>
            );
        });

        expect(vafChartMountTracker.mounts).toBe(1);
        expect(vafChartMountTracker.unmounts).toBe(0);

        const secondInstance = new (PatientViewMutationsTab as any)(
            makeProps({
                urlWrapper: {
                    query: {
                        genomicEvolutionSettings: {
                            showTimeline: 'false',
                        },
                    },
                    updateURL: jest.fn(),
                },
            })
        );

        TestRenderer.act(() => {
            renderer!.update(<>{secondInstance.vafLineChart.component}</>);
        });

        expect(vafChartMountTracker.mounts).toBe(1);
        expect(vafChartMountTracker.unmounts).toBe(0);
        expect(vafChartWrapperMock).toHaveBeenCalledTimes(2);
    });

    it('does not remount the mutation timeline wrapper when the viewport width changes', () => {
        const instance = new (PatientViewMutationsTab as any)(makeProps());
        let renderer: TestRenderer.ReactTestRenderer;

        TestRenderer.act(() => {
            renderer = TestRenderer.create(<>{instance.timeline.component}</>);
        });

        expect(timelineWrapperMountTracker.mounts).toBe(1);
        expect(timelineWrapperMountTracker.unmounts).toBe(0);

        TestRenderer.act(() => {
            WindowStore.size.width += 100;
            renderer!.update(<>{instance.timeline.component}</>);
        });

        expect(timelineWrapperMountTracker.mounts).toBe(1);
        expect(timelineWrapperMountTracker.unmounts).toBe(0);
        expect(timelineWrapperMock).toHaveBeenCalledTimes(2);
    });

    it('appends namespace-derived columns after the default mutation-table columns', () => {
        jest.spyOn(MutationMapperUtils, 'extractColumnNames').mockReturnValue([
            'NAMESPACE_A',
            'NAMESPACE_B',
        ] as any);
        const instance = new (PatientViewMutationsTab as any)(makeProps());

        const columns = instance.columns;
        const defaultColumns = PatientViewMutationTable.defaultProps.columns;

        expect(columns[columns.length - 2]).toBe('NAMESPACE_A');
        expect(columns[columns.length - 1]).toBe('NAMESPACE_B');
        expect(columns.length).toBe(defaultColumns.length + 2);
        expect(columns.slice(0, defaultColumns.length)).toEqual(defaultColumns);
    });
});
