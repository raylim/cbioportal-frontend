import { ClinicalEvent } from 'cbioportal-ts-api-client';
import { fetchPatientHierarchyReadOnly } from './wsiHierarchyFetchCache';
import { formatDaysSinceDiagnosis, getSlideTimepointDays } from './wsiNavUtils';
import {
    DAY_ZERO_TOOLTIP,
    procedureSequencingOffset,
    procedureTooltip,
    WsiSampleTimelineMap,
} from './wsiSampleTimeline';
import { isServableDiagnosticSlide, wsiStainKind } from './wsiSlideUtils';
import { blockName, formatSpecimenLabel } from './wsiSpecimenUtils';
import { buildWsiHierarchyApiUrl } from './wsiUrls';
import { getWsiViewerRuntime } from './wsiViewerConfig';
import { MatchLevel, PatientHierarchy, WsiStainFilter } from './wsiViewerTypes';

export const PATHOLOGY_SLIDES_EVENT_TYPE = 'PATHOLOGY SLIDES';

export const UNMATCHED_LABEL = 'Unmatched';

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
    slidesTooltip: string;
    imageIds: string[];
    /** In-app path to the Pathology Slides tab; unset when nothing is viewable. */
    openPath?: string;
    openLabel: string;
}

/**
 * The fields read from a PATHOLOGY SLIDES event; satisfied by both a
 * ClinicalEvent and a timeline item's event.
 */
export type PathologySlideEvent = Pick<
    ClinicalEvent,
    'startNumberOfDaysSinceDiagnosis'
> & { attributes?: { key: string; value: string }[] };

function eventAttributes(event: PathologySlideEvent): Record<string, string> {
    const attrs: Record<string, string> = {};
    (event.attributes || []).forEach(attr => {
        attrs[attr.key] = attr.value;
    });
    return attrs;
}

function parseCount(value: string | undefined): number {
    const count = parseInt(value || '', 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
}

/** Image IDs from the IMAGE_IDS JSON array; malformed values yield none. */
export function parseImageIds(value: string | undefined): string[] {
    if (!value) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter(id => id != null && id !== '').map(id => String(id))
            : [];
    } catch (_) {
        return [];
    }
}

/** "Part 6 / Block Block 1" -> "Part 6 / Block 1". */
export function formatSpecimen(specimen: string | undefined): string {
    return (specimen || '').replace(
        /(\bBlock\s+)(.*)$/i,
        (_match, prefix: string, rest: string) => prefix + blockName(rest)
    );
}

/**
 * Pathology Slides tab path carrying the LINKOUT query, or undefined when
 * the LINKOUT is empty or has no query. Only the path and query are kept so
 * the router adds any deployment base path.
 */
export function pathologySlidesOpenPath(
    linkout: string | undefined
): string | undefined {
    if (!linkout || !linkout.trim()) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(linkout.trim(), 'http://localhost');
    } catch (_) {
        return undefined;
    }
    if (!url.search) {
        return undefined;
    }
    return `${url.pathname}${url.search}`;
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
    imageIds: string[],
    viewableCount: number,
    totalCount: number
): string {
    const parts = [
        imageIds.length > 0
            ? `Image IDs: ${imageIds.join(', ')}.`
            : 'No image IDs recorded.',
    ];
    const nonViewable = Math.max(totalCount - viewableCount, 0);
    if (nonViewable > 0) {
        parts.push(
            `${nonViewable} ${
                nonViewable === 1 ? 'slide is' : 'slides are'
            } not viewable: no scanned image is available.`
        );
    }
    return parts.join(' ');
}

/** Sequenced sample of a BLOCK- or PART-matched event; unset when unmatched. */
export function pathologySlideSampleId(
    event: PathologySlideEvent
): string | undefined {
    const attrs = eventAttributes(event);
    const matchLevel = (attrs.MATCH_LEVEL || '').toUpperCase();
    return MATCH_LABELS[matchLevel] && attrs.SAMPLE_ID
        ? attrs.SAMPLE_ID
        : undefined;
}

