import { ClinicalEvent } from 'cbioportal-ts-api-client';
import { fetchPatientHierarchyReadOnly } from './wsiHierarchyFetchCache';
import {
    DAY_ZERO_TOOLTIP,
    formatDaysSinceDiagnosis,
    getSlideTimepointDays,
    procedureSequencingOffset,
    procedureTooltip,
} from './wsiNavUtils';
import { WsiSampleTimelineMap } from './wsiSampleTimeline';
import { isServableDiagnosticSlide, wsiStainKind } from './wsiSlideUtils';
import { formatSpecimenLabel } from './wsiSpecimenUtils';
import { buildWsiHierarchyApiUrl } from './wsiUrls';
import { getWsiViewerRuntime } from './wsiViewerConfig';
import { MatchLevel, PatientHierarchy, WsiStainFilter } from './wsiViewerTypes';

export const PATHOLOGY_SLIDES_EVENT_TYPE = 'PATHOLOGY SLIDES';

const UNMATCHED_LABEL = 'Unmatched';

const MATCH_LABELS: Record<string, { text: string; tooltip: string }> = {
    BLOCK: {
        text: 'Block',
        tooltip:
            'The slide was cut from the same tissue block that was sequenced for this sample',
    },
    PART: {
        text: 'Part',
        tooltip:
            'The slide comes from the same specimen part as the sequenced sample; the sequenced block is not confirmed',
    },
};

const UNMATCHED_TOOLTIP = 'Not linked to a sequenced sample';

/** One PATHOLOGY SLIDES event, formatted for its timeline tooltip. */
export interface PathologySlideRow {
    procedureDays?: number;
    procedureText: string;
    procedureTooltip?: string;
    /** Sequenced sample the slides belong to; unset when unmatched. */
    sampleId?: string;
    sampleText: string;
    sequencingDays?: number;
    sequencingText: string;
    sequencingTooltip?: string;
    stain: string;
    matchText: string;
    matchTooltip: string;
    specimen: string;
    viewableCount: number;
    totalCount: number;
    slidesText: string;
    /** Why some slides are not viewable; unset when all are. */
    slidesTooltip?: string;
    /** In-app path to the Pathology Slides tab; unset when nothing is viewable. */
    openPath?: string;
    openLabel: string;
}

/** What the timeline tooltip and markers show for one PATHOLOGY SLIDES event. */
export interface PathologySlideEventDetails {
    /** Sequenced sample of a BLOCK- or PART-matched event; unset when unmatched. */
    sampleId?: string;
    matchLevel: MatchLevel;
    /** Stain row label: H&E, IHC, Other or Unknown. */
    stain: string;
    specimen: string;
    /** Opaque slide keys of the event's viewable slides. */
    viewableSlideKeys: string[];
    totalCount: number;
    timepointSource?: string;
    /** In-app path to the Pathology Slides tab, scoped to this event. */
    openPath: string;
}

/**
 * A PATHOLOGY SLIDES event built by `buildPathologySlideEvents`. Its only
 * attribute is SUBTYPE, which splits the timeline track into stain rows;
 * the tooltip and markers read `pathologySlide`.
 */
export type PathologySlideClinicalEvent = ClinicalEvent & {
    pathologySlide: PathologySlideEventDetails;
};

/**
 * The fields read from a PATHOLOGY SLIDES event; satisfied by both a built
 * event and a timeline item's event.
 */
export type PathologySlideEvent = Pick<
    ClinicalEvent,
    'startNumberOfDaysSinceDiagnosis'
>;

function eventDetails(
    event: PathologySlideEvent
): PathologySlideEventDetails | undefined {
    return (event as Partial<PathologySlideClinicalEvent>).pathologySlide;
}

/**
 * Procedure offset from sequencing, e.g. "42 d before (d+962)", or with a
 * subject "42 d before sequencing (d+962)". Empty when either day is unknown.
 */
function sequencingRelation(
    procedureDays: number | undefined,
    sequencingDays: number | undefined,
    subject?: string
): string {
    const offset = procedureSequencingOffset(procedureDays, sequencingDays);
    if (!offset) {
        return '';
    }
    const day = formatDaysSinceDiagnosis(sequencingDays!);
    if (offset.relation === 'same') {
        return subject
            ? `same day as ${subject} (${day})`
            : `same day (${day})`;
    }
    return `${offset.days} d ${offset.relation}${
        subject ? ` ${subject}` : ''
    } (${day})`;
}

