import { ClinicalEvent } from 'cbioportal-ts-api-client';
import { buildWsiSampleTimelineMap } from 'cbioportal-wsi-viewer';
import {
    buildPathologySlideRows,
    buildPathologySlideTooltipContent,
    formatSpecimen,
    pathologySlideSampleId,
    parseImageIds,
    pathologySlidesOpenPath,
} from './pathologySlidesTableUtils';

const LINKOUT =
    '/patient/wsiHESlides?studyId=mskimpact&caseId=P-0000081&stainFilter=hne&matchLevel=PART&specimenKey=part%3A%3Apart%3A1&sampleId=P-0000081-T02-IM6';

function event(
    eventType: string,
    days: number | undefined,
    attributes: Record<string, string>
): ClinicalEvent {
    return {
        eventType,
        startNumberOfDaysSinceDiagnosis: days,
        attributes: Object.entries(attributes).map(([key, value]) => ({
            key,
            value,
        })),
    } as ClinicalEvent;
}

function slideEvent(
    days: number | undefined,
    attributes: Record<string, string>
): ClinicalEvent {
    return event('PATHOLOGY SLIDES', days, {
        SAMPLE_ID: 'P-0000081-T02-IM6',
        SUBTYPE: 'H&E',
        MATCH_LEVEL: 'PART',
        SPECIMEN: 'Part 1',
        IMAGE_COUNT: '1',
        NON_SERVABLE_IMAGE_COUNT: '0',
        TOTAL_IMAGE_COUNT: '1',
        TIMEPOINT_SOURCE:
            'Recorded procedure date relative to first tumor sequencing',
        IMAGE_IDS: '["496610"]',
        LINKOUT,
        ...attributes,
    });
}

const SEQUENCING = event('Sequencing', 962, {
    SAMPLE_ID: 'P-0000081-T02-IM6',
});

function rows(events: ClinicalEvent[]) {
    return buildPathologySlideRows(
        events,
        buildWsiSampleTimelineMap([...events, SEQUENCING])
    );
}

describe('buildPathologySlideRows', () => {
    it('formats a matched event', () => {
        const [row] = rows([slideEvent(920, {})]);
        expect(row.procedureText).toBe('d+920');
        expect(row.procedureTooltip).toMatch(
            /^Recorded procedure date relative to first tumor sequencing\. Days are counted/
        );
        expect(row.sampleText).toBe('P-0000081-T02-IM6');
        expect(row.sequencingText).toBe('42 d before (d+962)');
        expect(row.sequencingTooltip).toContain(
            '42 days before this sample was sequenced (d+962)'
        );
        expect(row.stain).toBe('H&E');
        expect(row.matchText).toBe('Part');
        expect(row.matchTooltip).toBe(
            'The slide comes from the same specimen part as the sequenced sample; the sequenced block is not confirmed'
        );
        expect(row.specimen).toBe('Part 1');
        expect(row.slidesText).toBe('1 of 1 viewable');
        expect(row.slidesTooltip).toBe('Image IDs: 496610.');
        expect(row.openPath).toBe(LINKOUT);
        expect(row.openLabel).toBe('Open H&E slides for P-0000081-T02-IM6');
    });

    it('describes same-day and after-sequencing procedures', () => {
        const [same, after] = rows([
            slideEvent(962, {}),
            slideEvent(970, { SUBTYPE: 'IHC' }),
        ]);
        expect(same.sequencingText).toBe('same day (d+962)');
        expect(after.sequencingText).toBe('8 d after (d+962)');
    });

    it('sorts by procedure day, then sample, then stain', () => {
        const sorted = rows([
            slideEvent(920, { SUBTYPE: 'IHC' }),
            slideEvent(undefined, { SUBTYPE: 'H&E' }),
            slideEvent(920, { SAMPLE_ID: 'P-0000081-T01-IM3' }),
            slideEvent(-5, { SUBTYPE: 'IHC' }),
            slideEvent(920, {}),
        ]);
        expect(
            sorted.map(r => [r.procedureText, r.sampleText, r.stain])
        ).toEqual([
            ['d-5', 'P-0000081-T02-IM6', 'IHC'],
            ['d+920', 'P-0000081-T01-IM3', 'H&E'],
            ['d+920', 'P-0000081-T02-IM6', 'H&E'],
            ['d+920', 'P-0000081-T02-IM6', 'IHC'],
            ['', 'P-0000081-T02-IM6', 'H&E'],
        ]);
    });

    it('labels unmatched slides without a sequencing relation', () => {
        const [row] = rows([
            slideEvent(920, { MATCH_LEVEL: 'Unmatched', SAMPLE_ID: '' }),
        ]);
        expect(row.sampleId).toBeUndefined();
        expect(row.sampleText).toBe('Unmatched');
        expect(row.matchText).toBe('Unmatched');
        expect(row.matchTooltip).toBe('Not linked to a sequenced sample');
        expect(row.sequencingText).toBe('');
        expect(row.sequencingTooltip).toBeUndefined();
        expect(row.openLabel).toBe('Open H&E slides for Unmatched');
    });

    it('leaves the sequencing relation blank when the sample was not sequenced', () => {
        const [row] = rows([slideEvent(920, { SAMPLE_ID: 'P-OTHER' })]);
        expect(row.sequencingText).toBe('');
    });

    it('tolerates malformed IMAGE_IDS and reports non-viewable slides', () => {
        const [row] = rows([
            slideEvent(920, {
                IMAGE_IDS: '["1", ',
                IMAGE_COUNT: '2',
                TOTAL_IMAGE_COUNT: '3',
            }),
        ]);
        expect(row.imageIds).toEqual([]);
        expect(row.slidesText).toBe('2 of 3 viewable');
        expect(row.slidesTooltip).toBe(
            'No image IDs recorded. 1 slide is not viewable: no scanned image is available.'
        );
    });

    it('has no link when LINKOUT is empty or nothing is viewable', () => {
        const [empty, none] = rows([
            slideEvent(920, { LINKOUT: '' }),
            slideEvent(921, { IMAGE_COUNT: '0' }),
        ]);
        expect(empty.openPath).toBeUndefined();
        expect(none.openPath).toBeUndefined();
        expect(none.slidesText).toBe('0 of 1 viewable');
    });
});

