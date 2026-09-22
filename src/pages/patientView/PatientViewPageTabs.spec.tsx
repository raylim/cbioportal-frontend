import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { observable, runInAction } from 'mobx';
const mockUsePathologyAugmentedClinicalEvents = jest.fn();
const mockTimelineWrapperContent = jest.fn((_: any) => (
    <div>Timeline Content</div>
));
import {
    PatientViewPageTabs as PatientViewPageTabIds,
    SummaryTimelineSection,
    patientViewTabs,
    tabs,
} from './PatientViewPageTabs';
import { buildTimelineEventsSignature } from 'pages/patientView/timeline/pathologyTimelineUtils';

var mockServerConfig = {
    msk_wsi_tile_server_url: 'https://slides.example.com',
    app_name: 'localdbe2e',
    show_oncokb: false,
    oncoprint_custom_driver_annotation_binary_menu_label: '',
    oncoprint_custom_driver_annotation_binary_menu_description: '',
    oncoprint_custom_driver_annotation_tiers_menu_label: '',
    oncoprint_custom_driver_annotation_tiers_menu_description: '',
};

jest.mock('config/config', () => ({
    getServerConfig: () => mockServerConfig,
    getLoadConfig: () => ({ apiRoot: '' }),
    ServerConfigHelpers: {},
}));
jest.mock('shared/components/MSKTabs/MSKTabs', () => ({
    MSKTabs: ({ children }: any) => <div>{children}</div>,
    MSKTab: ({ children }: any) => <div>{children}</div>,
}));
jest.mock('pages/patientView/mutation/MutationTableWrapper', () => () => (
    <div>Mutation Table</div>
));
jest.mock(
    'pages/patientView/structuralVariant/StructuralVariantTableWrapper',
    () => () => <div>Structural Variants</div>
);
jest.mock(
    'pages/patientView/clinicalInformation/ClinicalInformationSamplesTable',
    () => () => <div>Clinical Samples</div>
);
jest.mock(
    'pages/patientView/timeline/usePathologyAugmentedClinicalEvents',
    () => ({
        __esModule: true,
        default: (...args: unknown[]) =>
            mockUsePathologyAugmentedClinicalEvents(...args)?.events,
        usePathologyAugmentedClinicalEventsState: (...args: unknown[]) =>
            mockUsePathologyAugmentedClinicalEvents(...args),
    })
);
jest.mock('pages/patientView/timeline/TimelineWrapper', () => ({
    __esModule: true,
    TimelineWrapperContent: (props: any) => mockTimelineWrapperContent(props),
}));
jest.mock('pages/patientView/timeline/ClinicalEventsTables', () => ({
    __esModule: true,
    default: () => <div>Clinical Events</div>,
}));

function makeHierarchy(
    slidesBySampleId: Record<string, any[]>,
    slideAssociations?: any[]
) {
    const associations =
        slideAssociations ||
        Object.entries(slidesBySampleId).flatMap(([sampleId, slides]) =>
            slides.map(slide => ({
                image_id: slide.image_id,
                sample_id: sampleId,
                match_level: 'BLOCK',
                specimen_key: 'block::1::1',
                slide_type: slide.is_ihc ? 'IHC' : 'H&E',
                can_serve_tiles: slide.can_serve_tiles,
            }))
        );
    return {
        referenceSampleId:
            Object.keys(slidesBySampleId).find(
                sampleId => sampleId !== 'UNMATCHED'
            ) || null,
        sampleGroups: Object.entries(slidesBySampleId).map(
            ([sampleId, slides]) => ({
                sampleId: sampleId === 'UNMATCHED' ? null : sampleId,
                parts: [
                    {
                        partNumber: '1',
                        partDesignator: '1',
                        partType: '',
                        partDescription: '',
                        subspecialty: '',
                        pathDxTitle: '',
                        blocks: [
                            {
                                blockNumber: '1',
                                blockLabel: 'A1',
                                slides: slides.map(slide => {
                                    const association = associations.find(
                                        item => item.image_id === slide.image_id
                                    );
                                    const hasDays =
                                        slide.slide_timepoint_days != null;
                                    return {
                                        imageId: slide.image_id,
                                        stainName: slide.stain_name,
                                        stainGroup: slide.stain_group,
                                        isHne: slide.is_hne,
                                        isIhc: slide.is_ihc,
                                        magnification: slide.magnification,
                                        fileSizeBytes: slide.file_size_bytes
                                            ? Number(slide.file_size_bytes)
                                            : null,
                                        canServeTiles: slide.can_serve_tiles,
                                        barcode: slide.barcode,
                                        slideType: slide.slide_type || null,
                                        sampleId:
                                            association?.sample_id ??
                                            (sampleId === 'UNMATCHED'
                                                ? null
                                                : sampleId),
                                        matchLevel:
                                            association?.match_level ||
                                            (sampleId === 'UNMATCHED'
                                                ? 'UNMATCHED'
                                                : 'BLOCK'),
                                        specimenKey:
                                            association?.specimen_key ||
                                            'block::1::1',
                                        procedureDateDays:
                                            slide.slide_timepoint_days ?? null,
                                        timepointSource:
                                            slide.slide_timepoint_source ||
                                            (hasDays
                                                ? 'Procedure date'
                                                : 'Procedure date unavailable'),
                                        procedureDateKind:
                                            slide.slide_timepoint_kind ||
                                            (hasDays ? 'RECORDED' : 'UNDATED'),
                                        procedureDateSource:
                                            slide.slide_timepoint_date_source ||
                                            (hasDays
                                                ? 'recorded_procedure_date'
                                                : 'missing_procedure_date'),
                                        procedureDateReason: hasDays
                                            ? null
                                            : slide.slide_timepoint_reason ||
                                              'unavailable',
                                        procedureDateStatus:
                                            slide.slide_timepoint_status ||
                                            (hasDays
                                                ? 'AVAILABLE'
                                                : 'MISSING_PROCEDURE_DATE'),
                                        procedureCoordinateSystem:
                                            slide.slide_timepoint_coordinate_system ||
                                            'patient_first_tumor_sequencing_day_zero',
                                    };
                                }),
                            },
                        ],
                    },
                ],
            })
        ),
    };
}

