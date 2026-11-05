import { WsiStainFilter } from 'cbioportal-wsi-viewer';
import {
    fetchResourceTableGroups,
    fetchResourceTableMetadata,
    fetchResourceTableTabs,
    RESOURCE_GROUPS_MAX_PAGE_SIZE,
    ResourceColumnFilter,
    ResourceTableGroup,
} from 'shared/api/resourceTableClient';
import {
    buildResourceTableGroupsMetadataQuery,
    buildResourceTableGroupsQuery,
    ResourceTableGroupsState,
} from 'shared/components/resourceTable/GroupedResourceTableStore';
import { ResourceCohort } from 'shared/components/resourceTable/resourceTableCohort';
import {
    PATHOLOGY_SLIDES_RESOURCE_TAB,
    resourceSearchTermForQuery,
    STAIN_GROUP_TO_SLIDE_STAIN_FILTER,
} from 'shared/lib/ResourcePolicy';

/**
 * The Pathology Slides tab's data: the slide resources (WSI_SAMPLE and WSI_PATIENT) read through
 * the generic resource-table API, grouped by patient.
 */

export type StudySlideStainGroup = 'H&E' | 'IHC' | 'Other' | 'Unknown';

/** The slide rows' stain groups, which the list counts and filters by. */
export const STUDY_SLIDE_STAIN_GROUPS: StudySlideStainGroup[] = [
    'H&E',
    'IHC',
    'Other',
    'Unknown',
];

/** How a slide's specimen is matched to a sequenced sample. */
export type StudySlideMatchLevel = 'PART' | 'BLOCK' | 'UNMATCHED';

export const STUDY_SLIDE_MATCH_LEVELS: StudySlideMatchLevel[] = [
    'PART',
    'BLOCK',
    'UNMATCHED',
];

export const STUDY_SLIDE_MATCH_LABELS: Record<StudySlideMatchLevel, string> = {
    PART: 'Part',
    BLOCK: 'Block',
    UNMATCHED: 'Unmatched',
};

/** The slide rows' stain group and match level columns. */
export const STAIN_GROUP_COLUMN = 'metadata:stain_group';
export const MATCH_LEVEL_COLUMN = 'metadata:match_level';
const METADATA_COLUMN_PREFIX = 'metadata:';

export type StudySlideStainCounts = Record<StudySlideStainGroup, number>;

export interface StudySlidePatientRef {
    studyId: string;
    patientId: string;
}

export interface StudySlidePatient extends StudySlidePatientRef {
    slideCount: number;
    /** The samples the listed slides are matched to; unmatched slides have none. */
    sampleCount: number;
    stainGroupCounts: StudySlideStainCounts;
}

export interface StudySlidesPage {
    totalPatients: number;
    totalSlides: number;
    /** Position of the requested patient in the full list, when it is in it. */
    locatedIndex: number | null;
    pageNumber: number;
    pageSize: number;
    patients: StudySlidePatient[];
}

/** Selected values of slide columns (`metadata:<key>`), each column narrowing the list. */
export interface StudySlideColumnFilters {
    [columnId: string]: string[];
}

/** The slides a list reads: the cohort's, narrowed by the tab's own filters. */
export interface StudySlidesSelection {
    cohort: ResourceCohort;
    /** The slide resources the cohort's studies hold; see fetchStudySlideResourceIds. */
    resourceIds: string[];
    stainGroups: StudySlideStainGroup[];
    matchLevels: StudySlideMatchLevel[];
    /** Filters on other slide columns. */
    columnFilters: StudySlideColumnFilters;
    /** Keeps slides whose IDs or metadata contain this, ignoring case. */
    search?: string;
}

export interface StudySlidesRequest extends StudySlidesSelection {
    /** A patient whose place in the full list to report. */
    locate?: StudySlidePatientRef;
    pageNumber: number;
    pageSize: number;
}

/** The resource-table endpoints the tab reads; tests pass their own. */
export interface StudySlidesResourceApi {
    tabs: typeof fetchResourceTableTabs;
    groups: typeof fetchResourceTableGroups;
    metadata: typeof fetchResourceTableMetadata;
}

export const RESOURCE_TABLE_API: StudySlidesResourceApi = {
    tabs: fetchResourceTableTabs,
    groups: fetchResourceTableGroups,
    metadata: fetchResourceTableMetadata,
};