function slidesTooltip(
    viewableCount: number,
    totalCount: number
): string | undefined {
    const nonViewable = Math.max(totalCount - viewableCount, 0);
    return nonViewable > 0
        ? `${nonViewable} ${
              nonViewable === 1 ? 'slide is' : 'slides are'
          } not viewable: no scanned image is available.`
        : undefined;
}

/** Sequenced sample of a BLOCK- or PART-matched event; unset when unmatched. */
export function pathologySlideSampleId(
    event: PathologySlideEvent
): string | undefined {
    return eventDetails(event)?.sampleId;
}

export function buildPathologySlideRow(
    event: PathologySlideEvent,
    sampleTimelines: WsiSampleTimelineMap
): PathologySlideRow {
    const details = eventDetails(event);
    const rawDays = event.startNumberOfDaysSinceDiagnosis;
    const procedureDays =
        typeof rawDays === 'number' && Number.isFinite(rawDays)
            ? rawDays
            : undefined;
    const match = details ? MATCH_LABELS[details.matchLevel] : undefined;
    const sampleId = details?.sampleId;
    const sequencingDays = sampleId
        ? sampleTimelines.get(sampleId)?.sequencingDays
        : undefined;
    const sequencingText = sequencingRelation(procedureDays, sequencingDays);
    const stain = details?.stain || '';
    const viewableCount = details?.viewableSlideKeys.length || 0;
    const totalCount = Math.max(details?.totalCount || 0, viewableCount);
    const sampleText = sampleId || UNMATCHED_LABEL;

    return {
        procedureDays,
        procedureText:
            procedureDays != null
                ? formatDaysSinceDiagnosis(procedureDays)
                : '',
        procedureTooltip:
            procedureDays != null
                ? [details?.timepointSource, DAY_ZERO_TOOLTIP]
                      .filter(Boolean)
                      .join('. ')
                : undefined,
        sampleId,
        sampleText,
        sequencingDays,
        sequencingText,
        sequencingTooltip: sequencingText
            ? procedureTooltip(procedureDays, sequencingDays)
            : undefined,
        stain,
        matchText: match ? match.text : UNMATCHED_LABEL,
        matchTooltip: match ? match.tooltip : UNMATCHED_TOOLTIP,
        specimen: details?.specimen || '',
        viewableCount,
        totalCount,
        slidesText: `${viewableCount} of ${totalCount} viewable`,
        slidesTooltip: slidesTooltip(viewableCount, totalCount),
        openPath: viewableCount > 0 ? details?.openPath : undefined,
        openLabel: `Open ${stain || 'pathology'} slides for ${sampleText}`,
    };
}

/** One labelled line of the timeline tooltip for a PATHOLOGY SLIDES event. */
export interface PathologySlideTooltipLine {
    label: string;
    value: string;
    /** Hover explanation for the value. */
    tooltip?: string;
}

export interface PathologySlideTooltipContent {
    title: string;
    lines: PathologySlideTooltipLine[];
    openPath?: string;
    openLabel: string;
}

const UNMATCHED_SAMPLE_TEXT = 'Unmatched (not linked to a sequenced sample)';

/**
 * Timeline tooltip content for one PATHOLOGY SLIDES event, e.g.
 * "Pathology slides · H&E · Part-matched" followed by Sample, Procedure,
 * Specimen and Slides lines.
 */
export function buildPathologySlideTooltipContent(
    row: PathologySlideRow
): PathologySlideTooltipContent {
    const matched = row.matchText !== UNMATCHED_LABEL;
    const title = [
        'Pathology slides',
        row.stain,
        matched ? `${row.matchText}-matched` : UNMATCHED_LABEL,
    ]
        .filter(Boolean)
        .join(' · ');

    const lines: PathologySlideTooltipLine[] = [
        {
            label: 'Sample',
            value: row.sampleId || UNMATCHED_SAMPLE_TEXT,
            tooltip: row.matchTooltip,
        },
    ];
    if (row.procedureText) {
        const relation = sequencingRelation(
            row.procedureDays,
            row.sequencingDays,
            'sequencing'
        );
        lines.push({
            label: 'Procedure',
            value: relation
                ? `${row.procedureText} — ${relation}`
                : row.procedureText,
            tooltip: row.sequencingTooltip || row.procedureTooltip,
        });
    }
    if (row.specimen) {
        lines.push({ label: 'Specimen', value: row.specimen });
    }
    lines.push({
        label: 'Slides',
        value: row.slidesText,
        tooltip: row.slidesTooltip,
    });

    return {
        title,
        lines,
        openPath: row.openPath,
        openLabel: row.openLabel,
    };
}

