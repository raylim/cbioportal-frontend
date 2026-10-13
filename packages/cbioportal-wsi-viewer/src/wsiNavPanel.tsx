import { pluralize } from 'cbioportal-frontend-commons';
import * as React from 'react';
import {
    PatientHierarchy,
    PathologySlideMatchFilter,
    Sample,
    Slide,
    WsiStainFilter,
    WsiTimepointSelection,
} from './wsiViewerTypes';
import {
    getOrderedServableSlidesForSampleReadOnly,
    getWsiTimepointOptions,
    matchesMatchFilter,
    matchesWsiStainFilter,
    matchesWsiTimepointFilter,
    sampleHasMultiplePartDescriptions,
    wsiStainKind,
} from './wsiSlideUtils';
import {
    abbreviatePartDesc,
    cleanStain,
    compareSamplesByTimepoint,
    decodeBlockCode,
    fmtFileSize,
    DAY_ZERO_TOOLTIP,
    formatDaysSinceDiagnosis,
    getSlideTimepointDays,
    procedureSlideTimepointText,
    procedureTooltip,
    stainQualifier,
} from './wsiNavUtils';
import { getStainDotColor } from './wsiMetaUtils';
import {
    procedureRelativeToSequencingText,
    sampleSequencedText,
    sampleSequencedTooltip,
    WsiSampleTimeline,
    WsiSampleTimelineMap,
} from './wsiSampleTimeline';
import { scheduleThumbnailRequest } from './thumbnailRequestLimiter';
import { getWsiSlideAccess } from './wsiAuth';
import {
    fetchWsiThumbnailBlob,
    parseMaxAgeMs,
    WsiThumbnailFetchError,
} from './wsiThumbnailFetchCache';

import {
    WSI_NAV_WIDTH,
    WSI_SECTION_TITLE_STYLE,
    WSI_THEME as theme,
} from './wsiTheme';
import { WsiPanelHideButton } from './wsiPanelChrome';
import { WsiFilterChipGroup } from './wsiFilterChips';

export interface WsiNavPanelProps {
    hierarchy: PatientHierarchy;
    selectedSlide: Slide | null;
    stainFilter: WsiStainFilter;
    sampleIdFilter?: string;
    slideIdFilter?: Set<string>;
    linkoutScopeActive?: boolean;
    matchFilter?: PathologySlideMatchFilter;
    timepointDays?: WsiTimepointSelection;
    showClearFilters?: boolean;
    deferOffscreenSamples?: boolean;
    onFilterChange: (f: WsiStainFilter) => void;
    onMatchFilterChange?: (f: PathologySlideMatchFilter) => void;
    onTimepointChange?: (days?: WsiTimepointSelection) => void;
    onClearFilters?: () => void;
    onSelectSlide: (slide: Slide, sample: Sample) => void;
    tileServerBase: string;
    studyId: string;
    authScope: string;
    /** Sample acquisition/sequencing days from the patient timeline. */
    sampleTimelines?: WsiSampleTimelineMap;
    /** Shows a header button that hides the panel. */
    onHide?: () => void;
}

const INITIAL_VISIBLE_SAMPLE_LIMIT = 6;
const THUMBNAIL_WIDTH = 64;
const THUMBNAIL_HEIGHT = 48;
const MAX_THUMBNAIL_ATTEMPTS = 3;
const DEFAULT_THUMBNAIL_RETRY_DELAY_MS = 60_000;
const NETWORK_THUMBNAIL_RETRY_DELAYS_MS = [5_000, 15_000];

const ellipsisStyle: React.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

function parseRetryAfterMs(retryAfter: string | null): number | undefined {
    if (!retryAfter) {
        return undefined;
    }
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }
    const retryAt = Date.parse(retryAfter);
    return Number.isFinite(retryAt)
        ? Math.max(0, retryAt - Date.now())
        : undefined;
}

function thumbnailRetryDelayMs(
    response: Response | undefined,
    reason: string | undefined,
    attempt: number
): number | null {
    if (attempt >= MAX_THUMBNAIL_ATTEMPTS) {
        return null;
    }

    if (response?.status === 429) {
        return (
            parseRetryAfterMs(response.headers.get('Retry-After')) ??
            DEFAULT_THUMBNAIL_RETRY_DELAY_MS
        );
    }

    if (!response || response.status === 408 || response.status >= 500) {
        return NETWORK_THUMBNAIL_RETRY_DELAYS_MS[
            Math.min(attempt - 1, NETWORK_THUMBNAIL_RETRY_DELAYS_MS.length - 1)
        ];
    }

    if (response.status !== 200) {
        return null;
    }

    if (reason === 'missing') {
        return null;
    }

    const maxAgeMs =
        parseMaxAgeMs(response.headers.get('Cache-Control')) ??
        DEFAULT_THUMBNAIL_RETRY_DELAY_MS;
    return maxAgeMs + Math.round(maxAgeMs * 0.1 * Math.random());
}

