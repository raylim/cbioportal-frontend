/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StudyViewFilter } from 'cbioportal-ts-api-client';
import { StudyPathologySlidesStore } from './StudyPathologySlidesStore';
import { StudyPathologySlidesTab } from './StudyPathologySlidesTab';
import {
    StudySlidePatient,
    StudySlidesPage,
    StudySlidesRequest,
    StudySlidesRequestError,
} from './studySlidesApi';

const mockViewer = jest.fn((_props: Record<string, unknown>) => null);

jest.mock('shared/components/wsiViewer/wsiAppConfig', () => ({
    AppWsiViewer: (props: Record<string, unknown>) => mockViewer(props),
}));

jest.mock('shared/api/urls', () => ({
    buildCBioPortalAPIUrl: (path: string) => `/${path}`,
    getPatientViewUrlWithPathname: (
        studyId: string,
        caseId: string,
        pathname: string,
        navIds?: { studyId: string; patientId: string }[]
    ) =>
        `/${pathname}?studyId=${studyId}&caseId=${caseId}` +
        (navIds
            ? `#navCaseIds=${navIds
                  .map(id => `${id.studyId}:${id.patientId}`)
                  .join(',')}`
            : ''),
}));

const PATIENTS: StudySlidePatient[] = ['P-1', 'P-2', 'P-3'].map(id => ({
    studyId: 'study',
    patientId: id,
    slideCount: 2,
    stainGroupCounts: { 'H&E': 1, IHC: 1, Other: 0, Unknown: 0 },
}));

function pageFor(
    request: StudySlidesRequest,
    patients = PATIENTS
): StudySlidesPage {
    const located = patients.findIndex(
        p => p.patientId === request.locatePatientId
    );
    return {
        totalPatients: patients.length,
        totalSlides: patients.length * 2,
        stainGroupTotals: { 'H&E': 3, IHC: 3, Other: 0, Unknown: 0 },
        locatedIndex: located >= 0 ? located : null,
        pageNumber: request.pageNumber ?? 0,
        pageSize: request.pageSize ?? 50,
        patients,
    };
}

/**
 * A rejected request. MobxPromise attaches its handler a tick later, so the
 * rejection is marked handled here to keep Jest from reporting it.
 */
function failedRequest(error: Error): Promise<StudySlidesPage> {
    const request = Promise.reject(error);
    request.catch(() => undefined);
    return request;
}

function listed(patientId: string) {
    return within(screen.getByTestId('study-slides-patients')).getByText(
        patientId
    );
}

async function settle() {
    await act(async () => {
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    });
}

function renderTab(
    fetchPage: (request: StudySlidesRequest) => Promise<StudySlidesPage>,
    isActive = true,
    pageSize?: number
) {
    const store = new StudyPathologySlidesStore({
        getFilters: () => ({ studyIds: ['study'] } as StudyViewFilter),
        getStudyIds: () => ['study'],
        fetchPage,
        pageSize,
    });
    const view = render(
        <StudyPathologySlidesTab
            store={store}
            tileServerUrl="https://tiles.example"
            isActive={isActive}
            height={600}
        />
    );
    return { store, view };
}

/** Seven patients served two per page. */
const MANY = Array.from({ length: 7 }, (_, i) => ({
    ...PATIENTS[0],
    patientId: `M-${i + 1}`,
}));

function pagedFor(request: StudySlidesRequest): StudySlidesPage {
    const pageNumber = request.pageNumber ?? 0;
    const pageSize = request.pageSize ?? 50;
    return {
        ...pageFor(request, MANY),
        patients: MANY.slice(
            pageNumber * pageSize,
            (pageNumber + 1) * pageSize
        ),
    };
}

