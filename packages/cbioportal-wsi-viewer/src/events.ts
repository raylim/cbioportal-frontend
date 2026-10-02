// Events entry: the patient timeline's PATHOLOGY SLIDES events, built from
// the slide hierarchy. Hosts load it lazily for patients with slides; it
// does not include the viewer, so the timeline need not load it.
export {
    buildPathologySlideRow,
    buildPathologySlideTooltipContent,
    fetchPathologySlideTimelineData,
    PATHOLOGY_SLIDES_EVENT_TYPE,
    PathologySlideClinicalEvent,
    PathologySlideEvent,
    PathologySlideEventDetails,
    PathologySlideEventScope,
    PathologySlideTimelineData,
    pathologySlideSampleId,
} from './wsiPathologyEvents';
