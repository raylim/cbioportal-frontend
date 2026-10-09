import { ResourceData } from 'cbioportal-ts-api-client';
import { WsiStainFilter } from 'cbioportal-wsi-viewer';
import { getServerConfig } from 'config/config';
import { PatientViewPageTabs } from 'pages/patientView/PatientViewPageTabIds';

// H&E slide resources that the native viewer replaces. Every H&E resource on
// the public and MSK portals uses one of these IDs.
const LEGACY_HE_RESOURCE_IDS = new Set(['HE', 'MSK_HNE']);
// Whole-slide images are stored as these resources, one row per slide (1.7M
// for MSK-IMPACT). The patient view reaches slides through its Pathology
// Slides tab; study view lists WSI_SAMPLE as its slide table, which the
// backend serves with only the allowlisted public slide fields.
const WSI_RESOURCE_IDS = new Set(['WSI_SAMPLE', 'WSI_PATIENT']);
export const STUDY_SLIDE_TABLE_RESOURCE_ID = 'WSI_SAMPLE';

function isNonEmptyString(value: string | null | undefined): boolean {
    return (value?.trim().length ?? 0) > 0;
}

export function isWsiResourceId(resourceId: string | undefined): boolean {
    return !!resourceId && WSI_RESOURCE_IDS.has(resourceId);
}

export function isWsiTileServerConfigured(): boolean {
    return isNonEmptyString(getServerConfig().msk_wsi_tile_server_url);
}

export function shouldHideLegacyHeResourceTab(
    resourceId: string | undefined
): boolean {
    return !!resourceId && isWsiTileServerConfigured()
        ? LEGACY_HE_RESOURCE_IDS.has(resourceId)
        : false;
}

/**
 * The study's resource definitions Files & Links lists: legacy H&E ones give way to the slide
 * viewer, so a study with only those has no Files & Links tab.
 */
export function visibleStudyResourceDefinitions<
    T extends { resourceId: string }
>(definitions: T[]): T[] {
    return definitions.filter(
        d => !shouldHideLegacyHeResourceTab(d.resourceId)
    );
}

/**
 * Resource tabs study view's resource table offers. WSI_PATIENT never shows; the slide table
 * (WSI_SAMPLE) shows as its own tab only without the slide viewer. With the viewer configured,
 * the Pathology Slides tab shows the slide table as one of its views instead.
 */
export function isStudyViewResourceTab(resourceId: string): boolean {
    return (
        !shouldHideLegacyHeResourceTab(resourceId) &&
        (!isWsiResourceId(resourceId) ||
            (resourceId === STUDY_SLIDE_TABLE_RESOURCE_ID &&
                !isWsiTileServerConfigured()))
    );
}

/** The slide key a slide table row's viewer link names, if any. */
export function slideKeyFromSlideUrl(
    url: string | undefined
): string | undefined {
    const match = /[?&]slideKey=([0-9a-f]{32})(?:&|#|$)/.exec(url || '');
    return match ? match[1] : undefined;
}

/** Resource tabs the patient view's resource table offers: no slide resources. */
export function isPatientViewResourceTab(resourceId: string): boolean {
    return (
        !shouldHideLegacyHeResourceTab(resourceId) &&
        !isWsiResourceId(resourceId)
    );
}

/**
 * The patient view tab a resource row's patient or sample link opens: slides live in the Pathology
 * Slides tab (the patient view's resource table leaves them out), everything else in Files & Links.
 */
export function patientViewPathForResource(
    resourceId: string | undefined
): string {
    return `patient/${
        isWsiResourceId(resourceId)
            ? PatientViewPageTabs.WSIHESlides
            : PatientViewPageTabs.FilesAndLinks
    }`;
}

/** The slide stain groups and the Pathology Slides stain filter each corresponds to. */
export const STAIN_GROUP_TO_SLIDE_STAIN_FILTER: {
    [stainGroup: string]: Exclude<WsiStainFilter, 'all'>;
} = {
    'H&E': 'hne',
    IHC: 'ihc',
    Other: 'other',
    Unknown: 'unknown',
};

/**
 * The Pathology Slides stain filter for a slide table narrowed to exactly one
 * stain group, so a patient or sample link opens the slides filtered the same
 * way. Any other filtering has no viewer equivalent and is not carried over.
 */
export function slideStainFilterForColumnFilters(
    filters: ReadonlyArray<{
        columnId: string;
        operator: string;
        values?: string[];
    }>
): string | undefined {
    const stainGroup = filters.filter(
        filter => filter.columnId === 'metadata:stain_group'
    );
    if (stainGroup.length !== 1) {
        return undefined;
    }
    const { operator, values } = stainGroup[0];
    if (operator !== 'in' || !values || values.length !== 1) {
        return undefined;
    }
    return STAIN_GROUP_TO_SLIDE_STAIN_FILTER[values[0]];
}

/** The patient view query that opens Pathology Slides with this stain filter. */
export function slideStainFilterQuery(
    stainFilter: string | undefined
): { pathologySlideSettings?: string } {
    return stainFilter
        ? { pathologySlideSettings: JSON.stringify({ stainFilter }) }
        : {};
}

export function shouldHideLegacyHeResource(
    resource?: Partial<ResourceData>
): boolean {
    return shouldHideLegacyHeResourceTab(
        resource?.resourceId || resource?.resourceDefinition?.resourceId
    );
}
