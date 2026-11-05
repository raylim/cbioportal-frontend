/**
 * @jest-environment jsdom
 */
import { autorun, observable, runInAction } from 'mobx';
import { getServerConfig } from 'config/config';
import { ResourceCohort } from 'shared/components/resourceTable/resourceTableCohort';
import {
    STUDY_SLIDES_SEARCH_DEBOUNCE_MS,
    StudyPathologySlidesStore,
    studySlidesUrlState,
    studySlidesViewFromUrl,
} from './StudyPathologySlidesStore';
import { StudySlidePatientRef } from './studySlidesApi';
import {
    patientListRequests,
    settle,
    testSlidesApi,
    TestSlidePatient,
} from './studySlidesTestServer';

const STUDY = 'study';

function patient(patientId: string, stain = 'H&E'): TestSlidePatient {
    return {
        studyId: STUDY,
        patientId,
        sampleCount: 1,
        stainGroupCounts: { [stain]: 1 },
    };
}

const STUDY_COHORT: ResourceCohort = {
    studyIds: [STUDY],
    patientIdentifiers: [],
    sampleIdentifiers: [],
};

/** A cohort the study view's filter narrows; the test server lists `patients` for it. */
function filteredCohort(caseList: string): ResourceCohort {
    return {
        ...STUDY_COHORT,
        studyViewFilter: { studyIds: [STUDY], caseLists: [[caseList]] } as any,
    };
}

/** The resource-table API over a fixed patient list, recording its requests. */
function fakeServer(allPatients: () => TestSlidePatient[]) {
    const server = testSlidesApi(allPatients);
    return {
        api: server.api,
        recorded: server.requests,
        /** The patient list requests. */
        get requests() {
            return patientListRequests(server.requests);
        },
    };
}