export function buildPathologySlideRow(
    event: PathologySlideEvent,
    sampleTimelines: WsiSampleTimelineMap
): PathologySlideRow {
    const attrs = eventAttributes(event);
    const rawDays = event.startNumberOfDaysSinceDiagnosis;
    const procedureDays =
        typeof rawDays === 'number' && Number.isFinite(rawDays)
            ? rawDays
            : undefined;
    const matchLevel = (attrs.MATCH_LEVEL || '').toUpperCase();
    const match = MATCH_LABELS[matchLevel];
    const sampleId = pathologySlideSampleId(event);
    const sequencingDays = sampleId
        ? sampleTimelines.get(sampleId)?.sequencingDays
        : undefined;
    const sequencingText = sequencingRelation(procedureDays, sequencingDays);
    const stain = attrs.SUBTYPE || '';
    const viewableCount = parseCount(attrs.IMAGE_COUNT);
    const totalCount = Math.max(
        parseCount(attrs.TOTAL_IMAGE_COUNT),
        viewableCount
    );
    const imageIds = parseImageIds(attrs.IMAGE_IDS);
    const sampleText = sampleId || UNMATCHED_LABEL;

    return {
        procedureDays,
        procedureText:
            procedureDays != null
                ? formatDaysSinceDiagnosis(procedureDays)
                : '',
        procedureTooltip:
            procedureDays != null
                ? [attrs.TIMEPOINT_SOURCE, DAY_ZERO_TOOLTIP]
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
        specimen: formatSpecimen(attrs.SPECIMEN),
        viewableCount,
        totalCount,
        slidesText: `${viewableCount} of ${totalCount} viewable`,
        slidesTooltip: slidesTooltip(imageIds, viewableCount, totalCount),
        imageIds,
        openPath:
            viewableCount > 0
                ? pathologySlidesOpenPath(attrs.LINKOUT)
                : undefined,
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

export const UNMATCHED_SAMPLE_TEXT =
    'Unmatched (not linked to a sequenced sample)';

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
     * `/patient/wsiHESlides`; each event's LINKOUT is this path with the
     * event's scope as its query.
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
    viewableImageIds: string[];
    slideKeys: Set<string>;
}

/**
 * Pathology Slides tab link for one event: its sample, match level, stain
 * and procedure day, plus the specimen key when all of its slides share one.
 */
function pathologySlideEventLinkout(
    group: PathologySlideEventGroup,
    scope: PathologySlideEventScope
): string {
    const query = new URLSearchParams({
        studyId: scope.studyId,
        caseId: scope.patientId,
        stainFilter: group.stain,
        matchLevel: group.matchLevel,
    });
    if (group.specimenKeys.size === 1) {
        query.set('specimenKey', Array.from(group.specimenKeys)[0]);
    }
    if (group.sampleId) {
        query.set('sampleId', group.sampleId);
    }
    query.set('timepointDays', String(group.days));
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
): ClinicalEvent[] {
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
                            viewableImageIds: [],
                            slideKeys: new Set(),
                        };
                        groups.set(key, group);
                    }
                    const slideKey =
                        slide.image_id ||
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
                        group.viewableImageIds.push(slide.image_id);
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
        .map(group => {
            const attributes: Record<string, string> = {
                SAMPLE_ID: group.sampleId || '',
                SUBTYPE: STAIN_LABELS[group.stain],
                MATCH_LEVEL: group.matchLevel,
                SPECIMEN: group.specimen,
                IMAGE_COUNT: String(group.viewableImageIds.length),
                TOTAL_IMAGE_COUNT: String(group.slideKeys.size),
                IMAGE_IDS: JSON.stringify(group.viewableImageIds),
                TIMEPOINT_SOURCE: group.timepointSource || '',
                LINKOUT: pathologySlideEventLinkout(group, scope),
            };
            return {
                eventType: PATHOLOGY_SLIDES_EVENT_TYPE,
                studyId: scope.studyId,
                patientId: scope.patientId,
                uniquePatientKey: '',
                // A point event, as the timeline draws events without an end day.
                startNumberOfDaysSinceDiagnosis: group.days,
                attributes: Object.keys(attributes)
                    .filter(key => attributes[key] !== '')
                    .map(key => ({ key, value: attributes[key] })),
            } as ClinicalEvent;
        });
}

/**
 * The patient's PATHOLOGY SLIDES timeline events, from the slide hierarchy
 * loaded through the viewer's shared hierarchy cache, so a Pathology Slides
 * tab opened afterwards with the same `authScope` reuses the response.
 */
export async function fetchPathologySlideEvents(
    scope: PathologySlideEventScope,
    authScope?: string,
    signal?: AbortSignal
): Promise<ClinicalEvent[]> {
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
    return buildPathologySlideEvents(hierarchy, scope);
}
