import {
    ClinicalDataBySampleId,
    ClinicalEvent,
} from 'cbioportal-ts-api-client';
import {
    getServableSlideTimepointDays,
    getServableSlideAssociationsByImageIdReadOnly,
    getServableSlideEntriesForHierarchyReadOnly,
} from 'shared/components/wsiViewer/wsiSlideUtils';
import { formatSpecimenLabel } from 'shared/components/wsiViewer/wsiSpecimenUtils';
import { PatientHierarchy } from 'shared/components/wsiViewer/wsiViewerTypes';
import {
    buildPathologyAssociationSnapshot,
    formatMatchLevel,
    getPathologySlideAssociationsReadOnly,
    matchesPathologySlideType,
    PathologySlideType,
} from './pathologyAssociationUtils';
import { buildClinicalEventsSignature } from './clinicalEventSignatureUtils';
import { buildWsiHierarchyApiUrl } from 'shared/components/wsiViewer/wsiUrls';

export const PATHOLOGY_EVENT_ATTRIBUTE_KEYS = {
    imageCount: 'IMAGE_COUNT',
    linkout: 'LINKOUT',
    matchLevel: 'MATCH_LEVEL',
    nonServableImageCount: 'NON_SERVABLE_IMAGE_COUNT',
    sampleId: 'SAMPLE_ID',
    specimen: 'SPECIMEN',
    subtype: 'SUBTYPE',
    timepointSource: 'TIMEPOINT_SOURCE',
    totalImageCount: 'TOTAL_IMAGE_COUNT',
} as const;

const PATHOLOGY_SLIDE_TYPES: PathologySlideType[] = [
    'H&E',
    'IHC',
    'Other',
    'Unknown',
];

type CachedPathologyAssociationGroupsEntry = {
    associationSignature: string | null;
    cacheKey: string;
    hierarchyRef: PatientHierarchy;
    groups: PathologyAssociationGroup[];
};

export type PathologyTimelineEvent = ClinicalEvent & {
    uniqueSampleKey?: string;
};

export type PathologyAssociationGroup = {
    date: number | null;
    dated: boolean;
    imageCount: number;
    nonServableImageCount: number;
    imageIds: string[];
    sampleId: string | null;
    specimen: string;
    specimenKey: string;
    subtype: PathologySlideType;
    timepointSource: string;
    matchLevel: string;
};

type MutablePathologyAssociationGroup = Omit<
    PathologyAssociationGroup,
    'imageIds'
> & {
    imageIds: Set<string>;
};

const pathologyAssociationGroupsCache = new WeakMap<
    PatientHierarchy,
    CachedPathologyAssociationGroupsEntry
>();
function freezePathologyAssociationGroup(
    group: MutablePathologyAssociationGroup
): PathologyAssociationGroup {
    const imageIds = new Array<string>(group.imageIds.size);
    let imageIndex = 0;
    for (const imageId of group.imageIds) {
        imageIds[imageIndex] = imageId;
        imageIndex += 1;
    }

    return Object.freeze({
        ...group,
        imageIds: Object.freeze(imageIds),
    }) as PathologyAssociationGroup;
}

function freezePathologyAssociationGroups(
    groups: MutablePathologyAssociationGroup[]
): PathologyAssociationGroup[] {
    const frozenGroups = new Array<PathologyAssociationGroup>(groups.length);
    for (let index = 0; index < groups.length; index += 1) {
        frozenGroups[index] = freezePathologyAssociationGroup(groups[index]);
    }
    return Object.freeze(frozenGroups) as PathologyAssociationGroup[];
}

function getPathologyGroupSampleDisplayValue(
    group: Pick<PathologyAssociationGroup, 'sampleId' | 'matchLevel'>
): string {
    if (group.sampleId) {
        return group.sampleId;
    }
    return group.matchLevel === 'Unmatched' ? 'Unmatched' : '';
}

function createSingletonStringSet(value: string): Set<string> {
    const set = new Set<string>();
    set.add(value);
    return set;
}

function joinDistinctValues(existing: string, value: string): string {
    const entries = existing ? existing.split(', ') : [];
    let hasValue = false;
    let nextCount = 0;

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry) {
            continue;
        }
        if (entry === value) {
            hasValue = true;
        }
        entries[nextCount] = entry;
        nextCount += 1;
    }

    if (!hasValue && value) {
        entries[nextCount] = value;
        nextCount += 1;
    }

    if (nextCount === 0) {
        return '';
    }

    let joined = entries[0];
    for (let index = 1; index < nextCount; index += 1) {
        joined += `, ${entries[index]}`;
    }
    return joined;
}

