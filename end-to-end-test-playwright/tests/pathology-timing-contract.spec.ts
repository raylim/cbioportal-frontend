import { test, expect } from '../fixtures';

const baseUrl = process.env.WSI_VIEWER_BASE_URL ?? '';
const timingStudyId = process.env.WSI_TIMING_STUDY_ID ?? 'mskimpact';
const undatedPatientId =
    process.env.WSI_TIMING_UNDATED_PATIENT_ID ?? 'P-0003647';
const undatedSlideCount = Number(
    process.env.WSI_TIMING_UNDATED_SLIDE_COUNT ?? '260'
);
const recordedPatientId =
    process.env.WSI_TIMING_RECORDED_PATIENT_ID ?? 'P-0000012';
const recordedSlideId =
    process.env.WSI_TIMING_RECORDED_SLIDE_ID ?? '322525';
const recordedDateDays = Number(
    process.env.WSI_TIMING_RECORDED_DATE_DAYS ?? '-53'
);
const recordedDateSource =
    process.env.WSI_TIMING_RECORDED_DATE_SOURCE ??
    'DATE_OF_PROCEDURE_SURGICAL';

test.describe('WSI pathology timing contract', () => {
    test('serves recorded and undated timing without a synthetic day-zero date', async ({
        request,
    }) => {
        test.skip(!baseUrl, 'WSI_VIEWER_BASE_URL not set');

        const undatedResponse = await request.get(
            `${baseUrl}/api/wsi/v2/hierarchy/${timingStudyId}/${undatedPatientId}`
        );
        expect(undatedResponse.ok()).toBe(true);
        const undated = await undatedResponse.json();
        const undatedSlides = undated.sampleGroups
            .flatMap((group: any) => group.parts)
            .flatMap((part: any) => part.blocks)
            .flatMap((block: any) => block.slides);
        expect(undatedSlides.length).toBe(undatedSlideCount);
        expect(
            undatedSlides.every(
                (slide: any) =>
                    slide.procedureDateDays === null &&
                    slide.procedureDateKind === 'UNDATED' &&
                    slide.procedureDateReason === 'MISSING_PROCEDURE_DATE'
            )
        ).toBe(true);

        const recordedResponse = await request.get(
            `${baseUrl}/api/wsi/v2/hierarchy/${timingStudyId}/${recordedPatientId}`
        );
        expect(recordedResponse.ok()).toBe(true);
        const recorded = await recordedResponse.json();
        const recordedSlide = recorded.sampleGroups
            .flatMap((group: any) => group.parts)
            .flatMap((part: any) => part.blocks)
            .flatMap((block: any) => block.slides)
            .find((slide: any) => slide.imageId === recordedSlideId);
        expect(recordedSlide).toMatchObject({
            procedureDateDays: recordedDateDays,
            procedureDateKind: 'RECORDED',
            procedureDateStatus: 'AVAILABLE',
            procedureDateSource: recordedDateSource,
        });
    });
});