function makeSlide(overrides: Record<string, any> = {}) {
    return {
        image_id: '1',
        stain_name: 'H&E',
        stain_group: 'H&E (Initial)',
        is_hne: true,
        is_ihc: false,
        magnification: '',
        file_size_bytes: '',
        can_serve_tiles: true,
        barcode: '',
        block_label: 'A1',
        block_number: '1',
        ...overrides,
    };
}

function makePageComponent(
    overrides: Record<string, any> = {},
    queryOverrides: Record<string, any> = {}
) {
    const pageStore = {
        clinicalDataGroupedBySample: {
            isComplete: true,
            isPending: false,
            result: [{ id: 'S-1' }, { id: 'S-2' }],
        },
        clinicalEvents: {
            isComplete: false,
            isPending: false,
            result: [],
        },
        patientId: 'P-1',
        studyId: 'study',
        studyMetaData: {
            isComplete: true,
            isPending: false,
            result: {
                studyId: 'study',
                name: 'Long Form Study Name',
            },
        },
        samples: { result: [] },
        mutationMolecularProfileId: { result: null },
        mutationData: { isPending: false, isComplete: false },
        uncalledMutationData: { isPending: false, isComplete: false },
        oncoKbAnnotatedGenes: { isPending: false, isComplete: false },
        cnaSegments: { isPending: false, isComplete: false, result: [] },
        sequencedSampleIdsInStudy: { isPending: false, isComplete: false },
        sampleToMutationGenePanelId: {
            isPending: false,
            isComplete: false,
            result: {},
        },
        sampleToDiscreteGenePanelId: {
            isPending: false,
            isComplete: false,
            result: {},
        },
        studies: { isPending: false, isComplete: false, result: [] },
        mergedMutationDataFilteredByGene: [],
        namespaceColumnConfig: { structVar: {}, cna: {} },
        studyIdToStudy: { isPending: false, isComplete: false },
        genePanelIdToEntrezGeneIds: { isComplete: false },
        referenceGenes: { isComplete: false },
        discreteMolecularProfile: { isComplete: false, result: null },
        genePanelDataByMolecularProfileIdAndSampleId: { isComplete: false },
        sampleIds: [],
        existsSomeMutationWithVAFData: false,
        plotsStore: { mrnaExpressionMolecularProfile: { isComplete: false } },
        geneticTrackData: { isComplete: false },
        mergedMutationDataIncludingUncalledFilteredByGene: null,
        clinicalDataPatient: { isComplete: false, result: [] },
        pathologyReport: { isComplete: false, result: [] },
        hasMutationalSignatureData: { result: false },
        initialMutationalSignatureVersion: { isComplete: false },
        pageMode: 'patient',
        ...overrides.pageStore,
    };

    return {
        patientViewPageStore: pageStore,
        patientViewMutationDataStore: { namespaceColumnConfig: {} },
        patientViewCnaDataStore: {},
        urlWrapper: {
            query: {
                stainFilter: 'all',
                sampleId: 'S-1',
                matchLevel: undefined,
                specimenKey: undefined,
                timepointDays: undefined,
                wsiScope: undefined,
                ...queryOverrides,
            },
            activeTabId: PatientViewPageTabIds.Summary,
            hash: '',
            routing: {
                location: {
                    pathname: '/patient/summary',
                },
            },
            setActiveTab: jest.fn(),
            setWsiTimepointDays: jest.fn(),
        },
        props: {
            appStore: {
                featureFlagStore: {
                    has: () => false,
                },
            },
        },
        resourceTabs: { component: [] },
        shouldShowResources: false,
        shouldShowPathologyReport: false,
        hideTissueImageTab: true,
        shouldShowTrialMatch: false,
        mergeMutationTableOncoKbIcons: false,
        mutationTableColumnVisibility: {},
        cnaTableColumnVisibility: {},
        columns: [],
        genePanelModal: { isOpen: false },
        onResetViewClick: jest.fn(),
        toggleGenePanelModal: jest.fn(),
        handleOncoKbIconToggle: jest.fn(),
        onMutationTableColumnVisibilityToggled: jest.fn(),
        onFilterGenesMutationTable: jest.fn(),
        onMutationTableRowClick: jest.fn(),
        onMutationTableRowMouseEnter: jest.fn(),
        onMutationTableRowMouseLeave: jest.fn(),
        onFilterGenesCopyNumberTable: jest.fn(),
        onCnaTableColumnVisibilityToggled: jest.fn(),
        onCnaTableRowClick: jest.fn(),
        onMutationalSignatureVersionChange: jest.fn(),
        onSampleIdChange: jest.fn(),
        ...overrides,
    };
}

