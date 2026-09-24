import { ClinicalEvent } from 'cbioportal-ts-api-client';
import { groupTimelineData } from './timelineDataUtils';

function event(
    eventType: string,
    attributes: Array<{ key: string; value: string }> = [],
    start = 5
): ClinicalEvent {
    return ({
        eventType,
        patientId: 'P-1',
        studyId: 'study',
        uniquePatientKey: 'patient-key',
        uniqueSampleKey: 'sample-key',
        startNumberOfDaysSinceDiagnosis: start,
        endNumberOfDaysSinceDiagnosis: start,
        attributes,
    } as unknown) as ClinicalEvent;
}

describe('groupTimelineData', () => {
    it('groups events and preserves first-seen attribute columns', () => {
        expect(
            groupTimelineData([
                event('TREATMENT', [
                    { key: 'B', value: '2' },
                    { key: 'A', value: '1' },
                ]),
                event('TREATMENT', [{ key: 'C', value: '3' }]),
                event('STATUS', [{ key: 'STATE', value: 'ACTIVE' }]),
            ])
        ).toEqual({
            TREATMENT: [
                [
                    'PATIENT_ID',
                    'START_DATE',
                    'STOP_DATE',
                    'EVENT_TYPE',
                    'B',
                    'A',
                    'C',
                ],
                ['P-1', '5', '5', 'TREATMENT', '2', '1', ''],
                ['P-1', '5', '5', 'TREATMENT', '', '', '3'],
            ],
            STATUS: [
                [
                    'PATIENT_ID',
                    'START_DATE',
                    'STOP_DATE',
                    'EVENT_TYPE',
                    'STATE',
                ],
                ['P-1', '5', '5', 'STATUS', 'ACTIVE'],
            ],
        });
    });

    it('recomputes ordinary timeline data after event changes', () => {
        const events = [event('TREATMENT', [{ key: 'A', value: '1' }])];
        const first = groupTimelineData(events);
        events[0] = event('TREATMENT', [{ key: 'A', value: '9' }], 6);

        expect(groupTimelineData(events)).not.toBe(first);
        expect(groupTimelineData(events).TREATMENT[1]).toEqual([
            'P-1',
            '6',
            '6',
            'TREATMENT',
            '9',
        ]);
    });
});
