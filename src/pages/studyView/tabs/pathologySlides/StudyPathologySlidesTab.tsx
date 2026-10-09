import * as React from 'react';
import { observer } from 'mobx-react';
import {
    WSI_FONT_FAMILY,
    WSI_SECTION_TITLE_STYLE,
    WSI_THEME,
    WsiCollapsedRail,
    WsiPanelHideButton,
    wsiListItemStyle,
} from 'cbioportal-wsi-viewer';
import { getPatientViewUrlWithPathname } from 'shared/api/urls';
import LoadingIndicator from 'shared/components/loadingIndicator/LoadingIndicator';
import { AppWsiViewer } from 'shared/components/wsiViewer/wsiAppConfig';
import {
    isSamePatient,
    StudyPathologySlidesStore,
    StudySlidesView,
} from './StudyPathologySlidesStore';
import {
    STUDY_SLIDE_STAIN_GROUPS,
    StudySlidePatient,
    StudySlidesRequestError,
    viewerMatchFilter,
    viewerStainFilter,
} from './studySlidesApi';
import {
    StainDot,
    StudySlidesFilterChips,
    StudySlidesFilterSection,
    StudySlidesSearch,
    useStoredFlag,
} from './StudySlidesFilters';

export interface StudyPathologySlidesTabProps {
    store: StudyPathologySlidesStore;
    tileServerUrl: string;
    /** Keyboard shortcuts are active only while the tab is shown. */
    isActive: boolean;
    height: number;
    userName?: string;
    /** The cohort's slide table, shown as the tab's second view. */
    slideTable?: React.ReactNode;
}

const VIEW_SWITCH_HEIGHT = 38;

/** Browser-stored hidden state of the patient list. */
export const PATIENT_LIST_COLLAPSED_KEY = 'wsi.study.patientListCollapsed';

const C = WSI_THEME;
const PANEL_WIDTH = 280;
const TOOLBAR_HEIGHT = 34;

const iconButtonStyle: React.CSSProperties = {
    border: 'none',
    background: 'transparent',
    padding: '2px 6px',
    color: C.muted,
    cursor: 'pointer',
    lineHeight: 1,
};

function count(n: number, noun: string): string {
    return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element || !element.tagName) {
        return false;
    }
    const tag = element.tagName.toLowerCase();
    return (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        element.isContentEditable
    );
}

function patientOptionId(patient: { studyId: string; patientId: string }) {
    return `study-slides-patient-${patient.studyId}-${patient.patientId}`;
}

function IconButton({
    icon,
    label,
    onClick,
    disabled,
    testId,
}: {
    icon: string;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    testId?: string;
}) {
    return (
        <button
            type="button"
            title={label}
            aria-label={label}
            disabled={disabled}
            data-testid={testId}
            onClick={onClick}
            style={{
                ...iconButtonStyle,
                opacity: disabled ? 0.35 : 1,
                cursor: disabled ? 'default' : 'pointer',
            }}
        >
            <i className={`fa ${icon}`} aria-hidden="true" />
        </button>
    );
}

function Key({ children }: { children: React.ReactNode }) {
    return (
        <kbd
            style={{
                background: '#fff',
                color: C.muted,
                border: `1px solid ${C.border}`,
                borderRadius: 3,
                boxShadow: 'none',
                padding: '0 4px',
                fontSize: 10,
            }}
        >
            {children}
        </kbd>
    );
}

