import { ClinicalEvent } from 'cbioportal-ts-api-client';
import {
    blockName,
    DAY_ZERO_TOOLTIP,
    formatDaysSinceDiagnosis,
    procedureTooltip,
    WsiSampleTimelineMap,
} from 'cbioportal-wsi-viewer';

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

/** One PATHOLOGY SLIDES event, formatted for the Clinical Data table. */
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
    if (procedureDays == null || sequencingDays == null) {
        return '';
    }
    const day = formatDaysSinceDiagnosis(sequencingDays);
    const delta = sequencingDays - procedureDays;
    if (delta === 0) {
        return subject
            ? `same day as ${subject} (${day})`
            : `same day (${day})`;
    }
    const direction = delta > 0 ? 'before' : 'after';
    return `${Math.abs(delta)} d ${direction}${
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

function compareOptionalNumbers(a?: number, b?: number): number {
    if (a == null || b == null) {
        return a == null ? (b == null ? 0 : 1) : -1;
    }
    return a - b;
}

/** Rows sorted by procedure day, then sample, then stain. */
export function buildPathologySlideRows(
    events: ClinicalEvent[],
    sampleTimelines: WsiSampleTimelineMap
): PathologySlideRow[] {
    return events
        .map(event => buildPathologySlideRow(event, sampleTimelines))
        .sort(
            (a, b) =>
                compareOptionalNumbers(a.procedureDays, b.procedureDays) ||
                a.sampleText.localeCompare(b.sampleText) ||
                a.stain.localeCompare(b.stain)
        );
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
