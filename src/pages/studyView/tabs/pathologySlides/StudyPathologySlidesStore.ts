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
    fetchStudySlideFacets,
    fetchStudySlidePatients,
    STUDY_SLIDE_MATCH_LABELS,
    STUDY_SLIDE_MATCH_LEVELS,
    StudySlideAttributeFacet,
    StudySlideFacets,
    StudySlideFacetsRequest,
    StudySlideMatchLevel,
    StudySlidePatient,
    StudySlidesPage,
    StudySlidesRequest,
    StudySlideStainGroup,
} from './studySlidesApi';

export const STUDY_SLIDES_PAGE_SIZE = 50;
export const STUDY_SLIDES_SEARCH_DEBOUNCE_MS = 300;

/** Clinical filters offered when the study has more than one value. */
export const DEFAULT_FACET_ATTRIBUTE_IDS = [
    'CANCER_TYPE',
    'CANCER_TYPE_DETAILED',
    'SAMPLE_TYPE',
];
/** Attributes whose values the search suggests, beyond the shown filters. */
export const SUGGESTION_ATTRIBUTE_LIMIT = 12;
export const MAX_SUGGESTIONS = 8;
/** Browser-stored attributes the user added with "More filters". */
export const PINNED_FACETS_KEY = 'wsi.study.pinnedFacets';

export interface StudySlidesClinicalAttribute {
    attributeId: string;
    displayName: string;
}

/** The study view's clinical filters, shared with the rest of the page. */
export interface StudySlidesClinicalAccess {
    /** Categorical attributes, most important first. */
    getAttributes: () => StudySlidesClinicalAttribute[];
    /** Selected values of each attribute with a study-view clinical filter. */
    getFilters: () => { attributeId: string; values: string[] }[];
    /** Replaces an attribute's filter; no values removes it. */
    setFilterValues: (attributeId: string, values: string[]) => void;
}

export type StudySlidesSuggestion =
    | {
          kind: 'clinical';
          attributeId: string;
          displayName: string;
          value: string;
          patientCount: number;
      }
    | { kind: 'match'; level: StudySlideMatchLevel; patientCount: number };

function readPinnedAttributeIds(): string[] {
    try {
        const stored = JSON.parse(
            window.localStorage.getItem(PINNED_FACETS_KEY) || '[]'
        );
        return Array.isArray(stored)
            ? stored.filter(id => typeof id === 'string')
            : [];
    } catch (e) {
        return [];
    }
}

function writePinnedAttributeIds(ids: string[]) {
    try {
        window.localStorage.setItem(PINNED_FACETS_KEY, JSON.stringify(ids));
    } catch (e) {
        // Blocked storage only loses the remembered filters.
    }
}

/** Patient and sample IDs carry digits or dashes; clinical words rarely do. */
export function looksLikeId(text: string): boolean {
    return /[0-9-]/.test(text);
}

/** Values that are nearly all different, such as IDs, make poor suggestions. */
function isIdLike(facet: StudySlideAttributeFacet): boolean {
    return (
        facet.values.length >= 50 &&
        facet.values.filter(v => v.patientCount > 1).length <
            facet.values.length / 2
    );
}

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

export interface StudyPathologySlidesStoreOptions {
    /** The study-view cohort; the list reloads when it changes. */
    getFilters: () => StudyViewFilter;
    /** The queried physical studies, for deciding whether to show the tab. */
    getStudyIds: () => string[];
    /** Called when the user, or a cohort change, selects another patient. */
    onSelectionChange?: (patient: StudySlidePatientRef | undefined) => void;
    /** Patient to show first, such as one restored from the URL. */
    initialSelection?: StudySlidePatientRef;
    fetchPage?: (request: StudySlidesRequest) => Promise<StudySlidesPage>;
    fetchFacets?: (
        request: StudySlideFacetsRequest
    ) => Promise<StudySlideFacets>;
    /** The study view's clinical filters; without it no clinical filters show. */
    clinical?: StudySlidesClinicalAccess;
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
    @observable.ref pinnedAttributeIds: string[] = readPinnedAttributeIds();
    /** Set while the search has focus, to load suggestion values. */
    @observable private suggestionsWanted = false;
    @observable pageNumber = 0;
    @observable.ref selected: StudySlidePatientRef | undefined;
    /** Zero-based position of the selected patient in the full list. */
    @observable selectedIndex: number | undefined;
    @observable private reloadCount = 0;

