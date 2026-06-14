jest.mock('shared/components/iframeLoader/IFrameLoader', () => {
    const React = require('react');

    return function MockIFrameLoader() {
        return <div data-testid="iframe-loader" />;
    };
});

jest.mock('shared/components/loadingIndicator/LoadingIndicator', () => {
    const React = require('react');

    return function MockLoadingIndicator(props: { isLoading: boolean }) {
        return props.isLoading ? <div data-testid="loading-indicator" /> : null;
    };
});

const mockReload = jest.fn();

jest.mock('cbioportal-frontend-commons', () => ({
    WindowWrapper: class WindowWrapper {
        size = { height: 900, width: 1200 };
    },
    getBrowserWindow: () => ({
        location: {
            protocol: 'https:',
            reload: mockReload,
        },
    }),
}));

// Capture WSIViewer props for annotation passthrough assertions
let capturedWSIViewerProps: Record<string, any> = {};
jest.mock('shared/components/wsiViewer/WSIViewer', () => {
    const React = require('react');
    return function MockWSIViewer(props: any) {
        capturedWSIViewerProps = props;
        return <div data-testid="wsi-viewer" />;
    };
});

jest.mock('shared/lib/ResourceConfig', () => ({
    getResourceConfig: jest.fn(),
}));

jest.mock('config/config', () => ({
    getServerConfig: jest.fn(),
}));

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { ResourceData, ResourceDefinition } from 'cbioportal-ts-api-client';
import ResourceTab, { IResourceTabProps } from './ResourceTab';
import { getResourceConfig } from 'shared/lib/ResourceConfig';
import { getServerConfig } from 'config/config';

const VPN_WARNING_MESSAGE =
    'This resource requires VPN access. Please connect to VPN and refresh the page.';

function makeDefinition(
    overrides: Partial<ResourceDefinition> = {}
): ResourceDefinition {
    return {
        customMetaData: '',
        description: '',
        displayName: 'H&E Slide',
        openByDefault: false,
        priority: '1',
        resourceId: 'MSK_HNE',
        resourceType: 'PATIENT',
        studyId: 'study1',
        ...overrides,
    };
}

function makeResourceData(overrides: Partial<ResourceData> = {}): ResourceData {
    return {
        patientId: 'PATIENT_1',
        resourceDefinition: makeDefinition(),
        resourceId: 'MSK_HNE',
        sampleId: 'SAMPLE_1',
        studyId: 'study1',
        uniquePatientKey: 'PATIENT_1',
        uniqueSampleKey: 'SAMPLE_1',
        url: 'https://example.org/resource.png',
        ...overrides,
    };
}

function makeProps(
    overrides: Partial<IResourceTabProps> = {}
): IResourceTabProps {
    return {
        resourceDisplayName: 'H&E Slide',
        resourceData: [makeResourceData()],
        urlWrapper: {
            setResourceUrl: jest.fn(),
            query: {},
        },
        ...overrides,
    };
}

describe('ResourceTab', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        jest.clearAllMocks();
    });

    it('renders the iframe when the accessibility check succeeds', async () => {
        (getServerConfig as jest.Mock).mockReturnValue({ msk_wsi_annotation_api_url: null });
        (getResourceConfig as jest.Mock).mockReturnValue({ nativeViewer: undefined, iframeErrorMessage: VPN_WARNING_MESSAGE });
        global.fetch = jest.fn().mockResolvedValue({}) as typeof fetch;

        render(<ResourceTab {...makeProps()} />);

        await waitFor(() =>
            expect(screen.getByTestId('iframe-loader')).toBeTruthy()
        );
        expect(screen.queryByText(VPN_WARNING_MESSAGE)).toBeNull();
    });

    it('shows the configured warning when the accessibility check fails', async () => {
        (getServerConfig as jest.Mock).mockReturnValue({ msk_wsi_annotation_api_url: null });
        (getResourceConfig as jest.Mock).mockReturnValue({ nativeViewer: undefined, iframeErrorMessage: VPN_WARNING_MESSAGE });
        global.fetch = jest
            .fn()
            .mockRejectedValue(new Error('VPN blocked')) as typeof fetch;

        render(<ResourceTab {...makeProps()} />);

        await waitFor(() =>
            expect(screen.getByText(VPN_WARNING_MESSAGE)).toBeTruthy()
        );
        expect(screen.queryByTestId('iframe-loader')).toBeNull();
    });
});

describe('ResourceTab — annotation API URL passthrough', () => {
    beforeEach(() => {
        capturedWSIViewerProps = {};
        (getServerConfig as jest.Mock).mockReturnValue({
            msk_wsi_annotation_api_url: 'http://anno-api.example.com',
        });
        (getResourceConfig as jest.Mock).mockReturnValue({ nativeViewer: 'wsi' });
        // No network needed: WSIViewer is mocked, no accessibility check for WSI resources
        global.fetch = jest.fn().mockResolvedValue({}) as typeof fetch;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('passes annotationApiUrl from getServerConfig to WSIViewer', async () => {
        const wsiData = makeResourceData({
            url: 'http://tiles.example.com/patient/P-1?studyId=study1',
            resourceDefinition: makeDefinition({ customMetaData: '{"nativeViewer":"wsi"}' }),
        });

        render(<ResourceTab {...makeProps({ resourceData: [wsiData] })} />);

        await waitFor(() =>
            expect(screen.getByTestId('wsi-viewer')).toBeTruthy()
        );
        expect(capturedWSIViewerProps.annotationApiUrl).toBe(
            'http://anno-api.example.com'
        );
    });

    it('passes undefined annotationApiUrl when msk_wsi_annotation_api_url is null', async () => {
        (getServerConfig as jest.Mock).mockReturnValue({
            msk_wsi_annotation_api_url: null,
        });
        const wsiData = makeResourceData({
            url: 'http://tiles.example.com/patient/P-1?studyId=study1',
            resourceDefinition: makeDefinition({ customMetaData: '{"nativeViewer":"wsi"}' }),
        });

        render(<ResourceTab {...makeProps({ resourceData: [wsiData] })} />);

        await waitFor(() =>
            expect(screen.getByTestId('wsi-viewer')).toBeTruthy()
        );
        expect(capturedWSIViewerProps.annotationApiUrl).toBeUndefined();
    });
});