describe('pathology slide helpers', () => {
    it('parses IMAGE_IDS arrays only', () => {
        expect(parseImageIds('["1", 2]')).toEqual(['1', '2']);
        expect(parseImageIds('{"a": 1}')).toEqual([]);
        expect(parseImageIds('not json')).toEqual([]);
        expect(parseImageIds(undefined)).toEqual([]);
    });

    it('removes a repeated "Block" from specimen labels', () => {
        expect(formatSpecimen('Part 6 / Block Block 1')).toBe(
            'Part 6 / Block 1'
        );
        expect(formatSpecimen('Part 6 / Block 1')).toBe('Part 6 / Block 1');
        expect(formatSpecimen('Part 1')).toBe('Part 1');
    });

    it('keeps only the path and query of a LINKOUT', () => {
        expect(
            pathologySlidesOpenPath(
                'https://portal.example/patient/wsiHESlides?caseId=P-1'
            )
        ).toBe('/patient/wsiHESlides?caseId=P-1');
        expect(pathologySlidesOpenPath('/patient/wsiHESlides')).toBe(undefined);
        expect(pathologySlidesOpenPath('  ')).toBe(undefined);
    });
});

describe('buildPathologySlideTooltipContent', () => {
    function tooltip(attributes: Record<string, string>, days?: number) {
        const [row] = rows([slideEvent(days, attributes)]);
        return buildPathologySlideTooltipContent(row);
    }

    it('summarizes a matched event with its sequencing offset', () => {
        const content = tooltip({}, 920);
        expect(content.title).toBe('Pathology slides · H&E · Part-matched');
        expect(content.lines.map(l => [l.label, l.value])).toEqual([
            ['Sample', 'P-0000081-T02-IM6'],
            ['Procedure', 'd+920 — 42 d before sequencing (d+962)'],
            ['Specimen', 'Part 1'],
            ['Slides', '1 of 1 viewable'],
        ]);
        expect(content.lines[1].tooltip).toContain(
            '42 days before this sample was sequenced (d+962)'
        );
        expect(content.openPath).toBe(LINKOUT);
    });

    it('describes same-day and after-sequencing procedures', () => {
        expect(tooltip({}, 962).lines[1].value).toBe(
            'd+962 — same day as sequencing (d+962)'
        );
        expect(tooltip({ MATCH_LEVEL: 'BLOCK' }, 970).lines[1].value).toBe(
            'd+970 — 8 d after sequencing (d+962)'
        );
        expect(tooltip({ MATCH_LEVEL: 'BLOCK' }, 970).title).toBe(
            'Pathology slides · H&E · Block-matched'
        );
    });

    it('shows only the procedure day when sequencing is unknown', () => {
        const content = tooltip({ SAMPLE_ID: 'P-OTHER' }, 920);
        expect(content.lines[1].value).toBe('d+920');
    });

    it('describes unmatched slides without a sequencing clause', () => {
        const content = tooltip(
            { MATCH_LEVEL: 'Unmatched', SUBTYPE: 'IHC', SPECIMEN: '' },
            920
        );
        expect(content.title).toBe('Pathology slides · IHC · Unmatched');
        expect(content.lines.map(l => [l.label, l.value])).toEqual([
            ['Sample', 'Unmatched (not linked to a sequenced sample)'],
            ['Procedure', 'd+920'],
            ['Slides', '1 of 1 viewable'],
        ]);
    });

    it('omits the procedure line and Open path when unavailable', () => {
        const content = tooltip({ IMAGE_COUNT: '0' });
        expect(content.lines.map(l => l.label)).toEqual([
            'Sample',
            'Specimen',
            'Slides',
        ]);
        expect(content.openPath).toBeUndefined();
    });
});

describe('pathologySlideSampleId', () => {
    it('returns the sample of BLOCK- and PART-matched events only', () => {
        expect(pathologySlideSampleId(slideEvent(1, {}))).toBe(
            'P-0000081-T02-IM6'
        );
        expect(
            pathologySlideSampleId(slideEvent(1, { MATCH_LEVEL: 'block' }))
        ).toBe('P-0000081-T02-IM6');
        expect(
            pathologySlideSampleId(slideEvent(1, { MATCH_LEVEL: 'Unmatched' }))
        ).toBeUndefined();
        expect(
            pathologySlideSampleId(slideEvent(1, { SAMPLE_ID: '' }))
        ).toBeUndefined();
    });
});
