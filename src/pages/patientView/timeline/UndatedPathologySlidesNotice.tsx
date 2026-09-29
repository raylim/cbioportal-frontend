import React from 'react';
import { Link } from 'react-router-dom';
import { fetchUndatedViewableSlideCount } from 'cbioportal-wsi-viewer';
import { buildWsiViewerConfig } from 'shared/components/wsiViewer/wsiAppConfig';

/** Patient attribute with the patient's WSI slide count. */
export const WSI_PATIENT_SLIDE_COUNT_ATTRIBUTE = 'WSI_PATIENT_SLIDE_COUNT';

/** Pathology Slides tab showing only the patient's undated slides. */
export function undatedPathologySlidesPath(
    studyId: string,
    patientId: string
): string {
    const query = new URLSearchParams({
        studyId,
        caseId: patientId,
        timepointDays: 'undated',
    });
    return `/patient/wsiHESlides?${query.toString()}`;
}

export function undatedPathologySlidesMessage(count: number): string {
    return count === 1
        ? '1 viewable pathology slide has no procedure date, so it is not shown on the timeline.'
        : `${count} viewable pathology slides have no procedure date, so they are not shown on the timeline.`;
}

/**
 * Notice for viewable slides without a procedure day: they have no PATHOLOGY
 * SLIDES timeline event, so they appear neither on the timeline nor in the
 * Clinical Data table. Renders nothing while loading, when there are none,
 * or when the hierarchy can't be read (the Pathology Slides tab reports that
 * error).
 */
const UndatedPathologySlidesNotice: React.FunctionComponent<{
    studyId: string;
    patientId: string;
    userName?: string;
}> = function({ studyId, patientId, userName }) {
    const [count, setCount] = React.useState(0);
    React.useEffect(() => {
        setCount(0);
        const controller = new AbortController();
        fetchUndatedViewableSlideCount(
            buildWsiViewerConfig(userName),
            studyId,
            patientId,
            controller.signal
        ).then(
            n => {
                if (!controller.signal.aborted) {
                    setCount(n);
                }
            },
            () => undefined
        );
        return () => controller.abort();
    }, [studyId, patientId, userName]);

    if (count === 0) {
        return null;
    }
    return (
        <div
            className="alert alert-info"
            role="status"
            data-test="undated-pathology-slides-notice"
            style={{ padding: '6px 10px', marginTop: 15, marginBottom: 10 }}
        >
            {undatedPathologySlidesMessage(count)}{' '}
            <Link to={undatedPathologySlidesPath(studyId, patientId)}>
                View undated slides
            </Link>
        </div>
    );
};

export default UndatedPathologySlidesNotice;
