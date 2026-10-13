import * as React from 'react';
import { observer } from 'mobx-react';
import {
    useWsiPanelFlag,
    WSI_SECTION_TITLE_STYLE,
    WSI_STAIN_COLORS,
    WSI_THEME,
    WsiFilterChip,
    WsiFilterChipGroup,
} from 'cbioportal-wsi-viewer';
import { StudyPathologySlidesStore } from './StudyPathologySlidesStore';
import {
    STUDY_SLIDE_MATCH_LABELS,
    STUDY_SLIDE_MATCH_LEVELS,
    STUDY_SLIDE_STAIN_GROUPS,
    StudySlideStainGroup,
} from './studySlidesApi';

const C = WSI_THEME;
/** Browser-stored open state of the filters section, which starts closed. */
export const FILTERS_OPEN_KEY = 'wsi.study.filtersOpen';

const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: C.muted,
    marginBottom: 2,
};

/** The patient search: typed text narrows the list to patient or sample IDs containing it. */
export const StudySlidesSearch: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
}> = observer(({ store }) => (
    <div style={{ position: 'relative', marginTop: 7 }}>
        <i
            className="fa fa-search"
            aria-hidden="true"
            style={{
                position: 'absolute',
                left: 7,
                top: 7,
                fontSize: 11,
                color: C.muted,
            }}
        />
        <input
            type="text"
            className="form-control input-sm"
            placeholder="Search patient or sample IDs"
            aria-label="Search patients"
            data-testid="study-slides-search"
            value={store.searchText}
            onChange={e => store.setSearchText(e.target.value)}
            onKeyDown={e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    store.applySearch();
                }
            }}
            style={{
                height: 26,
                fontSize: 12,
                paddingLeft: 22,
                paddingRight: 22,
            }}
        />
        {store.searchText && (
            <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                    store.setSearchText('');
                    store.applySearch();
                }}
                style={{
                    position: 'absolute',
                    right: 2,
                    top: 6,
                    border: 'none',
                    background: 'transparent',
                    color: C.muted,
                    padding: '2px 6px',
                    lineHeight: 1,
                }}
            >
                <i className="fa fa-times" aria-hidden="true" />
            </button>
        )}
    </div>
));

function Chip({
    label,
    onRemove,
    testId,
}: {
    label: React.ReactNode;
    onRemove: () => void;
    testId: string;
}) {
    return (
        <span
            data-testid={testId}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                maxWidth: '100%',
                gap: 4,
                padding: '1px 4px 1px 7px',
                borderRadius: 10,
                background: C.blueLight,
                border: `1px solid #c5dcf3`,
                fontSize: 12,
                color: C.text,
            }}
        >
            <span
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    minWidth: 0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                }}
            >
                {label}
            </span>
            <button
                type="button"
                aria-label="Remove filter"
                onClick={onRemove}
                style={{
                    border: 'none',
                    background: 'transparent',
                    padding: '0 2px',
                    color: C.muted,
                    lineHeight: 1,
                }}
            >
                <i className="fa fa-times" aria-hidden="true" />
            </button>
        </span>
    );
}

/** The tab's own filters narrowing the list. */
export const StudySlidesFilterChips: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
}> = observer(({ store }) => {
    if (!store.hasSlideFilters) {
        return null;
    }
    const muted = (text: string) => (
        // Kept whole, with its trailing space, beside the shrinking values.
        <span style={{ color: C.muted, flexShrink: 0, whiteSpace: 'pre' }}>
            {text}:{' '}
        </span>
    );
    return (
        <div
            data-testid="study-slides-chips"
            style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
                marginTop: 7,
                alignItems: 'center',
            }}
        >
            {store.matchLevels.map(level => (
                <Chip
                    key={level}
                    testId={`study-slides-chip-match-${level}`}
                    label={
                        <>
                            {muted('Match')}
                            {STUDY_SLIDE_MATCH_LABELS[level]}
                        </>
                    }
                    onRemove={() => store.toggleMatchLevel(level)}
                />
            ))}
            {store.stainGroups.map(group => (
                <Chip
                    key={group}
                    testId={`study-slides-chip-stain-${group}`}
                    label={
                        <>
                            {muted('Stain')}
                            {group}
                        </>
                    }
                    onRemove={() => store.toggleStainGroup(group)}
                />
            ))}
            {store.search && (
                <Chip
                    testId="study-slides-chip-search"
                    label={
                        <>
                            {muted('ID')}“{store.search}”
                        </>
                    }
                    onRemove={() => {
                        store.setSearchText('');
                        store.applySearch();
                    }}
                />
            )}
            <button
                type="button"
                className="btn btn-link btn-xs"
                data-testid="study-slides-clear-filters"
                onClick={store.clearSlideFilters}
                style={{ padding: 0, fontSize: 12 }}
            >
                Clear slide filters
            </button>
        </div>
    );
});

