import * as React from 'react';
import { parse } from 'query-string';
import { getBrowserWindow } from 'cbioportal-frontend-commons';
import { getServerConfig } from 'config/config';
import { AppWsiViewer } from 'shared/components/wsiViewer/wsiAppConfig';
import { capWsiViewerHeight } from 'cbioportal-wsi-viewer';
import { buildCBioPortalPageUrl } from 'shared/api/urls';

/**
 * A slide permalink that opens at one annotation:
 * `/wsi/patient/{patient}?studyId=..&slideKey=..&annotationId=..`.
 */
export function wsiRouteAnnotationLink(
    studyId: string,
    patientId: string,
    target: { slideKey: string; annotationId: string }
): string {
    return buildCBioPortalPageUrl(
        `wsi/patient/${encodeURIComponent(patientId)}`,
        {
            studyId,
            slideKey: target.slideKey,
            annotationId: target.annotationId,
        }
    );
}

/**
 * Drops `annotationId` from the address bar once the viewer used it, so a
 * reload or a copied address does not open the annotation again.
 */
export function dropRouteAnnotationId() {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('annotationId')) return;
    url.searchParams.delete('annotationId');
    window.history.replaceState(window.history.state, '', url.toString());
}

/**
 * The signed-in portal user (`AppStore.userName`, the principal the study
 * access check forwards as `X-Auth-Request-User`), when the app has one.
 */
export function portalUserName(): string | undefined {
    const name = getBrowserWindow().globalStores?.appStore?.userName;
    return typeof name === 'string' && name ? name : undefined;
}

interface Props {
    match: { params: { patientId: string } };
    location: { search?: string };
}

/**
 * The full-page slide viewer that slide permalinks open:
 * `/wsi/patient/{patient}?studyId=..&slideKey=..`. cbioportal-core writes
 * these links as the WSI_SAMPLE resource URLs, and the backend serves this
 * path to the app.
 */
export default function WsiPatientViewRoute({ match, location }: Props) {
    const query = parse(location.search || '');
    const studyId = typeof query.studyId === 'string' ? query.studyId : '';
    // The router basename supplies any deployment context path.
    const requestedSlideKey =
        typeof query.slideKey === 'string' && query.slideKey
            ? query.slideKey
            : undefined;
    const requestedAnnotationId =
        typeof query.annotationId === 'string' && query.annotationId
            ? query.annotationId
            : undefined;
    const patientId = match.params.patientId;
    const annotationLink = React.useCallback(
        (target: { slideKey: string; annotationId: string }) =>
            wsiRouteAnnotationLink(studyId, patientId, target),
        [studyId, patientId]
    );
    const tileServerUrl = getServerConfig().wsi_tile_server_url;

    if (!studyId || !tileServerUrl) {
        return (
            <div role="alert" data-testid="wsi-route-unavailable">
                WSI viewer configuration is unavailable.
            </div>
        );
    }

    const height =
        typeof window === 'undefined'
            ? 720
            : capWsiViewerHeight(
                  Math.max(480, window.innerHeight - 120),
                  window.innerWidth
              );

    return (
        <AppWsiViewer
            patientId={match.params.patientId}
            studyId={studyId}
            tileServerUrl={tileServerUrl}
            height={height}
            requestedSlideKey={requestedSlideKey}
            requestedAnnotationId={requestedAnnotationId}
            requestedAnnotationSlideKey={requestedSlideKey}
            onRequestedAnnotationUsed={dropRouteAnnotationId}
            annotationLink={annotationLink}
            userName={portalUserName()}
        />
    );
}
