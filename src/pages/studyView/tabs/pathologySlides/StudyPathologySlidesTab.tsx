import * as React from 'react';
import { observer } from 'mobx-react';
import { getPatientViewUrlWithPathname } from 'shared/api/urls';
import LoadingIndicator from 'shared/components/loadingIndicator/LoadingIndicator';
import { AppWsiViewer } from 'shared/components/wsiViewer/wsiAppConfig';
import {
    isSamePatient,
    StudyPathologySlidesStore,
} from './StudyPathologySlidesStore';
import {
    STUDY_SLIDE_STAIN_GROUPS,
    StudySlidePatient,
    StudySlidesRequestError,
    StudySlideStainGroup,
    viewerStainFilter,
} from './studySlidesApi';

export interface StudyPathologySlidesTabProps {
    store: StudyPathologySlidesStore;
    tileServerUrl: string;
    /** Keyboard shortcuts are active only while the tab is shown. */
    isActive: boolean;
    height: number;
    userName?: string;
}

const LIST_WIDTH = 260;

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

function count(n: number, noun: string): string {
    return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

function stainSummary(patient: StudySlidePatient): string {
    return (STUDY_SLIDE_STAIN_GROUPS as StudySlideStainGroup[])
        .filter(group => patient.stainGroupCounts[group] > 0)
        .map(group => `${group} ${patient.stainGroupCounts[group]}`)
        .join(' · ');
}

/**
 * Study-view Pathology Slides tab: the cohort's patients with slides on the
 * left, and the selected patient's slides in the viewer on the right.
 */
export const StudyPathologySlidesTab: React.FunctionComponent<StudyPathologySlidesTabProps> = observer(
    ({ store, tileServerUrl, isActive, height, userName }) => {
        const listRef = React.useRef<HTMLUListElement>(null);

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
                }
            };
            document.addEventListener('keydown', onKeyDown);
            return () => document.removeEventListener('keydown', onKeyDown);
        }, [isActive, store]);

        const selected = store.selected;
        React.useEffect(() => {
            if (!selected || !listRef.current) {
                return;
            }
            const option = listRef.current.querySelector(
                `[id="${patientOptionId(selected)}"]`
            ) as HTMLElement | null;
            option?.scrollIntoView?.({ block: 'nearest' });
        }, [selected, store.page.result]);

        const page = store.page.result;
        const filtering =
            store.stainGroups.length > 0 || store.patientIdPrefix !== '';

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

        if (!page) {
            return <LoadingIndicator isLoading={true} center={true} />;
        }

        const pageStart = page.pageNumber * page.pageSize;
        const navPatients = page.patients.map(p => ({
            studyId: p.studyId,
            patientId: p.patientId,
        }));

        return (
            <div data-testid="study-slides-tab">
                <div
                    style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 8,
                    }}
                >
                    <strong data-testid="study-slides-summary">
                        {count(page.totalPatients, 'patient')} ·{' '}
                        {count(page.totalSlides, 'slide')} (
                        {page.totalViewableSlides.toLocaleString()} viewable)
                    </strong>
                    <span style={{ color: '#666' }}>
                        in the current selection
                    </span>
                    <span
                        role="group"
                        aria-label="Stain groups"
                        style={{ display: 'inline-flex', gap: 4 }}
                    >
                        {(STUDY_SLIDE_STAIN_GROUPS as StudySlideStainGroup[]).map(
                            group => {
                                const active = store.stainGroups.includes(
                                    group
                                );
                                return (
                                    <button
                                        key={group}
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
                                        {group} (
                                        {page.stainGroupTotals[
                                            group
                                        ].toLocaleString()}
                                        )
                                    </button>
                                );
                            }
                        )}
                    </span>
                </div>

                <div style={{ display: 'flex', gap: 12 }}>
                    <div
                        style={{
                            width: LIST_WIDTH,
                            flex: `0 0 ${LIST_WIDTH}px`,
                            display: 'flex',
                            flexDirection: 'column',
                            height,
                        }}
                    >
                        <input
                            type="search"
                            className="form-control input-sm"
                            placeholder="Find patient ID"
                            aria-label="Find patient ID"
                            data-testid="study-slides-search"
                            value={store.searchText}
                            onChange={e => store.setSearchText(e.target.value)}
                            style={{ marginBottom: 6 }}
                        />
                        {page.patients.length === 0 ? (
                            <div
                                style={{ color: '#666', padding: 8 }}
                                data-testid="study-slides-empty"
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
                                aria-activedescendant={
                                    selected
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
                                    padding: 0,
                                    overflowY: 'auto',
                                    flex: 1,
                                    border: '1px solid #ddd',
                                    borderRadius: 3,
                                }}
                            >
                                {page.patients.map(patient => {
                                    const isSelected = isSamePatient(
                                        patient,
                                        selected
                                    );
                                    return (
                                        <li
                                            key={patientOptionId(patient)}
                                            id={patientOptionId(patient)}
                                            role="option"
                                            aria-selected={isSelected}
                                            data-testid="study-slides-patient"
                                            onClick={() =>
                                                store.selectPatient(patient)
                                            }
                                            style={{
                                                cursor: 'pointer',
                                                padding: '4px 8px',
                                                borderBottom: '1px solid #eee',
                                                background: isSelected
                                                    ? '#e6f0fa'
                                                    : undefined,
                                                fontWeight: isSelected
                                                    ? 600
                                                    : undefined,
                                            }}
                                        >
                                            <div>{patient.patientId}</div>
                                            <div
                                                style={{
                                                    fontSize: 11,
                                                    color: '#666',
                                                    fontWeight: 'normal',
                                                }}
                                            >
                                                {count(
                                                    patient.slideCount,
                                                    'slide'
                                                )}
                                                {patient.viewableSlideCount <
                                                patient.slideCount
                                                    ? ` (${patient.viewableSlideCount} viewable)`
                                                    : ''}
                                                {' · '}
                                                {stainSummary(patient)}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                        {page.totalPatients > page.pageSize && (
                            <div
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    marginTop: 6,
                                }}
                                data-testid="study-slides-pages"
                            >
                                <button
                                    className="btn btn-default btn-xs"
                                    aria-label="Previous page of patients"
                                    disabled={store.pageNumber === 0}
                                    onClick={() =>
                                        store.setPageNumber(
                                            store.pageNumber - 1
                                        )
                                    }
                                >
                                    ‹
                                </button>
                                <span style={{ fontSize: 12 }}>
                                    {pageStart + 1}–
                                    {pageStart + page.patients.length} of{' '}
                                    {page.totalPatients.toLocaleString()}
                                </span>
                                <button
                                    className="btn btn-default btn-xs"
                                    aria-label="Next page of patients"
                                    disabled={
                                        store.pageNumber >= store.pageCount - 1
                                    }
                                    onClick={() =>
                                        store.setPageNumber(
                                            store.pageNumber + 1
                                        )
                                    }
                                >
                                    ›
                                </button>
                            </div>
                        )}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                        {selected ? (
                            <>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        marginBottom: 6,
                                    }}
                                    data-testid="study-slides-nav"
                                >
                                    <button
                                        className="btn btn-default btn-xs"
                                        disabled={!store.hasPrevious}
                                        onClick={store.selectPrevious}
                                        title="Previous patient ([)"
                                        data-testid="study-slides-previous"
                                    >
                                        ◀ Previous
                                    </button>
                                    <span data-testid="study-slides-position">
                                        <strong>{selected.patientId}</strong>
                                        {store.selectedIndex !== undefined &&
                                            ` · ${(
                                                store.selectedIndex + 1
                                            ).toLocaleString()} of ${page.totalPatients.toLocaleString()}`}
                                    </span>
                                    <button
                                        className="btn btn-default btn-xs"
                                        disabled={!store.hasNext}
                                        onClick={store.selectNext}
                                        title="Next patient (])"
                                        data-testid="study-slides-next"
                                    >
                                        Next ▶
                                    </button>
                                    <a
                                        style={{ marginLeft: 'auto' }}
                                        href={getPatientViewUrlWithPathname(
                                            selected.studyId,
                                            selected.patientId,
                                            'patient/wsiHESlides',
                                            navPatients.some(p =>
                                                isSamePatient(p, selected)
                                            )
                                                ? navPatients
                                                : undefined
                                        )}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        data-testid="study-slides-open-patient"
                                    >
                                        Open in patient view ↗
                                    </a>
                                </div>
                                <AppWsiViewer
                                    studyId={selected.studyId}
                                    patientId={selected.patientId}
                                    tileServerUrl={tileServerUrl}
                                    userName={userName}
                                    height={height - 32}
                                    initialStainFilter={viewerStainFilter(
                                        store.stainGroups
                                    )}
                                />
                            </>
                        ) : (
                            <div style={{ color: '#666', padding: 8 }}>
                                Select a patient to view their slides.
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }
);

export default StudyPathologySlidesTab;
