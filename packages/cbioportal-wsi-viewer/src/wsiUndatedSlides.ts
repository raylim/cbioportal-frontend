import { fetchPatientHierarchyReadOnly } from './wsiHierarchyFetchCache';
import {
    getServableSlideEntriesForHierarchyReadOnly,
    getServableSlideTimepointDays,
} from './wsiSlideUtils';
import { buildWsiHierarchyApiUrl } from './wsiUrls';
import { configureWsiViewerRuntime, WsiViewerConfig } from './wsiViewerConfig';
import { PatientHierarchy } from './wsiViewerTypes';

/**
 * Viewable slides without a procedure day. They have no PATHOLOGY SLIDES
 * timeline event, so hosts point to them separately.
 */
export function countUndatedViewableSlides(
    hierarchy: PatientHierarchy
): number {
    const imageIds = new Set<string>();
    getServableSlideEntriesForHierarchyReadOnly(hierarchy).forEach(
        ({ slide }) => {
            if (getServableSlideTimepointDays(slide) == null) {
                imageIds.add(slide.image_id);
            }
        }
    );
    return imageIds.size;
}

/**
 * Loads the patient's hierarchy through the viewer's shared cache (so a later
 * Pathology Slides tab reuses it) and counts its undated viewable slides.
 */
export async function fetchUndatedViewableSlideCount(
    config: WsiViewerConfig,
    studyId: string,
    patientId: string,
    signal?: AbortSignal
): Promise<number> {
    configureWsiViewerRuntime(config);
    const hierarchy = await fetchPatientHierarchyReadOnly(
        buildWsiHierarchyApiUrl(config.buildApiUrl, studyId, patientId),
        signal,
        config.authScope,
        studyId,
        patientId
    );
    return countUndatedViewableSlides(hierarchy);
}