describe('StudyPathologySlidesTab', () => {
    beforeEach(() => {
        mockViewer.mockClear();
        window.localStorage.clear();
        // Most cases use the filters, which start closed.
        window.localStorage.setItem('wsi.study.filtersOpen', '1');
    });

    it('lists the cohort and shows the first patient in the viewer', async () => {
        const { store } = renderTab(async r => pageFor(r));
        await settle();

        expect(
            screen.getByTestId('study-slides-patient-count').textContent
        ).toBe('3');
        expect(screen.getByTestId('study-slides-summary').textContent).toBe(
            '6 viewable slides'
        );
        const rows = screen.getAllByTestId('study-slides-patient');
        expect(rows).toHaveLength(3);
        expect(within(rows[1]).getByTitle('H&E: 1')).toBeTruthy();
        expect(within(rows[1]).getByTitle('IHC: 1')).toBeTruthy();
        expect(within(rows[1]).getByText('2 slides')).toBeTruthy();
        expect(screen.getByTestId('study-slides-position').textContent).toBe(
            'P-1 · 1 of 3'
        );
        expect(mockViewer).toHaveBeenLastCalledWith(
            expect.objectContaining({
                studyId: 'study',
                patientId: 'P-1',
                tileServerUrl: 'https://tiles.example',
                initialStainFilter: 'all',
            })
        );
        store.dispose();
    });

    it('switches between the viewer and the slide table, and opens a table slide', async () => {
        const store = new StudyPathologySlidesStore({
            getFilters: () => ({ studyIds: ['study'] } as StudyViewFilter),
            getStudyIds: () => ['study'],
            fetchPage: async r => pageFor(r),
        });
        render(
            <StudyPathologySlidesTab
                store={store}
                tileServerUrl="https://tiles.example"
                isActive={true}
                height={600}
                slideTable={
                    <button
                        data-testid="fake-slide-row"
                        onClick={() =>
                            store.openSlide(
                                { studyId: 'study', patientId: 'P-2' },
                                'slide-of-p2'
                            )
                        }
                    />
                }
            />
        );
        await settle();
        expect(screen.queryByTestId('study-slides-table')).toBeNull();
        expect(screen.getByTestId('study-slides-tab')).toBeTruthy();

        fireEvent.click(screen.getByTestId('study-slides-view-table'));
        expect(screen.getByTestId('study-slides-table')).toBeTruthy();
        expect(screen.queryByTestId('study-slides-tab')).toBeNull();

        fireEvent.click(screen.getByTestId('fake-slide-row'));
        await settle();
        expect(screen.queryByTestId('study-slides-table')).toBeNull();
        expect(mockViewer).toHaveBeenLastCalledWith(
            expect.objectContaining({
                patientId: 'P-2',
                requestedSlideKey: 'slide-of-p2',
            })
        );
        store.dispose();
    });

    it('switches the viewer patient from the list, buttons and keys', async () => {
        const { store } = renderTab(async r => pageFor(r));
        await settle();

        fireEvent.click(listed('P-3'));
        expect(mockViewer).toHaveBeenLastCalledWith(
            expect.objectContaining({ patientId: 'P-3' })
        );

        fireEvent.click(screen.getByTestId('study-slides-previous'));
        expect(store.selected?.patientId).toBe('P-2');

        fireEvent.keyDown(document, { key: ']' });
        expect(store.selected?.patientId).toBe('P-3');
        fireEvent.keyDown(document, { key: '[' });
        expect(store.selected?.patientId).toBe('P-2');

        fireEvent.keyDown(screen.getByTestId('study-slides-patients'), {
            key: 'ArrowUp',
        });
        expect(store.selected?.patientId).toBe('P-1');
        expect(
            listed('P-1')
                .closest('li')!
                .getAttribute('aria-selected')
        ).toBe('true');
        store.dispose();
    });

    it('ignores the shortcuts while typing or when the tab is hidden', async () => {
        const { store, view } = renderTab(async r => pageFor(r));
        await settle();

        fireEvent.keyDown(screen.getByTestId('study-slides-search'), {
            key: ']',
        });
        expect(store.selected?.patientId).toBe('P-1');

        view.rerender(
            <StudyPathologySlidesTab
                store={store}
                tileServerUrl="https://tiles.example"
                isActive={false}
                height={600}
            />
        );
        fireEvent.keyDown(document, { key: ']' });
        expect(store.selected?.patientId).toBe('P-1');
        store.dispose();
    });

    it('filters by stain group and passes one group to the viewer', async () => {
        const requests: StudySlidesRequest[] = [];
        const { store } = renderTab(async r => {
            requests.push(r);
            return pageFor(r);
        });
        await settle();

        fireEvent.click(screen.getByTestId('study-slides-stain-IHC'));
        await settle();

        expect(requests[requests.length - 1].stainGroups).toEqual(['IHC']);
        expect(
            screen
                .getByTestId('study-slides-stain-IHC')
                .getAttribute('aria-pressed')
        ).toBe('true');
        expect(mockViewer).toHaveBeenLastCalledWith(
            expect.objectContaining({ initialStainFilter: 'ihc' })
        );
        store.dispose();
    });

    it('links to the patient view with the listed patients as navigation', async () => {
        const { store } = renderTab(async r => pageFor(r));
        await settle();

        expect(
            screen.getByTestId('study-slides-open-patient').getAttribute('href')
        ).toBe(
            '/patient/wsiHESlides?studyId=study&caseId=P-1' +
                '#navCaseIds=study:P-1,study:P-2,study:P-3'
        );
        store.dispose();
    });

    it('explains an empty cohort', async () => {
        const { store } = renderTab(async r => pageFor(r, []));
        await settle();

        expect(screen.getByTestId('study-slides-empty').textContent).toBe(
            'No pathology slides in the current selection.'
        );
        expect(mockViewer).not.toHaveBeenCalled();
        store.dispose();
    });

    it('asks anonymous users to sign in, and retries other failures', async () => {
        const unauthorized = renderTab(() =>
            failedRequest(new StudySlidesRequestError(401))
        );
        await settle();
        expect(screen.getByTestId('study-slides-error').textContent).toContain(
            'Sign in to view pathology slides.'
        );
        unauthorized.store.dispose();
        unauthorized.view.unmount();

        let fail = true;
        const { store } = renderTab(r =>
            fail
                ? failedRequest(new StudySlidesRequestError(500))
                : Promise.resolve(pageFor(r))
        );
        await settle();
        expect(screen.getByTestId('study-slides-error').textContent).toContain(
            "Pathology slides couldn't be loaded."
        );

        fail = false;
        fireEvent.click(screen.getByText('Retry'));
        await settle();
        expect(screen.getAllByTestId('study-slides-patient')).toHaveLength(3);
        store.dispose();
    });

    it('hides the patient list into a rail that still steps through patients', async () => {
        const { store, view } = renderTab(async r => pageFor(r));
        await settle();

        fireEvent.click(screen.getByTestId('study-slides-hide'));
        expect(screen.queryByTestId('study-slides-patient-panel')).toBeNull();
        expect(screen.getByTestId('study-slides-rail')).toBeTruthy();
        expect(
            window.localStorage.getItem('wsi.study.patientListCollapsed')
        ).toBe('1');

        fireEvent.click(screen.getByTestId('study-slides-rail-next'));
        expect(store.selected?.patientId).toBe('P-2');

        // The hidden state is remembered for the next visit.
        view.unmount();
        store.dispose();
        const again = renderTab(async r => pageFor(r));
        await settle();
        expect(screen.getByTestId('study-slides-rail')).toBeTruthy();

        fireEvent.click(screen.getByTestId('study-slides-rail-expand'));
        expect(screen.getByTestId('study-slides-patient-panel')).toBeTruthy();
        expect(
            window.localStorage.getItem('wsi.study.patientListCollapsed')
        ).toBeNull();
        again.store.dispose();
    });

    it('toggles the patient list with the backslash key', async () => {
        const { store } = renderTab(async r => pageFor(r));
        await settle();

        fireEvent.keyDown(document, { key: '\\' });
        expect(screen.getByTestId('study-slides-rail')).toBeTruthy();
        fireEvent.keyDown(document, { key: '\\' });
        expect(screen.getByTestId('study-slides-patient-panel')).toBeTruthy();
        store.dispose();
    });

    it('answers a page click at once and shows the page when it arrives', async () => {
        let release: (() => void) | undefined;
        const { store } = renderTab(
            r =>
                r.pageNumber
                    ? new Promise(resolve => {
                          release = () => resolve(pagedFor(r));
                      })
                    : Promise.resolve(pagedFor(r)),
            true,
            2
        );
        await settle();
        expect(screen.getByTestId('study-slides-range').textContent).toBe(
            '1–2 of 7'
        );
        const list = screen.getByTestId('study-slides-patients');
        list.scrollTop = 40;

        fireEvent.click(screen.getByLabelText('Next page of patients'));
        await settle();
        // Before the page arrives: the new range, a spinner and a busy list.
        expect(screen.getByTestId('study-slides-range').textContent).toBe(
            '3–4 of 7'
        );
        expect(screen.getByLabelText('Loading patients')).toBeTruthy();
        expect(list.getAttribute('aria-busy')).toBe('true');

        await act(async () => release!());
        await settle();
        expect(listed('M-3')).toBeTruthy();
        expect(screen.queryByLabelText('Loading patients')).toBeNull();
        expect(screen.getByTestId('study-slides-patients').scrollTop).toBe(0);
        // The viewer keeps the selected patient from the first page.
        expect(store.selected?.patientId).toBe('M-1');

        fireEvent.click(screen.getByTestId('study-slides-go-selected'));
        await settle();
        expect(listed('M-1')).toBeTruthy();
        expect(screen.queryByTestId('study-slides-go-selected')).toBeNull();
        store.dispose();
    });

    it('jumps to the first, last and a typed page', async () => {
        const { store } = renderTab(async r => pagedFor(r), true, 2);
        await settle();

        fireEvent.click(screen.getByLabelText('Last page of patients'));
        await settle();
        expect(screen.getByTestId('study-slides-range').textContent).toBe(
            '7–7 of 7'
        );
        expect(listed('M-7')).toBeTruthy();

        fireEvent.change(screen.getByTestId('study-slides-page-input'), {
            target: { value: '2' },
        });
        fireEvent.submit(
            screen.getByTestId('study-slides-page-input').closest('form')!
        );
        await settle();
        expect(listed('M-3')).toBeTruthy();

        fireEvent.click(screen.getByLabelText('First page of patients'));
        await settle();
        expect(listed('M-1')).toBeTruthy();
        store.dispose();
    });

    it('filters by specimen match and passes one level to the viewer', async () => {
        const requests: StudySlidesRequest[] = [];
        const { store } = renderTab(async r => {
            requests.push(r);
            return pageFor(r);
        });
        await settle();

        fireEvent.click(screen.getByTestId('study-slides-match-UNMATCHED'));
        await settle();

        expect(requests[requests.length - 1].matchLevels).toEqual([
            'UNMATCHED',
        ]);
        expect(mockViewer).toHaveBeenLastCalledWith(
            expect.objectContaining({ initialMatchFilter: 'unmatched' })
        );
        expect(
            screen.getByTestId('study-slides-chip-match-UNMATCHED')
        ).toBeTruthy();

        fireEvent.click(screen.getByTestId('study-slides-clear-filters'));
        await settle();
        expect(requests[requests.length - 1].matchLevels).toEqual([]);
        store.dispose();
    });

    it('starts with the filters closed and counts active filters', async () => {
        window.localStorage.removeItem('wsi.study.filtersOpen');
        const { store } = renderTab(async r => pageFor(r));
        await settle();
        act(() => store.toggleStainGroup('IHC'));

        expect(screen.queryByTestId('study-slides-filters')).toBeNull();
        expect(
            screen.getByTestId('study-slides-filters-toggle').textContent
        ).toContain('1 active');
        fireEvent.click(screen.getByTestId('study-slides-filters-toggle'));
        expect(screen.getByTestId('study-slides-filters')).toBeTruthy();
        expect(window.localStorage.getItem('wsi.study.filtersOpen')).toBe('1');
        store.dispose();
    });
});
