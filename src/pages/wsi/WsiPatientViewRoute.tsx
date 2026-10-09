import * as React from 'react';
import { parse } from 'query-string';
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import { getServerConfig } from 'config/config';
import internalClient from 'shared/api/cbioportalInternalClientInstance';
import { AppWsiViewer } from 'shared/components/wsiViewer/wsiAppConfig';

/**
 * Loads the patient's clinical events for sample acquisition/sequencing
 * days. The viewer renders without them, and a failed request leaves them
 * unset so slides keep their patient-level timepoints.
 */
function usePatientClinicalEvents(
    studyId: string,
    patientId: string
): ClinicalEvent[] | undefined {
    const [events, setEvents] = React.useState<ClinicalEvent[] | undefined>();
    React.useEffect(() => {
        setEvents(undefined);
        if (!studyId || !patientId) {
            return;
        }
        let cancelled = false;
        internalClient
            .getAllClinicalEventsOfPatientInStudyUsingGET({
                studyId,
                patientId,
                projection: 'DETAILED',
            })
            .then(
                result => {
                    if (!cancelled) {
                        setEvents(result);
                    }
                },
                () => undefined
            );
        return () => {
            cancelled = true;
        };
    }, [studyId, patientId]);
    return events;
}

interface Props {
    match: { params: { patientId: string } };
    location: { search?: string };
}

/** Minimal standalone route used by the foundation smoke flow. */
export default function WsiPatientViewRoute({ match, location }: Props) {
    const query = parse(location.search || '');
    const studyId = typeof query.studyId === 'string' ? query.studyId : '';
    // Viewer links name one slide by its opaque key:
    // /wsi/patient/{patient}?studyId=..&slideKey=..
    // The router basename supplies any deployment context path.
    const requestedSlideKey =
        typeof query.slideKey === 'string' && query.slideKey
            ? query.slideKey
            : undefined;
    const tileServerUrl = getServerConfig().msk_wsi_tile_server_url;
    const clinicalEvents = usePatientClinicalEvents(
        tileServerUrl ? studyId : '',
        match.params.patientId
    );

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
            : Math.max(480, window.innerHeight - 120);

    return (
        <AppWsiViewer
            patientId={match.params.patientId}
            studyId={studyId}
            tileServerUrl={tileServerUrl}
            height={height}
            requestedSlideKey={requestedSlideKey}
            clinicalEvents={clinicalEvents}
        />
    );
}
