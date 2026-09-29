/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import UndatedPathologySlidesNotice, {
    undatedPathologySlidesMessage,
    undatedPathologySlidesPath,
} from './UndatedPathologySlidesNotice';

const mockFetchCount = jest.fn();

jest.mock('cbioportal-wsi-viewer', () => ({
    fetchUndatedViewableSlideCount: (...args: unknown[]) =>
        mockFetchCount(...args),
}));

jest.mock('shared/components/wsiViewer/wsiAppConfig', () => ({
    buildWsiViewerConfig: (userName?: string) => ({ authScope: userName }),
}));

// react-router 5 typings predate React 18's implicit-children removal.
const TestRouter = MemoryRouter as React.ComponentType<
    React.PropsWithChildren<{}>
>;

function renderNotice() {
    return render(
        <TestRouter>
            <UndatedPathologySlidesNotice
                studyId="mskimpact"
                patientId="P-0000081"
                userName="user"
            />
        </TestRouter>
    );
}

describe('UndatedPathologySlidesNotice', () => {
    beforeEach(() => mockFetchCount.mockReset());

    it('links to the undated slides when there are some', async () => {
        mockFetchCount.mockResolvedValue(2);
        renderNotice();
        const link = await screen.findByRole('link', {
            name: 'View undated slides',
        });
        expect(link.getAttribute('href')).toBe(
            '/patient/wsiHESlides?studyId=mskimpact&caseId=P-0000081&timepointDays=undated'
        );
        expect(
            screen.getByText(/2 viewable pathology slides have no procedure/)
        ).toBeTruthy();
        expect(mockFetchCount).toHaveBeenCalledWith(
            { authScope: 'user' },
            'mskimpact',
            'P-0000081',
            expect.anything()
        );
    });

    it('renders nothing when there are none or the hierarchy fails', async () => {
        mockFetchCount.mockResolvedValueOnce(0);
        const { container, unmount } = renderNotice();
        await waitFor(() => expect(mockFetchCount).toHaveBeenCalled());
        expect(container.textContent).toBe('');
        unmount();

        mockFetchCount.mockRejectedValueOnce(new Error('500'));
        const failed = renderNotice();
        await waitFor(() => expect(mockFetchCount).toHaveBeenCalledTimes(2));
        expect(failed.container.textContent).toBe('');
    });
});

describe('undated pathology slides helpers', () => {
    it('words the message for one or several slides', () => {
        expect(undatedPathologySlidesMessage(1)).toBe(
            '1 viewable pathology slide has no procedure date, so it is not shown on the timeline.'
        );
        expect(undatedPathologySlidesMessage(3)).toMatch(
            /^3 viewable pathology slides have no procedure date, so they are/
        );
    });

    it('encodes the tab path', () => {
        expect(undatedPathologySlidesPath('s 1', 'P&1')).toBe(
            '/patient/wsiHESlides?studyId=s+1&caseId=P%261&timepointDays=undated'
        );
    });
});