describe('SummaryTimelineSection', () => {
    beforeEach(() => {
        mockUsePathologyAugmentedClinicalEvents.mockReset();
        mockTimelineWrapperContent.mockClear();
    });

    it('passes one augmented pathology event array to the summary timeline', () => {
        const clinicalEvents = [
            {
                eventType: 'TREATMENT',
                patientId: 'P-1',
                studyId: 'study',
                startNumberOfDaysSinceDiagnosis: 1,
            },
        ] as any;
        const augmentedEvents = [
            {
                eventType: 'PATHOLOGY SLIDES',
                patientId: 'P-1',
                studyId: 'study',
                startNumberOfDaysSinceDiagnosis: 5,
                endNumberOfDaysSinceDiagnosis: 5,
                uniquePatientKey: 'patient-key',
                uniqueSampleKey: 'sample-key',
                attributes: [],
            },
        ];
        const augmentedEventsSignature = buildTimelineEventsSignature(
            augmentedEvents
        );
        mockUsePathologyAugmentedClinicalEvents.mockReturnValue({
            events: augmentedEvents,
            eventsSignature: augmentedEventsSignature,
        });

        TestRenderer.create(
            <SummaryTimelineSection
                dataStore={{}}
                caseMetaData={{ color: {}, label: {}, index: {} }}
                clinicalEvents={clinicalEvents}
                patientId="P-1"
                studyId="study"
                sampleManager={{ samples: [] } as any}
                width={1000}
                samples={[] as any}
                clinicalSamples={[] as any}
                mutationProfileId="profile"
            />
        );

        expect(mockUsePathologyAugmentedClinicalEvents).toHaveBeenCalledTimes(
            1
        );
        expect(mockUsePathologyAugmentedClinicalEvents).toHaveBeenCalledWith(
            expect.objectContaining({
                clinicalEvents,
                clinicalEventsSignature: buildTimelineEventsSignature(
                    clinicalEvents
                ),
            })
        );
        expect(mockTimelineWrapperContent.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                timelineData: augmentedEvents,
            })
        );
        expect(
            mockTimelineWrapperContent.mock.calls[0][0].timelineDataSignature
        ).toBe(augmentedEventsSignature);
    });
});

