/**
 * @jest-environment jsdom
 */
var mockServerConfig: Record<string, any> = {};

jest.mock('config/config', () => ({
    getServerConfig: () => mockServerConfig,
}));

import {
    initializeDatadogRUM,
    reportWsiAssociationIntegrity,
    reportWsiInitialSlideLoadPerformance,
    sanitizeWsiAssociationIntegrityTelemetry,
    sanitizeWsiInitialSlideLoadTelemetry,
    WsiInitialSlideLoadTelemetry,
} from './tracking';
import { datadogRum } from '@datadog/browser-rum';

jest.mock('@datadog/browser-rum', () => ({
    datadogRum: {
        init: jest.fn(),
        addAction: jest.fn(),
    },
}));

describe('tracking WSI telemetry', () => {
    const metric: WsiInitialSlideLoadTelemetry = {
        loadSeq: 7,
        slideId: 'slide-42',
        patientId: 'P-1',
        studyId: 'study-1',
        openSeadragonWarmHit: true,
        hierarchyCacheHit: false,
        metadataCacheHit: true,
        hierarchySource: 'bootstrap',
        metadataSource: 'viewer-cache',
        loadPath: 'bootstrap',
        bootstrapStatus: 'failed',
        bootstrapFallbackReason: 'Server returned 502',
        hierarchyMs: 15,
        metadataMs: 23,
        osdOpenMs: 40,
        firstTileReadyMs: 67,
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('sanitizes WSI initial-load telemetry to non-PHI fields', () => {
        expect(sanitizeWsiInitialSlideLoadTelemetry(metric)).toEqual({
            load_seq: 7,
            load_path: 'bootstrap',
            bootstrap_status: 'failed',
            bootstrap_fallback_reason: 'http_502',
            hierarchy_source: 'bootstrap',
            metadata_source: 'viewer-cache',
            osd_warm_hit: 'true',
            hierarchy_cache_hit: 'false',
            metadata_cache_hit: 'true',
            hierarchy_ms: 15,
            metadata_ms: 23,
            osd_open_ms: 40,
            first_tile_ready_ms: 67,
        });
    });

    it('reports the sanitized payload to Datadog and returns it', () => {
        const payload = reportWsiInitialSlideLoadPerformance(metric);

        expect(datadogRum.addAction).toHaveBeenCalledWith(
            'wsi_initial_slide_load',
            payload
        );
        expect(payload).not.toHaveProperty('slideId');
        expect(payload).not.toHaveProperty('patientId');
        expect(payload).not.toHaveProperty('studyId');
    });

    it('coarsens unknown bootstrap failure reasons', () => {
        expect(
            sanitizeWsiInitialSlideLoadTelemetry({
                ...metric,
                bootstrapFallbackReason:
                    'bootstrap initial slide missing after frontend filtering',
            }).bootstrap_fallback_reason
        ).toBe('filtered_out');
        expect(
            sanitizeWsiInitialSlideLoadTelemetry({
                ...metric,
                bootstrapFallbackReason: 'Invalid bootstrap response',
            }).bootstrap_fallback_reason
        ).toBe('invalid_response');
        expect(
            sanitizeWsiInitialSlideLoadTelemetry({
                ...metric,
                bootstrapFallbackReason: 'totally unexpected failure',
            }).bootstrap_fallback_reason
        ).toBe('other');
    });
});

describe('tracking Datadog RUM init', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockServerConfig = {};
        delete (window as any).__cbioportalDatadogRumInitialized;
    });

    it('initializes Datadog RUM at most once per browser window', () => {
        mockServerConfig = {
            datadog_rum_application_id: 'app-id',
            datadog_rum_client_token: 'client-token',
            datadog_rum_site: 'datadoghq.com',
            app_name: 'cbioportal',
            datadog_rum_env: 'test',
            datadog_rum_session_sample_rate: 100,
            datadog_rum_session_replay_sample_rate: 20,
        };

        initializeDatadogRUM();
        initializeDatadogRUM();

        expect(datadogRum.init).toHaveBeenCalledTimes(1);
        expect(datadogRum.init).toHaveBeenCalledWith(
            expect.objectContaining({
                applicationId: 'app-id',
                clientToken: 'client-token',
                service: 'cbioportal',
                env: 'test',
                defaultPrivacyLevel: 'mask-user-input',
            })
        );
        expect(
            (window as any).__cbioportalDatadogRumInitialized
        ).toBe(true);
    });
});

describe('tracking WSI association integrity telemetry', () => {
    const metric = {
        hierarchyServableDistinctImages: 12,
        hierarchyNonServableDistinctImages: 3,
        hierarchyBlockDistinctImages: 4,
        hierarchyPartDistinctImages: 7,
        hierarchyUnmatchedDistinctImages: 1,
        timelineServableDistinctImages: 11,
        timelineNonServableDistinctImages: 3,
        declaredSampleServableCount: 13,
        declaredSampleBlockCount: 4,
        declaredSamplePartCount: 8,
        duplicateServableAssociationRows: 2,
        multiBucketServableImages: 1,
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('sanitizes WSI association integrity telemetry to aggregate-only fields', () => {
        expect(sanitizeWsiAssociationIntegrityTelemetry(metric)).toEqual({
            hierarchy_servable_distinct_images: 12,
            hierarchy_non_servable_distinct_images: 3,
            hierarchy_block_distinct_images: 4,
            hierarchy_part_distinct_images: 7,
            hierarchy_unmatched_distinct_images: 1,
            timeline_servable_distinct_images: 11,
            timeline_non_servable_distinct_images: 3,
            declared_sample_servable_count: 13,
            declared_sample_block_count: 4,
            declared_sample_part_count: 8,
            duplicate_servable_association_rows: 2,
            multi_bucket_servable_images: 1,
            viewer_vs_timeline_servable_mismatch: 'true',
            viewer_vs_timeline_non_servable_mismatch: 'false',
            multi_bucket_servable_mismatch: 'true',
            hierarchy_vs_clinical_sample_servable_mismatch: 'true',
            hierarchy_vs_clinical_sample_block_mismatch: 'false',
            hierarchy_vs_clinical_sample_part_mismatch: 'true',
        });
    });

    it('reports the sanitized association payload to Datadog and returns it', () => {
        const payload = reportWsiAssociationIntegrity(metric);

        expect(datadogRum.addAction).toHaveBeenCalledWith(
            'wsi_association_integrity',
            payload
        );
        expect(payload).not.toHaveProperty('patientId');
        expect(payload).not.toHaveProperty('sampleId');
        expect(payload).not.toHaveProperty('imageId');
    });
});
