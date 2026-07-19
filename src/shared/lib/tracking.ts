import $ from 'jquery';
import { getServerConfig } from 'config/config';
import { getBrowserWindow, isWebdriver } from 'cbioportal-frontend-commons';
import _ from 'lodash';
import { log } from './consoleLog';
import { StudyViewPageStore } from '../../pages/studyView/StudyViewPageStore';
// @ts-ignore
import { UniversalAnalytics } from 'google.analytics';

const DATADOG_RUM_INIT_FLAG = '__cbioportalDatadogRumInitialized';

type DatadogRumClient = {
    init?: (config: Record<string, unknown>) => void;
    addAction?: (name: string, context: Record<string, unknown>) => void;
};

let cachedDatadogRumClient: DatadogRumClient | null | undefined;

function getDatadogRumClient(): DatadogRumClient | undefined {
    if (cachedDatadogRumClient !== undefined) {
        return cachedDatadogRumClient ?? undefined;
    }

    try {
        cachedDatadogRumClient = (
            require('@datadog/browser-rum') as {
                datadogRum?: DatadogRumClient;
            }
        ).datadogRum ?? null;
    } catch (_) {
        cachedDatadogRumClient = null;
    }

    return cachedDatadogRumClient ?? undefined;
}

export type GAEvent = {
    category:
    | 'studyPage'
    | 'resultsView'
    | 'quickSearch'
    | 'download'
    | 'groupComparison'
    | 'homePage'
    | 'patientView'
    | 'linkout';
    action: string;
    label?: string | string[];
    fieldsObject?: { [key: string]: string | number };
};

export type GA4Event = {
    eventName: string;
    parameters: { [key: string]: string | number };
};

function detectGA4() {
    return (
        true || /^G-/.test(getServerConfig().google_analytics_profile_id || '')
    );
}

export function initializeTracking() {
    if (!_.isEmpty(getServerConfig().google_analytics_profile_id)) {
        // Google Analaytics v4 replaced Universal Analytics in 2023 and we can detect the new
        // implementation based on the prefix (G-) of the analytics id, e.g. "G-XXXXXXXX"
        if (detectGA4()) {
            embedGoogleAnalyticsVersion4(
                getServerConfig().google_analytics_profile_id!
            );
        } else {
            embedGoogleAnalytics(
                getServerConfig().google_analytics_profile_id!
            );
        }
    }

    // Initialize Datadog RUM
    initializeDatadogRUM();

    $('body').on('click', '[data-event]', el => {
        try {
            const event: GAEvent = JSON.parse(
                $(el.currentTarget).attr('data-event')!
            ) as GAEvent;
            trackEvent(event);
        } catch (ex) {}
    });
}

export function trackEvent(event: any) {
    //
    // trackEvent is used to send custom UI events which may depend on custom configuration within GA
    // for other installers, we want to shut these off, leaving them with bare-bones out-of-box GA implementaion
    if (/cbioportal\.org$|mskcc\.org$/.test(getBrowserWindow().location.host)) {
        if (detectGA4() && event.eventName) {
            getGA4Instance()('event', event.eventName, event.parameters);
        }
    }
}

export function serializeEvent(gaEvent: GAEvent) {
    // when we send arrays of values as single event properties to google analytics
    // we want to send them as comma delimitted strings WITH trailing commas to allow us to filter in analytics
    // without risk of catching substring matches (e.g. tcga_brca, tcga_brca_2018)
    // this is annoying to do on one off basis, so this is a little helper transform
    const arraysToString = _.mapValues(gaEvent, val => {
        if (_.isArray(val)) {
            return val.join(',') + ','; // add trailing comma
        } else {
            return val;
        }
    });

    try {
        return JSON.stringify(arraysToString);
    } catch (ex) {}
}

