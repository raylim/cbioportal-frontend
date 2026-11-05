import {
    action,
    comparer,
    computed,
    IReactionDisposer,
    makeObservable,
    observable,
    reaction,
    untracked,
} from 'mobx';
import { remoteData } from 'cbioportal-frontend-commons';
import {
    fetchStudySlideFacets,
    fetchStudySlideResourceIds,
    fetchStudySlidesPage,
    RESOURCE_TABLE_API,
    StudySlideFacets,
    StudySlideMatchLevel,
    StudySlidePatient,
    StudySlidePatientRef,
    StudySlidesPage,
    StudySlidesRequest,
    StudySlidesResourceApi,
    StudySlidesSelection,
    StudySlideStainCounts,
    StudySlideStainGroup,
    stainGroupPatientCounts,
    STUDY_SLIDE_MATCH_LEVELS,
    STUDY_SLIDE_STAIN_GROUPS,
} from './studySlidesApi';

import { getStudyViewResourceTableTabId } from 'pages/studyView/StudyViewPageTabs';
import {
    isWsiTileServerConfigured,
    PATHOLOGY_SLIDES_RESOURCE_TAB,
} from 'shared/lib/ResourcePolicy';
import {
    ResourceCohort,
    sameCohort,
} from 'shared/components/resourceTable/resourceTableCohort';

export const STUDY_SLIDES_PAGE_SIZE = 50;

/**
 * The promise, marked as handled: MobxPromise attaches its handlers a tick later, and a failure
 * it reports through `isError` is not an unhandled rejection.
 */
function handled<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => undefined);
    return promise;
}
export const STUDY_SLIDES_SEARCH_DEBOUNCE_MS = 300;

export function isSamePatient(
    a: StudySlidePatientRef | undefined,
    b: StudySlidePatientRef | undefined
): boolean {
    return !!a && !!b && a.studyId === b.studyId && a.patientId === b.patientId;
}

/** The tab's two views: patients beside the viewer, or the cohort's slide table. */
export type StudySlidesView = 'viewer' | 'table';

// The slide table's own resource tab, and the ones it had as the WSI_SLIDES and WSI_SAMPLE
// resources.
const SLIDE_TABLE_TAB_IDS = [
    PATHOLOGY_SLIDES_RESOURCE_TAB.id,
    'WSI_SLIDES',
    'WSI_SAMPLE',
].map(getStudyViewResourceTableTabId);

/**
 * The Pathology Slides view a study-view URL asks for: `wsiView=table`, or an old link to the
 * slide table's own resource tab, which then redirects to the Pathology Slides table view.
 */
export function studySlidesViewFromUrl(
    tabId: string | undefined,
    wsiView: string | undefined
): { view: StudySlidesView; redirectToSlidesTab: boolean } {
    const redirectToSlidesTab =
        !!tabId &&
        SLIDE_TABLE_TAB_IDS.includes(tabId) &&
        isWsiTileServerConfigured();
    return {
        view: wsiView === 'table' || redirectToSlidesTab ? 'table' : 'viewer',
        redirectToSlidesTab,
    };
}

/** The tab's own list filters, on top of the study-view cohort. */
export interface StudySlideListFilters {
    stainGroups: StudySlideStainGroup[];
    matchLevels: StudySlideMatchLevel[];
    search: string;
}

/** The patient and list filters a study-view URL names for the Pathology Slides tab. */
export function studySlidesUrlState(query: {
    wsiStudyId?: string;
    wsiPatientId?: string;
    wsiStain?: string;
    wsiMatch?: string;
    wsiSearch?: string;
}): {
    selection: StudySlidePatientRef | undefined;
    filters: StudySlideListFilters;
} {
    const list = (value: string | undefined) =>
        (value || '').split(',').filter(Boolean);
    return {
        selection:
            query.wsiStudyId && query.wsiPatientId
                ? { studyId: query.wsiStudyId, patientId: query.wsiPatientId }
                : undefined,
        filters: {
            stainGroups: list(
                query.wsiStain
            ).filter((group): group is StudySlideStainGroup =>
                STUDY_SLIDE_STAIN_GROUPS.includes(group as StudySlideStainGroup)
            ),
            matchLevels: list(
                query.wsiMatch
            ).filter((level): level is StudySlideMatchLevel =>
                STUDY_SLIDE_MATCH_LEVELS.includes(level as StudySlideMatchLevel)
            ),
            search: (query.wsiSearch || '').trim(),
        },
    };
}

