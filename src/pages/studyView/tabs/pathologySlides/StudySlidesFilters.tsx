import * as React from 'react';
import { observer } from 'mobx-react';
import { CheckedSelect } from 'cbioportal-frontend-commons';
import { components as SelectComponents } from 'react-select';
import {
    useWsiPanelFlag,
    WSI_SECTION_TITLE_STYLE,
    WSI_STAIN_COLORS,
    WSI_THEME,
    WsiFilterChip,
    WsiFilterChipGroup,
} from 'cbioportal-wsi-viewer';
import {
    DEFAULT_FACET_COLUMN_IDS,
    StudyPathologySlidesStore,
    StudySlidesSuggestion,
} from './StudyPathologySlidesStore';
import {
    STUDY_SLIDE_MATCH_LABELS,
    STUDY_SLIDE_MATCH_LEVELS,
    STUDY_SLIDE_STAIN_GROUPS,
    StudySlideFacetColumn,
} from './studySlidesApi';

const C = WSI_THEME;
/** Browser-stored open state of the filters section, which starts closed. */
export const FILTERS_OPEN_KEY = 'wsi.study.filtersOpen';

type SearchOption = { kind: 'id' } | StudySlidesSuggestion;

const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: C.muted,
    marginBottom: 2,
};

function optionKey(option: SearchOption): string {
    switch (option.kind) {
        case 'id':
            return 'id';
        case 'match':
            return `match:${option.level}`;
        default:
            return `value:${option.columnId}:${option.value}`;
    }
}

/**
 * The patient search: typed text narrows the list to patients with a slide whose
 * patient, sample or slide ID, or other slide detail, contains it; the dropdown
 * suggests slide column values and match levels containing it, which add
 * filters when picked.
 */