function buildPathologyAssociationsSignature(
    hierarchy: PatientHierarchy
): string {
    const associations = getPathologySlideAssociationsReadOnly(hierarchy);
    if (!associations.length) {
        return '';
    }

    const snapshots = new Array<string>(associations.length);
    for (let index = 0; index < associations.length; index += 1) {
        snapshots[index] = buildPathologyAssociationSnapshot(
            associations[index]
        );
    }
    snapshots.sort((left, right) => left.localeCompare(right));
    return snapshots.join('|');
}

export function hasServableDiagnosticSlides(
    hierarchy: PatientHierarchy,
    allowedSampleIds?: Set<string>
): boolean {
    return !!hierarchy.slide_associations?.some(
        association =>
            association.can_serve_tiles &&
            (!allowedSampleIds ||
                association.sample_id == null ||
                allowedSampleIds.has(association.sample_id))
    );
}

export function buildPatientHierarchyUrl(
    tileServerBase: string,
    patientId: string,
    studyId: string
): string {
    return `${tileServerBase}/patient/${encodeURIComponent(
        patientId
    )}?studyId=${encodeURIComponent(studyId)}`;
}

/** Build the cBioPortal backend hierarchy endpoint for a patient. */
export function buildPatientHierarchyApiUrl(
    patientId: string,
    studyId: string
): string {
    return buildWsiHierarchyApiUrl(studyId, patientId);
}

function collectHierarchySlidePresence(
    hierarchy: PatientHierarchy
): {
    allImageIds: Set<string>;
    servableImageIds: Set<string>;
} {
    const allImageIds = new Set<string>();
    const servableImageIds = new Set<string>();

    for (
        let sampleIndex = 0;
        sampleIndex < hierarchy.samples.length;
        sampleIndex += 1
    ) {
        const sample = hierarchy.samples[sampleIndex];
        for (
            let partIndex = 0;
            partIndex < sample.parts.length;
            partIndex += 1
        ) {
            const part = sample.parts[partIndex];
            for (
                let blockIndex = 0;
                blockIndex < part.blocks.length;
                blockIndex += 1
            ) {
                const block = part.blocks[blockIndex];
                for (
                    let slideIndex = 0;
                    slideIndex < block.slides.length;
                    slideIndex += 1
                ) {
                    const slide = block.slides[slideIndex];
                    if (!slide.image_id) {
                        continue;
                    }
                    allImageIds.add(slide.image_id);
                }
            }
        }
    }

    const servableEntries = getServableSlideEntriesForHierarchyReadOnly(
        hierarchy
    );
    for (let index = 0; index < servableEntries.length; index += 1) {
        servableImageIds.add(servableEntries[index].slide.image_id);
    }

    return { allImageIds, servableImageIds };
}