/** The tab's filters as resource-table column filters. */
export function studySlidesColumnFilters(
    selection: Pick<
        StudySlidesSelection,
        'stainGroups' | 'matchLevels' | 'columnFilters'
    >
): ResourceColumnFilter[] {
    const filters: ResourceColumnFilter[] = [];
    if (selection.stainGroups.length > 0) {
        filters.push({
            columnId: STAIN_GROUP_COLUMN,
            operator: 'in',
            values: selection.stainGroups.slice(),
        });
    }
    if (selection.matchLevels.length > 0) {
        filters.push({
            columnId: MATCH_LEVEL_COLUMN,
            operator: 'in',
            values: selection.matchLevels.slice(),
        });
    }
    Object.keys(selection.columnFilters)
        .sort()
        .forEach(columnId => {
            const values = selection.columnFilters[columnId];
            if (values.length > 0) {
                filters.push({ columnId, operator: 'in', values });
            }
        });
    return filters;
}

/** The grouped-table state of a slide list request, grouped by `groupBy`. */
function groupsState(
    request: StudySlidesSelection &
        Partial<Pick<StudySlidesRequest, 'locate' | 'pageNumber' | 'pageSize'>>,
    groupBy: 'patient' | 'sample',
    extraFilters: ResourceColumnFilter[] = []
): ResourceTableGroupsState {
    return {
        cohort: request.cohort,
        resourceIds: request.resourceIds,
        groupBy,
        groupCounts: groupBy === 'patient' ? [STAIN_GROUP_COLUMN] : [],
        // A pasted Slide ID searches for its slide key.
        search: request.search
            ? resourceSearchTermForQuery(request.resourceIds, request.search)
            : '',
        filters: [...studySlidesColumnFilters(request), ...extraFilters],
        direction: 'asc',
        pageNumber: request.pageNumber || 0,
        pageSize: request.pageSize || 1,
        locate: request.locate,
    };
}

/**
 * The slide resources the studies hold, which a request must name: the API rejects a resource
 * none of its studies has. None means the studies have no slides.
 */
export async function fetchStudySlideResourceIds(
    studyIds: string[],
    api: StudySlidesResourceApi = RESOURCE_TABLE_API
): Promise<string[]> {
    if (studyIds.length === 0) {
        return [];
    }
    const tabs = await api.tabs({
        studyIds,
        patientIdentifiers: [],
        sampleIdentifiers: [],
    });
    return PATHOLOGY_SLIDES_RESOURCE_TAB.resourceIds.filter(id =>
        tabs.some(tab => tab.resourceId === id && tab.totalCount > 0)
    );
}

const patientKey = (p: { studyId: string; patientId: string }) =>
    `${p.studyId}\u0000${p.patientId}`;

/**
 * Distinct samples per patient among the listed patients' slides: the same slides grouped by
 * sample (which keeps only sample-level rows), narrowed to the page's patients. Patient ids are
 * unique only within a study, so the groups are matched back by study too.
 */
async function fetchSampleCounts(
    request: StudySlidesRequest,
    patients: ResourceTableGroup[],
    api: StudySlidesResourceApi
): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (patients.length === 0) {
        return counts;
    }
    const pagePatients = new Set(patients.map(patientKey));
    const patientFilter: ResourceColumnFilter = {
        columnId: 'patientId',
        operator: 'in',
        values: Array.from(new Set(patients.map(p => p.patientId))),
    };
    for (let pageNumber = 0; ; pageNumber++) {
        const query = buildResourceTableGroupsQuery(
            groupsState(
                {
                    ...request,
                    locate: undefined,
                    pageNumber,
                    pageSize: RESOURCE_GROUPS_MAX_PAGE_SIZE,
                },
                'sample',
                [patientFilter]
            )
        );
        if (!query) {
            return counts;
        }
        const page = await api.groups(query);
        page.groups
            .filter(sample => pagePatients.has(patientKey(sample)))
            .forEach(sample => {
                const key = patientKey(sample);
                counts.set(key, (counts.get(key) || 0) + 1);
            });
        if (
            (pageNumber + 1) * RESOURCE_GROUPS_MAX_PAGE_SIZE >=
            page.totalGroups
        ) {
            return counts;
        }
    }
}

const EMPTY_PAGE = (request: StudySlidesRequest): StudySlidesPage => ({
    totalPatients: 0,
    totalSlides: 0,
    locatedIndex: null,
    pageNumber: request.pageNumber,
    pageSize: request.pageSize,
    patients: [],
});

/**
 * One page of the patients with slides: groups/fetch by patient, counting each patient's slides
 * per stain group, then the page's distinct samples.
 */
