import { ResourceData } from 'cbioportal-ts-api-client';
import { getServerConfig } from 'config/config';

// H&E slide resources that the native viewer replaces. Every H&E resource on
// the public and MSK portals uses one of these IDs.
const LEGACY_HE_RESOURCE_IDS = new Set(['HE', 'MSK_HNE']);
// Whole-slide images are stored as these resources, one row per slide (1.7M
// for MSK-IMPACT). The patient view reaches slides through its Pathology
// Slides tab; study view lists WSI_SAMPLE as its slide table, which the
// backend serves with only the allowlisted public slide fields.
const WSI_RESOURCE_IDS = new Set(['WSI_SAMPLE', 'WSI_PATIENT']);
const STUDY_SLIDE_TABLE_RESOURCE_ID = 'WSI_SAMPLE';

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

/** Resource tabs study view's resource table offers: the slide table, not WSI_PATIENT. */
export function isStudyViewResourceTab(resourceId: string): boolean {
    return (
        !shouldHideLegacyHeResourceTab(resourceId) &&
        (!isWsiResourceId(resourceId) ||
            resourceId === STUDY_SLIDE_TABLE_RESOURCE_ID)
    );
}

/** Resource tabs the patient view's resource table offers: no slide resources. */
export function isPatientViewResourceTab(resourceId: string): boolean {
    return (
        !shouldHideLegacyHeResourceTab(resourceId) &&
        !isWsiResourceId(resourceId)
    );
}

export function shouldHideLegacyHeResource(
    resource?: Partial<ResourceData>
): boolean {
    return shouldHideLegacyHeResourceTab(
        resource?.resourceId || resource?.resourceDefinition?.resourceId
    );
}
