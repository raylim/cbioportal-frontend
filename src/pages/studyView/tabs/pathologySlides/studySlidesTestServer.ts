// Type-only imports keep this module free of path aliases, so the Playwright
// specs can import it too.
import {
    StudySlidePatient,
    StudySlidesPage,
    StudySlidesRequest,
    StudySlideStainCounts,
    StudySlideStainGroup,
} from './studySlidesApi';

const STAIN_GROUPS: StudySlideStainGroup[] = ['H&E', 'IHC', 'Other', 'Unknown'];

/**
 * The study-slides endpoint over a fixed patient list, for tests: honours the
 * ID search, stain groups, the located patient and paging.
 */
export function studySlidesPageFor(
    request: StudySlidesRequest,
    patients: StudySlidePatient[]
): StudySlidesPage {
    const listed = patients.filter(
        p =>
            (!request.search ||
                p.patientId
                    .toLowerCase()
                    .includes(request.search.toLowerCase())) &&
            (!request.stainGroups?.length ||
                request.stainGroups.some(g => p.stainGroupCounts[g] > 0))
    );
    const pageNumber = request.pageNumber ?? 0;
    const pageSize = request.pageSize ?? 50;
    const located = listed.findIndex(
        p =>
            p.studyId === request.locateStudyId &&
            p.patientId === request.locatePatientId
    );
    const stainGroupTotals = {} as StudySlideStainCounts;
    STAIN_GROUPS.forEach(
        group =>
            (stainGroupTotals[group] = patients.reduce(
                (sum, p) => sum + p.stainGroupCounts[group],
                0
            ))
    );
    return {
        totalPatients: listed.length,
        totalSlides: listed.reduce((sum, p) => sum + p.slideCount, 0),
        stainGroupTotals,
        locatedIndex: located >= 0 ? located : null,
        pageNumber,
        pageSize,
        patients: listed.slice(
            pageNumber * pageSize,
            (pageNumber + 1) * pageSize
        ),
    };
}

/** Lets pending requests and reactions run. */
export async function settle() {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}