export function buildPathologyAssociationGroups(
    hierarchy: PatientHierarchy,
    samples: ClinicalDataBySampleId[]
): PathologyAssociationGroup[] {
    void samples;
    const cacheKey = buildPathologyAssociationsSignature(hierarchy);
    const cached = pathologyAssociationGroupsCache.get(hierarchy);
    if (
        cached &&
        cached.hierarchyRef === hierarchy &&
        cached.cacheKey === cacheKey &&
        cached.associationSignature === cacheKey
    ) {
        return cached.groups;
    }

    const groups = new Map<string, MutablePathologyAssociationGroup>();
    const hierarchySlidePresence = collectHierarchySlidePresence(hierarchy);

    let canonicalServableAssociationSnapshots: Set<string> | null = null;
    if (hierarchy.slide_associations?.length) {
        canonicalServableAssociationSnapshots = new Set<string>();
        const canonicalAssociations = getServableSlideAssociationsByImageIdReadOnly(
            hierarchy.slide_associations
        );
        const canonicalAssociationValues = canonicalAssociations.values();
        let currentCanonicalAssociation = canonicalAssociationValues.next();
        while (!currentCanonicalAssociation.done) {
            const association = currentCanonicalAssociation.value;
            canonicalServableAssociationSnapshots!.add(
                buildPathologyAssociationSnapshot(association)
            );
            currentCanonicalAssociation = canonicalAssociationValues.next();
        }
    }

    const slideAssociations = getPathologySlideAssociationsReadOnly(hierarchy);
    for (
        let associationIndex = 0;
        associationIndex < slideAssociations.length;
        associationIndex += 1
    ) {
        const association = slideAssociations[associationIndex];
        if (
            association.can_serve_tiles
                ? !hierarchySlidePresence.servableImageIds.has(
                      association.image_id
                  )
                : !hierarchySlidePresence.allImageIds.has(association.image_id)
        ) {
            continue;
        }
        if (
            association.can_serve_tiles &&
            canonicalServableAssociationSnapshots &&
            !canonicalServableAssociationSnapshots.has(
                buildPathologyAssociationSnapshot(association)
            )
        ) {
            continue;
        }

        const dated =
            typeof association.procedure_date_days === 'number' &&
            Number.isFinite(association.procedure_date_days);
        // Undated associations stay available to the adjacent undated
        // section, but are never assigned a synthetic day-zero position.
        const date = dated ? association.procedure_date_days! : null;
        const timepointSource = association.timepoint_source || '';

        for (
            let slideTypeIndex = 0;
            slideTypeIndex < PATHOLOGY_SLIDE_TYPES.length;
            slideTypeIndex += 1
        ) {
            const slideType = PATHOLOGY_SLIDE_TYPES[slideTypeIndex];
            if (!matchesPathologySlideType(association, slideType)) {
                continue;
            }

            const specimen = formatSpecimenLabel(association);
            const matchLevel = formatMatchLevel(association.match_level);
            const groupKey = [
                date == null ? 'undated' : date,
                slideType,
                association.sample_id || '',
                association.match_level,
                association.can_serve_tiles
                    ? association.specimen_key
                    : specimen,
            ].join('::');
            const existing = groups.get(groupKey);

            if (existing) {
                if (!existing.imageIds.has(association.image_id)) {
                    existing.imageIds.add(association.image_id);
                    if (association.can_serve_tiles) {
                        existing.imageCount += 1;
                    } else {
                        existing.nonServableImageCount += 1;
                    }
                }
                existing.timepointSource = joinDistinctValues(
                    existing.timepointSource,
                    timepointSource
                );
                continue;
            }

            groups.set(groupKey, {
                date,
                dated,
                imageCount: association.can_serve_tiles ? 1 : 0,
                imageIds: createSingletonStringSet(association.image_id),
                nonServableImageCount: association.can_serve_tiles ? 0 : 1,
                sampleId: association.sample_id,
                specimen,
                specimenKey: association.specimen_key,
                subtype: slideType,
                timepointSource,
                matchLevel,
            });
        }
    }

    const materializedGroups = new Array<MutablePathologyAssociationGroup>(
        groups.size
    );
    const groupValues = groups.values();
    let currentGroup = groupValues.next();
    let groupIndex = 0;
    while (!currentGroup.done) {
        materializedGroups[groupIndex] = currentGroup.value;
        groupIndex += 1;
        currentGroup = groupValues.next();
    }
    materializedGroups.sort(
        (a, b) =>
            (a.date == null ? 1 : b.date == null ? -1 : a.date - b.date) ||
            getPathologyGroupSampleDisplayValue(a).localeCompare(
                getPathologyGroupSampleDisplayValue(b)
            ) ||
            a.matchLevel.localeCompare(b.matchLevel) ||
            a.specimen.localeCompare(b.specimen) ||
            a.subtype.localeCompare(b.subtype)
    );
    const sortedGroups = freezePathologyAssociationGroups(materializedGroups);

    pathologyAssociationGroupsCache.set(hierarchy, {
        associationSignature: cacheKey,
        cacheKey,
        hierarchyRef: hierarchy,
        groups: sortedGroups,
    });

    return sortedGroups;
}

export function getUndatedPathologyAssociationGroups(
    hierarchy: PatientHierarchy,
    samples: ClinicalDataBySampleId[]
): PathologyAssociationGroup[] {
    return buildPathologyAssociationGroups(hierarchy, samples).filter(
        group => !group.dated
    );
}

export function getUndatedPathologySlideCount(
    hierarchy: PatientHierarchy,
    samples: ClinicalDataBySampleId[]
): number {
    const associations = getServableSlideAssociationsByImageIdReadOnly(
        hierarchy.slide_associations
    );
    return getServableSlideEntriesForHierarchyReadOnly(hierarchy).filter(
        ({ slide }) =>
            getServableSlideTimepointDays(
                slide,
                associations.get(slide.image_id)
            ) == null
    ).length;
}

export function buildTimelineEventsSignature(events: ClinicalEvent[]): string {
    return buildClinicalEventsSignature(events, {
        includeUniqueKeys: false,
    });
}