export interface StudyPathologySlidesStoreOptions {
    /**
     * The study-view cohort (see getStudyViewResourceCohort), or undefined while it loads; the
     * list reloads when it changes.
     */
    getCohort: () => ResourceCohort | undefined;
    /** The queried physical studies, for deciding whether to show the tab. */
    getStudyIds: () => string[];
    /** Called when the user, or a cohort change, selects another patient. */
    onSelectionChange?: (patient: StudySlidePatientRef | undefined) => void;
    /** Patient to show first, such as one restored from the URL. */
    initialSelection?: StudySlidePatientRef;
    initialView?: StudySlidesView;
    /** Called when the user switches between the viewer and the slide table. */
    onViewChange?: (view: StudySlidesView) => void;
    /** The list's own filters to start with, such as ones restored from the URL. */
    initialSlideFilters?: StudySlideListFilters;
    /** Called when the list's own filters change. */
    onSlideFiltersChange?: (filters: StudySlideListFilters) => void;
    /** The resource-table endpoints; tests pass their own. */
    api?: StudySlidesResourceApi;
    pageSize?: number;
}

/**
 * State of the study-view Pathology Slides tab: one page of the cohort's
 * patients with slides, and the patient shown in the viewer. The list is the
 * slide resources grouped by patient (resource-table groups/fetch).
 *
 * Every list request also asks the server where the selected patient is in
 * the full list, so the selection keeps its place ("i of N") across list
 * pages, and survives cohort and list-filter changes while the patient is
 * still listed.
 */
export class StudyPathologySlidesStore {
    @observable.ref stainGroups: StudySlideStainGroup[] = [];
    @observable.ref matchLevels: StudySlideMatchLevel[] = [];
    @observable searchText = '';
    /** The applied (debounced) patient/sample ID search. */
    @observable search = '';
    @observable pageNumber = 0;
    @observable.ref selected: StudySlidePatientRef | undefined;
    @observable view: StudySlidesView = 'viewer';
    /** Slide the viewer opens for the selected patient, chosen from the slide table. */
    @observable requestedSlideKey: string | undefined;
    /** Zero-based position of the selected patient in the full list. */
    @observable selectedIndex: number | undefined;
    @observable private reloadCount = 0;
    /** The cohort the list reads, once the study view has one. */
    @observable.ref private cohort: ResourceCohort | undefined;

    readonly pageSize: number;
    private readonly getStudyIds: () => string[];
    private readonly onSelectionChange?: (
        patient: StudySlidePatientRef | undefined
    ) => void;
    private readonly onViewChange?: (view: StudySlidesView) => void;
    private readonly api: StudySlidesResourceApi;
    // Page offset to select once the requested page loads (prev/next across pages).
    private selectOnLoad: number | undefined;
    // After a cohort or list-filter change, move the list to the selected patient's page.
    private followSelection: boolean;
    // A slide opened from the slide table whose patient the list has yet to locate.
    private locatePending = false;
    private searchTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly disposers: IReactionDisposer[] = [];

    constructor(options: StudyPathologySlidesStoreOptions) {
        this.getStudyIds = options.getStudyIds;
        this.onSelectionChange = options.onSelectionChange;
        this.onViewChange = options.onViewChange;
        this.view = options.initialView || 'viewer';
        this.api = options.api || RESOURCE_TABLE_API;
        this.pageSize = options.pageSize || STUDY_SLIDES_PAGE_SIZE;
        this.selected = options.initialSelection;
        this.followSelection = !!options.initialSelection;
        if (options.initialSlideFilters) {
            this.stainGroups = options.initialSlideFilters.stainGroups;
            this.matchLevels = options.initialSlideFilters.matchLevels;
            this.search = this.searchText = options.initialSlideFilters.search;
        }
        this.cohort = options.getCohort();
        makeObservable(this);
        this.disposers.push(
            reaction(
                () => options.getCohort(),
                cohort => this.setCohort(cohort)
            )
        );
        const onSlideFiltersChange = options.onSlideFiltersChange;
        if (onSlideFiltersChange) {
            this.disposers.push(
                reaction(
                    () => this.slideFilters,
                    filters => onSlideFiltersChange(filters),
                    { equals: comparer.structural }
                )
            );
        }
    }

