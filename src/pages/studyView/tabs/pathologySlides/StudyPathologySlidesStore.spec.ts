/**
 * @jest-environment jsdom
 */
import { autorun, observable, runInAction } from 'mobx';
import { StudyViewFilter } from 'cbioportal-ts-api-client';
import {
    STUDY_SLIDES_SEARCH_DEBOUNCE_MS,
    StudyPathologySlidesStore,
    StudySlidePatientRef,
} from './StudyPathologySlidesStore';
import {
    StudySlidePatient,
    StudySlidesPage,
    StudySlidesRequest,
} from './studySlidesApi';
import { studySlidesPageFor } from './studySlidesTestServer';

jest.mock('shared/api/urls', () => ({
    buildCBioPortalAPIUrl: (path: string) => `/${path}`,
}));

const STUDY = 'study';

function patient(patientId: string, stain = 'H&E'): StudySlidePatient {
    return {
        studyId: STUDY,
        patientId,
        slideCount: 1,
        stainGroupCounts: {
            'H&E': stain === 'H&E' ? 1 : 0,
            IHC: stain === 'IHC' ? 1 : 0,
            Other: 0,
            Unknown: 0,
        },
    };
}

/** A server over a fixed patient list that honours the request options. */
function fakeServer(allPatients: () => StudySlidePatient[]) {
    const requests: StudySlidesRequest[] = [];
    const fetchPage = jest.fn(async (request: StudySlidesRequest) => {
        requests.push(request);
        return studySlidesPageFor(request, allPatients());
    });
    return { fetchPage, requests };
}

async function settle() {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

describe('StudyPathologySlidesStore', () => {
    const filters = observable.box<StudyViewFilter>({
        studyIds: [STUDY],
    } as StudyViewFilter);
    let patients: StudySlidePatient[];
    let server: ReturnType<typeof fakeServer>;
    let selections: (StudySlidePatientRef | undefined)[];
    let store: StudyPathologySlidesStore;
    let stopObserving: () => void;

    function makeStore(initialSelection?: StudySlidePatientRef) {
        store = new StudyPathologySlidesStore({
            getFilters: () => filters.get(),
            getStudyIds: () => [STUDY],
            onSelectionChange: p => selections.push(p),
            initialSelection,
            fetchPage: server.fetchPage,
            pageSize: 2,
        });
        // The tab observes the page while it is shown.
        stopObserving = autorun(() => void store.page.result);
    }

    beforeEach(() => {
        patients = ['P-1', 'P-2', 'P-3', 'P-4', 'P-5'].map(id => patient(id));
        server = fakeServer(() => patients);
        selections = [];
        runInAction(() =>
            filters.set({ studyIds: [STUDY] } as StudyViewFilter)
        );
    });

    afterEach(() => {
        stopObserving();
        store.dispose();
    });

    it('posts the cohort filter and selects the first listed patient', async () => {
        makeStore();
        await settle();

        expect(server.requests[0]).toEqual(
            expect.objectContaining({
                studyViewFilter: { studyIds: [STUDY] },
                pageNumber: 0,
                pageSize: 2,
            })
        );
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
            getFilters: () => filters.get(),
            getStudyIds: () => [STUDY],
            onSelectionChange: p => selections.push(p),
            onViewChange: view => views.push(view),
            initialView: 'table',
            fetchPage: server.fetchPage,
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

        expect(server.requests[0]).toEqual(
            expect.objectContaining({
                locateStudyId: STUDY,
                locatePatientId: 'P-4',
            })
        );
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
        runInAction(() =>
            filters.set({ studyIds: [STUDY], caseLists: [['x']] } as any)
        );
        await settle();

        expect(store.selected?.patientId).toBe('P-3');
        expect(store.selectedIndex).toBe(1);
        expect(store.pageNumber).toBe(0);
    });

    it('selects the first patient when the selection leaves the cohort', async () => {
        makeStore({ studyId: STUDY, patientId: 'P-4' });
        await settle();

        patients = patients.filter(p => p.patientId !== 'P-4');
        runInAction(() =>
            filters.set({ studyIds: [STUDY], caseLists: [['y']] } as any)
        );
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
            expect.objectContaining({ stainGroups: ['IHC'], pageNumber: 0 })
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
            getFilters: () => filters.get(),
            getStudyIds: () => [STUDY],
            fetchPage: server.fetchPage,
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