const PatientRow: React.FunctionComponent<{
    patient: StudySlidePatient;
    selected: boolean;
    onSelect: () => void;
}> = ({ patient, selected, onSelect }) => {
    const [hovered, setHovered] = React.useState(false);
    return (
        <li
            id={patientOptionId(patient)}
            role="option"
            aria-selected={selected}
            data-testid="study-slides-patient"
            onClick={onSelect}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={wsiListItemStyle(selected, hovered)}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                }}
            >
                <span
                    style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: selected ? C.blueDark : C.text,
                    }}
                >
                    {patient.patientId}
                </span>
                <span style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                    {STUDY_SLIDE_STAIN_GROUPS.filter(
                        group => patient.stainGroupCounts[group] > 0
                    ).map(group => (
                        <span
                            key={group}
                            title={`${group}: ${patient.stainGroupCounts[group]}`}
                            style={{ marginLeft: 6, color: C.muted }}
                        >
                            <StainDot group={group} />
                            {patient.stainGroupCounts[group]}
                        </span>
                    ))}
                </span>
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>
                {count(patient.slideCount, 'slide')}
            </div>
        </li>
    );
};

const PatientPager: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
}> = observer(({ store }) => {
    const [pageInput, setPageInput] = React.useState('');
    const lastPage = store.pageCount - 1;
    const { first, last } = store.displayedRange;
    const selectedElsewhere =
        store.selectedPageNumber !== undefined &&
        store.selectedPageNumber !== store.pageNumber;
    const submitPage = () => {
        const requested = parseInt(pageInput, 10);
        if (Number.isFinite(requested)) {
            store.setPageNumber(requested - 1);
        }
        setPageInput('');
    };
    return (
        <div
            data-testid="study-slides-pages"
            style={{
                flexShrink: 0,
                borderTop: `1px solid ${C.border}`,
                padding: '5px 6px',
                fontSize: 11,
                color: C.muted,
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                }}
            >
                <span>
                    <IconButton
                        icon="fa-angle-double-left"
                        label="First page of patients"
                        disabled={store.pageNumber === 0}
                        onClick={() => store.setPageNumber(0)}
                    />
                    <IconButton
                        icon="fa-chevron-left"
                        label="Previous page of patients"
                        disabled={store.pageNumber === 0}
                        onClick={() =>
                            store.setPageNumber(store.pageNumber - 1)
                        }
                    />
                </span>
                <span data-testid="study-slides-range" aria-live="polite">
                    {first.toLocaleString()}–{last.toLocaleString()} of{' '}
                    {store.totalPatients.toLocaleString()}
                    {store.isPageLoading && (
                        <i
                            className="fa fa-spinner fa-spin"
                            aria-label="Loading patients"
                            style={{ marginLeft: 5 }}
                        />
                    )}
                </span>
                <span>
                    <IconButton
                        icon="fa-chevron-right"
                        label="Next page of patients"
                        disabled={store.pageNumber >= lastPage}
                        onClick={() =>
                            store.setPageNumber(store.pageNumber + 1)
                        }
                    />
                    <IconButton
                        icon="fa-angle-double-right"
                        label="Last page of patients"
                        disabled={store.pageNumber >= lastPage}
                        onClick={() => store.setPageNumber(lastPage)}
                    />
                </span>
            </div>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 3,
                }}
            >
                <form
                    onSubmit={event => {
                        event.preventDefault();
                        submitPage();
                    }}
                >
                    Page{' '}
                    <input
                        type="number"
                        min={1}
                        max={store.pageCount}
                        aria-label="Page number"
                        data-testid="study-slides-page-input"
                        placeholder={String(store.pageNumber + 1)}
                        value={pageInput}
                        onChange={event => setPageInput(event.target.value)}
                        onBlur={() => pageInput && submitPage()}
                        style={{
                            width: 56,
                            fontSize: 11,
                            padding: '0 3px',
                            border: `1px solid ${C.border}`,
                            borderRadius: 3,
                        }}
                    />{' '}
                    of {store.pageCount.toLocaleString()}
                </form>
                {selectedElsewhere && (
                    <button
                        type="button"
                        className="btn btn-link btn-xs"
                        data-testid="study-slides-go-selected"
                        onClick={store.goToSelectedPage}
                        style={{ padding: 0, fontSize: 11 }}
                    >
                        Go to selected
                    </button>
                )}
            </div>
        </div>
    );
});