describe('tabs', () => {
    it('keeps the summary timeline mounted while WSI availability is resolved', () => {
        const pageComponent = makePageComponent({
            pageStore: {
                clinicalEvents: {
                    isComplete: true,
                    isPending: false,
                    result: [],
                },
                clinicalDataGroupedBySample: {
                    isComplete: true,
                    isPending: false,
                    result: [],
                },
                mutationMolecularProfileId: { result: 'profile' },
            },
        });

        const tabElements = tabs(
            pageComponent as any,
            {
                sampleColors: {},
                sampleLabels: {},
                sampleIndex: {},
                getActiveSampleIdsInOrder: () => [],
            } as any,
            pageComponent.urlWrapper as any
        );
        const summaryTab = tabElements.find(
            tab => tab.props.id === PatientViewPageTabIds.Summary
        );
        const summaryChildren = React.Children.toArray(
            summaryTab!.props.children
        );

        expect(
            summaryChildren.some(
                child =>
                    React.isValidElement(child) &&
                    child.type === SummaryTimelineSection
            )
        ).toBe(true);
    });

    it('renders the summary timeline for pathology-only patients', () => {
        const pageComponent = makePageComponent({
            pageStore: {
                clinicalEvents: {
                    isComplete: true,
                    isPending: false,
                    result: [],
                },
                clinicalDataGroupedBySample: {
                    isComplete: true,
                    isPending: false,
                    result: [],
                },
                mutationMolecularProfileId: { result: 'profile' },
            },
        });

        const tabElements = tabs(
            pageComponent as any,
            {
                sampleColors: {},
                sampleLabels: {},
                sampleIndex: {},
                getActiveSampleIdsInOrder: () => [],
            } as any,
            pageComponent.urlWrapper as any
        );
        const summaryTab = tabElements.find(
            tab => tab.props.id === PatientViewPageTabIds.Summary
        );
        const summaryChildren = React.Children.toArray(
            summaryTab!.props.children
        );

        expect(
            summaryChildren.some(
                child =>
                    React.isValidElement(child) &&
                    child.type === SummaryTimelineSection
            )
        ).toBe(true);
    });

    it('renders the clinical event tables on the Clinical Data tab when clinical events are loaded', () => {
        const pageComponent = makePageComponent({
            pageStore: {
                clinicalEvents: {
                    isComplete: true,
                    isPending: false,
                    result: [
                        {
                            eventType: 'TREATMENT',
                            patientId: 'P-1',
                            studyId: 'study',
                            startNumberOfDaysSinceDiagnosis: 1,
                        },
                    ],
                },
                clinicalDataGroupedBySample: {
                    isComplete: true,
                    isPending: false,
                    result: [{ id: 'S-1' }],
                },
            },
        });

        const tabElements = tabs(
            pageComponent as any,
            {
                sampleColors: {},
                sampleLabels: {},
                sampleIndex: {},
                getActiveSampleIdsInOrder: () => ['S-1'],
            } as any,
            pageComponent.urlWrapper as any
        );
        const clinicalDataTab = tabElements.find(
            tab => tab.props.id === PatientViewPageTabIds.ClinicalData
        );

        expect(clinicalDataTab).toBeDefined();

        let renderer!: TestRenderer.ReactTestRenderer;
        act(() => {
            renderer = TestRenderer.create(
                <div>{clinicalDataTab!.props.children}</div>
            );
        });

        expect(
            renderer.root
                .findAllByType('div')
                .some(node => node.children.includes('Clinical Events'))
        ).toBe(true);
    });

    it('reuses one active-sample-id snapshot across tab consumers in a single build', () => {
        const getActiveSampleIdsInOrder = jest
            .fn()
            .mockReturnValue(['S-1', 'S-2']);
        const pageComponent = makePageComponent();
        Object.assign(pageComponent.patientViewPageStore, {
            sampleIds: ['S-1', 'S-2'],
            existsSomeMutationWithVAFData: true,
            mutationData: { isPending: false, isComplete: true },
            cnaSegments: { isPending: false, isComplete: true, result: [] },
            sequencedSampleIdsInStudy: {
                isPending: false,
                isComplete: true,
            },
            sampleToMutationGenePanelId: {
                isPending: false,
                isComplete: true,
                result: {},
            },
            sampleToDiscreteGenePanelId: {
                isPending: false,
                isComplete: true,
                result: {},
            },
            studies: {
                isPending: false,
                isComplete: true,
                result: [{ referenceGenome: 'hg19' }],
            },
            studyIdToStudy: { isPending: false, isComplete: true },
            oncoKbAnnotatedGenes: {
                isPending: false,
                isComplete: true,
            },
            genePanelIdToEntrezGeneIds: { isComplete: true },
            referenceGenes: { isComplete: true },
            discreteMolecularProfile: {
                isComplete: true,
                result: { molecularProfileId: 'cna' },
            },
            genePanelDataByMolecularProfileIdAndSampleId: {
                isComplete: true,
            },
            mergedMutationDataFilteredByGene: [],
            mutationMolecularProfileId: { result: 'profile' },
        });
        const sampleManager = {
            getActiveSampleIdsInOrder,
            sampleColors: {},
            sampleLabels: {},
            sampleIndex: {},
        };

        tabs(
            pageComponent as any,
            sampleManager as any,
            pageComponent.urlWrapper as any
        );

        expect(getActiveSampleIdsInOrder).toHaveBeenCalledTimes(1);
    });
});
