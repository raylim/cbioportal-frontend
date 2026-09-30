import { ITrackEventConfig } from 'cbioportal-clinical-timeline';
import { ClinicalData, ClinicalEvent } from 'cbioportal-ts-api-client';
import { ISampleMetaDeta } from './TimelineWrapper';

/** Patient attribute with the patient's WSI slide count. */
export const WSI_PATIENT_SLIDE_COUNT_ATTRIBUTE = 'WSI_PATIENT_SLIDE_COUNT';

/** The PATHOLOGY SLIDES timeline track of a patient with slides. */
export interface PathologySlidesTimeline {
    /** Synthetic PATHOLOGY SLIDES events built from the slide hierarchy. */
    events: ClinicalEvent[];
    /**
     * The track's renderer; `clinicalEvents` gives each sample's sequencing
     * day for the tooltip.
     */
    trackConfig: (
        caseMetaData: ISampleMetaDeta,
        clinicalEvents: ClinicalEvent[]
    ) => ITrackEventConfig;
}

/** What the loader reads from the lazily loaded timeline module. */
export interface PathologySlidesTimelineModule {
    loadPathologySlideEvents: (
        studyId: string,
        patientId: string,
        authScope: string
    ) => Promise<ClinicalEvent[]>;
    pathologySlidesTrackConfig: PathologySlidesTimeline['trackConfig'];
}

// The track module and the viewer entry it imports are one async chunk, so
// patients without slides load neither.
function importPathologySlidesTimeline(): Promise<
    PathologySlidesTimelineModule
> {
    // The project TypeScript module target predates dynamic import syntax;
    // rspack still emits this as an async chunk.
    // @ts-ignore
    return import('./pathologySlidesTimeline');
}

/** The patient's WSI_PATIENT_SLIDE_COUNT; 0 when missing or not a number. */
export function patientWsiSlideCount(
    clinicalDataPatient: Pick<ClinicalData, 'clinicalAttributeId' | 'value'>[]
): number {
    const datum = clinicalDataPatient.find(
        d => d.clinicalAttributeId === WSI_PATIENT_SLIDE_COUNT_ATTRIBUTE
    );
    const count = datum ? parseInt(datum.value, 10) : 0;
    return Number.isFinite(count) ? count : 0;
}

export interface PathologySlidesTimelineRequest {
    tileServerUrl: string | null | undefined;
    clinicalDataPatient: Pick<ClinicalData, 'clinicalAttributeId' | 'value'>[];
    studyId: string;
    patientId: string;
    /** Scopes the shared hierarchy cache, as for the Pathology Slides tab. */
    authScope: string;
}

/**
 * The PATHOLOGY SLIDES track for a patient with slides on a portal that
 * serves them. Resolves undefined, without loading anything, when the tile
 * server is not configured or WSI_PATIENT_SLIDE_COUNT is not positive, and
 * undefined when the hierarchy cannot be loaded, so the timeline renders
 * without the track.
 */
export async function loadPathologySlidesTimeline(
    request: PathologySlidesTimelineRequest,
    importModule: () => Promise<
        PathologySlidesTimelineModule
    > = importPathologySlidesTimeline
): Promise<PathologySlidesTimeline | undefined> {
    if (
        !request.tileServerUrl ||
        patientWsiSlideCount(request.clinicalDataPatient) <= 0
    ) {
        return undefined;
    }
    try {
        const module = await importModule();
        const events = await module.loadPathologySlideEvents(
            request.studyId,
            request.patientId,
            request.authScope
        );
        return { events, trackConfig: module.pathologySlidesTrackConfig };
    } catch (_) {
        return undefined;
    }
}

/** The patient's clinical events with the PATHOLOGY SLIDES events, if any. */
export function withPathologySlideEvents(
    clinicalEvents: ClinicalEvent[],
    timeline: PathologySlidesTimeline | undefined
): ClinicalEvent[] {
    return timeline && timeline.events.length > 0
        ? [...clinicalEvents, ...timeline.events]
        : clinicalEvents;
}
