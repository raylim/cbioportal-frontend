import { render, screen } from '@testing-library/react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { levelIconClassNames } from '../../util/OncoKbUtils';
import LevelIcon from './LevelIcon';

jest.mock('rc-tooltip', () => {
    const React = require('react');
    return function MockTooltip(props: {
        children: React.ReactNode;
        overlay: React.ReactElement;
    }) {
        return (
            <div
                data-testid="mock-tooltip"
                data-overlay-html={renderToStaticMarkup(props.overlay)}
            >
                {props.children}
            </div>
        );
    };
});

describe('LevelIcon', () => {
    it('renders the shared level description in the tooltip overlay', () => {
        const { container } = render(<LevelIcon level="1" />);
        const overlayHtml = screen
            .getByTestId('mock-tooltip')
            .getAttribute('data-overlay-html');
        const icon = container.querySelector('i');

        expect(icon).toBeTruthy();
        expect(icon?.getAttribute('class')).toContain(levelIconClassNames('1'));
        expect(overlayHtml).toContain('FDA-recognized');
        expect(overlayHtml).toContain('FDA-approved drug');
    });
});