const PatientPanel: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
    onHide: () => void;
}> = observer(({ store, onHide }) => {
    const listRef = React.useRef<HTMLUListElement>(null);
    const page = store.page.result!;
    const selected = store.selected;

    // Show the selected patient when it is on the page; otherwise start a
    // newly loaded page from its top.
    React.useEffect(() => {
        const list = listRef.current;
        if (!list) {
            return;
        }
        const option =
            selected &&
            (list.querySelector(
                `[id="${patientOptionId(selected)}"]`
            ) as HTMLElement | null);
        if (option) {
            option.scrollIntoView?.({ block: 'nearest' });
        } else {
            list.scrollTop = 0;
        }
    }, [selected, page]);

    return (
        <div
            data-testid="study-slides-patient-panel"
            style={{
                width: PANEL_WIDTH,
                minWidth: PANEL_WIDTH,
                display: 'flex',
                flexDirection: 'column',
                background: C.navBg,
                borderRight: `1px solid ${C.border}`,
                position: 'relative',
            }}
        >
            {store.isPageLoading && (
                <div
                    aria-hidden="true"
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: 2,
                        background: C.blue,
                        opacity: 0.7,
                        zIndex: 1,
                    }}
                />
            )}
            <div
                style={{
                    padding: '9px 12px 8px',
                    borderBottom: `1px solid ${C.border}`,
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
                    <div style={WSI_SECTION_TITLE_STYLE}>
                        Patients{' '}
                        <span
                            data-testid="study-slides-patient-count"
                            style={{ fontWeight: 400, letterSpacing: 0 }}
                        >
                            {page.totalPatients.toLocaleString()}
                        </span>
                    </div>
                    <WsiPanelHideButton
                        side="left"
                        label="Hide patient list (\)"
                        onClick={onHide}
                        testId="study-slides-hide"
                    />
                </div>
                <div
                    data-testid="study-slides-summary"
                    style={{ fontSize: 11, color: C.muted, marginTop: 2 }}
                >
                    {count(page.totalSlides, 'viewable slide')}
                </div>
                <StudySlidesSearch store={store} />
                <StudySlidesFilterChips store={store} />
                <StudySlidesFilterSection
                    store={store}
                    stainGroupTotals={page.stainGroupTotals}
                />
            </div>

            {page.patients.length === 0 ? (
                <div
                    data-testid="study-slides-empty"
                    style={{ color: '#bbb', fontSize: 11, padding: 12 }}
                >
                    {store.hasSlideFilters
                        ? 'No patients match these filters.'
                        : 'No pathology slides in the current selection.'}
                </div>
            ) : (
                <ul
                    ref={listRef}
                    role="listbox"
                    tabIndex={0}
                    aria-label="Patients with pathology slides"
                    aria-busy={store.isPageLoading}
                    aria-activedescendant={
                        selected &&
                        page.patients.some(p => isSamePatient(p, selected))
                            ? patientOptionId(selected)
                            : undefined
                    }
                    data-testid="study-slides-patients"
                    onKeyDown={event => {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            store.selectNext();
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            store.selectPrevious();
                        }
                    }}
                    style={{
                        listStyle: 'none',
                        margin: 0,
                        padding: '4px 0',
                        overflowY: 'auto',
                        flex: 1,
                        outline: 'none',
                        opacity: store.isPageLoading ? 0.5 : 1,
                        transition: 'opacity 120ms',
                    }}
                >
                    {page.patients.map(patient => (
                        <PatientRow
                            key={patientOptionId(patient)}
                            patient={patient}
                            selected={isSamePatient(patient, selected)}
                            onSelect={() => store.selectPatient(patient)}
                        />
                    ))}
                </ul>
            )}
            {page.totalPatients > page.pageSize && (
                <PatientPager store={store} />
            )}
        </div>
    );
});

