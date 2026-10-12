import * as React from 'react';
import { observer } from 'mobx-react';
import { Nav, NavItem } from 'react-bootstrap';
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
import { PaginationControls } from 'shared/components/paginationControls/PaginationControls';
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

/** Height of the bar holding the view pills and the patient navigation. */
const BAR_HEIGHT = 40;

/** Browser-stored hidden state of the patient list. */
export const PATIENT_LIST_COLLAPSED_KEY = 'wsi.study.patientListCollapsed';

const C = WSI_THEME;
const PANEL_WIDTH = 280;

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
                <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
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
            <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>
                {count(patient.slideCount, 'slide')}
            </div>
        </li>
    );
};

/** Pages the patient list with the portal's pager, laid out like the slide table's. */
const PatientPager: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
}> = observer(({ store }) => {
    const lastPage = store.pageCount - 1;
    const isFirstPage = store.pageNumber === 0;
    const isLastPage = store.pageNumber >= lastPage;
    const { first, last } = store.displayedRange;
    const selectedElsewhere =
        store.selectedPageNumber !== undefined &&
        store.selectedPageNumber !== store.pageNumber;
    return (
        <div
            data-testid="study-slides-pages"
            style={{
                flexShrink: 0,
                borderTop: `1px solid ${C.border}`,
                padding: '6px 8px',
                textAlign: 'center',
            }}
        >
            <PaginationControls
                className="study-slides-pager"
                style={{ display: 'inline-block' }}
                totalItems={store.totalPatients}
                itemsPerPage={store.pageSize}
                showItemsPerPageSelector={false}
                showAllOption={false}
                showMoreButton={false}
                showFirstPage={true}
                showLastPage={true}
                hidePaginationIfOnePage={false}
                textBetweenButtons={
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
                }
                firstPageDisabled={isFirstPage}
                previousPageDisabled={isFirstPage}
                nextPageDisabled={isLastPage}
                lastPageDisabled={isLastPage}
                onFirstPageClick={() => store.setPageNumber(0)}
                onPreviousPageClick={() =>
                    store.setPageNumber(store.pageNumber - 1)
                }
                onNextPageClick={() =>
                    store.setPageNumber(store.pageNumber + 1)
                }
                onLastPageClick={() => store.setPageNumber(lastPage)}
            />
            {selectedElsewhere && (
                <div style={{ marginTop: 4 }}>
                    <button
                        type="button"
                        className="btn btn-link btn-xs"
                        data-testid="study-slides-go-selected"
                        onClick={store.goToSelectedPage}
                        style={{ padding: 0, fontSize: 12 }}
                    >
                        Go to selected patient
                    </button>
                </div>
            )}
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
    const filtering = store.hasSlideFilters || store.clinicalFilters.length > 0;

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
                    style={{ fontSize: 12, color: C.muted, marginTop: 2 }}
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
                    style={{ color: C.muted, fontSize: 12, padding: 12 }}
                >
                    {filtering
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

/** The selected patient, with previous/next and a link to the patient's own page. */
const PatientNav: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
}> = observer(({ store }) => {
    const selected = store.selected;
    const page = store.page.result;
    if (!selected || !page) {
        return null;
    }
    const listed = page.patients.find(p => isSamePatient(p, selected));
    const navPatients = page.patients.map(p => ({
        studyId: p.studyId,
        patientId: p.patientId,
    }));
    return (
        <div
            data-testid="study-slides-nav"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
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
                <span style={{ color: C.muted }}>
                    {count(listed.slideCount, 'slide')}
                </span>
            )}
            <span style={{ color: C.border }}>|</span>
            <a
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

const VIEWS: { id: StudySlidesView; label: string }[] = [
    { id: 'viewer', label: 'Viewer' },
    { id: 'table', label: 'Slide table' },
];

/** The view pills, as on the portal's other tabs, with the patient navigation beside them. */
const StudySlidesBar: React.FunctionComponent<{
    store: StudyPathologySlidesStore;
    showViews: boolean;
}> = observer(({ store, showViews }) => (
    <div
        className="pillTabs"
        style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            height: BAR_HEIGHT,
            fontSize: 13,
        }}
    >
        {showViews && (
            <Nav
                bsStyle="pills"
                activeKey={store.view}
                onSelect={(key: any) => store.setView(key as StudySlidesView)}
                style={{ marginBottom: 0, flexShrink: 0 }}
            >
                {VIEWS.map(view => (
                    <NavItem
                        key={view.id}
                        eventKey={view.id}
                        data-testid={`study-slides-view-${view.id}`}
                        aria-pressed={store.view === view.id}
                    >
                        {view.label}
                    </NavItem>
                ))}
            </Nav>
        )}
        {store.view === 'viewer' && <PatientNav store={store} />}
    </div>
));

/**
 * The study's pathology slides, as patients beside the slide viewer or as the cohort's slide table
 * (one row per slide, with column filters, sorting and download). A table row's View opens that
 * slide in the viewer.
 */
export const StudyPathologySlidesTab: React.FunctionComponent<StudyPathologySlidesTabProps> = observer(
    props => {
        const { store, slideTable, height } = props;
        const showTable = !!slideTable && store.view === 'table';
        return (
            <div data-testid="study-slides-views">
                <StudySlidesBar store={store} showViews={!!slideTable} />
                {showTable ? (
                    <div data-testid="study-slides-table">{slideTable}</div>
                ) : (
                    <StudySlidesViewerView
                        {...props}
                        height={height - BAR_HEIGHT}
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
                        <AppWsiViewer
                            studyId={selected.studyId}
                            patientId={selected.patientId}
                            tileServerUrl={tileServerUrl}
                            userName={userName}
                            height={innerHeight}
                            initialStainFilter={viewerStainFilter(
                                store.stainGroups
                            )}
                            initialMatchFilter={viewerMatchFilter(
                                store.matchLevels
                            )}
                            requestedSlideKey={store.requestedSlideKey}
                        />
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