    /** The slide resources the queried studies hold; none when they have no slides. */
    readonly slideResourceIds = remoteData<string[]>({
        invoke: async () => {
            try {
                return await fetchStudySlideResourceIds(
                    this.getStudyIds(),
                    this.api
                );
            } catch (e) {
                return [];
            }
        },
        default: [],
    });

    /** Whether the queried studies have any pathology slides. */
    readonly studyHasSlides = remoteData<boolean>({
        await: () => [this.slideResourceIds],
        invoke: async () => this.slideResourceIds.result!.length > 0,
        default: false,
    });

    /**
     * The slides the list reads before the stain and match filters, which the filter options
     * ignore; undefined until the cohort is known.
     */
    @computed private get unfilteredSelection():
        | StudySlidesSelection
        | undefined {
        if (!this.cohort || !this.slideResourceIds.isComplete) {
            return undefined;
        }
        return {
            cohort: this.cohort,
            resourceIds: this.slideResourceIds.result!,
            stainGroups: [],
            matchLevels: [],
            search: this.search || undefined,
        };
    }

    /** The slides the list reads, without paging; undefined until the cohort is known. */
    @computed private get selection(): StudySlidesSelection | undefined {
        const unfiltered = this.unfilteredSelection;
        return (
            unfiltered && {
                ...unfiltered,
                stainGroups: this.stainGroups.slice(),
                matchLevels: this.matchLevels.slice(),
            }
        );
    }

    readonly page = remoteData<StudySlidesPage>({
        await: () => [this.slideResourceIds],
        invoke: () => {
            // Tracked: a change to any of these reloads the page.
            const selection = this.selection;
            const pageNumber = this.pageNumber;
            void this.reloadCount;
            if (!selection) {
                // The cohort is still loading; its arrival re-runs this.
                return new Promise<StudySlidesPage>(() => {});
            }
            const request: StudySlidesRequest = {
                ...selection,
                pageNumber,
                pageSize: this.pageSize,
            };
            // Untracked: selecting a patient does not reload the list.
            const selected = untracked(() => this.selected);
            if (selected) {
                request.locate = {
                    studyId: selected.studyId,
                    patientId: selected.patientId,
                };
            }
            return handled(fetchStudySlidesPage(request, this.api));
        },
        onResult: page => {
            if (page) {
                this.reconcile(page);
            }
        },
        // The tab shows its own message and retry for a failed request.
        onError: () => {},
    });

    /**
     * Patients per value of the slide columns the list filters by. The column filters do not
     * narrow them, so a stain or match filter does not re-request them.
     */
    readonly facets = remoteData<StudySlideFacets>({
        await: () => [this.slideResourceIds],
        invoke: () => {
            const selection = this.unfilteredSelection;
            if (!selection) {
                return new Promise<StudySlideFacets>(() => {});
            }
            return handled(fetchStudySlideFacets(selection, this.api));
        },
        default: {},
        onError: () => {},
    });

    /** Patients with slides of each stain group, for the stain filter. */
    @computed get stainGroupPatientCounts(): StudySlideStainCounts {
        return stainGroupPatientCounts(this.facets.result);
    }

    @action
    private setCohort(cohort: ResourceCohort | undefined) {
        // Undefined while the study view's selection reloads: keep the list as it is.
        if (!cohort || (this.cohort && sameCohort(cohort, this.cohort))) {
            return;
        }
        this.cohort = cohort;
        this.restartList();
    }

    @action.bound
    toggleMatchLevel(level: StudySlideMatchLevel) {
        this.matchLevels = this.matchLevels.includes(level)
            ? this.matchLevels.filter(l => l !== level)
            : [...this.matchLevels, level];
        this.restartList();
    }

    @action.bound
    clearMatchLevels() {
        this.matchLevels = [];
        this.restartList();
    }