const ViewerToolbar: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
}> = observer(({ store }) => {
    const selected = store.selected!;
    const page = store.page.result!;
    const listed = page.patients.find(p => isSamePatient(p, selected));
    const navPatients = page.patients.map(p => ({
        studyId: p.studyId,
        patientId: p.patientId,
    }));
    return (
        <div
            data-testid="study-slides-nav"
            style={{
                height: TOOLBAR_HEIGHT,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 8px',
                background: C.sidebarBg,
                borderBottom: `1px solid ${C.border}`,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
            }}
        >
            <IconButton
                icon="fa-chevron-left"
                label="Previous patient ([)"
                disabled={!store.hasPrevious}
                onClick={store.selectPrevious}
                testId="study-slides-previous"
            />
            <span data-testid="study-slides-position">
                <strong style={{ color: C.text }}>{selected.patientId}</strong>
                {store.selectedIndex !== undefined && (
                    <span style={{ color: C.muted }}>
                        {` · ${(
                            store.selectedIndex + 1
                        ).toLocaleString()} of ${page.totalPatients.toLocaleString()}`}
                    </span>
                )}
            </span>
            <IconButton
                icon="fa-chevron-right"
                label="Next patient (])"
                disabled={!store.hasNext}
                onClick={store.selectNext}
                testId="study-slides-next"
            />
            {listed && (
                <span style={{ color: C.muted, fontSize: 11 }}>
                    {count(listed.slideCount, 'slide')}
                </span>
            )}
            <span
                className="hidden-xs hidden-sm"
                style={{ color: '#aaa', fontSize: 11, marginLeft: 6 }}
            >
                <Key>[</Key> <Key>]</Key> patients · <Key>\</Key> list
            </span>
            <a
                style={{ marginLeft: 'auto', fontSize: 12 }}
                href={getPatientViewUrlWithPathname(
                    selected.studyId,
                    selected.patientId,
                    'patient/wsiHESlides',
                    listed ? navPatients : undefined
                )}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="study-slides-open-patient"
            >
                Open in patient view{' '}
                <i className="fa fa-external-link" aria-hidden="true" />
            </a>
        </div>
    );
});

/**
 * The study's pathology slides, as patients beside the slide viewer or as the cohort's slide table
 * (one row per slide, with column filters, sorting and download). A table row's View opens that
 * slide in the viewer.
 */
export const StudyPathologySlidesTab: React.FunctionComponent<StudyPathologySlidesTabProps> = observer(
    props => {
        const { store, slideTable, height } = props;
        if (!slideTable) {
            return <StudySlidesViewerView {...props} />;
        }
        const views: { id: StudySlidesView; label: string; icon: string }[] = [
            { id: 'viewer', label: 'Viewer', icon: 'fa-picture-o' },
            { id: 'table', label: 'Slide table', icon: 'fa-table' },
        ];
        return (
            <div data-testid="study-slides-views">
                <div
                    className="btn-group btn-group-sm"
                    role="group"
                    aria-label="Pathology slides view"
                    style={{ marginBottom: 8 }}
                >
                    {views.map(view => (
                        <button
                            key={view.id}
                            type="button"
                            className={`btn btn-default${
                                store.view === view.id ? ' active' : ''
                            }`}
                            aria-pressed={store.view === view.id}
                            data-testid={`study-slides-view-${view.id}`}
                            onClick={() => store.setView(view.id)}
                        >
                            <i
                                className={`fa ${view.icon}`}
                                style={{ marginRight: 5 }}
                            />
                            {view.label}
                        </button>
                    ))}
                </div>
                {store.view === 'table' ? (
                    <div data-testid="study-slides-table">{slideTable}</div>
                ) : (
                    <StudySlidesViewerView
                        {...props}
                        height={height - VIEW_SWITCH_HEIGHT}
                    />
                )}
            </div>
        );
    }
);

