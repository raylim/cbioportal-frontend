import * as React from 'react';
import { observer } from 'mobx-react';
import { CheckedSelect } from 'cbioportal-frontend-commons';
import {
    readWsiPanelFlag,
    WSI_SECTION_TITLE_STYLE,
    WSI_STAIN_COLORS,
    WSI_THEME,
    writeWsiPanelFlag,
} from 'cbioportal-wsi-viewer';
import {
    DEFAULT_FACET_ATTRIBUTE_IDS,
    StudyPathologySlidesStore,
    StudySlidesSuggestion,
} from './StudyPathologySlidesStore';
import {
    STUDY_SLIDE_MATCH_LABELS,
    STUDY_SLIDE_MATCH_LEVELS,
    STUDY_SLIDE_STAIN_GROUPS,
    StudySlideAttributeFacet,
    StudySlideStainGroup,
} from './studySlidesApi';

const C = WSI_THEME;
const STAIN_GROUPS = STUDY_SLIDE_STAIN_GROUPS as StudySlideStainGroup[];
/** Browser-stored open state of the filters section, which starts closed. */
export const FILTERS_OPEN_KEY = 'wsi.study.filtersOpen';

const MATCH_BUTTON_LABELS = {
    PART: 'Part',
    BLOCK: 'Block',
    UNMATCHED: 'Unmatched',
};

type SearchOption = { kind: 'id' } | StudySlidesSuggestion;

const labelStyle: React.CSSProperties = {
    fontSize: 10,
    color: C.muted,
    marginBottom: 2,
};

function StainDot({ group }: { group: StudySlideStainGroup }) {
    return (
        <i
            className="fa fa-circle"
            aria-hidden="true"
            style={{
                fontSize: 7,
                marginRight: 3,
                color: WSI_STAIN_COLORS[group],
                verticalAlign: 'middle',
            }}
        />
    );
}

function optionKey(option: SearchOption): string {
    switch (option.kind) {
        case 'id':
            return 'id';
        case 'match':
            return `match:${option.level}`;
        default:
            return `clinical:${option.attributeId}:${option.value}`;
    }
}

