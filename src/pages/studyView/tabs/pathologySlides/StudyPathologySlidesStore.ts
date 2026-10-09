import {
    action,
    computed,
    IReactionDisposer,
    makeObservable,
    observable,
    reaction,
    untracked,
} from 'mobx';
import { remoteData } from 'cbioportal-frontend-commons';
import { StudyViewFilter } from 'cbioportal-ts-api-client';
import {
    fetchStudySlidePatients,
    StudySlideMatchLevel,
    StudySlidePatient,
    StudySlidesPage,
    StudySlidesRequest,
    StudySlideStainGroup,
} from './studySlidesApi';

export const STUDY_SLIDES_PAGE_SIZE = 50;
export const STUDY_SLIDES_SEARCH_DEBOUNCE_MS = 300;

export interface StudySlidePatientRef {
    studyId: string;
    patientId: string;
}

export function isSamePatient(
    a: StudySlidePatientRef | undefined,
    b: StudySlidePatientRef | undefined
): boolean {
    return !!a && !!b && a.studyId === b.studyId && a.patientId === b.patientId;
}

/** The tab's two views: patients beside the viewer, or the cohort's slide table. */
export type StudySlidesView = 'viewer' | 'table';

export interface StudyPathologySlidesStoreOptions {
    /** The study-view cohort; the list reloads when it changes. */
    getFilters: () => StudyViewFilter;
    /** The queried physical studies, for deciding whether to show the tab. */
    getStudyIds: () => string[];
    /** Called when the user, or a cohort change, selects another patient. */
    onSelectionChange?: (patient: StudySlidePatientRef | undefined) => void;
    /** Patient to show first, such as one restored from the URL. */
    initialSelection?: StudySlidePatientRef;
    initialView?: StudySlidesView;
    /** Called when the user switches between the viewer and the slide table. */
    onViewChange?: (view: StudySlidesView) => void;
    fetchPage?: (request: StudySlidesRequest) => Promise<StudySlidesPage>;
    pageSize?: number;
}

/**
 * State of the study-view Pathology Slides tab: one page of the cohort's
 * patients with slides, and the patient shown in the viewer.
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

    readonly pageSize: number;
    private readonly getFilters: () => StudyViewFilter;
    private readonly getStudyIds: () => string[];
    private readonly onSelectionChange?: (
        patient: StudySlidePatientRef | undefined
    ) => void;
    private readonly onViewChange?: (view: StudySlidesView) => void;
    private readonly fetchPage: (
        request: StudySlidesRequest
    ) => Promise<StudySlidesPage>;
    // Page offset to select once the requested page loads (prev/next across pages).
    private selectOnLoad: number | undefined;
    // After a cohort or list-filter change, move the list to the selected patient's page.
    private followSelection: boolean;
    // A slide opened from the slide table whose patient the list has yet to locate.
    private locatePending = false;
    private searchTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly disposers: IReactionDisposer[] = [];

    constructor(options: StudyPathologySlidesStoreOptions) {
        this.getFilters = options.getFilters;
        this.getStudyIds = options.getStudyIds;
        this.onSelectionChange = options.onSelectionChange;
        this.onViewChange = options.onViewChange;
        this.view = options.initialView || 'viewer';
        this.fetchPage = options.fetchPage || fetchStudySlidePatients;
        this.pageSize = options.pageSize || STUDY_SLIDES_PAGE_SIZE;
        this.selected = options.initialSelection;
        this.followSelection = !!options.initialSelection;
        makeObservable(this);
        this.disposers.push(
            reaction(
                () => this.getFilters(),
                () => this.restartList()
            )
        );
    }

    /** Whether the queried studies have any pathology slides. */
    readonly studyHasSlides = remoteData<boolean>({
        invoke: async () => {
            const studyIds = this.getStudyIds();
            if (studyIds.length === 0) {
                return false;
            }
            try {
                const page = await this.fetchPage({
                    studyViewFilter: { studyIds } as StudyViewFilter,
                    pageSize: 1,
                });
                return page.totalSlides > 0;
            } catch (e) {
                return false;
            }
        },
        default: false,
    });

    readonly page = remoteData<StudySlidesPage>({
        invoke: () => {
            // Tracked: a change to any of these reloads the page.
            const request: StudySlidesRequest = {
                studyViewFilter: this.getFilters(),
                stainGroups: this.stainGroups.slice(),
                matchLevels: this.matchLevels.slice(),
                search: this.search || undefined,
                pageNumber: this.pageNumber,
                pageSize: this.pageSize,
            };
            void this.reloadCount;
            // Untracked: selecting a patient does not reload the list.
            const selected = untracked(() => this.selected);
            if (selected) {
                request.locateStudyId = selected.studyId;
                request.locatePatientId = selected.patientId;
            }
            return this.fetchPage(request);
        },
        onResult: page => {
            if (page) {
                this.reconcile(page);
            }
        },
        // The tab shows its own message and retry for a failed request.
        onError: () => {},
    });

    @action.bound
    toggleMatchLevel(level: StudySlideMatchLevel) {
        this.matchLevels = this.matchLevels.includes(level)
            ? this.matchLevels.filter(l => l !== level)
            : [...this.matchLevels, level];
        this.restartList();
    }

    /** Clears the tab's own filters; the study-view filters stay. */
    @action.bound
    clearSlideFilters() {
        this.stainGroups = [];
        this.matchLevels = [];
        this.searchText = '';
        this.applySearch();
        this.restartList();
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

    @action.bound
    clearStainGroups() {
        if (this.stainGroups.length > 0) {
            this.stainGroups = [];
            this.restartList();
        }
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
                (this.stainGroups.length > 0 ||
                    this.matchLevels.length > 0 ||
                    this.search !== '')
            ) {
                // The list's own filters hide the patient opened from the slide table: clear
                // them rather than replace the patient.
                this.stainGroups = [];
                this.matchLevels = [];
                this.search = '';
                this.searchText = '';
                this.restartList();
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
