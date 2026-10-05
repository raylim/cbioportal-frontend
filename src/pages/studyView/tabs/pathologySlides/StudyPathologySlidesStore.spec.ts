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
    StudySlideFacets,
    StudySlideFacetsRequest,
    StudySlidePatient,
    StudySlidesPage,
    StudySlidesRequest,
} from './studySlidesApi';

jest.mock('shared/api/urls', () => ({
    buildCBioPortalAPIUrl: (path: string) => `/${path}`,
}));

const STUDY = 'study';

function patient(patientId: string, stain = 'H&E'): StudySlidePatient {
    return {
        studyId: STUDY,
        patientId,
        slideCount: 1,
        viewableSlideCount: 1,
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
    const fetchPage = jest.fn(
        async (request: StudySlidesRequest): Promise<StudySlidesPage> => {
            requests.push(request);
            const listed = allPatients().filter(
                p =>
                    (!request.search ||
                        p.patientId
                            .toLowerCase()
                            .includes(request.search.toLowerCase())) &&
                    (!request.stainGroups?.length ||
                        request.stainGroups.some(
                            g => p.stainGroupCounts[g] > 0
                        ))
            );
            const pageNumber = request.pageNumber ?? 0;
            const pageSize = request.pageSize ?? 50;
            const located = listed.findIndex(
                p =>
                    p.studyId === request.locateStudyId &&
                    p.patientId === request.locatePatientId
            );
            return {
                totalPatients: listed.length,
                totalSlides: listed.length,
                totalViewableSlides: listed.length,
                stainGroupTotals: { 'H&E': 0, IHC: 0, Other: 0, Unknown: 0 },
                locatedIndex: located >= 0 ? located : null,
                pageNumber,
                pageSize,
                patients: listed.slice(
                    pageNumber * pageSize,
                    (pageNumber + 1) * pageSize
                ),
            };
        }
    );
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
                viewableOnly: true,
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

    it('waits for an explicit ID search when the text is not ID-like', () => {
        jest.useFakeTimers();
        try {
            makeStore();
            store.setSearchText('colorectal');
            jest.advanceTimersByTime(STUDY_SLIDES_SEARCH_DEBOUNCE_MS * 2);
            expect(store.search).toBe('');

            store.applySearch();
            expect(store.search).toBe('colorectal');
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

    describe('filters', () => {
        const facets: StudySlideFacets = {
            attributes: [
                {
                    attributeId: 'CANCER_TYPE',
                    values: [
                        { value: 'Colorectal Cancer', patientCount: 3 },
                        { value: 'Breast Cancer', patientCount: 2 },
                    ],
                    truncated: false,
                },
                {
                    attributeId: 'SAMPLE_TYPE',
                    values: [{ value: 'Primary', patientCount: 5 }],
                    truncated: false,
                },
            ],
            matchLevels: { PART: 4, BLOCK: 2, UNMATCHED: 1 },
        };
        const suggestionFacets: StudySlideFacets = {
            attributes: [
                {
                    attributeId: 'PRIMARY_SITE',
                    values: [{ value: 'Colon', patientCount: 2 }],
                    truncated: false,
                },
            ],
            matchLevels: { PART: 4, BLOCK: 2, UNMATCHED: 1 },
        };
        // Observable, like the study view's filters.
        const clinicalFilters = observable.box<
            { attributeId: string; values: string[] }[]
        >([]);
        let facetRequests: StudySlideFacetsRequest[];
        let setFilterValues: jest.Mock;

        function makeFilterStore() {
            runInAction(() => clinicalFilters.set([]));
            facetRequests = [];
            setFilterValues = jest.fn((attributeId, values) =>
                runInAction(() =>
                    clinicalFilters.set(
                        values.length ? [{ attributeId, values }] : []
                    )
                )
            );
            store = new StudyPathologySlidesStore({
                getFilters: () => filters.get(),
                getStudyIds: () => [STUDY],
                fetchPage: server.fetchPage,
                fetchFacets: async request => {
                    facetRequests.push(request);
                    return request.attributeIds.includes('PRIMARY_SITE')
                        ? suggestionFacets
                        : facets;
                },
                clinical: {
                    getAttributes: () =>
                        [
                            'CANCER_TYPE',
                            'CANCER_TYPE_DETAILED',
                            'SAMPLE_TYPE',
                            'PRIMARY_SITE',
                        ].map(attributeId => ({
                            attributeId,
                            displayName: attributeId.toLowerCase(),
                        })),
                    getFilters: () => clinicalFilters.get(),
                    setFilterValues,
                },
                pageSize: 2,
            });
            stopObserving = autorun(() => {
                void store.page.result;
                void store.facets.result;
                void store.suggestionFacets.result;
            });
        }

        beforeEach(() => window.localStorage.clear());

        it('requests the default filters with the list filters but not the ID search', async () => {
            makeFilterStore();
            store.toggleMatchLevel('PART');
            store.setSearchText('P-1');
            store.applySearch();
            await settle();

            expect(facetRequests[facetRequests.length - 1]).toEqual({
                studyViewFilter: { studyIds: [STUDY] },
                viewableOnly: true,
                stainGroups: [],
                matchLevels: ['PART'],
                attributeIds: [
                    'CANCER_TYPE',
                    'CANCER_TYPE_DETAILED',
                    'SAMPLE_TYPE',
                ],
            });
            expect(server.requests[server.requests.length - 1]).toEqual(
                expect.objectContaining({
                    matchLevels: ['PART'],
                    search: 'P-1',
                })
            );
            // SAMPLE_TYPE has one value in the cohort, so it is not offered.
            expect(store.visibleFacets.map(f => f.attributeId)).toEqual([
                'CANCER_TYPE',
            ]);
        });

        it('suggests clinical values and match levels once the search is used', async () => {
            makeFilterStore();
            await settle();
            expect(store.suggestionsFor('col')).toEqual([
                {
                    kind: 'clinical',
                    attributeId: 'CANCER_TYPE',
                    displayName: 'cancer_type',
                    value: 'Colorectal Cancer',
                    patientCount: 3,
                },
            ]);

            store.requestSuggestions();
            await settle();
            expect(
                store
                    .suggestionsFor('col')
                    .map(s => s.kind + ':' + s.patientCount)
            ).toEqual(['clinical:3', 'clinical:2']);
            expect(store.suggestionsFor('unmatch')).toEqual([
                { kind: 'match', level: 'UNMATCHED', patientCount: 1 },
            ]);
            expect(store.suggestionsFor('  ')).toEqual([]);
        });

        it('sets the shared clinical filter and pins more filters', async () => {
            makeFilterStore();
            await settle();

            store.addClinicalValue('CANCER_TYPE', 'Breast Cancer');
            store.addClinicalValue('CANCER_TYPE', 'Colorectal Cancer');
            expect(setFilterValues).toHaveBeenLastCalledWith('CANCER_TYPE', [
                'Breast Cancer',
                'Colorectal Cancer',
            ]);
            expect(store.clinicalFilters).toEqual([
                {
                    attributeId: 'CANCER_TYPE',
                    displayName: 'cancer_type',
                    values: ['Breast Cancer', 'Colorectal Cancer'],
                },
            ]);

            store.pinAttribute('PRIMARY_SITE');
            expect(store.facetAttributeIds).toContain('PRIMARY_SITE');
            expect(
                JSON.parse(
                    window.localStorage.getItem('wsi.study.pinnedFacets')!
                )
            ).toEqual(['PRIMARY_SITE']);
            store.unpinAttribute('PRIMARY_SITE');
            expect(store.facetAttributeIds).not.toContain('PRIMARY_SITE');
            expect(setFilterValues).toHaveBeenLastCalledWith(
                'PRIMARY_SITE',
                []
            );
        });

        it('clears only the tab filters', async () => {
            makeFilterStore();
            store.toggleStainGroup('IHC');
            store.toggleMatchLevel('UNMATCHED');
            store.setSearchText('P');
            store.applySearch();
            expect(store.hasSlideFilters).toBe(true);

            store.clearSlideFilters();
            expect(store.hasSlideFilters).toBe(false);
            expect(store.searchText).toBe('');
            expect(setFilterValues).not.toHaveBeenCalled();
        });
    });
});