/**
 * The patient search: typed text narrows the list to patient or sample IDs
 * containing it, and the dropdown suggests clinical values and match levels
 * containing it, which add filters when picked.
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
            if (option.kind === 'clinical') {
                store.addClinicalValue(option.attributeId, option.value);
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
                placeholder="Search IDs, cancer types…"
                aria-label="Search patients"
                aria-autocomplete="list"
                aria-expanded={options.length > 0}
                data-testid="study-slides-search"
                value={store.searchText}
                onFocus={() => {
                    store.requestSuggestions();
                    setOpen(true);
                }}
                onBlur={() => {
                    finish();
                    store.releaseSuggestions();
                }}
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
                                    Patient or sample ID contains “{text}”
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
                                            {option.kind === 'clinical'
                                                ? option.value
                                                : STUDY_SLIDE_MATCH_LABELS[
                                                      option.level
                                                  ]}
                                        </span>
                                        <span
                                            style={{
                                                display: 'block',
                                                fontSize: 10,
                                                color: C.muted,
                                            }}
                                        >
                                            {option.kind === 'clinical'
                                                ? option.displayName
                                                : 'Specimen match'}
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
                fontSize: 11,
                color: C.text,
            }}
        >
            <span
                style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
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

/** Every filter narrowing the list, including the study view's clinical ones. */
export const StudySlidesFilterChips: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
}> = observer(({ store }) => {
    const clinical = store.clinicalFilters;
    if (clinical.length === 0 && !store.hasSlideFilters) {
        return null;
    }
    const muted = (text: string) => (
        <span style={{ color: C.muted }}>{text}: </span>
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
            {clinical.map(f => (
                <Chip
                    key={f.attributeId}
                    testId={`study-slides-chip-${f.attributeId}`}
                    label={
                        <>
                            {muted(f.displayName)}
                            {f.values.join(', ')}
                        </>
                    }
                    onRemove={() => store.setClinicalValues(f.attributeId, [])}
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
            {store.hasSlideFilters && (
                <button
                    type="button"
                    className="btn btn-link btn-xs"
                    data-testid="study-slides-clear-filters"
                    onClick={store.clearSlideFilters}
                    style={{ padding: 0, fontSize: 11 }}
                >
                    Clear slide filters
                </button>
            )}
        </div>
    );
});

const ClinicalFacet: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
    facet: StudySlideAttributeFacet;
}> = observer(({ store, facet }) => {
    const attribute = store.clinicalAttributesById[facet.attributeId];
    const selected = store.clinicalValues(facet.attributeId);
    const listed = new Set(facet.values.map(v => v.value));
    const options = [
        ...facet.values.map(v => ({
            value: v.value,
            label: `${v.value} (${v.patientCount.toLocaleString()})`,
        })),
        // A selected value outside the most frequent ones stays selectable.
        ...selected
            .filter(v => !listed.has(v))
            .map(v => ({ value: v, label: v })),
    ];
    const removable = !DEFAULT_FACET_ATTRIBUTE_IDS.includes(facet.attributeId);
    return (
        <div
            data-testid={`study-slides-facet-${facet.attributeId}`}
            style={{ marginTop: 6 }}
        >
            <div
                style={{
                    ...labelStyle,
                    display: 'flex',
                    justifyContent: 'space-between',
                }}
            >
                <span>{attribute?.displayName || facet.attributeId}</span>
                {removable && (
                    <button
                        type="button"
                        aria-label={`Remove ${attribute?.displayName ||
                            facet.attributeId} filter`}
                        onClick={() => store.unpinAttribute(facet.attributeId)}
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
                name={`study-slides-facet-${facet.attributeId}`}
                placeholder={
                    selected.length > 0
                        ? selected.join(', ')
                        : `Any ${(
                              attribute?.displayName || facet.attributeId
                          ).toLowerCase()}`
                }
                options={options}
                value={selected.map(value => ({ value }))}
                onChange={values =>
                    store.setClinicalValues(
                        facet.attributeId,
                        values.map(v => v.value)
                    )
                }
                showControls={false}
            />
        </div>
    );
});

/** Clinical, match-level and stain filters, in a collapsible section. */
export const StudySlidesFilterSection: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
    stainGroupTotals: Record<StudySlideStainGroup, number>;
}> = observer(({ store, stainGroupTotals }) => {
    const [open, setOpen] = React.useState(() =>
        readWsiPanelFlag(FILTERS_OPEN_KEY)
    );
    const collapsed = !open;
    const toggle = () => {
        writeWsiPanelFlag(FILTERS_OPEN_KEY, !open);
        setOpen(!open);
    };
    const activeCount =
        store.clinicalFilters.length +
        store.matchLevels.length +
        store.stainGroups.length;
    // Without facet counts the match buttons still filter.
    const matchCounts = store.facets.result?.matchLevels;
    const shown = new Set(store.facetAttributeIds);
    const addable = (store.clinical?.getAttributes() || []).filter(
        a => !shown.has(a.attributeId)
    );
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
                        <ClinicalFacet
                            key={facet.attributeId}
                            store={store}
                            facet={facet}
                        />
                    ))}
                    <div style={{ marginTop: 6 }}>
                        <div style={labelStyle}>Specimen match</div>
                        <div
                            role="group"
                            aria-label="Specimen match"
                            className="btn-group btn-group-xs"
                            style={{ display: 'flex', flexWrap: 'wrap' }}
                        >
                            {STUDY_SLIDE_MATCH_LEVELS.map(level => {
                                const active = store.matchLevels.includes(
                                    level
                                );
                                return (
                                    <button
                                        key={level}
                                        type="button"
                                        className={`btn btn-xs ${
                                            active
                                                ? 'btn-primary'
                                                : 'btn-default'
                                        }`}
                                        aria-pressed={active}
                                        data-testid={`study-slides-match-${level}`}
                                        onClick={() =>
                                            store.toggleMatchLevel(level)
                                        }
                                    >
                                        {MATCH_BUTTON_LABELS[level]}
                                        {typeof matchCounts?.[level] ===
                                            'number' && (
                                            <span style={{ opacity: 0.7 }}>
                                                {' '}
                                                {matchCounts[
                                                    level
                                                ].toLocaleString()}
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div style={{ marginTop: 6 }}>
                        <div style={labelStyle}>Stain</div>
                        <div
                            role="group"
                            aria-label="Stain groups"
                            className="btn-group btn-group-xs"
                            style={{ display: 'flex', flexWrap: 'wrap' }}
                        >
                            {STAIN_GROUPS.map(group => {
                                const active = store.stainGroups.includes(
                                    group
                                );
                                return (
                                    <button
                                        key={group}
                                        type="button"
                                        className={`btn btn-xs ${
                                            active
                                                ? 'btn-primary'
                                                : 'btn-default'
                                        }`}
                                        aria-pressed={active}
                                        data-testid={`study-slides-stain-${group}`}
                                        onClick={() =>
                                            store.toggleStainGroup(group)
                                        }
                                    >
                                        {!active && <StainDot group={group} />}
                                        {group}{' '}
                                        <span style={{ opacity: 0.7 }}>
                                            {stainGroupTotals[
                                                group
                                            ].toLocaleString()}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {addable.length > 0 && (
                        <select
                            aria-label="Add a clinical filter"
                            data-testid="study-slides-add-filter"
                            className="form-control input-sm"
                            value=""
                            onChange={e =>
                                e.target.value &&
                                store.pinAttribute(e.target.value)
                            }
                            style={{ height: 24, fontSize: 11, marginTop: 7 }}
                        >
                            <option value="">+ More filters…</option>
                            {addable.map(a => (
                                <option
                                    key={a.attributeId}
                                    value={a.attributeId}
                                >
                                    {a.displayName}
                                </option>
                            ))}
                        </select>
                    )}
                </div>
            )}
        </div>
    );
});