export function sendToLoggly(payload: Record<string, string | number>) {
    try {
        if (/cbioportal\.org$/.test(window.location.hostname)) {
            const LOGGLY_TOKEN = 'b7a422a1-9878-49a2-8a30-2a8d5d33518f';

            const data = {
                location: window.location.href.replace(/#.*$/, ''),
                ...payload,
                e2e: isWebdriver() ? 'true' : 'false',
            };

            $.ajax({
                url: `//logs-01.loggly.com/inputs/${LOGGLY_TOKEN}.gif`,
                data,
            });
        }
    } catch (ex) {
        // do nothing
    }
}

export type WsiInitialSlideLoadTelemetry = {
    loadSeq: number;
    slideId: string;
    patientId?: string;
    studyId?: string;
    openSeadragonWarmHit: boolean;
    hierarchyCacheHit: boolean;
    metadataCacheHit: boolean;
    hierarchySource: 'shared-cache' | 'network' | 'bootstrap';
    metadataSource:
        | 'viewer-cache'
        | 'shared-cache'
        | 'network'
        | 'bootstrap';
    loadPath: 'legacy' | 'bootstrap';
    bootstrapStatus:
        | 'disabled'
        | 'success'
        | 'failed'
        | 'missing-initial'
        | 'skipped-cache-hit'
        | 'filtered-out';
    bootstrapFallbackReason?: string;
    hierarchyMs: number;
    metadataMs: number;
    osdOpenMs: number;
    firstTileReadyMs: number;
};

type WsiInitialSlideLoadTelemetryPayload = {
    load_seq: number;
    load_path: 'legacy' | 'bootstrap';
    bootstrap_status:
        | 'disabled'
        | 'success'
        | 'failed'
        | 'missing-initial'
        | 'skipped-cache-hit'
        | 'filtered-out';
    bootstrap_fallback_reason?: string;
    hierarchy_source: 'shared-cache' | 'network' | 'bootstrap';
    metadata_source:
        | 'viewer-cache'
        | 'shared-cache'
        | 'network'
        | 'bootstrap';
    osd_warm_hit: 'true' | 'false';
    hierarchy_cache_hit: 'true' | 'false';
    metadata_cache_hit: 'true' | 'false';
    hierarchy_ms: number;
    metadata_ms: number;
    osd_open_ms: number;
    first_tile_ready_ms: number;
};

function classifyWsiBootstrapFallbackReason(
    reason: string | undefined
): string | undefined {
    if (!reason) {
        return undefined;
    }

    const normalized = reason.toLowerCase();
    const statusMatch = normalized.match(/\b(\d{3})\b/);
    if (statusMatch) {
        return `http_${statusMatch[1]}`;
    }
    if (normalized.includes('invalid bootstrap response')) {
        return 'invalid_response';
    }
    if (normalized.includes('aborted')) {
        return 'aborted';
    }
    if (normalized.includes('missing after frontend filtering')) {
        return 'filtered_out';
    }
    if (normalized.includes('network')) {
        return 'network';
    }
    return 'other';
}

export function sanitizeWsiInitialSlideLoadTelemetry(
    metric: WsiInitialSlideLoadTelemetry
): WsiInitialSlideLoadTelemetryPayload {
    return {
        load_seq: metric.loadSeq,
        load_path: metric.loadPath,
        bootstrap_status: metric.bootstrapStatus,
        bootstrap_fallback_reason: classifyWsiBootstrapFallbackReason(
            metric.bootstrapFallbackReason
        ),
        hierarchy_source: metric.hierarchySource,
        metadata_source: metric.metadataSource,
        osd_warm_hit: metric.openSeadragonWarmHit ? 'true' : 'false',
        hierarchy_cache_hit: metric.hierarchyCacheHit ? 'true' : 'false',
        metadata_cache_hit: metric.metadataCacheHit ? 'true' : 'false',
        hierarchy_ms: metric.hierarchyMs,
        metadata_ms: metric.metadataMs,
        osd_open_ms: metric.osdOpenMs,
        first_tile_ready_ms: metric.firstTileReadyMs,
    };
}

export function reportWsiInitialSlideLoadPerformance(
    metric: WsiInitialSlideLoadTelemetry
): WsiInitialSlideLoadTelemetryPayload {
    const payload = sanitizeWsiInitialSlideLoadTelemetry(metric);
    const datadogRum = getDatadogRumClient();

    try {
        datadogRum?.addAction?.('wsi_initial_slide_load', payload);
    } catch (_) {
        // Ignore telemetry sink failures.
    }

    sendToLoggly({
        message: 'WSI_INITIAL_SLIDE_LOAD',
        ...payload,
    });

    return payload;
}

export type WsiAssociationIntegrityTelemetry = {
    hierarchyServableDistinctImages: number;
    hierarchyNonServableDistinctImages: number;
    hierarchyBlockDistinctImages: number;
    hierarchyPartDistinctImages: number;
    hierarchyUnmatchedDistinctImages: number;
    timelineServableDistinctImages: number;
    timelineNonServableDistinctImages: number;
    declaredSampleServableCount?: number;
    declaredSampleBlockCount?: number;
    declaredSamplePartCount?: number;
    duplicateServableAssociationRows: number;
    multiBucketServableImages: number;
};

type WsiAssociationIntegrityTelemetryPayload = {
    hierarchy_servable_distinct_images: number;
    hierarchy_non_servable_distinct_images: number;
    hierarchy_block_distinct_images: number;
    hierarchy_part_distinct_images: number;
    hierarchy_unmatched_distinct_images: number;
    timeline_servable_distinct_images: number;
    timeline_non_servable_distinct_images: number;
    declared_sample_servable_count?: number;
    declared_sample_block_count?: number;
    declared_sample_part_count?: number;
    duplicate_servable_association_rows: number;
    multi_bucket_servable_images: number;
    viewer_vs_timeline_servable_mismatch: 'true' | 'false';
    viewer_vs_timeline_non_servable_mismatch: 'true' | 'false';
    multi_bucket_servable_mismatch: 'true' | 'false';
    hierarchy_vs_clinical_sample_servable_mismatch?: 'true' | 'false';
    hierarchy_vs_clinical_sample_block_mismatch?: 'true' | 'false';
    hierarchy_vs_clinical_sample_part_mismatch?: 'true' | 'false';
};

export function sanitizeWsiAssociationIntegrityTelemetry(
    metric: WsiAssociationIntegrityTelemetry
): WsiAssociationIntegrityTelemetryPayload {
    return {
        hierarchy_servable_distinct_images:
            metric.hierarchyServableDistinctImages,
        hierarchy_non_servable_distinct_images:
            metric.hierarchyNonServableDistinctImages,
        hierarchy_block_distinct_images: metric.hierarchyBlockDistinctImages,
        hierarchy_part_distinct_images: metric.hierarchyPartDistinctImages,
        hierarchy_unmatched_distinct_images:
            metric.hierarchyUnmatchedDistinctImages,
        timeline_servable_distinct_images:
            metric.timelineServableDistinctImages,
        timeline_non_servable_distinct_images:
            metric.timelineNonServableDistinctImages,
        declared_sample_servable_count: metric.declaredSampleServableCount,
        declared_sample_block_count: metric.declaredSampleBlockCount,
        declared_sample_part_count: metric.declaredSamplePartCount,
        duplicate_servable_association_rows: metric.duplicateServableAssociationRows,
        multi_bucket_servable_images: metric.multiBucketServableImages,
        viewer_vs_timeline_servable_mismatch:
            metric.hierarchyServableDistinctImages !==
            metric.timelineServableDistinctImages
                ? 'true'
                : 'false',
        viewer_vs_timeline_non_servable_mismatch:
            metric.hierarchyNonServableDistinctImages !==
            metric.timelineNonServableDistinctImages
                ? 'true'
                : 'false',
        multi_bucket_servable_mismatch:
            metric.multiBucketServableImages > 0 ? 'true' : 'false',
        ...(metric.declaredSampleServableCount != null
            ? {
                  hierarchy_vs_clinical_sample_servable_mismatch:
                      metric.hierarchyServableDistinctImages !==
                      metric.declaredSampleServableCount
                          ? 'true'
                          : 'false',
              }
            : {}),
        ...(metric.declaredSampleBlockCount != null
            ? {
                  hierarchy_vs_clinical_sample_block_mismatch:
                      metric.hierarchyBlockDistinctImages !==
                      metric.declaredSampleBlockCount
                          ? 'true'
                          : 'false',
              }
            : {}),
        ...(metric.declaredSamplePartCount != null
            ? {
                  hierarchy_vs_clinical_sample_part_mismatch:
                      metric.hierarchyPartDistinctImages !==
                      metric.declaredSamplePartCount
                          ? 'true'
                          : 'false',
              }
            : {}),
    };
}

export function reportWsiAssociationIntegrity(
    metric: WsiAssociationIntegrityTelemetry
): WsiAssociationIntegrityTelemetryPayload {
    const payload = sanitizeWsiAssociationIntegrityTelemetry(metric);
    const datadogRum = getDatadogRumClient();

    try {
        datadogRum?.addAction?.('wsi_association_integrity', payload);
    } catch (_) {
        // Ignore telemetry sink failures.
    }

    sendToLoggly({
        message: 'WSI_ASSOCIATION_INTEGRITY',
        ...payload,
    });

    return payload;
}

export function embedGoogleAnalytics(ga_code: string) {
    $(document).ready(function() {
        $(
            '<script async src="https://www.google-analytics.com/analytics.js"></script>'
        ).appendTo('body');
        $(
            '<script async src="https://cdnjs.cloudflare.com/ajax/libs/autotrack/2.4.1/autotrack.js"></script>'
        ).appendTo('body');
        getBrowserWindow().ga =
            getBrowserWindow().ga ||
            function() {
                (ga.q = ga.q || []).push(arguments);
            };
        const ga: UniversalAnalytics.ga = getBrowserWindow().ga;
        ga.l = +new Date();
        ga('create', ga_code, 'auto');

        ga('require', 'urlChangeTracker', {
            hitFilter: function(model: any) {
                sendToLoggly({ message: 'PAGE_VIEW' });
            },
        });

        ga('require', 'cleanUrlTracker', {
            stripQuery: true,
            trailingSlash: 'remove',
        });
        ga('send', 'pageview');
        sendToLoggly({ message: 'PAGE_VIEW' });
    });
}

export function embedGoogleAnalyticsVersion4(ga_code: string) {
    $(document).ready(function() {
        $(
            `<script async src="https://www.googletagmanager.com/gtag/js?id=${ga_code}"></script>`
        ).appendTo('body');

        getBrowserWindow().dataLayer = getBrowserWindow().dataLayer || [];

        function gtag(...args: any[]) {
            getBrowserWindow().dataLayer.push(arguments);
        }

        getBrowserWindow().gtag = gtag;

        gtag('js', new Date());

        gtag('config', ga_code);

        sendToLoggly({ message: 'PAGE_VIEW' });
    });
}

export function initializeDatadogRUM() {
    const config = getServerConfig();
    const datadogRum = getDatadogRumClient();

    if (
        !datadogRum ||
        !config.datadog_rum_application_id ||
        !config.datadog_rum_client_token
    ) {
        return;
    }

    const browserWindow = getBrowserWindow() as Window & {
        [DATADOG_RUM_INIT_FLAG]?: boolean;
    };
    if (browserWindow[DATADOG_RUM_INIT_FLAG]) {
        return;
    }

    datadogRum?.init?.({
        applicationId: config.datadog_rum_application_id,
        clientToken: config.datadog_rum_client_token,
        site: config.datadog_rum_site || 'datadoghq.com',
        service: config.app_name || 'cbioportal',
        env: config.datadog_rum_env || 'public',
        sessionSampleRate: config.datadog_rum_session_sample_rate || 100,
        sessionReplaySampleRate: config.datadog_rum_session_replay_sample_rate || 20,
        defaultPrivacyLevel: 'mask-user-input',
    });
    browserWindow[DATADOG_RUM_INIT_FLAG] = true;
}

export function sendSentryMessage(msg: string) {
    log('sentry message', msg);
    if ((window as any).Sentry) {
        (window as any).Sentry.captureException(new Error(msg));
    }
}

export function getGA4Instance() {
    return getBrowserWindow().gtag as (
        command: string,
        eventName: string,
        parameters: any
    ) => void;
}

export function getGAInstance(): UniversalAnalytics.ga {
    const ga: UniversalAnalytics.ga = getBrowserWindow().ga;

    return ga || function() {};
}

let queryCount = 0;

export enum GACustomFieldsEnum {
    Studies = 'studies',
}

export function trackQuery(
    cancerStudyIds: string[],
    oql: string,
    geneSymbols: string[],
    isVirtualStudy: boolean
) {
    getGA4Instance()('event', 'resultsViewQuery', {
        ['studies']: cancerStudyIds.join(',') + ',',
        ['oql']: oql,
        ['study count']: cancerStudyIds.length,
        ['genes']: geneSymbols.join(',') + ',',
        ['virtual study']: isVirtualStudy.toString(),
    });
}

export function trackPatient(studyId: string): void {
    trackEvent({
        category: 'patientView',
        action: 'patientViewed',
        label: studyId,
    });
}

export function trackStudyViewFilterEvent(
    label: string,
    store: StudyViewPageStore
) {
    trackEvent({
        category: 'studyPage',
        action: 'addFilter',
        label: label,
        fieldsObject: {
            [GACustomFieldsEnum.Studies]:
                store.queriedPhysicalStudyIds.result.join(',') + ',',
        },
    });
}