function matchesSlideFilters(
    slide: Slide,
    stainFilter: WsiStainFilter,
    matchFilter: PathologySlideMatchFilter,
    timepointDays?: WsiTimepointSelection
): boolean {
    return (
        matchesWsiStainFilter(slide, stainFilter) &&
        matchesMatchFilter(slide, matchFilter) &&
        matchesWsiTimepointFilter(slide, timepointDays)
    );
}

type FilteredSampleEntry = {
    sample: Sample;
    filteredSlides: Array<{ slide: Slide; blockLabel: string | null }>;
    filteredSlideIds: Set<string>;
};

function sampleEntry(
    sample: Sample,
    filteredSlides: FilteredSampleEntry['filteredSlides']
): FilteredSampleEntry | null {
    return filteredSlides.length
        ? {
              sample,
              filteredSlides,
              filteredSlideIds: new Set(
                  filteredSlides.map(({ slide }) => slide.slide_key)
              ),
          }
        : null;
}

/** The entries that keep a slide matching `keep`, with only those slides. */
function narrowSampleEntries(
    entries: FilteredSampleEntry[],
    keep: (slide: Slide) => boolean
): FilteredSampleEntry[] {
    return entries.flatMap(entry => {
        const narrowed = sampleEntry(
            entry.sample,
            entry.filteredSlides.filter(({ slide }) => keep(slide))
        );
        return narrowed ? [narrowed] : [];
    });
}

