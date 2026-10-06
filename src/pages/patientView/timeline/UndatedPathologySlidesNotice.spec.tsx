/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import UndatedPathologySlidesNotice, {
    undatedPathologySlidesMessage,
    undatedPathologySlidesPath,
} from './UndatedPathologySlidesNotice';

// react-router 5 typings predate React 18's implicit-children removal.
const TestRouter = MemoryRouter as React.ComponentType<
    React.PropsWithChildren<{}>
>;

function renderNotice(count: number) {
    return render(
        <TestRouter>
            <UndatedPathologySlidesNotice
                studyId="mskimpact"
                patientId="P-0000081"
                count={count}
            />
        </TestRouter>
    );
}

describe('UndatedPathologySlidesNotice', () => {
    it('links to the undated slides when there are some', () => {
        renderNotice(2);
        const link = screen.getByRole('link', {
            name: 'View undated slides',
        });
        expect(link.getAttribute('href')).toBe(
            '/patient/wsiHESlides?studyId=mskimpact&caseId=P-0000081&pathologySlideSettings=%7B%22timepointDays%22%3A%22undated%22%7D'
        );
        expect(
            screen.getByText(/2 viewable pathology slides have no procedure/)
        ).toBeTruthy();
    });

    it('renders nothing when there are none', () => {
        const { container } = renderNotice(0);
        expect(container.textContent).toBe('');
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
            '/patient/wsiHESlides?studyId=s+1&caseId=P%261&pathologySlideSettings=%7B%22timepointDays%22%3A%22undated%22%7D'
        );
    });
});
