import {
    STUDY_SLIDE_STAIN_GROUPS,
    StudySlidePatient,
    StudySlidesPage,
    StudySlidesRequest,
    StudySlideStainCounts,
} from './studySlidesApi';

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
    STUDY_SLIDE_STAIN_GROUPS.forEach(
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