function WsiNavPanelComponent({
    hierarchy,
    selectedSlide,
    stainFilter,
    sampleIdFilter,
    slideIdFilter,
    linkoutScopeActive = false,
    matchFilter = 'all',
    timepointDays,
    showClearFilters = false,
    deferOffscreenSamples = false,
    onFilterChange,
    onMatchFilterChange,
    onTimepointChange,
    onClearFilters,
    onSelectSlide,
    tileServerBase,
    studyId,
    authScope,
    sampleTimelines,
    onHide,
}: WsiNavPanelProps) {
    const selectedSlideId = selectedSlide?.slide_key;
    const unscopedSampleEntries = React.useMemo(
        () =>
            hierarchy.samples.flatMap(sample => {
                const entry = sampleEntry(
                    sample,
                    getOrderedServableSlidesForSampleReadOnly(sample)
                );
                return entry ? [entry] : [];
            }),
        [hierarchy.samples]
    );
    const allSampleEntries = React.useMemo(() => {
        if (!sampleIdFilter && !slideIdFilter) {
            return unscopedSampleEntries;
        }
        return narrowSampleEntries(
            sampleIdFilter
                ? unscopedSampleEntries.filter(
                      entry => entry.sample.sample_id === sampleIdFilter
                  )
                : unscopedSampleEntries,
            slide => !slideIdFilter || slideIdFilter.has(slide.slide_key)
        );
    }, [sampleIdFilter, slideIdFilter, unscopedSampleEntries]);
    const filteredSampleEntries = React.useMemo(
        () =>
            narrowSampleEntries(allSampleEntries, slide =>
                matchesSlideFilters(
                    slide,
                    stainFilter,
                    matchFilter,
                    timepointDays
                )
            ),
        [allSampleEntries, matchFilter, stainFilter, timepointDays]
    );
    const sampleEntries = React.useMemo(() => {
        const sorted = [...filteredSampleEntries].sort((left, right) =>
            compareSamplesByTimepoint(left.sample, right.sample)
        );
        if (
            !deferOffscreenSamples ||
            sorted.length <= INITIAL_VISIBLE_SAMPLE_LIMIT
        ) {
            return sorted;
        }

        const visible = sorted.slice(0, INITIAL_VISIBLE_SAMPLE_LIMIT);
        if (!selectedSlideId) {
            return visible;
        }

        const selectedEntry = sorted.find(entry =>
            entry.filteredSlideIds.has(selectedSlideId)
        );
        if (
            selectedEntry &&
            !visible.some(
                entry =>
                    entry.sample.sample_id === selectedEntry.sample.sample_id
            )
        ) {
            return visible.concat(selectedEntry);
        }

        return visible;
    }, [deferOffscreenSamples, filteredSampleEntries, selectedSlideId]);
    /** Why no slide is listed when the patient has none to show at all. */
    const emptyPatientMessage = React.useMemo(() => {
        let slides = 0;
        let viewable = 0;
        hierarchy.samples.forEach(sample =>
            sample.parts.forEach(part =>
                part.blocks.forEach(block =>
                    block.slides.forEach(slide => {
                        slides += 1;
                        if (slide.can_serve_tiles) viewable += 1;
                    })
                )
            )
        );
        if (slides === 0) return 'No pathology slides for this patient';
        if (viewable === 0)
            return 'No viewable pathology slides for this patient';
        return undefined;
    }, [hierarchy]);
    const filteredSlideCount = React.useMemo(
        () =>
            filteredSampleEntries.reduce(
                (count, entry) => count + entry.filteredSlides.length,
                0
            ),
        [filteredSampleEntries]
    );
    const hiddenSampleCount =
        filteredSampleEntries.length - sampleEntries.length;
    const facetSlides = React.useMemo(
        () =>
            unscopedSampleEntries.flatMap(entry =>
                entry.filteredSlides.map(({ slide }) => slide)
            ),
        [unscopedSampleEntries]
    );
    const timepointOptions = React.useMemo(
        () => getWsiTimepointOptions(facetSlides),
        [facetSlides]
    );
    const selectedTimepointOption =
        timepointDays == null
            ? undefined
            : timepointOptions.find(option => option.days === timepointDays);
    const hasUnavailableTimepoint =
        timepointDays != null && !selectedTimepointOption;
    const showTimepointFilter =
        timepointOptions.length > 0 || hasUnavailableTimepoint;
    const timepointSliderIndex =
        timepointDays == null
            ? 0
            : Math.max(
                  0,
                  timepointOptions.findIndex(
                      option => option.days === timepointDays
                  ) + 1
              );
    const chips: Array<{
        key: WsiStainFilter;
        label: string;
        color?: string;
    }> = [
        { key: 'all', label: 'All' },
        { key: 'hne', label: 'H&E', color: theme.blue },
        { key: 'ihc', label: 'IHC', color: theme.orange },
        { key: 'other', label: 'Other (known)', color: theme.muted },
        { key: 'unknown', label: 'Unknown', color: theme.muted },
    ];
    const matchChips: Array<{
        key: PathologySlideMatchFilter;
        label: string;
    }> = [
        { key: 'all', label: 'All' },
        { key: 'part', label: 'Part' },
        { key: 'block', label: 'Block' },
        { key: 'unmatched', label: 'Unmatched' },
    ];
    const stainCounts = React.useMemo(() => {
        const filteredCounts: Record<WsiStainFilter, number> = {
            all: 0,
            hne: 0,
            ihc: 0,
            other: 0,
            unknown: 0,
        };
        facetSlides.forEach(slide => {
            if (!matchesMatchFilter(slide, matchFilter)) {
                return;
            }
            if (!matchesWsiTimepointFilter(slide, timepointDays)) {
                return;
            }
            filteredCounts.all += 1;
            filteredCounts[wsiStainKind(slide)] += 1;
        });

        return filteredCounts;
    }, [facetSlides, matchFilter, timepointDays]);
    const matchCounts = React.useMemo(() => {
        const filteredCounts = { part: 0, block: 0, unmatched: 0 };
        facetSlides.forEach(slide => {
            if (
                !matchesWsiStainFilter(slide, stainFilter) ||
                !matchesWsiTimepointFilter(slide, timepointDays)
            ) {
                return;
            }
            if (slide.match_level === 'PART') filteredCounts.part += 1;
            if (slide.match_level === 'BLOCK') filteredCounts.block += 1;
            if (slide.match_level === 'UNMATCHED') {
                filteredCounts.unmatched += 1;
            }
        });
        return filteredCounts;
    }, [facetSlides, stainFilter, timepointDays]);
    /** A click on the active chip only matters for All, to drop a link scope. */
    const reselects = (current: string, key: string) =>
        current !== key || (key === 'all' && linkoutScopeActive);

    return (
        <div
            style={{
                width: WSI_NAV_WIDTH,
                minWidth: WSI_NAV_WIDTH,
                display: 'flex',
                flexDirection: 'column',
                background: theme.navBg,
                borderRight: `1px solid ${theme.border}`,
                overflow: 'hidden',
            }}
        >
            <div
                style={{
                    padding: '9px 12px 7px',
                    borderBottom: `1px solid ${theme.border}`,
                    flexShrink: 0,
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                    }}
                >
                    <div style={WSI_SECTION_TITLE_STYLE}>Slides</div>
                    {onHide && (
                        <WsiPanelHideButton
                            side="left"
                            label="Hide slide list"
                            onClick={onHide}
                            testId="wsi-nav-hide"
                        />
                    )}
                </div>
                <WsiFilterChipGroup
                    label="Filter slides by stain"
                    testId="wsi-stain-filter-row"
                    chipTestIdPrefix="wsi-stain-filter"
                    style={{ marginTop: 7 }}
                    chips={chips.map(chip => ({
                        ...chip,
                        count:
                            chip.key === 'all'
                                ? undefined
                                : stainCounts[chip.key],
                        disabled:
                            chip.key !== 'all' && stainCounts[chip.key] === 0,
                    }))}
                    isActive={key => stainFilter === key}
                    onSelect={key => {
                        if (reselects(stainFilter, key)) onFilterChange(key);
                    }}
                />
                <WsiFilterChipGroup
                    label="Filter slides by match level"
                    testId="wsi-match-filter-row"
                    chipTestIdPrefix="wsi-match-filter"
                    style={{ marginTop: 6 }}
                    chips={matchChips
                        .filter(
                            chip =>
                                chip.key === 'all' || matchCounts[chip.key] > 0
                        )
                        .map(chip => ({
                            ...chip,
                            count:
                                chip.key === 'all'
                                    ? undefined
                                    : matchCounts[chip.key],
                        }))}
                    isActive={key => matchFilter === key}
                    onSelect={key => {
                        if (reselects(matchFilter, key)) {
                            onMatchFilterChange?.(key);
                        }
                    }}
                />
                {showTimepointFilter && (
                    <div
                        style={{ marginTop: 8 }}
                        data-testid="wsi-timepoint-filter"
                    >
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 6,
                                fontSize: 10,
                                color: theme.muted,
                            }}
                        >
                            <span>Time</span>
                            <button
                                type="button"
                                className={`btn btn-xs ${
                                    timepointDays == null
                                        ? 'btn-primary'
                                        : 'btn-default'
                                }`}
                                data-testid="wsi-timepoint-filter-all"
                                onClick={() => onTimepointChange?.(undefined)}
                            >
                                All
                            </button>
                            <span
                                data-testid="wsi-timepoint-filter-value"
                                title={
                                    timepointDays == null
                                        ? `All slide dates. ${DAY_ZERO_TOOLTIP}`
                                        : `${selectedTimepointOption?.label ||
                                              `${
                                                  timepointDays === 'undated'
                                                      ? 'Undated'
                                                      : formatDaysSinceDiagnosis(
                                                            timepointDays
                                                        )
                                              } (unavailable)`}. ${DAY_ZERO_TOOLTIP}`
                                }
                                style={{
                                    flex: 1,
                                    textAlign: 'right',
                                    fontWeight: 600,
                                    color: theme.text,
                                }}
                            >
                                {timepointDays == null
                                    ? 'All'
                                    : selectedTimepointOption?.label ||
                                      `${
                                          timepointDays === 'undated'
                                              ? 'Undated'
                                              : formatDaysSinceDiagnosis(
                                                    timepointDays
                                                )
                                      } (unavailable)`}
                            </span>
                        </div>
                        {!hasUnavailableTimepoint && (
                            <input
                                type="range"
                                min={0}
                                max={timepointOptions.length}
                                step={1}
                                value={timepointSliderIndex}
                                aria-label="Filter slides by time"
                                aria-valuetext={
                                    timepointDays == null
                                        ? 'All dates'
                                        : timepointOptions.find(
                                              option =>
                                                  option.days === timepointDays
                                          )?.label || 'All dates'
                                }
                                data-testid="wsi-timepoint-filter-slider"
                                style={{ width: '100%', margin: '4px 0 0' }}
                                onChange={event => {
                                    const index = Number(event.target.value);
                                    onTimepointChange?.(
                                        index === 0
                                            ? undefined
                                            : timepointOptions[index - 1]?.days
                                    );
                                }}
                            />
                        )}
                        {!hasUnavailableTimepoint && (
                            <div
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    gap: 4,
                                    fontSize: 9,
                                    color: theme.muted,
                                }}
                            >
                                <span>All</span>
                                {timepointOptions.map(option => (
                                    <span
                                        key={option.days}
                                        title={
                                            option.days === 'undated'
                                                ? 'Slides without a recorded procedure date'
                                                : DAY_ZERO_TOOLTIP
                                        }
                                    >
                                        {option.label}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {sampleIdFilter && linkoutScopeActive && (
                    <div
                        data-testid="wsi-sample-scope"
                        style={{
                            marginTop: 6,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '1px 6px',
                            borderRadius: 3,
                            background: theme.blueLight,
                            color: theme.text,
                            fontSize: 12,
                        }}
                    >
                        <span>Sample {sampleIdFilter}</span>
                        <button
                            type="button"
                            className="btn btn-link btn-xs"
                            data-testid="wsi-sample-scope-clear"
                            aria-label={`Show all slides, not only sample ${sampleIdFilter}`}
                            title="Show all slides"
                            style={{ padding: 0, color: theme.muted }}
                            onClick={onClearFilters}
                        >
                            <i className="fa fa-times" />
                        </button>
                    </div>
                )}
                {showClearFilters && (
                    <button
                        type="button"
                        className="btn btn-link btn-xs"
                        data-testid="wsi-clear-filters"
                        style={{
                            display: 'block',
                            padding: '2px 0',
                            marginTop: 6,
                            color: theme.blue,
                        }}
                        onClick={onClearFilters}
                    >
                        Show all slides
                    </button>
                )}
                <div
                    style={{
                        marginTop: 6,
                        color: theme.muted,
                        fontSize: 11,
                    }}
                    data-testid="wsi-filtered-slide-count"
                >
                    {filteredSlideCount === 0
                        ? emptyPatientMessage || 'No slides match these filters'
                        : `Showing ${filteredSlideCount} ${pluralize(
                              'slide',
                              filteredSlideCount
                          )}`}
                </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
                {sampleEntries.map(
                    ({ sample, filteredSlides, filteredSlideIds }, index) => (
                        <MemoSampleNode
                            key={sample.sample_id}
                            sample={sample}
                            containsSelectedSlide={
                                !!selectedSlideId &&
                                filteredSlideIds.has(selectedSlideId)
                            }
                            filteredSlides={filteredSlides}
                            sampleIndex={index}
                            selectedSlide={selectedSlide}
                            sampleTimeline={
                                sample.sample_id === 'UNMATCHED'
                                    ? undefined
                                    : sampleTimelines?.get(sample.sample_id)
                            }
                            onSelectSlide={onSelectSlide}
                            tileServerBase={tileServerBase}
                            studyId={studyId}
                            authScope={authScope}
                        />
                    )
                )}
                {hiddenSampleCount > 0 && (
                    <div
                        style={{
                            padding: '8px 12px 12px',
                            fontSize: 11,
                            color: theme.muted,
                        }}
                    >
                        Loading {hiddenSampleCount} more{' '}
                        {pluralize('sample', hiddenSampleCount)}...
                    </div>
                )}
            </div>
        </div>
    );
}

export const WsiNavPanel = React.memo(WsiNavPanelComponent);

function SampleNode({
    sample,
    containsSelectedSlide,
    sampleIndex,
    selectedSlide,
    filteredSlides,
    sampleTimeline,
    onSelectSlide,
    tileServerBase,
    studyId,
    authScope,
}: {
    sample: Sample;
    containsSelectedSlide: boolean;
    filteredSlides: Array<{ slide: Slide; blockLabel: string | null }>;
    sampleIndex: number;
    selectedSlide: Slide | null;
    sampleTimeline?: WsiSampleTimeline;
    onSelectSlide: (slide: Slide, sample: Sample) => void;
    tileServerBase: string;
    studyId: string;
    authScope: string;
}) {
    const [open, setOpen] = React.useState(
        containsSelectedSlide || sampleIndex === 0
    );
    const servableSlides = open || containsSelectedSlide ? filteredSlides : [];
    const visibleSlideCount = filteredSlides.length;

    React.useEffect(() => {
        if (containsSelectedSlide && !open) {
            setOpen(true);
        }
    }, [containsSelectedSlide, open]);

    const sequencedText = sampleSequencedText(sampleTimeline);
    const sequencedTooltip = sampleSequencedTooltip(sampleTimeline);

    const multiPart = React.useMemo(
        () =>
            open || containsSelectedSlide
                ? sampleHasMultiplePartDescriptions(sample)
                : false,
        [containsSelectedSlide, open, sample]
    );

    return (
        <div
            style={{ borderBottom: `1px solid ${theme.border}` }}
            data-testid={`wsi-sample-node-${sample.sample_id}`}
        >
            <div
                onClick={() => setOpen(o => !o)}
                onKeyDown={event => {
                    if (
                        event.target === event.currentTarget &&
                        (event.key === 'Enter' || event.key === ' ')
                    ) {
                        event.preventDefault();
                        setOpen(o => !o);
                    }
                }}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                aria-label={`${sample.sample_id || 'Sample'} slides${
                    sequencedText ? `, ${sequencedText}` : ''
                }`}
                style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 6,
                    padding: '8px 12px 7px',
                    cursor: 'pointer',
                    userSelect: 'none',
                }}
            >
                <span
                    style={{
                        fontSize: 11,
                        color: theme.muted,
                        marginTop: 2,
                        flexShrink: 0,
                        width: 10,
                    }}
                >
                    {open ? '▾' : '▸'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                        style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: theme.blue,
                            ...ellipsisStyle,
                        }}
                    >
                        {sample.sample_id || '—'}
                        {sequencedText && (
                            <span
                                data-testid={`wsi-sample-sequenced-${sample.sample_id}`}
                                title={sequencedTooltip}
                                style={{
                                    fontWeight: 400,
                                    color: theme.muted,
                                    marginLeft: 6,
                                }}
                            >
                                {sequencedText}
                            </span>
                        )}
                    </div>
                </div>
                <div
                    title="Viewable slides shown in this sample"
                    style={{
                        fontSize: 10,
                        color: theme.muted,
                        flexShrink: 0,
                        textAlign: 'right',
                        lineHeight: 1.4,
                        cursor: 'help',
                    }}
                >
                    <span style={{ color: theme.blue, fontWeight: 600 }}>
                        {visibleSlideCount}
                    </span>
                </div>
            </div>
            {open && (
                <div style={{ paddingBottom: 4 }}>
                    {servableSlides.map(({ slide, blockLabel }) => (
                        <SlideItem
                            key={slide.slide_key}
                            slide={slide}
                            sample={sample}
                            blockLabel={blockLabel}
                            multiPart={multiPart}
                            sequencingDays={sampleTimeline?.sequencingDays}
                            selected={
                                selectedSlide?.slide_key === slide.slide_key
                            }
                            onSelectSlide={onSelectSlide}
                            tileServerBase={tileServerBase}
                            studyId={studyId}
                            authScope={authScope}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

const MemoSampleNode = React.memo(SampleNode, (prev, next) => {
    if (
        prev.sample !== next.sample ||
        prev.containsSelectedSlide !== next.containsSelectedSlide ||
        prev.sampleIndex !== next.sampleIndex ||
        prev.filteredSlides !== next.filteredSlides ||
        prev.sampleTimeline !== next.sampleTimeline ||
        prev.onSelectSlide !== next.onSelectSlide ||
        prev.tileServerBase !== next.tileServerBase ||
        prev.studyId !== next.studyId ||
        prev.authScope !== next.authScope
    ) {
        return false;
    }

    if (
        next.containsSelectedSlide &&
        prev.selectedSlide?.slide_key !== next.selectedSlide?.slide_key
    ) {
        return false;
    }

    return true;
});

function SlideItem({
    slide,
    sample,
    blockLabel,
    multiPart,
    sequencingDays,
    selected,
    onSelectSlide,
    tileServerBase,
    studyId,
    authScope,
}: {
    slide: Slide;
    sample: Sample;
    blockLabel: string | null;
    multiPart: boolean;
    sequencingDays?: number;
    selected: boolean;
    onSelectSlide: (slide: Slide, sample: Sample) => void;
    tileServerBase: string;
    studyId: string;
    authScope: string;
}) {
    const [hovered, setHovered] = React.useState(false);
    const isHE = wsiStainKind(slide) === 'hne';
    const dotColor = getStainDotColor(slide, theme);
    const mag = slide.magnification || '';
    const sz = fmtFileSize(slide.file_size_bytes);
    const partDesc = multiPart
        ? abbreviatePartDesc(slide.part_description)
        : null;
    const blockMeaning = !partDesc ? decodeBlockCode(blockLabel) : null;
    const stainLabel = cleanStain(slide.stain_name);
    const rawGroup = (slide.stain_group || '').toLowerCase();
    const stainText =
        isHE && (rawGroup === '' || rawGroup.startsWith('h&e'))
            ? stainQualifier(slide.stain_group)
            : stainLabel;
    // Every slide reads the same way: its block as the title and its stain beneath.
    const primaryLabel = blockLabel || stainText || 'Slide';
    const subStain = blockLabel ? stainText : null;
    const scanDetails = [mag, sz !== '—' ? sz : null]
        .filter(Boolean)
        .join(' · ');
    const procedureTimepoint = procedureSlideTimepointText(slide);
    const timepoint = procedureTimepoint
        ? procedureRelativeToSequencingText(
              getSlideTimepointDays(slide),
              sequencingDays
          ) || procedureTimepoint
        : null;
    const timepointTooltip = procedureTimepoint
        ? procedureTooltip(getSlideTimepointDays(slide), sequencingDays)
        : undefined;
    const matchBadge =
        slide.match_level === 'BLOCK'
            ? { label: 'Block', color: '#2f7d32' }
            : slide.match_level === 'PART'
            ? { label: 'Part', color: '#476f9e' }
            : undefined;

    const tooltipLines: string[] = [];
    if (slide.stain_name) tooltipLines.push(`Stain: ${slide.stain_name}`);
    if (blockLabel) tooltipLines.push(`Block: ${blockLabel}`);
    if (slide.part_description) {
        tooltipLines.push(`Part: ${slide.part_description}`);
    }
    if (mag) tooltipLines.push(`Magnification: ${mag}`);
    if (sz !== '—') tooltipLines.push(`Size: ${sz}`);
    if (timepointTooltip) tooltipLines.push(timepointTooltip);

    const bg = selected
        ? theme.blueLight
        : hovered
        ? theme.blueLight
        : 'transparent';
    const borderLeft = selected
        ? `2px solid ${theme.blue}`
        : '2px solid transparent';

    return (
        <div
            data-testid={`wsi-slide-item-${slide.slide_key}`}
            onClick={() => {
                if (!selected) onSelectSlide(slide, sample);
            }}
            onKeyDown={event => {
                if ((event.key === 'Enter' || event.key === ' ') && !selected) {
                    event.preventDefault();
                    onSelectSlide(slide, sample);
                }
            }}
            role="button"
            tabIndex={0}
            aria-current={selected ? 'true' : undefined}
            aria-label={
                tooltipLines.length > 0
                    ? tooltipLines.join(', ')
                    : primaryLabel || 'Slide'
            }
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            title={tooltipLines.join('\n')}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 8px',
                margin: '1px 4px',
                borderRadius: 3,
                borderLeft,
                background: bg,
                cursor: 'pointer',
            }}
        >
            <WsiSlideThumbnail
                tileServerBase={tileServerBase}
                slideKey={slide.slide_key}
                studyId={studyId}
                authScope={authScope}
            />
            <span
                style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: dotColor,
                    flexShrink: 0,
                    display: 'inline-block',
                }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div
                    style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: theme.text,
                        ...ellipsisStyle,
                    }}
                >
                    {primaryLabel}
                </div>
                {partDesc && (
                    <div
                        style={{
                            fontSize: 11,
                            color: theme.blue,
                            ...ellipsisStyle,
                            fontStyle: 'italic',
                        }}
                    >
                        {partDesc}
                    </div>
                )}
                {blockMeaning && (
                    <div
                        style={{
                            fontSize: 11,
                            color: theme.blue,
                            ...ellipsisStyle,
                        }}
                    >
                        {blockMeaning}
                    </div>
                )}
                {subStain && (
                    <div
                        style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: dotColor,
                            ...ellipsisStyle,
                        }}
                    >
                        {subStain}
                    </div>
                )}
                {timepoint && (
                    <div
                        data-testid={`wsi-slide-timepoint-${slide.slide_key}`}
                        title={timepointTooltip}
                        style={{
                            fontSize: 11,
                            color: theme.muted,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {timepoint}
                    </div>
                )}
            </div>
            <div style={{ flexShrink: 0, textAlign: 'right', lineHeight: 1.5 }}>
                {matchBadge && (
                    <div
                        data-testid={`wsi-slide-match-badge-${slide.slide_key}`}
                        title={`${matchBadge.label}-matched to this sequenced sample`}
                        style={{
                            display: 'inline-block',
                            padding: '0 3px',
                            borderRadius: 2,
                            background: '#f0f0f0',
                            color: matchBadge.color,
                            fontSize: 10,
                            fontWeight: 700,
                            lineHeight: '14px',
                            textTransform: 'uppercase',
                        }}
                    >
                        {matchBadge.label}
                    </div>
                )}
                {scanDetails && (
                    <div
                        style={{
                            fontSize: 11,
                            color: theme.muted,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {scanDetails}
                    </div>
                )}
            </div>
        </div>
    );
}

function WsiSlideThumbnail({
    tileServerBase,
    slideKey,
    studyId,
    authScope,
}: {
    tileServerBase: string;
    slideKey: string;
    studyId: string;
    authScope: string;
}) {
    const hostRef = React.useRef<HTMLDivElement>(null);
    const objectUrlRef = React.useRef<string | null>(null);
    const [source, setSource] = React.useState<string | null>(null);
    const [hidden, setHidden] = React.useState(false);

    React.useEffect(() => {
        setSource(null);
        setHidden(false);
        let cancelled = false;
        let controller: AbortController | null = null;
        let observer: IntersectionObserver | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let attempt = 0;
        let loadThumbnail: () => void;

        const revokeObjectUrl = () => {
            const objectUrl = objectUrlRef.current;
            objectUrlRef.current = null;
            if (objectUrl && typeof URL.revokeObjectURL === 'function') {
                URL.revokeObjectURL(objectUrl);
            }
        };

        const scheduleRetry = (delayMs: number | null) => {
            if (cancelled || delayMs === null) {
                if (!cancelled && delayMs === null) {
                    setHidden(true);
                }
                return;
            }
            retryTimer = setTimeout(() => {
                retryTimer = null;
                loadThumbnail();
            }, delayMs);
        };

        loadThumbnail = () => {
            if (cancelled) {
                return;
            }
            attempt += 1;
            const requestAttempt = attempt;
            const requestController = new AbortController();
            controller = requestController;
            void scheduleThumbnailRequest(async () => {
                const access = await getWsiSlideAccess(
                    studyId,
                    slideKey,
                    false,
                    authScope
                );
                const blob = await fetchWsiThumbnailBlob(
                    tileServerBase,
                    studyId,
                    slideKey,
                    access,
                    requestController.signal,
                    requestAttempt > 1 ? 'reload' : 'default',
                    authScope
                );
                return blob;
            }, requestController.signal)
                .then(blob => {
                    const nextObjectUrl = URL.createObjectURL(blob);
                    if (cancelled) {
                        if (typeof URL.revokeObjectURL === 'function') {
                            URL.revokeObjectURL(nextObjectUrl);
                        }
                        return;
                    }
                    revokeObjectUrl();
                    objectUrlRef.current = nextObjectUrl;
                    setSource(nextObjectUrl);
                })
                .catch(error => {
                    if (cancelled || error?.name === 'AbortError') return;
                    if (error instanceof WsiThumbnailFetchError) {
                        if (!error.retryable) {
                            setHidden(true);
                            return;
                        }
                        scheduleRetry(
                            thumbnailRetryDelayMs(
                                error.response,
                                error.reason,
                                attempt
                            )
                        );
                        return;
                    }
                    scheduleRetry(
                        thumbnailRetryDelayMs(undefined, undefined, attempt)
                    );
                });
        };

        const host = hostRef.current;
        if (!host || typeof IntersectionObserver === 'undefined') {
            loadThumbnail();
        } else {
            observer = new IntersectionObserver(
                entries => {
                    if (entries.some(entry => entry.isIntersecting)) {
                        observer?.disconnect();
                        observer = null;
                        loadThumbnail();
                    }
                },
                { rootMargin: '200px' }
            );
            observer.observe(host);
        }

        return () => {
            cancelled = true;
            observer?.disconnect();
            controller?.abort();
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
            revokeObjectUrl();
        };
    }, [slideKey, studyId, tileServerBase]);

    if (hidden) {
        return null;
    }

    return (
        <div
            ref={hostRef}
            data-testid={`wsi-slide-thumbnail-${slideKey}`}
            aria-hidden="true"
            style={{
                width: THUMBNAIL_WIDTH,
                height: THUMBNAIL_HEIGHT,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                border: '1px solid #ddd',
                borderRadius: 2,
                background: '#f1f1f1',
            }}
        >
            {source && (
                <img
                    src={source}
                    alt=""
                    loading="lazy"
                    style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        display: 'block',
                    }}
                    onError={() => {
                        const objectUrl = objectUrlRef.current;
                        objectUrlRef.current = null;
                        if (
                            objectUrl &&
                            typeof URL.revokeObjectURL === 'function'
                        ) {
                            URL.revokeObjectURL(objectUrl);
                        }
                        setSource(null);
                        setHidden(true);
                    }}
                />
            )}
        </div>
    );
}
