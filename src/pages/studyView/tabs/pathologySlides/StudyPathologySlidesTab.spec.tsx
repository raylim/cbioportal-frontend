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
    viewableSlideCount: id === 'P-2' ? 1 : 2,
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
        totalViewableSlides: patients.length * 2 - 1,
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
    isActive = true
) {
    const store = new StudyPathologySlidesStore({
        getFilters: () => ({ studyIds: ['study'] } as StudyViewFilter),
        getStudyIds: () => ['study'],
        fetchPage,
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

describe('StudyPathologySlidesTab', () => {
    beforeEach(() => mockViewer.mockClear());

    it('lists the cohort and shows the first patient in the viewer', async () => {
        const { store } = renderTab(async r => pageFor(r));
        await settle();

        expect(screen.getByTestId('study-slides-summary').textContent).toBe(
            '3 patients · 6 slides (5 viewable)'
        );
        expect(screen.getAllByTestId('study-slides-patient')).toHaveLength(3);
        expect(
            screen.getByText('2 slides (1 viewable) · H&E 1 · IHC 1')
        ).toBeTruthy();
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
});