const StudySlidesViewerView: React.FunctionComponent<StudyPathologySlidesTabProps> = observer(
    ({ store, tileServerUrl, isActive, height, userName }) => {
        const [listCollapsed, setListCollapsed] = useStoredFlag(
            PATIENT_LIST_COLLAPSED_KEY
        );

        React.useEffect(() => {
            if (!isActive) {
                return;
            }
            const onKeyDown = (event: KeyboardEvent) => {
                if (
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    isTypingTarget(event.target)
                ) {
                    return;
                }
                if (event.key === ']') {
                    store.selectNext();
                } else if (event.key === '[') {
                    store.selectPrevious();
                } else if (event.key === '\\') {
                    setListCollapsed(!listCollapsed);
                }
            };
            document.addEventListener('keydown', onKeyDown);
            return () => document.removeEventListener('keydown', onKeyDown);
        }, [isActive, store, listCollapsed, setListCollapsed]);

        if (store.page.isError) {
            const status =
                store.page.error instanceof StudySlidesRequestError
                    ? store.page.error.status
                    : undefined;
            return (
                <div
                    className="alert alert-warning"
                    role="alert"
                    data-testid="study-slides-error"
                >
                    {status === 401
                        ? 'Sign in to view pathology slides.'
                        : "Pathology slides couldn't be loaded."}{' '}
                    <button
                        className="btn btn-default btn-xs"
                        onClick={store.reload}
                    >
                        Retry
                    </button>
                </div>
            );
        }

        const page = store.page.result;
        if (!page) {
            return <LoadingIndicator isLoading={true} center={true} />;
        }

        const selected = store.selected;
        const innerHeight = height - 2;

        return (
            <div
                data-testid="study-slides-tab"
                style={{
                    display: 'flex',
                    height,
                    border: `1px solid ${C.border}`,
                    borderRadius: 3,
                    overflow: 'hidden',
                    fontFamily: WSI_FONT_FAMILY,
                    fontSize: 13,
                    color: C.text,
                    background: '#fff',
                }}
            >
                {listCollapsed ? (
                    <WsiCollapsedRail
                        side="left"
                        title="Patients"
                        showLabel="Show patient list (\)"
                        onExpand={() => setListCollapsed(false)}
                        background={C.navBg}
                        testId="study-slides-rail"
                    >
                        <IconButton
                            icon="fa-chevron-up"
                            label="Previous patient ([)"
                            disabled={!store.hasPrevious}
                            onClick={store.selectPrevious}
                            testId="study-slides-rail-previous"
                        />
                        <IconButton
                            icon="fa-chevron-down"
                            label="Next patient (])"
                            disabled={!store.hasNext}
                            onClick={store.selectNext}
                            testId="study-slides-rail-next"
                        />
                    </WsiCollapsedRail>
                ) : (
                    <PatientPanel
                        store={store}
                        onHide={() => setListCollapsed(true)}
                    />
                )}

                <div
                    style={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        flexDirection: 'column',
                    }}
                >
                    {selected ? (
                        <>
                            <ViewerToolbar store={store} />
                            <AppWsiViewer
                                studyId={selected.studyId}
                                patientId={selected.patientId}
                                tileServerUrl={tileServerUrl}
                                userName={userName}
                                height={innerHeight - TOOLBAR_HEIGHT - 1}
                                initialStainFilter={viewerStainFilter(
                                    store.stainGroups
                                )}
                                initialMatchFilter={viewerMatchFilter(
                                    store.matchLevels
                                )}
                                requestedSlideKey={store.requestedSlideKey}
                            />
                        </>
                    ) : (
                        <div
                            style={{
                                flex: 1,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: C.muted,
                                background: '#e8e8e8',
                            }}
                        >
                            {page.totalPatients === 0
                                ? 'No pathology slides in the current selection.'
                                : 'Select a patient to view their slides.'}
                        </div>
                    )}
                </div>
            </div>
        );
    }
);

export default StudyPathologySlidesTab;
