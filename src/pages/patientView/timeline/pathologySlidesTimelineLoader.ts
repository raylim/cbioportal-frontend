import { ITrackEventConfig } from 'cbioportal-clinical-timeline';
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import {
    fetchWsiPatientHierarchy,
    PatientHierarchy,
} from 'cbioportal-wsi-viewer';
import { ISampleMetaDeta } from './TimelineWrapper';

/** The PATHOLOGY SLIDES timeline track of a patient with slides. */
export interface PathologySlidesTimeline {
    /** Synthetic PATHOLOGY SLIDES events built from the slide hierarchy. */
    events: ClinicalEvent[];
    /**
     * Viewable slides without a procedure day, which get no event; counted
     * from the same hierarchy.
     */
    undatedViewableSlideCount: number;
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
    loadPathologySlideTimelineData: (
        studyId: string,
        patientId: string,
        authScope: string
    ) => Promise<
        Pick<PathologySlidesTimeline, 'events' | 'undatedViewableSlideCount'>
    >;
    pathologySlidesTrackConfig: PathologySlidesTimeline['trackConfig'];
}

// The track module and the package's events entry it imports load as async
// chunks, so patients without slides load neither, and the timeline never
// loads the viewer itself.
function importPathologySlidesTimeline(): Promise<
    PathologySlidesTimelineModule
> {
    // The project TypeScript module target predates dynamic import syntax;
    // rspack still emits this as an async chunk.
    // @ts-ignore
    return import('./pathologySlidesTimeline');
}

/** Whether the hierarchy has a slide the viewer can open. */
export function hasServableSlide(hierarchy: PatientHierarchy): boolean {
    return hierarchy.samples.some(sample =>
        sample.parts.some(part =>
            part.blocks.some(block =>
                block.slides.some(
                    slide => slide.can_serve_tiles && !!slide.slide_key
                )
            )
        )
    );
}

export interface PathologySlidesTimelineRequest {
    tileServerUrl: string | null | undefined;
    studyId: string;
    patientId: string;
    /** Scopes the shared hierarchy cache, as for the Pathology Slides tab. */
    authScope: string;
}

/**
 * The PATHOLOGY SLIDES track for a patient with servable slides on a portal
 * that serves them. The patient's slide hierarchy decides, through the
 * viewer's shared hierarchy cache that the Pathology Slides tab also uses,
 * so the page requests it once. Resolves undefined, without loading the
 * track module, when the tile server is not configured or the patient has
 * no servable slide, and undefined when the hierarchy cannot be loaded, so
 * the timeline renders without the track.
 */
export async function loadPathologySlidesTimeline(
    request: PathologySlidesTimelineRequest,
    importModule: () => Promise<
        PathologySlidesTimelineModule
    > = importPathologySlidesTimeline,
    fetchHierarchy: typeof fetchWsiPatientHierarchy = fetchWsiPatientHierarchy
): Promise<PathologySlidesTimeline | undefined> {
    if (!request.tileServerUrl) {
        return undefined;
    }
    try {
        const hierarchy = await fetchHierarchy(
            request.studyId,
            request.patientId,
            request.authScope
        );
        if (!hasServableSlide(hierarchy)) {
            return undefined;
        }
        const module = await importModule();
        const data = await module.loadPathologySlideTimelineData(
            request.studyId,
            request.patientId,
            request.authScope
        );
        return {
            events: data.events,
            undatedViewableSlideCount: data.undatedViewableSlideCount,
            trackConfig: module.pathologySlidesTrackConfig,
        };
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
