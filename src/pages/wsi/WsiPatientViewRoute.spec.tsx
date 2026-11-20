/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import TestRenderer from 'react-test-renderer';
import WsiPatientViewRoute from './WsiPatientViewRoute';

const mockServerConfig: Record<string, unknown> = {};
const mockEntryPoint = jest.fn((_props: Record<string, unknown>) => null);

jest.mock('config/config', () => ({
    getServerConfig: () => mockServerConfig,
    getLoadConfig: () => ({ baseUrl: 'portal.example' }),
}));

jest.mock('shared/components/wsiViewer/wsiAppConfig', () => ({
    AppWsiViewer: (props: Record<string, unknown>) => mockEntryPoint(props),
}));

function renderRoute(search: string, patientId = 'P-1') {
    return TestRenderer.create(
        <WsiPatientViewRoute
            match={{ params: { patientId } }}
            location={{ search }}
        />
    );
}

describe('WsiPatientViewRoute', () => {
    beforeEach(() => {
        mockEntryPoint.mockClear();
        mockServerConfig.wsi_tile_server_url = '/wsi';
    });
    afterEach(() => {
        delete (window as any).globalStores;
    });

    it("passes the portal's signed-in user name to the viewer", () => {
        (window as any).globalStores = { appStore: { userName: 'user-a' } };
        mockServerConfig.user_display_name = 'display-user';
        renderRoute('?studyId=study-1');

        expect(mockEntryPoint.mock.calls[0][0].userName).toBe('user-a');
        delete mockServerConfig.user_display_name;
    });

    it('passes no user name without an app store', () => {
        renderRoute('?studyId=study-1');

        expect(mockEntryPoint.mock.calls[0][0].userName).toBeUndefined();
    });

    it('passes the slideKey link parameter as the requested slide', () => {
        renderRoute('?studyId=study-1&slideKey=0123456789ab');

        expect(mockEntryPoint).toHaveBeenCalledTimes(1);
        expect(mockEntryPoint.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                patientId: 'P-1',
                studyId: 'study-1',
                requestedSlideKey: '0123456789ab',
                tileServerUrl: '/wsi',
            })
        );
    });

    it('opens at a linked annotation, and links annotations by slide key and id', () => {
        renderRoute('?studyId=study-1&slideKey=0123456789ab&annotationId=a-7');
        const props = mockEntryPoint.mock.calls[0][0] as any;
        expect(props.requestedAnnotationId).toBe('a-7');
        // Opened on the link's slide only, and dropped from the address
        // once used.
        expect(props.requestedAnnotationSlideKey).toBe('0123456789ab');
        window.history.replaceState(
            null,
            '',
            '/wsi/patient/P-1?studyId=study-1&slideKey=0123456789ab&annotationId=a-7#wsi:x=1'
        );
        props.onRequestedAnnotationUsed();
        expect(window.location.search).toBe(
            '?studyId=study-1&slideKey=0123456789ab'
        );
        expect(window.location.hash).toBe('#wsi:x=1');
        window.history.replaceState(null, '', '/');
        const link = new URL(
            props.annotationLink({
                slideKey: '0123456789ab',
                annotationId: 'a 8',
            })
        );
        expect(link.host).toBe('portal.example');
        expect(link.pathname).toBe('/wsi/patient/P-1');
        expect(Array.from(link.searchParams.entries())).toEqual([
            ['studyId', 'study-1'],
            ['slideKey', '0123456789ab'],
            ['annotationId', 'a 8'],
        ]);
        expect(link.hash).toBe('');
    });

    it('decodes an encoded slideKey', () => {
        renderRoute(
            `?studyId=study%201&slideKey=${encodeURIComponent(
                'slide id/2 #x&y'
            )}`
        );

        expect(mockEntryPoint.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                studyId: 'study 1',
                requestedSlideKey: 'slide id/2 #x&y',
            })
        );
    });

    it('omits the requested slide when no slideKey is given', () => {
        renderRoute('?studyId=study-1&slideKey=');

        expect(
            mockEntryPoint.mock.calls[0][0].requestedSlideKey
        ).toBeUndefined();
    });

    it('passes an unknown slideKey through for the viewer to resolve', () => {
        renderRoute('?studyId=study-1&slideKey=does-not-exist');

        expect(mockEntryPoint.mock.calls[0][0].requestedSlideKey).toBe(
            'does-not-exist'
        );
    });

    it('ignores a legacy imageId link parameter', () => {
        renderRoute('?studyId=study-1&imageId=slide-2');

        expect(
            mockEntryPoint.mock.calls[0][0].requestedSlideKey
        ).toBeUndefined();
        expect(JSON.stringify(mockEntryPoint.mock.calls[0][0])).not.toContain(
            'slide-2'
        );
    });

    it('reports unavailable configuration without a study', () => {
        const rendered = renderRoute('?slideKey=0123456789ab');

        expect(mockEntryPoint).not.toHaveBeenCalled();
        expect(
            rendered.root.findByProps({
                'data-testid': 'wsi-route-unavailable',
            })
        ).toBeTruthy();
    });
});