    @action.bound
    clearStainGroups() {
        this.stainGroups = [];
        this.restartList();
    }

    /** Clears the tab's own filters; the study-view filters stay. */
    @action.bound
    clearSlideFilters() {
        this.resetSlideFilters();
        this.restartList();
    }

    @action
    private resetSlideFilters() {
        this.stainGroups = [];
        this.matchLevels = [];
        this.searchText = '';
        this.applySearch();
    }

    @computed get slideFilters(): StudySlideListFilters {
        return {
            stainGroups: this.stainGroups.slice(),
            matchLevels: this.matchLevels.slice(),
            search: this.search,
        };
    }

    /**
     * Takes the patient and list filters from the URL, e.g. after Back or
     * Forward, without reporting them back as changes.
     */
    @action.bound
    followUrl(
        selection: StudySlidePatientRef | undefined,
        filters: StudySlideListFilters
    ) {
        if (!comparer.structural(filters, this.slideFilters)) {
            this.stainGroups = filters.stainGroups;
            this.matchLevels = filters.matchLevels;
            this.searchText = filters.search;
            this.search = filters.search;
            this.restartList();
        }
        if (selection && !isSamePatient(selection, this.selected)) {
            this.selected = {
                studyId: selection.studyId,
                patientId: selection.patientId,
            };
            this.selectedIndex = undefined;
            this.requestedSlideKey = undefined;
            // Reload to find the patient's place in the list.
            this.followSelection = true;
            this.reloadCount += 1;
        }
    }

    @computed get hasSlideFilters(): boolean {
        return (
            this.stainGroups.length > 0 ||
            this.matchLevels.length > 0 ||
            this.search !== ''
        );
    }

    @computed get totalPatients(): number {
        return this.page.result?.totalPatients ?? 0;
    }

    @computed get pageCount(): number {
        return Math.max(1, Math.ceil(this.totalPatients / this.pageSize));
    }

    /** A requested list page is still loading; the previous page stays shown. */
    @computed get isPageLoading(): boolean {
        return this.page.isPending;
    }

    /**
     * The requested page's patient range, known as soon as a page is
     * requested so the pager answers a click before the list arrives.
     */
    @computed get displayedRange(): { first: number; last: number } {
        const first = this.pageNumber * this.pageSize;
        return {
            first: Math.min(first + 1, this.totalPatients),
            last: Math.min(first + this.pageSize, this.totalPatients),
        };
    }

    /** The list page of the selected patient, when it is listed. */
    @computed get selectedPageNumber(): number | undefined {
        return this.selectedIndex === undefined
            ? undefined
            : Math.floor(this.selectedIndex / this.pageSize);
    }

    @action.bound
    goToSelectedPage() {
        if (this.selectedPageNumber !== undefined) {
            this.pageNumber = this.selectedPageNumber;
        }
    }

    @computed get hasPrevious(): boolean {
        return this.selectedIndex !== undefined && this.selectedIndex > 0;
    }

    @computed get hasNext(): boolean {
        return (
            this.selectedIndex !== undefined &&
            this.selectedIndex + 1 < this.totalPatients
        );
    }

    @action.bound
    selectPatient(patient: StudySlidePatient | StudySlidePatientRef) {
        const index = this.page.result?.patients.findIndex(p =>
            isSamePatient(p, patient)
        );
        this.setSelection(
            { studyId: patient.studyId, patientId: patient.patientId },
            index !== undefined && index >= 0
                ? this.pageNumber * this.pageSize + index
                : undefined
        );
    }

    @action.bound
    setView(view: StudySlidesView) {
        if (view !== this.view) {
            this.view = view;
            this.onViewChange?.(view);
        }
    }

    /** Shows one slide from the slide table in the viewer, with its patient selected. */
    @action.bound
    openSlide(patient: StudySlidePatientRef, slideKey: string | undefined) {
        this.selectPatient(patient);
        this.requestedSlideKey = slideKey;
        if (this.selectedIndex === undefined) {
            // Not on this list page: reload to locate the patient (see reconcile).
            this.locatePending = true;
            this.followSelection = true;
            this.reloadCount += 1;
        }
        this.setView('viewer');
    }