describe('StudyPathologySlidesStore', () => {
    const cohort = observable.box<ResourceCohort | undefined>(STUDY_COHORT);
    let patients: TestSlidePatient[];
    let server: ReturnType<typeof fakeServer>;
    let selections: (StudySlidePatientRef | undefined)[];
    let store: StudyPathologySlidesStore;
    let stopObserving: () => void;

    function makeStore(initialSelection?: StudySlidePatientRef) {
        store = new StudyPathologySlidesStore({
            getCohort: () => cohort.get(),
            getStudyIds: () => [STUDY],
            onSelectionChange: p => selections.push(p),
            initialSelection,
            api: server.api,
            pageSize: 2,
        });
        // The tab observes the page while it is shown.
        stopObserving = autorun(() => void store.page.result);
    }

    beforeEach(() => {
        patients = ['P-1', 'P-2', 'P-3', 'P-4', 'P-5'].map(id => patient(id));
        server = fakeServer(() => patients);
        selections = [];
        runInAction(() => cohort.set(STUDY_COHORT));
    });

    afterEach(() => {
        stopObserving();
        store.dispose();
    });

    it('lists the slides grouped by patient and selects the first listed patient', async () => {
        makeStore();
        await settle();

        expect(server.recorded.tabs[0]).toEqual({
            studyIds: [STUDY],
            patientIdentifiers: [],
            sampleIdentifiers: [],
        });
        expect(server.requests[0]).toEqual(
            expect.objectContaining({
                studyIds: [STUDY],
                // The studies hold only matched slides.
                resourceId: 'WSI_SAMPLE',
                groupBy: 'patient',
                groupCounts: ['metadata:stain_group'],
                pageNumber: 0,
                pageSize: 2,
            })
        );
        expect(store.page.result!.patients[0]).toEqual({
            studyId: STUDY,
            patientId: 'P-1',
            slideCount: 1,
            sampleCount: 1,
            stainGroupCounts: { 'H&E': 1, IHC: 0, Other: 0, Unknown: 0 },
        });
        expect(store.selected).toEqual({ studyId: STUDY, patientId: 'P-1' });
        expect(store.selectedIndex).toBe(0);
        expect(selections).toEqual([{ studyId: STUDY, patientId: 'P-1' }]);
    });

    it('steps through patients across list pages', async () => {
        makeStore();
        await settle();

        store.selectNext();
        expect(store.selected?.patientId).toBe('P-2');
        expect(store.selectedIndex).toBe(1);

        store.selectNext();
        await settle();
        expect(store.pageNumber).toBe(1);
        expect(store.selected?.patientId).toBe('P-3');
        expect(store.selectedIndex).toBe(2);

        store.selectPrevious();
        await settle();
        expect(store.pageNumber).toBe(0);
        expect(store.selected?.patientId).toBe('P-2');
        expect(store.hasPrevious).toBe(true);
    });

    it('does not reload the list when a listed patient is selected', async () => {
        makeStore();
        await settle();
        const requestCount = server.requests.length;

        store.selectPatient(patients[1]);
        await settle();

        expect(server.requests.length).toBe(requestCount);
        expect(store.selectedIndex).toBe(1);
    });

    it('opens a slide from the slide table in the viewer', async () => {
        const views: string[] = [];
        store = new StudyPathologySlidesStore({
            getCohort: () => cohort.get(),
            getStudyIds: () => [STUDY],
            onSelectionChange: p => selections.push(p),
            onViewChange: view => views.push(view),
            initialView: 'table',
            api: server.api,
            pageSize: 2,
        });
        stopObserving = autorun(() => void store.page.result);
        await settle();
        expect(store.view).toBe('table');

        // P-2 is on the shown page.
        store.openSlide({ studyId: STUDY, patientId: 'P-2' }, 'key-2');
        expect(store.view).toBe('viewer');
        expect(views).toEqual(['viewer']);
        expect(store.selected?.patientId).toBe('P-2');
        expect(store.selectedIndex).toBe(1);
        expect(store.requestedSlideKey).toBe('key-2');

        // Another slide of the same patient keeps the patient.
        store.openSlide({ studyId: STUDY, patientId: 'P-2' }, 'key-2b');
        expect(store.requestedSlideKey).toBe('key-2b');

        // Choosing another patient from the list drops the requested slide.
        store.selectPatient(patients[0]);
        expect(store.requestedSlideKey).toBeUndefined();
    });

    it('locates a patient opened from the slide table on another list page', async () => {
        makeStore();
        await settle();

        store.openSlide({ studyId: STUDY, patientId: 'P-5' }, 'key-5');
        await settle();

        expect(store.selected?.patientId).toBe('P-5');
        expect(store.selectedIndex).toBe(4);
        expect(store.pageNumber).toBe(2);
        expect(store.requestedSlideKey).toBe('key-5');
    });

    it('clears list filters that hide a patient opened from the slide table', async () => {
        patients[3] = patient('P-4', 'IHC');
        makeStore();
        await settle();
        store.toggleStainGroup('H&E');
        await settle();

        store.openSlide({ studyId: STUDY, patientId: 'P-4' }, 'key-4');
        await settle();

        expect(store.stainGroups).toEqual([]);
        expect(store.selected?.patientId).toBe('P-4');
        expect(store.selectedIndex).toBe(3);
        expect(store.requestedSlideKey).toBe('key-4');
    });

    it('stops at either end of the list', async () => {
        makeStore({ studyId: STUDY, patientId: 'P-5' });
        await settle();

        expect(store.hasNext).toBe(false);
        store.selectNext();
        expect(store.selected?.patientId).toBe('P-5');
    });

    it('opens the list at a restored patient without reporting a change', async () => {
        makeStore({ studyId: STUDY, patientId: 'P-4' });
        await settle();

        expect(server.requests[0].locate).toEqual({
            studyId: STUDY,
            patientId: 'P-4',
        });
        expect(store.pageNumber).toBe(1);
        expect(store.selectedIndex).toBe(3);
        expect(store.selected?.patientId).toBe('P-4');
        expect(selections).toEqual([]);
    });

    it('keeps the patient across a cohort change while still listed', async () => {
        makeStore();
        await settle();
        store.selectNext();
        store.selectNext();
        await settle();
        expect(store.selected?.patientId).toBe('P-3');

        patients = patients.filter(p => p.patientId !== 'P-1');
        runInAction(() => cohort.set(filteredCohort('x')));
        await settle();

        expect(store.selected?.patientId).toBe('P-3');
        expect(store.selectedIndex).toBe(1);
        expect(store.pageNumber).toBe(0);
    });

    it('selects the first patient when the selection leaves the cohort', async () => {
        makeStore({ studyId: STUDY, patientId: 'P-4' });
        await settle();

        patients = patients.filter(p => p.patientId !== 'P-4');
        runInAction(() => cohort.set(filteredCohort('y')));
        await settle();

        expect(store.pageNumber).toBe(0);
        expect(store.selected?.patientId).toBe('P-1');
        expect(selections).toEqual([{ studyId: STUDY, patientId: 'P-1' }]);
    });

    it('filters by stain group from the first page', async () => {
        patients[3] = patient('P-4', 'IHC');
        makeStore();
        await settle();
        store.setPageNumber(1);
        await settle();

        store.toggleStainGroup('IHC');
        await settle();

        expect(server.requests[server.requests.length - 1]).toEqual(
            expect.objectContaining({
                filters: [
                    {
                        columnId: 'metadata:stain_group',
                        operator: 'in',
                        values: ['IHC'],
                    },
                ],
                pageNumber: 0,
            })
        );
        expect(store.selected?.patientId).toBe('P-4');
        expect(store.totalPatients).toBe(1);
    });

    it('debounces the patient search', async () => {
        jest.useFakeTimers();
        try {
            makeStore();
            jest.runOnlyPendingTimers();
            const before = server.requests.length;

            store.setSearchText('P-');
            store.setSearchText('P-3');
            jest.advanceTimersByTime(STUDY_SLIDES_SEARCH_DEBOUNCE_MS - 1);
            expect(store.search).toBe('');

            jest.advanceTimersByTime(1);
            expect(store.search).toBe('P-3');
            expect(
                server.requests.slice(before).filter(r => r.search === 'P-')
                    .length
            ).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('applies the typed search at once on request', () => {
        jest.useFakeTimers();
        try {
            makeStore();
            store.setSearchText('P-3');
            store.applySearch();
            expect(store.search).toBe('P-3');
        } finally {
            jest.useRealTimers();
        }
    });

    it('reports whether the studies have slides', async () => {
        makeStore();
        const stop = autorun(() => void store.studyHasSlides.result);
        await settle();
        expect(store.studyHasSlides.result).toBe(true);
        stop();

        patients = [];
        const empty = new StudyPathologySlidesStore({
            getCohort: () => cohort.get(),
            getStudyIds: () => [STUDY],
            api: server.api,
        });
        const stopEmpty = autorun(() => void empty.studyHasSlides.result);
        await settle();
        expect(empty.studyHasSlides.result).toBe(false);
        stopEmpty();
        empty.dispose();
    });

    it('reports the requested page range and loading state before the page arrives', async () => {
        makeStore();
        await settle();
        expect(store.displayedRange).toEqual({ first: 1, last: 2 });
        expect(store.isPageLoading).toBe(false);

        store.setPageNumber(2);
        expect(store.displayedRange).toEqual({ first: 5, last: 5 });
        expect(store.isPageLoading).toBe(true);
        expect(store.selectedPageNumber).toBe(0);

        await settle();
        expect(store.isPageLoading).toBe(false);
        store.goToSelectedPage();
        expect(store.pageNumber).toBe(0);
    });

    it('starts from list filters restored from the URL and reports changes', async () => {
        const reported: unknown[] = [];
        store = new StudyPathologySlidesStore({
            getCohort: () => cohort.get(),
            getStudyIds: () => [STUDY],
            api: server.api,
            pageSize: 2,
            initialSlideFilters: {
                stainGroups: ['IHC'],
                matchLevels: [],
                search: 'P-3',
            },
            onSlideFiltersChange: f => reported.push(f),
        });
        stopObserving = autorun(() => void store.page.result);
        await settle();

        expect(server.requests[0]).toEqual(
            expect.objectContaining({
                filters: [
                    {
                        columnId: 'metadata:stain_group',
                        operator: 'in',
                        values: ['IHC'],
                    },
                ],
                search: 'P-3',
            })
        );
        expect(store.searchText).toBe('P-3');
        expect(reported).toEqual([]);

        store.toggleMatchLevel('BLOCK');
        expect(reported).toEqual([
            { stainGroups: ['IHC'], matchLevels: ['BLOCK'], search: 'P-3' },
        ]);
    });

    it('follows the patient and filters in the URL without reporting them', async () => {
        const reported: unknown[] = [];
        store = new StudyPathologySlidesStore({
            getCohort: () => cohort.get(),
            getStudyIds: () => [STUDY],
            onSelectionChange: p => selections.push(p),
            onSlideFiltersChange: f => reported.push(f),
            api: server.api,
            pageSize: 2,
        });
        stopObserving = autorun(() => void store.page.result);
        await settle();
        selections = [];

        // As after Back to an entry for P-4 with an H&E filter.
        store.followUrl(
            { studyId: STUDY, patientId: 'P-4' },
            { stainGroups: ['H&E'], matchLevels: [], search: '' }
        );
        await settle();

        expect(store.selected?.patientId).toBe('P-4');
        expect(store.selectedIndex).toBe(3);
        expect(store.stainGroups).toEqual(['H&E']);
        expect(selections).toEqual([]);
        // The reaction reports the filters it was given; the page writes the
        // same values back, which leaves the URL unchanged.
        expect(reported).toEqual([
            { stainGroups: ['H&E'], matchLevels: [], search: '' },
        ]);
    });

    it("reads matched and unmatched slides together, with each patient's distinct samples", async () => {
        patients = [
            {
                studyId: STUDY,
                patientId: 'P-1',
                sampleCount: 2,
                stainGroupCounts: { 'H&E': 2, IHC: 1 },
            },
            {
                studyId: STUDY,
                patientId: 'P-2',
                sampleCount: 0,
                stainGroupCounts: { Other: 2 },
            },
        ];
        makeStore();
        await settle();

        expect(server.requests[0].resourceIds).toEqual([
            'WSI_SAMPLE',
            'WSI_PATIENT',
        ]);
        expect(store.page.result!.totalSlides).toBe(5);
        expect(
            store.page.result!.patients.map(p => [
                p.patientId,
                p.slideCount,
                p.sampleCount,
                p.stainGroupCounts,
            ])
        ).toEqual([
            ['P-1', 3, 2, { 'H&E': 2, IHC: 1, Other: 0, Unknown: 0 }],
            ['P-2', 2, 0, { 'H&E': 0, IHC: 0, Other: 2, Unknown: 0 }],
        ]);
        // The samples come from the same slides grouped by sample, for the page's patients.
        const samples = server.recorded.groups.filter(
            q => q.groupBy === 'sample'
        );
        expect(samples).toHaveLength(1);
        expect(samples[0].filters).toEqual([
            { columnId: 'patientId', operator: 'in', values: ['P-1', 'P-2'] },
        ]);
    });

    it('counts patients per stain group for the stain filter, whatever the filters', async () => {
        patients[3] = patient('P-4', 'IHC');
        makeStore();
        const stop = autorun(() => void store.facets.result);
        await settle();
        expect(store.stainGroupPatientCounts).toEqual({
            'H&E': 4,
            IHC: 1,
            Other: 0,
            Unknown: 0,
        });
        expect(server.recorded.metadata[0]).toEqual(
            expect.objectContaining({ groupBy: 'patient', pageSize: 0 })
        );

        const requests = server.recorded.metadata.length;
        store.toggleStainGroup('IHC');
        await settle();
        // The facets ignore column filters, so a stain filter does not re-request them.
        expect(server.recorded.metadata.length).toBe(requests);
        expect(store.stainGroupPatientCounts.IHC).toBe(1);
        stop();
    });

    it('waits for the study view cohort before listing', async () => {
        runInAction(() => cohort.set(undefined));
        makeStore();
        await settle();
        expect(server.requests).toHaveLength(0);
        expect(store.page.isPending).toBe(true);

        runInAction(() => cohort.set(STUDY_COHORT));
        await settle();
        expect(store.page.result!.totalPatients).toBe(5);
    });

    it('searches a pasted Slide ID by its slide key', async () => {
        makeStore();
        store.setSearchText('WSI-0000-0000-03e9');
        store.applySearch();
        await settle();

        expect(server.requests[server.requests.length - 1].search).toBe(
            '0000000003e9'
        );
        expect(store.page.result!.patients.map(p => p.patientId)).toEqual([
            'P-2',
        ]);
    });

    it('clears only the tab filters', async () => {
        makeStore();
        store.toggleStainGroup('IHC');
        store.toggleMatchLevel('UNMATCHED');
        store.setSearchText('P');
        store.applySearch();
        expect(store.hasSlideFilters).toBe(true);

        store.clearSlideFilters();
        expect(store.hasSlideFilters).toBe(false);
        expect(store.searchText).toBe('');
    });
});

describe('studySlidesViewFromUrl', () => {
    let savedTileServerUrl: unknown;

    beforeEach(() => {
        savedTileServerUrl = (getServerConfig() as any).wsi_tile_server_url;
        (getServerConfig() as any).wsi_tile_server_url =
            'https://slides.example.com';
    });

    afterEach(() => {
        (getServerConfig() as any).wsi_tile_server_url = savedTileServerUrl;
    });

    it('restores the slide table view from wsiView=table', () => {
        expect(studySlidesViewFromUrl('pathologySlides', 'table')).toEqual({
            view: 'table',
            redirectToSlidesTab: false,
        });
        expect(studySlidesViewFromUrl('pathologySlides', undefined)).toEqual({
            view: 'viewer',
            redirectToSlidesTab: false,
        });
    });

    it("redirects the slide table's old resource tab to the table view", () => {
        expect(
            studySlidesViewFromUrl('resourceTable_PATHOLOGY_SLIDES', undefined)
        ).toEqual({ view: 'table', redirectToSlidesTab: true });
        // The tabs the slide table had as a single resource.
        expect(
            studySlidesViewFromUrl('resourceTable_WSI_SLIDES', undefined)
        ).toEqual({ view: 'table', redirectToSlidesTab: true });
        expect(
            studySlidesViewFromUrl('resourceTable_WSI_SAMPLE', undefined)
        ).toEqual({ view: 'table', redirectToSlidesTab: true });
        expect(
            studySlidesViewFromUrl('resourceTable_OTHER', undefined)
        ).toEqual({ view: 'viewer', redirectToSlidesTab: false });
    });

    it('keeps the old slide table tab without a slide viewer', () => {
        (getServerConfig() as any).wsi_tile_server_url = '';
        expect(
            studySlidesViewFromUrl('resourceTable_PATHOLOGY_SLIDES', undefined)
        ).toEqual({ view: 'viewer', redirectToSlidesTab: false });
    });
});

describe('studySlidesUrlState', () => {
    it('reads the patient and the list filters, dropping unknown values', () => {
        expect(
            studySlidesUrlState({
                wsiStudyId: 's',
                wsiPatientId: 'P-1',
                wsiStain: 'H&E,bogus,IHC',
                wsiMatch: 'BLOCK',
                wsiSearch: ' P-1 ',
            })
        ).toEqual({
            selection: { studyId: 's', patientId: 'P-1' },
            filters: {
                stainGroups: ['H&E', 'IHC'],
                matchLevels: ['BLOCK'],
                search: 'P-1',
            },
        });
        expect(studySlidesUrlState({})).toEqual({
            selection: undefined,
            filters: { stainGroups: [], matchLevels: [], search: '' },
        });
    });
});
