/**
 * @jest-environment jsdom
 */
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import { buildWsiSampleTimelineMap } from './wsiSampleTimeline';
import {
    buildPathologySlideEvents,
    buildPathologySlideRow,
    buildPathologySlideTooltipContent,
    countUndatedViewableSlides,
    fetchPathologySlideTimelineData,
    PathologySlideClinicalEvent,
    PathologySlideEventDetails,
    pathologySlideSampleId,
} from './wsiPathologyEvents';
import { clearPatientHierarchyCache } from './wsiHierarchyFetchCache';
import {
    configureWsiViewerRuntime,
    resetWsiViewerRuntime,
} from './wsiViewerConfig';
import { PatientHierarchy, Slide } from './wsiViewerTypes';

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
    details: Partial<PathologySlideEventDetails>
): PathologySlideClinicalEvent {
    return {
        ...event('PATHOLOGY SLIDES', days, { SUBTYPE: 'H&E' }),
        pathologySlide: {
            sampleId: 'P-0000081-T02-IM6',
            matchLevel: 'PART',
            stain: 'H&E',
            specimen: 'Part 1',
            viewableSlideKeys: ['5d41402abc4b2a76b9719d911017c592'],
            totalCount: 1,
            timepointSource:
                'Recorded procedure date relative to first tumor sequencing',
            openPath: LINKOUT,
            ...details,
        },
    };
}

const SEQUENCING = event('Sequencing', 962, {
    SAMPLE_ID: 'P-0000081-T02-IM6',
});

function rows(events: ClinicalEvent[]) {
    const timelines = buildWsiSampleTimelineMap([...events, SEQUENCING]);
    return events.map(e => buildPathologySlideRow(e, timelines));
}

describe('buildPathologySlideRow', () => {
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
        expect(row.slidesTooltip).toBeUndefined();
        expect(row.openPath).toBe(LINKOUT);
        expect(row.openLabel).toBe('Open H&E slides for P-0000081-T02-IM6');
    });

    it('describes same-day and after-sequencing procedures', () => {
        const [same, after] = rows([
            slideEvent(962, {}),
            slideEvent(970, { stain: 'IHC' }),
        ]);
        expect(same.sequencingText).toBe('same day (d+962)');
        expect(after.sequencingText).toBe('8 d after (d+962)');
    });

    it('labels unmatched slides without a sequencing relation', () => {
        const [row] = rows([
            slideEvent(920, { matchLevel: 'UNMATCHED', sampleId: undefined }),
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
        const [row] = rows([slideEvent(920, { sampleId: 'P-OTHER' })]);
        expect(row.sequencingText).toBe('');
    });

    it('reports non-viewable slides', () => {
        const [row] = rows([
            slideEvent(920, { viewableSlideKeys: ['1', '2'], totalCount: 3 }),
        ]);
        expect(row.slidesText).toBe('2 of 3 viewable');
        expect(row.slidesTooltip).toBe(
            '1 slide is not viewable: no scanned image is available.'
        );
    });

    it('has no link when nothing is viewable', () => {
        const [none] = rows([slideEvent(921, { viewableSlideKeys: [] })]);
        expect(none.openPath).toBeUndefined();
        expect(none.slidesText).toBe('0 of 1 viewable');
        expect(none.slidesTooltip).toBe(
            '1 slide is not viewable: no scanned image is available.'
        );
    });
});

