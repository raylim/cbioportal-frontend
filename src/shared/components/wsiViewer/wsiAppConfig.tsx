import * as React from 'react';
import { DownloadControlOption } from 'cbioportal-frontend-commons';
import { WsiViewerConfig, WsiViewerProps } from 'cbioportal-wsi-viewer';
import { getServerConfig } from 'config/config';
import { buildCBioPortalAPIUrl, buildCBioPortalPageUrl } from 'shared/api/urls';
import LoadingIndicator from 'shared/components/loadingIndicator/LoadingIndicator';
import { useWsiClinicalRows, WsiPatientClinicalData } from './wsiClinicalRows';

const WSI_OSD_PREFIX_URL = '/reactapp/osd-images/';

function renderWsiLoading() {
    return <LoadingIndicator isLoading={true} center={true} size="big" />;
}

/** The terms of a comma-separated frontend property, trimmed. */
export function parseWsiLabelVocabulary(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    return Array.from(
        new Set(
            value
                .split(',')
                .map(term => term.trim())
                .filter(Boolean)
        )
    );
}

/** A boolean frontend property, which may arrive as a string. */
function isTrueProperty(value: unknown): boolean {
    return value === true || value === 'true';
}

/** Viewer services from the portal configuration, installed at startup. */
export function buildWsiViewerConfig(): WsiViewerConfig {
    const annotationApiUrl = getServerConfig().wsi_annotation_api_url?.trim();
    return {
        buildApiUrl: (path: string) => buildCBioPortalAPIUrl(path),
        buildPageUrl: (path: string, query: Record<string, string>) =>
            buildCBioPortalPageUrl(path, query),
        osdPrefixUrl: WSI_OSD_PREFIX_URL,
        annotations: annotationApiUrl
            ? {
                  apiUrl: annotationApiUrl.replace(/\/+$/, ''),
                  labelVocabulary: parseWsiLabelVocabulary(
                      getServerConfig().wsi_annotation_label_vocabulary
                  ),
                  labelVocabularyStrict: isTrueProperty(
                      getServerConfig().wsi_annotation_label_vocabulary_strict
                  ),
              }
            : undefined,
    };
}

/**
 * Subject that scopes the viewer caches: the signed-in user name, else the
 * configured display name, else the anonymous user.
 */
export function wsiAuthScope(userName?: string): string {
    return userName || getServerConfig().user_display_name || 'anonymousUser';
}

/**
 * The signed-in user as the annotation service names creators: the page's
 * portal user name (`AppStore.userName`, the backend's
 * `Authentication.getName()`, which the study access check forwards as
 * `X-Auth-Request-User`); only when the page passes none, the configured
 * display name. Undefined when anonymous.
 */
export function wsiAnnotationUser(userName?: string): string | undefined {
    const user = userName || getServerConfig().user_display_name;
    return user && user !== 'anonymousUser' ? user : undefined;
}

// The viewer is its own async chunk, and OpenSeadragon another one loaded on
// first slide open: most patient pages have no slides.
export const LazyWsiViewer = React.lazy(() => {
    // The project TypeScript module target predates dynamic import syntax;
    // rspack still emits this as an async chunk.
    // @ts-ignore
    return import('cbioportal-wsi-viewer/viewer');
});

export type AppWsiViewerProps = Omit<
    WsiViewerProps,
    | 'authScope'
    | 'showDownload'
    | 'renderLoading'
    | 'clinicalRows'
    | 'annotationUser'
> & {
    /** Signed-in user name, when the page knows it. */
    userName?: string;
    /**
     * The patient's clinical data for the sidebar, when the page has loaded
     * it (`null` while loading); fetched by the viewer when unset.
     */
    clinicalData?: WsiPatientClinicalData | null;
};

/** The package viewer configured for this portal, loaded lazily. */
export function AppWsiViewer({
    userName,
    clinicalData,
    ...viewerProps
}: AppWsiViewerProps) {
    const clinicalRows = useWsiClinicalRows(
        viewerProps.studyId,
        viewerProps.patientId,
        clinicalData
    );
    return (
        <React.Suspense
            fallback={
                <div role="status" data-testid="wsi-viewer-loading">
                    Loading pathology slides…
                </div>
            }
        >
            <LazyWsiViewer
                {...viewerProps}
                authScope={wsiAuthScope(userName)}
                annotationUser={wsiAnnotationUser(userName)}
                showDownload={
                    getServerConfig().skin_hide_download_controls ===
                    DownloadControlOption.SHOW_ALL
                }
                renderLoading={renderWsiLoading}
                clinicalRows={clinicalRows}
            />
        </React.Suspense>
    );
}
