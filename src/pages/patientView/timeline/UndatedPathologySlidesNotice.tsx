import React from 'react';
import { Link } from 'react-router-dom';
import { ClinicalData } from 'cbioportal-ts-api-client';
import { patientCountAttribute } from './pathologySlidesTimelineLoader';
import { PatientViewPageTabs } from 'pages/patientView/PatientViewPageTabIds';

/** Patient attribute with the patient's viewable slides without a procedure date. */
export const WSI_PATIENT_UNDATED_SLIDE_COUNT_ATTRIBUTE =
    'WSI_PATIENT_UNDATED_SLIDE_COUNT';

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
    return `/patient/${PatientViewPageTabs.WSIHESlides}?${query.toString()}`;
}

/**
 * The patient's WSI_PATIENT_UNDATED_SLIDE_COUNT; 0 when missing or not a
 * number.
 */
export function patientUndatedSlideCount(
    clinicalDataPatient: Pick<ClinicalData, 'clinicalAttributeId' | 'value'>[]
): number {
    return patientCountAttribute(
        clinicalDataPatient,
        WSI_PATIENT_UNDATED_SLIDE_COUNT_ATTRIBUTE
    );
}

export function undatedPathologySlidesMessage(count: number): string {
    return count === 1
        ? '1 viewable pathology slide has no procedure date, so it is not shown on the timeline.'
        : `${count} viewable pathology slides have no procedure date, so they are not shown on the timeline.`;
}

/**
 * Notice for viewable slides without a procedure day: they have no PATHOLOGY
 * SLIDES timeline event, so the timeline does not show them. Renders nothing
 * when there are none.
 */
const UndatedPathologySlidesNotice: React.FunctionComponent<{
    studyId: string;
    patientId: string;
    count: number;
}> = function({ studyId, patientId, count }) {
    if (count <= 0) {
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