/** Timeline row label of each stain kind. */
const STAIN_LABELS: Record<Exclude<WsiStainFilter, 'all'>, string> = {
    hne: 'H&E',
    ihc: 'IHC',
    other: 'Other',
    unknown: 'Unknown',
};

export interface PathologySlideEventScope {
    studyId: string;
    patientId: string;
    /**
     * Host path of the patient Pathology Slides tab, e.g.
     * `/patient/wsiHESlides`; each event opens this path with the event's
     * scope as its query.
     */
    slidesTabPath: string;
}

interface PathologySlideEventGroup {
    days: number;
    sampleId?: string;
    matchLevel: MatchLevel;
    stain: Exclude<WsiStainFilter, 'all'>;
    specimen: string;
    specimenKeys: Set<string>;
    timepointSource?: string;
    viewableSlideKeys: string[];
    slideKeys: Set<string>;
}

/**
 * Query param naming the Pathology Slides tab scope: a JSON object with
 * `stainFilter`, `matchLevel`, `specimenKey` and `timepointDays` (the host
 * patient view's nested `pathologySlideSettings` URL node). The sample is
 * the patient view's own `sampleId` param.
 */
const PATHOLOGY_SLIDE_SETTINGS_PARAM = 'pathologySlideSettings';

/**
 * Pathology Slides tab path for one event: its sample, match level, stain
 * and procedure day, plus the specimen key when all of its slides share one.
 */
function pathologySlideEventOpenPath(
    group: PathologySlideEventGroup,
    scope: PathologySlideEventScope
): string {
    const settings: Record<string, string> = {
        stainFilter: group.stain,
        matchLevel: group.matchLevel,
    };
    if (group.specimenKeys.size === 1) {
        settings.specimenKey = Array.from(group.specimenKeys)[0];
    }
    settings.timepointDays = String(group.days);
    const query = new URLSearchParams({
        studyId: scope.studyId,
        caseId: scope.patientId,
    });
    if (group.sampleId) {
        query.set('sampleId', group.sampleId);
    }
    query.set(PATHOLOGY_SLIDE_SETTINGS_PARAM, JSON.stringify(settings));
    return `${scope.slidesTabPath}?${query.toString()}`;
}

/**
 * PATHOLOGY SLIDES timeline events built from a patient slide hierarchy.
 * Slides are grouped by procedure day, sample (BLOCK and PART matches
 * only), match level, stain and specimen ("Part N" or "Part N / Block M"),
 * one event per group. Slides without a procedure day have no event.
 * Events are sorted by day, then sample, stain and specimen.
 */