    @action.bound
    selectNext() {
        if (this.hasNext) {
            this.selectAt(this.selectedIndex! + 1);
        }
    }

    @action.bound
    selectPrevious() {
        if (this.hasPrevious) {
            this.selectAt(this.selectedIndex! - 1);
        }
    }

    @action.bound
    setPageNumber(pageNumber: number) {
        this.pageNumber = Math.min(Math.max(0, pageNumber), this.pageCount - 1);
    }

    @action.bound
    toggleStainGroup(stainGroup: StudySlideStainGroup) {
        this.stainGroups = this.stainGroups.includes(stainGroup)
            ? this.stainGroups.filter(g => g !== stainGroup)
            : [...this.stainGroups, stainGroup];
        this.restartList();
    }

    /** Updates the typed ID search, which narrows the list after a pause. */
    @action.bound
    setSearchText(text: string) {
        this.searchText = text;
        if (this.searchTimer !== undefined) {
            clearTimeout(this.searchTimer);
        }
        this.searchTimer = setTimeout(
            () => this.applySearch(),
            STUDY_SLIDES_SEARCH_DEBOUNCE_MS
        );
    }

    @action.bound
    reload() {
        this.reloadCount += 1;
    }

    dispose() {
        this.disposers.forEach(dispose => dispose());
        if (this.searchTimer !== undefined) {
            clearTimeout(this.searchTimer);
        }
    }

    /** Applies the typed search now, without waiting for the debounce. */
    @action.bound
    applySearch() {
        if (this.searchTimer !== undefined) {
            clearTimeout(this.searchTimer);
        }
        this.searchTimer = undefined;
        const search = this.searchText.trim();
        if (search !== this.search) {
            this.search = search;
            this.restartList();
        }
    }

    @action
    private restartList() {
        this.pageNumber = 0;
        this.selectOnLoad = undefined;
        this.followSelection = !!this.selected;
    }

    @action
    private selectAt(index: number) {
        const pageNumber = Math.floor(index / this.pageSize);
        const offset = index - pageNumber * this.pageSize;
        const page = this.page.result;
        if (pageNumber === this.pageNumber && page?.patients[offset]) {
            this.setSelection(page.patients[offset], index);
        } else {
            this.selectOnLoad = offset;
            this.pageNumber = pageNumber;
        }
    }

    @action
    private setSelection(
        patient: StudySlidePatientRef | undefined,
        index: number | undefined
    ) {
        const ref = patient && {
            studyId: patient.studyId,
            patientId: patient.patientId,
        };
        const changed =
            !isSamePatient(ref, this.selected) && !!(ref || this.selected);
        this.selected = ref;
        this.selectedIndex = index;
        if (changed) {
            this.requestedSlideKey = undefined;
            this.onSelectionChange?.(ref);
        }
    }

    @action
    private reconcile(page: StudySlidesPage) {
        const pageStart = page.pageNumber * page.pageSize;
        if (this.selectOnLoad !== undefined) {
            const offset = Math.min(
                this.selectOnLoad,
                page.patients.length - 1
            );
            this.selectOnLoad = undefined;
            if (offset >= 0) {
                this.setSelection(page.patients[offset], pageStart + offset);
                return;
            }
        }

        if (this.locatePending) {
            this.locatePending = false;
            if (
                this.selected &&
                page.locatedIndex === null &&
                this.hasSlideFilters
            ) {
                // The list's own filters hide the patient opened from the slide table: clear
                // them rather than replace the patient.
                this.clearSlideFilters();
                return;
            }
        }

        if (this.selected && page.locatedIndex !== null) {
            // The selected patient is still listed.
            this.selectedIndex = page.locatedIndex;
            const selectedPage = Math.floor(page.locatedIndex / this.pageSize);
            if (this.followSelection && selectedPage !== this.pageNumber) {
                this.followSelection = false;
                this.pageNumber = selectedPage;
                return;
            }
            this.followSelection = false;
            return;
        }

        this.followSelection = false;
        // No selection yet, or the selected patient left the list: show the
        // first listed patient, if any.
        this.setSelection(
            page.patients[0],
            page.patients.length > 0 ? pageStart : undefined
        );
    }
}