export async function fetchStudySlidesPage(
    request: StudySlidesRequest,
    api: StudySlidesResourceApi = RESOURCE_TABLE_API
): Promise<StudySlidesPage> {
    const query = buildResourceTableGroupsQuery(
        groupsState(request, 'patient')
    );
    if (!query) {
        return EMPTY_PAGE(request);
    }
    const page = await api.groups(query);
    const sampleCounts = await fetchSampleCounts(request, page.groups, api);
    return {
        totalPatients: page.totalGroups,
        totalSlides: page.totalRows,
        locatedIndex: page.locatedIndex,
        pageNumber: request.pageNumber,
        pageSize: request.pageSize,
        patients: page.groups.map(group => {
            const stains = group.counts[STAIN_GROUP_COLUMN] || {};
            const stainGroupCounts = {} as StudySlideStainCounts;
            STUDY_SLIDE_STAIN_GROUPS.forEach(
                stain => (stainGroupCounts[stain] = stains[stain] || 0)
            );
            return {
                studyId: group.studyId,
                patientId: group.patientId,
                slideCount: group.rowCount,
                sampleCount: sampleCounts.get(patientKey(group)) || 0,
                stainGroupCounts,
            };
        }),
    };
}

/** Patients per value of each slide column, as the list's filters offer them. */
export interface StudySlideFacets {
    /** Column id (`metadata:<key>`) to its values, most patients first. */
    [columnId: string]: { value: string; count: number }[];
}

/** A slide column the list can filter by, with the patients having each of its values. */
export interface StudySlideFacetColumn {
    columnId: string;
    label: string;
    values: { value: string; count: number }[];
}

export interface StudySlideFilterOptions {
    facets: StudySlideFacets;
    /** The filterable columns with value counts, in the resources' declared order. */
    columns: StudySlideFacetColumn[];
}

const NO_FILTER_OPTIONS: StudySlideFilterOptions = { facets: {}, columns: [] };

/**
 * The list's filter options: grouped metadata/fetch, whose facets count patients per value, with
 * the columns' labels. The facets ignore every column filter, so a selected value never hides the
 * others; search and the cohort apply.
 */
export async function fetchStudySlideFacets(
    selection: StudySlidesSelection,
    api: StudySlidesResourceApi = RESOURCE_TABLE_API
): Promise<StudySlideFilterOptions> {
    const query = buildResourceTableGroupsMetadataQuery(
        groupsState(selection, 'patient')
    );
    if (!query) {
        return NO_FILTER_OPTIONS;
    }
    const metadata = await api.metadata(query);
    const labels = new Map(
        metadata.columns.map(column => [column.id, column.label])
    );
    // The columns first, in their declared order, then any facet without a column.
    const ids = Array.from(
        new Set([
            ...metadata.columns.map(column => column.id),
            ...Object.keys(metadata.facets),
        ])
    ).filter(id => !!metadata.facets[id]);
    return {
        facets: metadata.facets,
        columns: ids.map(columnId => ({
            columnId,
            label:
                labels.get(columnId) ||
                columnId.slice(METADATA_COLUMN_PREFIX.length),
            values: metadata.facets[columnId],
        })),
    };
}

/** Patients per stain group, from the facets; 0 for a group none has. */
export function stainGroupPatientCounts(
    facets: StudySlideFacets | undefined
): StudySlideStainCounts {
    const counts = {} as StudySlideStainCounts;
    STUDY_SLIDE_STAIN_GROUPS.forEach(group => {
        counts[group] =
            (facets?.[STAIN_GROUP_COLUMN] || []).find(o => o.value === group)
                ?.count || 0;
    });
    return counts;
}

/** The HTTP status of a failed resource-table request, if it got a response. */
export function studySlidesErrorStatus(error: unknown): number | undefined {
    const status = (error as { response?: { status?: unknown } } | undefined)
        ?.response?.status;
    return typeof status === 'number' ? status : undefined;
}

/** The viewer's match filter for a match-level selection: one level, else all. */
export function viewerMatchFilter(
    matchLevels: StudySlideMatchLevel[]
): 'all' | 'part' | 'block' | 'unmatched' {
    return matchLevels.length === 1
        ? (matchLevels[0].toLowerCase() as 'part' | 'block' | 'unmatched')
        : 'all';
}

/** The viewer's stain filter for a stain-group selection: one group, else all. */
export function viewerStainFilter(
    stainGroups: StudySlideStainGroup[]
): WsiStainFilter {
    return stainGroups.length === 1
        ? STAIN_GROUP_TO_SLIDE_STAIN_FILTER[stainGroups[0]]
        : 'all';
}
