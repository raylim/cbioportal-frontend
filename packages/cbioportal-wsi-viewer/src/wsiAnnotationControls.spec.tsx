/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { WsiAnnotationController } from './wsiAnnotationController';
import { WsiAnnotationPanel } from './wsiAnnotationControls';

function controllerWith(items: any[]): WsiAnnotationController {
    const controller = new WsiAnnotationController(
        'https://tiles.example',
        'study1'
    );
    (controller as any).slideKey = '0123456789ab';
    (controller as any).annotations = items.map(item =>
        (controller as any).fromApi(item, '0123456789ab')
    );
    return controller;
}

function apiItem(id: string, body: Record<string, unknown>) {
    return {
        id,
        body: { label: id, layer_name: 'Default', color: '#ef4444', ...body },
        target: {
            selector: { type: 'FragmentSelector', value: 'xywh=pixel:1,2,3,4' },
        },
        version: 1,
        created_by: 'user',
    };
}

describe('WsiAnnotationPanel', () => {
    beforeEach(() => window.localStorage.clear());

    it('marks assistant annotations and offers accept and reject until reviewed', () => {
        const controller = controllerWith([
            apiItem('ai-1', { provenance: { source: 'agent' } }),
            apiItem('ai-2', {
                provenance: { source: 'agent', review_status: 'accepted' },
            }),
            apiItem('mine', {}),
        ]);
        const accept = jest
            .spyOn(controller, 'acceptAnnotation')
            .mockResolvedValue(undefined);
        const reject = jest
            .spyOn(controller, 'rejectAnnotation')
            .mockResolvedValue(undefined);
        render(<WsiAnnotationPanel controller={controller} />);

        expect(screen.getByTestId('annotation-ai-badge-ai-1').textContent).toBe(
            'AI · unreviewed'
        );
        expect(screen.getByTestId('annotation-ai-badge-ai-2').textContent).toBe(
            'AI · accepted'
        );
        expect(screen.queryByTestId('annotation-ai-badge-mine')).toBeNull();
        expect(screen.queryByTestId('accept-annotation-ai-2')).toBeNull();

        fireEvent.click(screen.getByLabelText('Accept AI annotation ai-1'));
        fireEvent.click(screen.getByLabelText('Reject AI annotation ai-1'));
        expect(accept).toHaveBeenCalledWith('ai-1');
        expect(reject).toHaveBeenCalledWith('ai-1');

        fireEvent.click(screen.getByTestId('annotation-hide-unreviewed-ai'));
        expect(screen.queryByTestId('annotation-row-ai-1')).toBeNull();
        expect(screen.getByTestId('annotation-row-ai-2')).toBeTruthy();
    });
});
