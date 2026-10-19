import { WsiStainFilter } from 'cbioportal-wsi-viewer';
import { getServerConfig } from 'config/config';
import { PatientViewPageTabs } from 'pages/patientView/PatientViewPageTabIds';
import { PathologySlideSettings } from 'pages/patientView/PatientViewUrlWrapper';
import { isNonEmptyString } from './ResourceUtils';

// H&E slide resources that the native viewer replaces. Every H&E resource on
// the public and MSK portals uses one of these IDs.
const LEGACY_HE_RESOURCE_IDS = new Set(['HE', 'MSK_HNE']);
// Whole-slide images are stored as these resources, one row per slide. The
// patient view reaches slides through its Pathology Slides tab; study view
// lists WSI_SAMPLE as its slide table, which the backend serves with only the
// allowlisted public slide fields.
const WSI_RESOURCE_IDS = new Set(['WSI_SAMPLE', 'WSI_PATIENT']);
export const STUDY_SLIDE_TABLE_RESOURCE_ID = 'WSI_SAMPLE';

export function isWsiResourceId(resourceId: string | undefined): boolean {
    return !!resourceId && WSI_RESOURCE_IDS.has(resourceId);
}

export function isWsiTileServerConfigured(): boolean {
    return isNonEmptyString(getServerConfig().wsi_tile_server_url);
}

export function shouldHideLegacyHeResourceTab(
    resourceId: string | undefined
): boolean {
    return !!resourceId && isWsiTileServerConfigured()
        ? LEGACY_HE_RESOURCE_IDS.has(resourceId)
        : false;
}

/** The slide key a slide table row's viewer link names, if any. */
export function slideKeyFromSlideUrl(
    url: string | undefined
): string | undefined {
    const match = /[?&]slideKey=([0-9a-f]{12})(?:&|#|$)/.exec(url || '');
    return match ? match[1] : undefined;
}

/**
 * Resources the resource tables (Files & Links and the resource tabs) leave
 * out: slides are reached through the Pathology Slides views, which also
 * replace the legacy H&E resources when the slide viewer is configured.
 */
export function isHiddenFromResourceViews(resourceId: string): boolean {
    return (
        isWsiResourceId(resourceId) || shouldHideLegacyHeResourceTab(resourceId)
    );
}

/**
 * Resources study view's resource table leaves out. WSI_PATIENT never shows; the slide table
 * (WSI_SAMPLE) shows as its own tab only without the slide viewer. With the viewer configured,
 * the Pathology Slides tab shows the slide table as one of its views instead.
 */
export function isHiddenFromStudyResourceTable(resourceId: string): boolean {
    return (
        isHiddenFromResourceViews(resourceId) &&
        !(
            resourceId === STUDY_SLIDE_TABLE_RESOURCE_ID &&
            !isWsiTileServerConfigured()
        )
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
): WsiStainFilter | undefined {
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
    stainFilter: WsiStainFilter | undefined
): { pathologySlideSettings?: string } {
    const settings: PathologySlideSettings = { stainFilter };
    return stainFilter
        ? { pathologySlideSettings: JSON.stringify(settings) }
        : {};
}