describe('buildPathologySlideTooltipContent', () => {
    function tooltip(
        details: Partial<PathologySlideEventDetails>,
        days?: number
    ) {
        const [row] = rows([slideEvent(days, details)]);
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

    it('never shows a slide key', () => {
        const key = '5d41402abc4b2a76b9719d911017c592';
        const content = tooltip(
            { viewableSlideKeys: [key, key.replace('5', '6')], totalCount: 3 },
            920
        );
        expect(JSON.stringify(content)).not.toContain(key);
        expect(JSON.stringify(content)).not.toMatch(/image id/i);
    });

    it('describes same-day and after-sequencing procedures', () => {
        expect(tooltip({}, 962).lines[1].value).toBe(
            'd+962 — same day as sequencing (d+962)'
        );
        expect(tooltip({ matchLevel: 'BLOCK' }, 970).lines[1].value).toBe(
            'd+970 — 8 d after sequencing (d+962)'
        );
        expect(tooltip({ matchLevel: 'BLOCK' }, 970).title).toBe(
            'Pathology slides · H&E · Block-matched'
        );
    });

    it('shows only the procedure day when sequencing is unknown', () => {
        const content = tooltip({ sampleId: 'P-OTHER' }, 920);
        expect(content.lines[1].value).toBe('d+920');
    });

    it('describes unmatched slides without a sequencing clause', () => {
        const content = tooltip(
            {
                matchLevel: 'UNMATCHED',
                sampleId: undefined,
                stain: 'IHC',
                specimen: '',
            },
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
        const content = tooltip({ viewableSlideKeys: [] });
        expect(content.lines.map(l => l.label)).toEqual([
            'Sample',
            'Specimen',
            'Slides',
        ]);
        expect(content.openPath).toBeUndefined();
    });
});

describe('pathologySlideSampleId', () => {
    it("returns a built event's matched sample", () => {
        expect(pathologySlideSampleId(slideEvent(1, {}))).toBe(
            'P-0000081-T02-IM6'
        );
        expect(
            pathologySlideSampleId(
                slideEvent(1, { matchLevel: 'UNMATCHED', sampleId: undefined })
            )
        ).toBeUndefined();
        expect(
            pathologySlideSampleId(event('PATHOLOGY SLIDES', 1, {}))
        ).toBeUndefined();
    });
});

const SCOPE = {
    studyId: 'mskimpact',
    patientId: 'P-0000024',
    slidesTabPath: '/patient/wsiHESlides',
};

function hierarchySlide(
    slideKey: string,
    overrides: Partial<Slide> = {}
): Slide {
    return {
        slide_key: slideKey,
        stain_name: 'H&E',
        stain_group: 'initial',
        is_hne: true,
        is_ihc: false,
        magnification: '40x',
        file_size_bytes: '',
        can_serve_tiles: true,
        block_label: 'Block 1',
        block_number: '1',
        slide_type: 'H&E',
        slide_timepoint_days: -136,
        slide_timepoint_source:
            'Recorded procedure date relative to first tumor sequencing',
        ...overrides,
    };
}

function hierarchy(
    groups: Array<{
        sampleId: string;
        parts: Array<{
            part: string;
            blocks: Array<{ block: string; slides: Slide[] }>;
        }>;
    }>
): PatientHierarchy {
    return {
        patient_id: SCOPE.patientId,
        samples: groups.map(group => ({
            sample_id: group.sampleId,
            cancer_type: '',
            cancer_type_detailed: '',
            oncotree_code: '',
            primary_site: '',
            sample_type: '',
            parts: group.parts.map(part => ({
                part_number: part.part,
                part_type: '',
                part_description: '',
                subspecialty: '',
                blocks: part.blocks.map(block => ({
                    block_number: block.block,
                    block_label: `Block ${block.block}`,
                    slides: block.slides,
                })),
            })),
        })),
    };
}

function details(event: PathologySlideClinicalEvent) {
    expect(event.attributes).toEqual([
        { key: 'SUBTYPE', value: event.pathologySlide.stain },
    ]);
    return event.pathologySlide;
}

/** The event link's query, with the `pathologySlideSettings` JSON parsed. */
function linkoutQuery(event: PathologySlideClinicalEvent): Record<string, any> {
    const url = new URL(event.pathologySlide.openPath, 'http://localhost');
    expect(url.pathname).toBe('/patient/wsiHESlides');
    const query: Record<string, any> = Object.fromEntries(
        url.searchParams.entries()
    );
    if (query.pathologySlideSettings !== undefined) {
        query.pathologySlideSettings = JSON.parse(query.pathologySlideSettings);
    }
    return query;
}

const SAMPLE_24 = 'P-0000024-T01-IM3';

describe('buildPathologySlideEvents', () => {
    it('groups part-matched slides of one day, sample, stain and part', () => {
        const events = buildPathologySlideEvents(
            hierarchy([
                {
                    sampleId: SAMPLE_24,
                    parts: [
                        {
                            part: '1',
                            blocks: [
                                {
                                    block: '1',
                                    slides: [
                                        hierarchySlide(
                                            '7f3a1c9e2b4d6f8a0c1e3b5d7f9a1c3e',
                                            {
                                                sample_id: SAMPLE_24,
                                                match_level: 'PART',
                                                specimen_key:
                                                    'part::1::block:1',
                                            }
                                        ),
                                    ],
                                },
                                {
                                    block: '2',
                                    slides: [
                                        hierarchySlide(
                                            '8e4b2d0f3c5e7a9b1d3f5c7e9b1d3f5a',
                                            {
                                                sample_id: SAMPLE_24,
                                                match_level: 'PART',
                                                specimen_key:
                                                    'part::1::block:2',
                                            }
                                        ),
                                        // Not viewable, still counted.
                                        hierarchySlide(
                                            '9d5c3e1a4d6f8b0c2e4a6d8f0c2e4a6b',
                                            {
                                                sample_id: SAMPLE_24,
                                                match_level: 'PART',
                                                specimen_key:
                                                    'part::1::block:2',
                                                can_serve_tiles: false,
                                            }
                                        ),
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ]),
            SCOPE
        );

        expect(events).toHaveLength(1);
        const [event] = events;
        expect(event.eventType).toBe('PATHOLOGY SLIDES');
        expect(event.startNumberOfDaysSinceDiagnosis).toBe(-136);
        expect(event.studyId).toBe('mskimpact');
        expect(event.patientId).toBe('P-0000024');
        expect(details(event)).toEqual({
            sampleId: SAMPLE_24,
            stain: 'H&E',
            matchLevel: 'PART',
            specimen: 'Part 1',
            totalCount: 3,
            viewableSlideKeys: [
                '7f3a1c9e2b4d6f8a0c1e3b5d7f9a1c3e',
                '8e4b2d0f3c5e7a9b1d3f5c7e9b1d3f5a',
            ],
            timepointSource:
                'Recorded procedure date relative to first tumor sequencing',
            openPath: expect.any(String),
        });
        // Several specimen keys: the link narrows by day instead.
        expect(linkoutQuery(event)).toEqual({
            studyId: 'mskimpact',
            caseId: 'P-0000024',
            sampleId: SAMPLE_24,
            pathologySlideSettings: {
                stainFilter: 'hne',
                matchLevel: 'PART',
                timepointDays: '-136',
            },
        });
        // The tab scope is one JSON-encoded `pathologySlideSettings` param.
        expect(details(event).openPath).toBe(
            '/patient/wsiHESlides?studyId=mskimpact&caseId=P-0000024' +
                '&sampleId=P-0000024-T01-IM3' +
                '&pathologySlideSettings=%7B%22stainFilter%22%3A%22hne%22%2C' +
                '%22matchLevel%22%3A%22PART%22%2C%22timepointDays%22%3A%22-136%22%7D'
        );
    });

    it('keeps block-matched blocks, stains and days apart', () => {
        const blockSlide = (id: string, overrides: Partial<Slide> = {}) =>
            hierarchySlide(id, {
                sample_id: 'S-1',
                match_level: 'BLOCK',
                specimen_key: `block::${id}`,
                ...overrides,
            });
        const events = buildPathologySlideEvents(
            hierarchy([
                {
                    sampleId: 'S-1',
                    parts: [
                        {
                            part: '2',
                            blocks: [
                                {
                                    block: '1',
                                    slides: [
                                        blockSlide('a', {
                                            specimen_key: 'block::2-1',
                                        }),
                                        blockSlide('b', {
                                            specimen_key: 'block::2-1',
                                            is_hne: false,
                                            is_ihc: true,
                                            slide_type: 'IHC',
                                        }),
                                        blockSlide('c', {
                                            specimen_key: 'block::2-1',
                                            slide_timepoint_days: 10,
                                        }),
                                    ],
                                },
                                {
                                    block: '2',
                                    slides: [
                                        blockSlide('d', {
                                            specimen_key: 'block::2-2',
                                        }),
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ]),
            SCOPE
        );

        expect(
            events.map(e => [
                e.startNumberOfDaysSinceDiagnosis,
                details(e).stain,
                details(e).specimen,
                details(e).viewableSlideKeys,
            ])
        ).toEqual([
            [-136, 'H&E', 'Part 2 / Block 1', ['a']],
            [-136, 'H&E', 'Part 2 / Block 2', ['d']],
            [-136, 'IHC', 'Part 2 / Block 1', ['b']],
            [10, 'H&E', 'Part 2 / Block 1', ['c']],
        ]);
        // One specimen key: the link names it.
        expect(linkoutQuery(events[0])).toEqual({
            studyId: 'mskimpact',
            caseId: 'P-0000024',
            sampleId: 'S-1',
            pathologySlideSettings: {
                stainFilter: 'hne',
                matchLevel: 'BLOCK',
                specimenKey: 'block::2-1',
                timepointDays: '-136',
            },
        });
        expect(linkoutQuery(events[2]).pathologySlideSettings.stainFilter).toBe(
            'ihc'
        );
    });

    it('builds unmatched events per part without a sample', () => {
        const unmatched = (id: string, part: string) =>
            hierarchySlide(id, {
                sample_id: null,
                match_level: 'UNMATCHED',
                specimen_key: `unmatched::part:${part}`,
            });
        const events = buildPathologySlideEvents(
            hierarchy([
                {
                    sampleId: 'UNMATCHED',
                    parts: [
                        {
                            part: '3',
                            blocks: [
                                { block: '1', slides: [unmatched('3a', '3')] },
                                { block: '2', slides: [unmatched('3b', '3')] },
                            ],
                        },
                        {
                            part: '2',
                            blocks: [
                                { block: '1', slides: [unmatched('2a', '2')] },
                            ],
                        },
                    ],
                },
            ]),
            SCOPE
        );

        expect(events.map(e => details(e).specimen)).toEqual([
            'Part 2',
            'Part 3',
        ]);
        const part3 = details(events[1]);
        expect(part3.sampleId).toBeUndefined();
        expect(part3.matchLevel).toBe('UNMATCHED');
        expect(part3.viewableSlideKeys).toHaveLength(2);
        expect(pathologySlideSampleId(events[1])).toBeUndefined();
        expect(linkoutQuery(events[1])).toEqual({
            studyId: 'mskimpact',
            caseId: 'P-0000024',
            pathologySlideSettings: {
                stainFilter: 'hne',
                matchLevel: 'UNMATCHED',
                specimenKey: 'unmatched::part:3',
                timepointDays: '-136',
            },
        });
    });

    it('treats a matched slide without a sample as unmatched', () => {
        const [event] = buildPathologySlideEvents(
            hierarchy([
                {
                    sampleId: 'UNMATCHED',
                    parts: [
                        {
                            part: '1',
                            blocks: [
                                {
                                    block: '1',
                                    slides: [
                                        hierarchySlide('x', {
                                            sample_id: null,
                                            match_level: 'PART',
                                        }),
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ]),
            SCOPE
        );
        expect(details(event).matchLevel).toBe('UNMATCHED');
        expect(details(event).sampleId).toBeUndefined();
    });

    it('builds no event for slides without a procedure day', () => {
        const events = buildPathologySlideEvents(
            hierarchy([
                {
                    sampleId: 'S-1',
                    parts: [
                        {
                            part: '1',
                            blocks: [
                                {
                                    block: '1',
                                    slides: [
                                        hierarchySlide('undated', {
                                            sample_id: 'S-1',
                                            match_level: 'BLOCK',
                                            slide_timepoint_days: undefined,
                                        }),
                                        hierarchySlide('dated', {
                                            sample_id: 'S-1',
                                            match_level: 'BLOCK',
                                        }),
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ]),
            SCOPE
        );
        expect(events).toHaveLength(1);
        expect(details(events[0]).viewableSlideKeys).toEqual(['dated']);
        expect(details(events[0]).totalCount).toBe(1);
    });

    it('labels other and unknown stains', () => {
        const events = buildPathologySlideEvents(
            hierarchy([
                {
                    sampleId: 'S-1',
                    parts: [
                        {
                            part: '1',
                            blocks: [
                                {
                                    block: '1',
                                    slides: [
                                        hierarchySlide('o', {
                                            sample_id: 'S-1',
                                            match_level: 'BLOCK',
                                            is_hne: false,
                                            slide_type: 'Other',
                                        }),
                                        hierarchySlide('u', {
                                            sample_id: 'S-1',
                                            match_level: 'BLOCK',
                                            is_hne: false,
                                            slide_type: 'Unknown',
                                        }),
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ]),
            SCOPE
        );
        expect(
            events.map(e => [
                details(e).stain,
                linkoutQuery(e).pathologySlideSettings.stainFilter,
            ])
        ).toEqual([
            ['Other', 'other'],
            ['Unknown', 'unknown'],
        ]);
    });

    it('feeds the tooltip model with its sequencing relation', () => {
        const [slideEvent] = buildPathologySlideEvents(
            hierarchy([
                {
                    sampleId: SAMPLE_24,
                    parts: [
                        {
                            part: '1',
                            blocks: [
                                {
                                    block: '1',
                                    slides: [
                                        hierarchySlide(
                                            '7f3a1c9e2b4d6f8a0c1e3b5d7f9a1c3e',
                                            {
                                                sample_id: SAMPLE_24,
                                                match_level: 'PART',
                                            }
                                        ),
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ]),
            SCOPE
        );
        const row = buildPathologySlideRow(
            slideEvent,
            buildWsiSampleTimelineMap([
                event('Sequencing', 0, { SAMPLE_ID: SAMPLE_24 }),
            ])
        );
        const content = buildPathologySlideTooltipContent(row);
        expect(content.title).toBe('Pathology slides · H&E · Part-matched');
        expect(content.lines.map(l => [l.label, l.value])).toEqual([
            ['Sample', SAMPLE_24],
            ['Procedure', 'd-136 — 136 d before sequencing (d0)'],
            ['Specimen', 'Part 1'],
            ['Slides', '1 of 1 viewable'],
        ]);
        expect(content.openPath).toBe(details(slideEvent).openPath);
    });
});

describe('countUndatedViewableSlides', () => {
    it('counts each viewable slide without a procedure day once', () => {
        const undated = { slide_timepoint_days: undefined };
        expect(
            countUndatedViewableSlides(
                hierarchy([
                    {
                        sampleId: SAMPLE_24,
                        parts: [
                            {
                                part: '1',
                                blocks: [
                                    {
                                        block: '1',
                                        slides: [
                                            hierarchySlide('dated'),
                                            hierarchySlide(
                                                'undated-a',
                                                undated
                                            ),
                                            hierarchySlide(
                                                'undated-a',
                                                undated
                                            ),
                                            hierarchySlide(
                                                'undated-b',
                                                undated
                                            ),
                                            hierarchySlide('undated-hidden', {
                                                ...undated,
                                                can_serve_tiles: false,
                                            }),
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ])
            )
        ).toBe(2);
    });
});

describe('fetchPathologySlideTimelineData', () => {
    const payload = {
        referenceSampleId: SAMPLE_24,
        sampleGroups: [
            {
                sampleId: SAMPLE_24,
                parts: [
                    {
                        partNumber: '1',
                        partType: '',
                        partDescription: '',
                        subspecialty: '',
                        blocks: [
                            {
                                blockNumber: '1',
                                blockLabel: 'Block 1',
                                slides: [
                                    {
                                        slideKey:
                                            '7f3a1c9e2b4d6f8a0c1e3b5d7f9a1c3e',
                                        stainName: 'H&E',
                                        stainGroup: 'initial',
                                        isHne: true,
                                        isIhc: false,
                                        magnification: '40x',
                                        fileSizeBytes: null,
                                        canServeTiles: true,
                                        slideType: 'H&E',
                                        sampleId: SAMPLE_24,
                                        matchLevel: 'PART',
                                        specimenKey: 'part::1',
                                        procedureDateDays: -136,
                                        timepointSource:
                                            'Recorded procedure date relative to first tumor sequencing',
                                        procedureDateKind: 'RECORDED',
                                        procedureDateSource: 'procedure',
                                        procedureDateReason: null,
                                        procedureDateStatus: 'AVAILABLE',
                                        procedureCoordinateSystem:
                                            'patient_first_tumor_sequencing_day_zero',
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };

    afterEach(() => {
        resetWsiViewerRuntime();
        clearPatientHierarchyCache();
    });

    it('loads the hierarchy through the shared cache', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(payload),
        });
        configureWsiViewerRuntime({
            buildApiUrl: (path: string) => `https://portal.example/${path}`,
            authEnabled: false,
            fetchImpl,
        });

        const first = await fetchPathologySlideTimelineData(SCOPE, 'user-1');
        const second = await fetchPathologySlideTimelineData(SCOPE, 'user-1');

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][0]).toBe(
            'https://portal.example/api/wsi/v2/hierarchy/mskimpact/P-0000024'
        );
        expect(first.events).toHaveLength(1);
        expect(details(first.events[0]).viewableSlideKeys).toEqual([
            '7f3a1c9e2b4d6f8a0c1e3b5d7f9a1c3e',
        ]);
        expect(first.undatedViewableSlideCount).toBe(0);
        expect(second).toEqual(first);
    });

    it('rejects when the hierarchy cannot be loaded', async () => {
        configureWsiViewerRuntime({
            buildApiUrl: (path: string) => `/${path}`,
            authEnabled: false,
            fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 503 }),
        });

        await expect(fetchPathologySlideTimelineData(SCOPE)).rejects.toThrow(
            'Server returned 503'
        );
    });
});