export function buildPathologySlideEvents(
    hierarchy: PatientHierarchy,
    scope: PathologySlideEventScope
): PathologySlideClinicalEvent[] {
    const groups = new Map<string, PathologySlideEventGroup>();
    hierarchy.samples.forEach(sample =>
        sample.parts.forEach(part =>
            part.blocks.forEach(block =>
                block.slides.forEach((slide, slideIndex) => {
                    const days = getSlideTimepointDays(slide);
                    if (days == null) {
                        return;
                    }
                    const groupSampleId =
                        sample.sample_id === 'UNMATCHED'
                            ? undefined
                            : sample.sample_id;
                    const sampleId =
                        slide.match_level === 'UNMATCHED'
                            ? undefined
                            : slide.sample_id || groupSampleId;
                    const matchLevel: MatchLevel = sampleId
                        ? slide.match_level ?? 'BLOCK'
                        : 'UNMATCHED';
                    const stain = wsiStainKind(slide);
                    const specimen = formatSpecimenLabel({
                        match_level: matchLevel,
                        part_number: part.part_number,
                        part_description: part.part_description,
                        block_label: block.block_label,
                        block_number: block.block_number,
                    });
                    const key = JSON.stringify([
                        days,
                        sampleId ?? null,
                        matchLevel,
                        stain,
                        specimen,
                    ]);
                    let group = groups.get(key);
                    if (!group) {
                        group = {
                            days,
                            sampleId,
                            matchLevel,
                            stain,
                            specimen,
                            specimenKeys: new Set(),
                            viewableSlideKeys: [],
                            slideKeys: new Set(),
                        };
                        groups.set(key, group);
                    }
                    const slideKey =
                        slide.slide_key ||
                        `${part.part_number}/${block.block_number}/${slideIndex}`;
                    if (group.slideKeys.has(slideKey)) {
                        return;
                    }
                    group.slideKeys.add(slideKey);
                    if (slide.specimen_key) {
                        group.specimenKeys.add(slide.specimen_key);
                    }
                    group.timepointSource =
                        group.timepointSource ||
                        slide.slide_timepoint_source ||
                        undefined;
                    if (isServableDiagnosticSlide(slide)) {
                        group.viewableSlideKeys.push(slide.slide_key);
                    }
                })
            )
        )
    );

    return Array.from(groups.values())
        .sort(
            (a, b) =>
                a.days - b.days ||
                (a.sampleId || '\uffff').localeCompare(
                    b.sampleId || '\uffff'
                ) ||
                STAIN_LABELS[a.stain].localeCompare(STAIN_LABELS[b.stain]) ||
                a.specimen.localeCompare(b.specimen, undefined, {
                    numeric: true,
                })
        )
        .map(
            group =>
                ({
                    eventType: PATHOLOGY_SLIDES_EVENT_TYPE,
                    studyId: scope.studyId,
                    patientId: scope.patientId,
                    uniquePatientKey: '',
                    // A point event, as the timeline draws events without an end day.
                    startNumberOfDaysSinceDiagnosis: group.days,
                    attributes: [
                        { key: 'SUBTYPE', value: STAIN_LABELS[group.stain] },
                    ],
                    pathologySlide: {
                        sampleId: group.sampleId,
                        matchLevel: group.matchLevel,
                        stain: STAIN_LABELS[group.stain],
                        specimen: group.specimen,
                        viewableSlideKeys: group.viewableSlideKeys,
                        totalCount: group.slideKeys.size,
                        timepointSource: group.timepointSource,
                        openPath: pathologySlideEventOpenPath(group, scope),
                    },
                } as PathologySlideClinicalEvent)
        );
}

/**
 * Viewable slides without a procedure day. They get no PATHOLOGY SLIDES
 * event, so the timeline cannot show them.
 */
export function countUndatedViewableSlides(
    hierarchy: PatientHierarchy
): number {
    const slideKeys = new Set<string>();
    hierarchy.samples.forEach(sample =>
        sample.parts.forEach(part =>
            part.blocks.forEach(block =>
                block.slides.forEach(slide => {
                    if (
                        isServableDiagnosticSlide(slide) &&
                        getSlideTimepointDays(slide) == null
                    ) {
                        slideKeys.add(slide.slide_key);
                    }
                })
            )
        )
    );
    return slideKeys.size;
}

/** What the patient timeline shows for the patient's slides. */
export interface PathologySlideTimelineData {
    events: PathologySlideClinicalEvent[];
    /** Viewable slides left off the timeline for lack of a procedure day. */
    undatedViewableSlideCount: number;
}

/**
 * The patient's PATHOLOGY SLIDES timeline events and undated slide count,
 * from the slide hierarchy loaded through the viewer's shared hierarchy
 * cache, so a Pathology Slides tab opened afterwards with the same
 * `authScope` reuses the response.
 */
export async function fetchPathologySlideTimelineData(
    scope: PathologySlideEventScope,
    authScope?: string,
    signal?: AbortSignal
): Promise<PathologySlideTimelineData> {
    const hierarchy = await fetchPatientHierarchyReadOnly(
        buildWsiHierarchyApiUrl(
            getWsiViewerRuntime().buildApiUrl,
            scope.studyId,
            scope.patientId
        ),
        signal,
        authScope,
        scope.studyId,
        scope.patientId
    );
    return {
        events: buildPathologySlideEvents(hierarchy, scope),
        undatedViewableSlideCount: countUndatedViewableSlides(hierarchy),
    };
}