    readonly pageSize: number;
    private readonly getFilters: () => StudyViewFilter;
    private readonly getStudyIds: () => string[];
    private readonly onSelectionChange?: (
        patient: StudySlidePatientRef | undefined
    ) => void;
    private readonly fetchPage: (
        request: StudySlidesRequest
    ) => Promise<StudySlidesPage>;
    private readonly fetchFacets: (
        request: StudySlideFacetsRequest
    ) => Promise<StudySlideFacets>;
    readonly clinical?: StudySlidesClinicalAccess;
    // Page offset to select once the requested page loads (prev/next across pages).
    private selectOnLoad: number | undefined;
    // After a cohort or list-filter change, move the list to the selected patient's page.
    private followSelection: boolean;
    private searchTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly disposers: IReactionDisposer[] = [];

    constructor(options: StudyPathologySlidesStoreOptions) {
        this.getFilters = options.getFilters;
        this.getStudyIds = options.getStudyIds;
        this.onSelectionChange = options.onSelectionChange;
        this.fetchPage = options.fetchPage || fetchStudySlidePatients;
        this.fetchFacets = options.fetchFacets || fetchStudySlideFacets;
        this.clinical = options.clinical;
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
                    viewableOnly: true,
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
                viewableOnly: true,
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

    /** Categorical attributes by ID, for labels. */
    @computed get clinicalAttributesById(): {
        [attributeId: string]: StudySlidesClinicalAttribute;
    } {
        const byId: { [id: string]: StudySlidesClinicalAttribute } = {};
        (this.clinical?.getAttributes() || []).forEach(
            a => (byId[a.attributeId] = a)
        );
        return byId;
    }

    /** The study view's clinical filters, for chips. */
    @computed get clinicalFilters(): {
        attributeId: string;
        displayName: string;
        values: string[];
    }[] {
        return (this.clinical?.getFilters() || []).map(f => ({
            ...f,
            displayName:
                this.clinicalAttributesById[f.attributeId]?.displayName ||
                f.attributeId,
        }));
    }

    /**
     * Attributes shown as filters: the defaults, the user's pinned ones and
     * any with a study-view filter, when the study has them.
     */
    @computed get facetAttributeIds(): string[] {
        const known = this.clinicalAttributesById;
        return Array.from(
            new Set([
                ...DEFAULT_FACET_ATTRIBUTE_IDS,
                ...this.pinnedAttributeIds,
                ...this.clinicalFilters.map(f => f.attributeId),
            ])
        )
            .filter(id => !!known[id])
            .slice(0, 20);
    }

    private facetRequest(attributeIds: string[]): StudySlideFacetsRequest {
        // The ID search narrows only the list, so suggestions and filter
        // counts are not emptied by a value being typed.
        return {
            studyViewFilter: this.getFilters(),
            viewableOnly: true,
            stainGroups: this.stainGroups.slice(),
            matchLevels: this.matchLevels.slice(),
            attributeIds,
        };
    }

    readonly facets = remoteData<StudySlideFacets>({
        invoke: () =>
            this.fetchFacets(this.facetRequest(this.facetAttributeIds)),
        onError: () => {},
    });

    /**
     * Clinical filters to show: attributes with more than one value, or with
     * a filter set, in the order of `facetAttributeIds`.
     */
    @computed get visibleFacets(): StudySlideAttributeFacet[] {
        const filtered = new Set(this.clinicalFilters.map(f => f.attributeId));
        return (this.facets.result?.attributes || []).filter(
            f => f.values.length > 1 || filtered.has(f.attributeId)
        );
    }

    /** Values of further attributes, loaded once the search is used. */
    readonly suggestionFacets = remoteData<StudySlideAttributeFacet[]>({
        invoke: async () => {
            if (!this.suggestionsWanted || !this.clinical) {
                return [];
            }
            const shown = new Set(this.facetAttributeIds);
            const attributeIds = this.clinical
                .getAttributes()
                .map(a => a.attributeId)
                .filter(id => !shown.has(id))
                .slice(0, Math.max(0, SUGGESTION_ATTRIBUTE_LIMIT - shown.size));
            if (attributeIds.length === 0) {
                return [];
            }
            const facets = await this.fetchFacets(
                this.facetRequest(attributeIds)
            );
            return facets.attributes.filter(f => !isIdLike(f));
        },
        default: [],
        onError: () => {},
    });

    /** Clinical values and match levels whose name contains `text`. */
    suggestionsFor(text: string): StudySlidesSuggestion[] {
        const needle = text.trim().toLowerCase();
        if (!needle) {
            return [];
        }
        const attributes = [
            ...(this.facets.result?.attributes || []),
            ...(this.suggestionFacets.result || []),
        ];
        const clinical: StudySlidesSuggestion[] = [];
        const seen = new Set<string>();
        attributes.forEach(facet =>
            facet.values.forEach(v => {
                const key = `${facet.attributeId}\u0000${v.value}`;
                if (v.value.toLowerCase().includes(needle) && !seen.has(key)) {
                    seen.add(key);
                    clinical.push({
                        kind: 'clinical',
                        attributeId: facet.attributeId,
                        displayName:
                            this.clinicalAttributesById[facet.attributeId]
                                ?.displayName || facet.attributeId,
                        value: v.value,
                        patientCount: v.patientCount,
                    });
                }
            })
        );
        const match: StudySlidesSuggestion[] = STUDY_SLIDE_MATCH_LEVELS.filter(
            level =>
                STUDY_SLIDE_MATCH_LABELS[level].toLowerCase().includes(needle)
        ).map(level => ({
            kind: 'match' as const,
            level,
            patientCount: this.facets.result?.matchLevels?.[level] ?? 0,
        }));
        return [...clinical, ...match]
            .sort((a, b) => b.patientCount - a.patientCount)
            .slice(0, MAX_SUGGESTIONS);
    }

    /** The search has focus: load suggestion values for it. */
    @action.bound
    requestSuggestions() {
        this.suggestionsWanted = true;
    }

    /**
     * The search lost focus: stop reloading suggestion values on every
     * filter change, which would compete with the list and filter counts.
     */
    @action.bound
    releaseSuggestions() {
        this.suggestionsWanted = false;
    }

    /** Selected values of an attribute's study-view filter. */
    clinicalValues(attributeId: string): string[] {
        return (
            this.clinicalFilters.find(f => f.attributeId === attributeId)
                ?.values || []
        );
    }

    @action.bound
    setClinicalValues(attributeId: string, values: string[]) {
        this.clinical?.setFilterValues(attributeId, values);
    }

    @action.bound
    addClinicalValue(attributeId: string, value: string) {
        const values = this.clinicalValues(attributeId);
        if (!values.includes(value)) {
            this.setClinicalValues(attributeId, [...values, value]);
        }
    }

    @action.bound
    pinAttribute(attributeId: string) {
        if (!this.pinnedAttributeIds.includes(attributeId)) {
            this.pinnedAttributeIds = [...this.pinnedAttributeIds, attributeId];
            writePinnedAttributeIds(this.pinnedAttributeIds);
        }
    }

    @action.bound
    unpinAttribute(attributeId: string) {
        this.pinnedAttributeIds = this.pinnedAttributeIds.filter(
            id => id !== attributeId
        );
        writePinnedAttributeIds(this.pinnedAttributeIds);
        this.setClinicalValues(attributeId, []);
    }

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

    /**
     * Updates the typed search. Text that looks like an ID (or no text)
     * narrows the list after a pause; other text, such as a cancer type, is
     * left for the suggestions until the ID search is chosen explicitly.
     */
    @action.bound
    setSearchText(text: string) {
        this.searchText = text;
        if (this.searchTimer !== undefined) {
            clearTimeout(this.searchTimer);
            this.searchTimer = undefined;
        }
        if (looksLikeId(text) || text.trim() === '') {
            this.searchTimer = setTimeout(
                () => this.applySearch(),
                STUDY_SLIDES_SEARCH_DEBOUNCE_MS
            );
        }
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
