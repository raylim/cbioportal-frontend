// Type-only imports keep this module free of path aliases, so the Playwright
// specs can import it too.
import {
    ResourceTableTestServer,
    ResourceTableTestServerOptions,
    TestResourceRow,
} from '../../../../shared/api/resourceTableTestServer';
import {
    ResourceTableQuery,
    ResourceTabsRequest,
} from '../../../../shared/api/resourceTableClient';
import {
    StudySlideMatchLevel,
    StudySlideStainCounts,
    StudySlidesResourceApi,
} from './studySlidesApi';

export { settle } from '../../../../shared/api/resourceTableTestServer';

/** A patient's slides, as a test describes them. */
export interface TestSlidePatient {
    studyId: string;
    patientId: string;
    /** Slides of each stain group. */
    stainGroupCounts: Partial<StudySlideStainCounts>;
    /** Samples the slides are matched to, in turn; none makes every slide unmatched. */
    sampleCount: number;
    /** Match level of the matched slides; BLOCK by default. */
    matchLevel?: StudySlideMatchLevel;
}

/** A 12-hex slide key, distinct per patient and slide. */
export function testSlideKey(patientIndex: number, slideIndex: number) {
    return (patientIndex * 1000 + slideIndex + 1)
        .toString(16)
        .padStart(12, '0');
}

/**
 * The WSI_SAMPLE and WSI_PATIENT rows of the patients' slides: matched slides go to their
 * samples in turn, and a patient without samples has unmatched, patient-level slides.
 */
export function slideRowsFor(patients: TestSlidePatient[]): TestResourceRow[] {
    const rows: TestResourceRow[] = [];
    patients.forEach((patient, patientIndex) => {
        let slide = 0;
        Object.entries(patient.stainGroupCounts).forEach(([stain, count]) => {
            for (let i = 0; i < (count || 0); i++, slide++) {
                const sampleId =
                    patient.sampleCount > 0
                        ? `${patient.patientId}-S${(slide %
                              patient.sampleCount) +
                              1}`
                        : null;
                rows.push({
                    studyId: patient.studyId,
                    resourceId: sampleId ? 'WSI_SAMPLE' : 'WSI_PATIENT',
                    patientId: patient.patientId,
                    sampleId,
                    metadata: {
                        slide_key: testSlideKey(patientIndex, slide),
                        stain_group: stain,
                        match_level: sampleId
                            ? patient.matchLevel || 'BLOCK'
                            : 'UNMATCHED',
                    },
                });
            }
        });
    });
    return rows;
}

/** The requests a test API received, by endpoint. */
export interface RecordedSlideRequests {
    tabs: ResourceTabsRequest[];
    groups: ResourceTableQuery[];
    metadata: ResourceTableQuery[];
}

/**
 * The resource-table endpoints the Pathology Slides tab reads, answered by a
 * ResourceTableTestServer over the patients' slide rows, recording each request.
 */
export function testSlidesApi(
    patients: () => TestSlidePatient[],
    options?: ResourceTableTestServerOptions
): { api: StudySlidesResourceApi; requests: RecordedSlideRequests } {
    const server = new ResourceTableTestServer(
        () => slideRowsFor(patients()),
        options
    );
    const requests: RecordedSlideRequests = {
        tabs: [],
        groups: [],
        metadata: [],
    };
    return {
        requests,
        api: {
            tabs: async request => {
                requests.tabs.push(request);
                return server.tabs(request);
            },
            groups: async query => {
                requests.groups.push(query);
                return server.groups(query);
            },
            metadata: async query => {
                requests.metadata.push(query);
                return server.metadata(query);
            },
        },
    };
}

/** The patient-grouped list requests among the groups requests, leaving the sample counts out. */
export function patientListRequests(requests: RecordedSlideRequests) {
    return requests.groups.filter(query => query.groupBy === 'patient');
}