/**
 * A multi-select filter group like the viewer's chips: All clears the
 * group, and each other chip toggles its value.
 */
function MultiSelectChips<K extends string>({
    label,
    chipTestIdPrefix,
    chips,
    selected,
    onToggle,
    onClear,
}: {
    label: string;
    chipTestIdPrefix: string;
    chips: WsiFilterChip<K>[];
    selected: K[];
    onToggle: (key: K) => void;
    onClear: () => void;
}) {
    return (
        <div style={{ marginTop: 6 }}>
            <div style={labelStyle}>{label}</div>
            <WsiFilterChipGroup<K | 'all'>
                label={label}
                chipTestIdPrefix={chipTestIdPrefix}
                chips={[{ key: 'all', label: 'All' }, ...chips]}
                isActive={key =>
                    key === 'all'
                        ? selected.length === 0
                        : selected.includes(key as K)
                }
                onSelect={key => {
                    if (key !== 'all') {
                        onToggle(key as K);
                    } else if (selected.length > 0) {
                        onClear();
                    }
                }}
            />
        </div>
    );
}

/** Match-level and stain filters, in a collapsible section. */
export const StudySlidesFilterSection: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
    stainGroupTotals: Record<StudySlideStainGroup, number>;
}> = observer(({ store, stainGroupTotals }) => {
    const [open, setOpen] = useWsiPanelFlag(FILTERS_OPEN_KEY);
    const collapsed = !open;
    const toggle = () => setOpen(!open);
    const activeCount = store.matchLevels.length + store.stainGroups.length;
    return (
        <div style={{ marginTop: 8 }}>
            <button
                type="button"
                aria-expanded={!collapsed}
                data-testid="study-slides-filters-toggle"
                onClick={toggle}
                style={{
                    ...WSI_SECTION_TITLE_STYLE,
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                }}
            >
                <i
                    className={`fa fa-caret-${collapsed ? 'right' : 'down'}`}
                    aria-hidden="true"
                    style={{ width: 9 }}
                />{' '}
                Filters
                {collapsed && activeCount > 0 && (
                    <span style={{ fontWeight: 400, letterSpacing: 0 }}>
                        {' '}
                        · {activeCount} active
                    </span>
                )}
            </button>
            {!collapsed && (
                <div data-testid="study-slides-filters">
                    <MultiSelectChips
                        label="Specimen match"
                        chipTestIdPrefix="study-slides-match"
                        chips={STUDY_SLIDE_MATCH_LEVELS.map(level => ({
                            key: level,
                            label: STUDY_SLIDE_MATCH_LABELS[level],
                        }))}
                        selected={store.matchLevels}
                        onToggle={store.toggleMatchLevel}
                        onClear={store.clearMatchLevels}
                    />
                    <MultiSelectChips
                        label="Stain"
                        chipTestIdPrefix="study-slides-stain"
                        chips={STUDY_SLIDE_STAIN_GROUPS.map(group => ({
                            key: group,
                            label: group,
                            color: WSI_STAIN_COLORS[group],
                            count: stainGroupTotals[group],
                        }))}
                        selected={store.stainGroups}
                        onToggle={store.toggleStainGroup}
                        onClear={store.clearStainGroups}
                    />
                </div>
            )}
        </div>
    );
});
