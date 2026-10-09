import { StudyViewFilter } from 'cbioportal-ts-api-client';
import { WsiStainFilter } from 'cbioportal-wsi-viewer';
import { buildCBioPortalAPIUrl } from 'shared/api/urls';

/** Stain groups the study-slides endpoint counts and filters by. */
export const STUDY_SLIDE_STAIN_GROUPS = ['H&E', 'IHC', 'Other', 'Unknown'];

export type StudySlideStainGroup = 'H&E' | 'IHC' | 'Other' | 'Unknown';

/** How a slide's specimen is matched to a sequenced sample. */
export type StudySlideMatchLevel = 'PART' | 'BLOCK' | 'UNMATCHED';

export const STUDY_SLIDE_MATCH_LEVELS: StudySlideMatchLevel[] = [
    'PART',
    'BLOCK',
    'UNMATCHED',
];

export const STUDY_SLIDE_MATCH_LABELS: Record<StudySlideMatchLevel, string> = {
    PART: 'Part-matched',
    BLOCK: 'Block-matched',
    UNMATCHED: 'Unmatched',
};

export type StudySlideStainCounts = Record<StudySlideStainGroup, number>;

export interface StudySlidePatient {
    studyId: string;
    patientId: string;
    slideCount: number;
    viewableSlideCount: number;
    stainGroupCounts: StudySlideStainCounts;
}

export interface StudySlidesPage {
    totalPatients: number;
    totalSlides: number;
    totalViewableSlides: number;
    /** Counts for every stain group, ignoring the stain-group filter. */
    stainGroupTotals: StudySlideStainCounts;
    /** Position of the requested patient in the full list, when it is in it. */
    locatedIndex: number | null;
    pageNumber: number;
    pageSize: number;
    patients: StudySlidePatient[];
}

export interface StudySlidesRequest {
    studyViewFilter: StudyViewFilter;
    /** Counts and lists only slides the tile server can serve. */
    viewableOnly?: boolean;
    stainGroups?: StudySlideStainGroup[];
    matchLevels?: StudySlideMatchLevel[];
    /** Keeps slides whose patient or sample ID contains this, ignoring case. */
    search?: string;
    locateStudyId?: string;
    locatePatientId?: string;
    pageNumber?: number;
    pageSize?: number;
}

/** Thrown for a failed study-slides request; `status` is the HTTP status. */
export class StudySlidesRequestError extends Error {
    constructor(readonly status: number) {
        super(`Pathology slides request failed (${status})`);
        this.name = 'StudySlidesRequestError';
    }
}

/** Lists the patients with pathology slides in a study-view cohort. */
export function fetchStudySlidePatients(
    request: StudySlidesRequest
): Promise<StudySlidesPage> {
    return postStudySlides('api/wsi/v2/study-slides/patients/fetch', request);
}

async function postStudySlides<T>(path: string, body: object): Promise<T> {
    const response = await fetch(buildCBioPortalAPIUrl(path), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new StudySlidesRequestError(response.status);
    }
    return response.json();
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
    if (stainGroups.length !== 1) {
        return 'all';
    }
    switch (stainGroups[0]) {
        case 'H&E':
            return 'hne';
        case 'IHC':
            return 'ihc';
        case 'Other':
            return 'other';
        default:
            return 'unknown';
    }
}