export const StudySlidesSearch: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
}> = observer(({ store }) => {
    const [open, setOpen] = React.useState(false);
    const [active, setActive] = React.useState(0);
    const text = store.searchText.trim();
    const options: SearchOption[] =
        open && text ? [{ kind: 'id' }, ...store.suggestionsFor(text)] : [];

    const finish = () => {
        setOpen(false);
        setActive(0);
    };
    const pick = (option: SearchOption) => {
        if (option.kind === 'id') {
            store.applySearch();
        } else {
            if (option.kind === 'value') {
                store.addColumnValue(option.columnId, option.value);
            } else if (!store.matchLevels.includes(option.level)) {
                store.toggleMatchLevel(option.level);
            }
            store.setSearchText('');
            store.applySearch();
        }
        finish();
    };

    return (
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
                placeholder="Search IDs, stains, part types…"
                aria-label="Search patients"
                aria-autocomplete="list"
                aria-expanded={options.length > 0}
                data-testid="study-slides-search"
                value={store.searchText}
                onFocus={() => setOpen(true)}
                onBlur={finish}
                onChange={e => {
                    store.setSearchText(e.target.value);
                    setOpen(true);
                    setActive(0);
                }}
                onKeyDown={e => {
                    if (e.key === 'ArrowDown' && options.length > 0) {
                        e.preventDefault();
                        setActive((active + 1) % options.length);
                    } else if (e.key === 'ArrowUp' && options.length > 0) {
                        e.preventDefault();
                        setActive(
                            (active - 1 + options.length) % options.length
                        );
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        if (options[active]) {
                            pick(options[active]);
                        } else {
                            store.applySearch();
                        }
                    } else if (e.key === 'Escape') {
                        finish();
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
                    onMouseDown={e => e.preventDefault()}
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
            {options.length > 0 && (
                <ul
                    role="listbox"
                    data-testid="study-slides-suggestions"
                    style={{
                        position: 'absolute',
                        zIndex: 20,
                        top: 28,
                        left: 0,
                        // Wider than the panel, over the viewer, so values fit.
                        width: 420,
                        margin: 0,
                        padding: '3px 0',
                        listStyle: 'none',
                        background: '#fff',
                        border: `1px solid ${C.border}`,
                        borderRadius: 3,
                        boxShadow: '0 4px 12px rgba(0,0,0,.12)',
                        maxHeight: 340,
                        overflowY: 'auto',
                        fontSize: 12,
                    }}
                >
                    {options.map((option, index) => (
                        <li
                            key={optionKey(option)}
                            role="option"
                            aria-selected={index === active}
                            data-testid="study-slides-suggestion"
                            onMouseDown={e => e.preventDefault()}
                            onMouseEnter={() => setActive(index)}
                            onClick={() => pick(option)}
                            style={{
                                padding: '4px 8px',
                                cursor: 'pointer',
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 8,
                                background:
                                    index === active
                                        ? C.blueLight
                                        : 'transparent',
                            }}
                        >
                            {option.kind === 'id' ? (
                                <span>
                                    <i
                                        className="fa fa-search"
                                        aria-hidden="true"
                                        style={{
                                            color: C.muted,
                                            marginRight: 6,
                                        }}
                                    />
                                    Slides matching “{text}”
                                </span>
                            ) : (
                                <>
                                    <span style={{ minWidth: 0 }}>
                                        <span
                                            style={{
                                                display: 'block',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            {option.kind === 'value'
                                                ? option.value
                                                : STUDY_SLIDE_MATCH_LABELS[
                                                      option.level
                                                  ]}
                                        </span>
                                        <span
                                            style={{
                                                display: 'block',
                                                fontSize: 11,
                                                color: C.muted,
                                            }}
                                        >
                                            {option.kind === 'value'
                                                ? option.label
                                                : 'Match'}
                                        </span>
                                    </span>
                                    <span
                                        style={{
                                            color: C.muted,
                                            fontSize: 11,
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {option.patientCount.toLocaleString()}{' '}
                                        {option.patientCount === 1
                                            ? 'patient'
                                            : 'patients'}
                                    </span>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
});

/**
 * Selected values on one line: the first value, cut with an ellipsis when
 * long, then a count of the others. The full list is in the tooltip.
 */
export function SelectedValues({ values }: { values: string[] }) {
    const more = values.length - 1;
    return (
        <span
            title={values.join(', ')}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: '100%',
                minWidth: 0,
                verticalAlign: 'bottom',
            }}
        >
            <span
                style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {values[0]}
            </span>
            {more > 0 && (
                <span
                    data-testid="selected-values-more"
                    aria-label={`and ${more} more`}
                    style={{
                        flexShrink: 0,
                        padding: '0 5px',
                        borderRadius: 8,
                        background: C.blue,
                        color: '#fff',
                        fontSize: 10,
                        fontWeight: 600,
                        lineHeight: '15px',
                    }}
                >
                    +{more}
                </span>
            )}
        </span>
    );
}

/**
 * react-select's placeholder has no right bound, so a long selection would
 * run under the dropdown arrow; this caps it like a single value.
 */
const BoundedPlaceholder = (props: any) => (
    <SelectComponents.Placeholder
        {...props}
        getStyles={(key: string, state: any) => ({
            ...props.getStyles(key, state),
            maxWidth: 'calc(100% - 8px)',
        })}
    />
);
const FACET_SELECT_COMPONENTS = { Placeholder: BoundedPlaceholder };

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
            {store.activeColumnFilters.map(f => (
                <Chip
                    key={f.columnId}
                    testId={`study-slides-chip-${f.columnId}`}
                    label={
                        <>
                            {muted(f.label)}
                            <SelectedValues values={f.values} />
                        </>
                    }
                    onRemove={() => store.setColumnValues(f.columnId, [])}
                />
            ))}
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

/** One slide column's filter: its values with patient counts, any of which a slide may have. */
const ColumnFacet: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
    facet: StudySlideFacetColumn;
}> = observer(({ store, facet }) => {
    const selected = store.columnValues(facet.columnId);
    const listed = new Set(facet.values.map(v => v.value));
    const options = [
        ...facet.values.map(v => ({
            value: v.value,
            label: `${v.value} (${v.count.toLocaleString()})`,
        })),
        // A selected value no listed patient has any more stays selectable.
        ...selected
            .filter(v => !listed.has(v))
            .map(v => ({ value: v, label: v })),
    ];
    const removable = !DEFAULT_FACET_COLUMN_IDS.includes(facet.columnId);
    return (
        <div
            data-testid={`study-slides-facet-${facet.columnId}`}
            style={{ marginTop: 6 }}
        >
            <div
                style={{
                    ...labelStyle,
                    display: 'flex',
                    justifyContent: 'space-between',
                }}
            >
                <span>{facet.label}</span>
                {removable && (
                    <button
                        type="button"
                        aria-label={`Remove ${facet.label} filter`}
                        onClick={() => store.unpinColumn(facet.columnId)}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            padding: 0,
                            color: C.muted,
                            lineHeight: 1,
                        }}
                    >
                        <i className="fa fa-times" aria-hidden="true" />
                    </button>
                )}
            </div>
            <CheckedSelect
                name={`study-slides-facet-${facet.columnId}`}
                placeholder={
                    selected.length > 0 ? (
                        <SelectedValues values={selected} />
                    ) : (
                        `Any ${facet.label.toLowerCase()}`
                    )
                }
                options={options}
                value={selected.map(value => ({ value }))}
                onChange={values =>
                    store.setColumnValues(
                        facet.columnId,
                        values.map(v => v.value)
                    )
                }
                showControls={false}
                reactSelectComponents={FACET_SELECT_COMPONENTS}
            />
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

/**
 * Slide column, match-level and stain filters, in a collapsible section. Their counts are
 * patients with slides of each value.
 */
export const StudySlidesFilterSection: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
}> = observer(({ store }) => {
    const stainGroupPatients = store.stainGroupPatientCounts;
    const [open, setOpen] = useWsiPanelFlag(FILTERS_OPEN_KEY);
    const collapsed = !open;
    const toggle = () => setOpen(!open);
    const activeCount =
        store.activeColumnFilters.length +
        store.matchLevels.length +
        store.stainGroups.length;
    // Without facet counts the match buttons still filter.
    const matchCounts = store.matchLevelPatientCounts;
    const addable = store.addableFacetColumns;
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
                <div
                    data-testid="study-slides-filters"
                    aria-busy={store.facets.isPending}
                    style={{
                        // Counts dim while they reload for a new selection.
                        opacity: store.facets.isPending ? 0.6 : 1,
                        transition: 'opacity 120ms',
                    }}
                >
                    {store.visibleFacets.map(facet => (
                        <ColumnFacet
                            key={facet.columnId}
                            store={store}
                            facet={facet}
                        />
                    ))}
                    <MultiSelectChips
                        label="Match"
                        chipTestIdPrefix="study-slides-match"
                        chips={STUDY_SLIDE_MATCH_LEVELS.map(level => ({
                            key: level,
                            label: STUDY_SLIDE_MATCH_LABELS[level],
                            count: matchCounts?.[level],
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
                            count: stainGroupPatients[group],
                        }))}
                        selected={store.stainGroups}
                        onToggle={store.toggleStainGroup}
                        onClear={store.clearStainGroups}
                    />
                    {addable.length > 0 && (
                        <select
                            aria-label="Add a slide filter"
                            data-testid="study-slides-add-filter"
                            className="form-control input-sm"
                            value=""
                            onChange={e =>
                                e.target.value &&
                                store.pinColumn(e.target.value)
                            }
                            style={{ height: 26, fontSize: 12, marginTop: 7 }}
                        >
                            <option value="">+ More filters…</option>
                            {addable.map(column => (
                                <option
                                    key={column.columnId}
                                    value={column.columnId}
                                >
                                    {column.label}
                                </option>
                            ))}
                        </select>
                    )}
                </div>
            )}
        </div>
    );
});
