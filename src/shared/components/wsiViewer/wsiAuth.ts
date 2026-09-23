import { buildCBioPortalAPIUrl } from 'shared/api/urls';
import { getServerConfig } from 'config/config';
import { WsiSlideAccess } from './wsiViewerTypes';

const CURRENT_WSI_DECODE_POLICY =
    'geometry-v2;tile-max=16777216;thumbnail-max=16777216';
const CURRENT_WSI_DECODE_PIXELS = 16_777_216;

export function validateWsiTileMetadata(
    metadata: WsiSlideAccess['tileMetadata']
): void {
    if (
        !metadata ||
        !metadata.dimensions ||
        !Number.isInteger(metadata.dimensions.width) ||
        metadata.dimensions.width <= 0 ||
        !Number.isInteger(metadata.dimensions.height) ||
        metadata.dimensions.height <= 0 ||
        !Number.isInteger(metadata.levels) ||
        metadata.levels <= 0 ||
        !Array.isArray(metadata.level_dimensions) ||
        metadata.level_dimensions.length !== metadata.levels ||
        metadata.level_dimensions.some(
            level =>
                !level ||
                !Number.isInteger(level.width) ||
                level.width <= 0 ||
                !Number.isInteger(level.height) ||
                level.height <= 0
        ) ||
        !Number.isInteger(metadata.max_zoom) ||
        metadata.max_zoom < 0 ||
        !Number.isInteger(metadata.tile_size) ||
        metadata.tile_size <= 0
    ) {
        throw new Error('Invalid WSI tile metadata');
    }

    const schema = metadata.tile_metadata_schema_version;
    if (schema == null) return;
    if (!Number.isInteger(schema) || schema !== 2) {
        throw new Error('Invalid WSI tile metadata schema');
    }
    const safeMinLevel = metadata.safe_min_level;
    if (
        safeMinLevel == null ||
        !Number.isInteger(safeMinLevel) ||
        safeMinLevel < 0 ||
        safeMinLevel > metadata.max_zoom
    ) {
        throw new Error('Invalid WSI safe minimum level');
    }
    if (
        !Array.isArray(metadata.level_downsamples) ||
        metadata.level_downsamples.length !== metadata.levels ||
        metadata.level_downsamples.some(
            value => !Number.isFinite(value) || value <= 0
        )
    ) {
        throw new Error('Invalid WSI level downsamples');
    }
    if (metadata.decode_policy_version !== CURRENT_WSI_DECODE_POLICY) {
        throw new Error('Invalid WSI decode policy');
    }
    for (const [name, value] of [
        ['max_decode_pixels', metadata.max_decode_pixels],
        ['thumbnail_max_decode_pixels', metadata.thumbnail_max_decode_pixels],
    ] as Array<[string, number | null | undefined]>) {
        if (!Number.isInteger(value) || value !== CURRENT_WSI_DECODE_PIXELS) {
            throw new Error(`Invalid WSI ${name}`);
        }
    }
}

const WSI_SESSION_CACHE_PREFIXES = [
    'wsi-hierarchy-cache-',
    'wsi-metadata-cache-',
    'wsi-bootstrap-cache-',
];
let protectedSessionCachePurged = false;

export function normalizeWsiAuthScope(scope?: string): string {
    const normalized = scope?.trim();
    return normalized || 'anonymousUser';
}

function isConfiguredWsiAuthEnabled(): boolean {
    const config = getServerConfig() as ReturnType<typeof getServerConfig> & {
        msk_wsi_authentication_enabled?: boolean;
    };
    const authenticationMethod = config.authenticationMethod?.toLowerCase();
    return (
        authenticationMethod === 'saml' ||
        authenticationMethod === 'saml_plus_basic' ||
        config.msk_wsi_authentication_enabled === true
    );
}

export function isWsiAuthConfigured(): boolean {
    return isConfiguredWsiAuthEnabled();
}

export function isWsiAuthEnabled(): boolean {
    // The capability backend contract is mandatory for every deployed viewer mode.
    return true;
}

export function getWsiSessionStorage(): Storage | null {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        const storage = window.sessionStorage;
        if (!isConfiguredWsiAuthEnabled()) {
            return storage;
        }
        if (!protectedSessionCachePurged) {
            for (let index = storage.length - 1; index >= 0; index -= 1) {
                const key = storage.key(index);
                if (
                    key &&
                    WSI_SESSION_CACHE_PREFIXES.some(prefix =>
                        key.startsWith(prefix)
                    )
                ) {
                    storage.removeItem(key);
                }
            }
            protectedSessionCachePurged = true;
        }
        return null;
    } catch (_) {
        return null;
    }
}

const slideAccess = new Map<string, WsiSlideAccess>();
const pendingSlideAccess = new Map<string, Promise<WsiSlideAccess>>();

function slideAccessKey(
    studyId: string,
    imageId: string,
    authScope: string
): string {
    return `${normalizeWsiAuthScope(authScope)}::${studyId}::${imageId}`;
}

async function requestSlideAccess(
    studyId: string,
    imageId: string,
    authScope: string
): Promise<WsiSlideAccess> {
    const url = new URL(
        buildCBioPortalAPIUrl(
            `api/wsi/v2/slides/${encodeURIComponent(
                studyId
            )}/${encodeURIComponent(imageId)}/access`
        ),
        typeof window === 'undefined'
            ? 'http://localhost'
            : window.location.origin
    );
    const response = await fetch(url.toString(), {
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!response.ok) {
        throw new Error(`WSI authorization failed (${response.status})`);
    }
    const payload = (await response.json()) as WsiSlideAccess;
    if (
        !payload.accessToken ||
        !payload.sourceUrl ||
        !payload.tileMetadata ||
        !payload.thumbnail?.sourceUrl ||
        !Number.isFinite(payload.thumbnail.width) ||
        !Number.isFinite(payload.thumbnail.height) ||
        !Number.isFinite(payload.expiresIn) ||
        payload.expiresIn <= 0
    ) {
        throw new Error('Invalid WSI slide access response');
    }
    validateWsiTileMetadata(payload.tileMetadata);
    const access: WsiSlideAccess = {
        ...payload,
        expiresAt: Date.now() + payload.expiresIn * 1000,
    };
    slideAccess.set(slideAccessKey(studyId, imageId, authScope), access);
    return access;
}

export function getWsiSlideAccess(
    studyId: string,
    imageId: string,
    forceRefresh = false,
    authScope = 'anonymousUser'
): Promise<WsiSlideAccess> {
    if (!studyId || !imageId) {
        return Promise.reject(new Error('WSI study and slide are required'));
    }
    const scopedAuth = normalizeWsiAuthScope(authScope);
    const key = slideAccessKey(studyId, imageId, scopedAuth);
    if (!forceRefresh) {
        const cached = slideAccess.get(key);
        if (
            cached &&
            cached.expiresAt &&
            cached.expiresAt > Date.now() + 30_000
        ) {
            return Promise.resolve(cached);
        }
    }
    slideAccess.delete(key);
    let request = pendingSlideAccess.get(key);
    if (!request) {
        request = requestSlideAccess(studyId, imageId, scopedAuth).finally(
            () => {
                pendingSlideAccess.delete(key);
            }
        );
        pendingSlideAccess.set(key, request);
    }
    return request;
}

export function clearWsiSlideAccess(studyId?: string): void {
    if (studyId) {
        for (const key of slideAccess.keys()) {
            if (key.includes(`::${studyId}::`)) slideAccess.delete(key);
        }
        for (const key of pendingSlideAccess.keys()) {
            if (key.includes(`::${studyId}::`)) pendingSlideAccess.delete(key);
        }
        return;
    }
    slideAccess.clear();
    pendingSlideAccess.clear();
}

export function getWsiSourceFingerprint(access: WsiSlideAccess): string {
    let sourceDigest = '';
    try {
        const encodedPayload = access.accessToken.split('.')[1];
        if (encodedPayload) {
            const normalized = encodedPayload
                .replace(/-/g, '+')
                .replace(/_/g, '/');
            const decoded = atob(
                normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
            );
            const payload = JSON.parse(decoded) as {
                tile_source_sha256?: unknown;
            };
            if (
                typeof payload.tile_source_sha256 === 'string' &&
                /^[0-9a-f]{64}$/.test(payload.tile_source_sha256)
            ) {
                sourceDigest = payload.tile_source_sha256;
            }
        }
    } catch (_) {
        // Use the source URL when the capability payload is unavailable.
    }
    const source = sourceDigest || access.sourceUrl;
    return `wsi-v2:${source}:${access.tileMetadata.dimensions.width}x${access.tileMetadata.dimensions.height}`;
}

type AnnotationTokenResponse = {
    access_token: string;
    expires_in: number;
};

type AnnotationAccessToken = {
    value: string;
    expiresAt: number;
};

const annotationTokens = new Map<string, AnnotationAccessToken>();
const pendingAnnotationTokens = new Map<string, Promise<string>>();
const agentTokens = new Map<string, AnnotationAccessToken>();
const pendingAgentTokens = new Map<string, Promise<string>>();

function purposeTokenKey(
    studyId: string,
    purpose: 'annotations' | 'agent',
    authScope: string
): string {
    return `${normalizeWsiAuthScope(authScope)}::${purpose}::${studyId}`;
}

async function requestAnnotationToken(
    studyId: string,
    authScope: string
): Promise<string> {
    const url = new URL(
        buildCBioPortalAPIUrl('api/wsi/access-token'),
        typeof window === 'undefined'
            ? 'http://localhost'
            : window.location.origin
    );
    url.searchParams.set('studyId', studyId);
    url.searchParams.set('purpose', 'annotations');
    const response = await fetch(url.toString(), {
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!response.ok) {
        throw new Error(`WSI authorization failed (${response.status})`);
    }
    const payload = (await response.json()) as AnnotationTokenResponse;
    if (!payload.access_token || !Number.isFinite(payload.expires_in)) {
        throw new Error('Invalid WSI authorization response');
    }
    annotationTokens.set(purposeTokenKey(studyId, 'annotations', authScope), {
        value: payload.access_token,
        expiresAt: Date.now() + payload.expires_in * 1000,
    });
    return payload.access_token;
}

async function requestAgentToken(
    studyId: string,
    authScope: string
): Promise<string> {
    const url = new URL(
        buildCBioPortalAPIUrl('api/wsi/access-token'),
        typeof window === 'undefined'
            ? 'http://localhost'
            : window.location.origin
    );
    url.searchParams.set('studyId', studyId);
    url.searchParams.set('purpose', 'agent');
    const response = await fetch(url.toString(), {
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!response.ok) {
        throw new Error(`WSI authorization failed (${response.status})`);
    }
    const payload = (await response.json()) as AnnotationTokenResponse;
    if (!payload.access_token || !Number.isFinite(payload.expires_in)) {
        throw new Error('Invalid WSI authorization response');
    }
    agentTokens.set(purposeTokenKey(studyId, 'agent', authScope), {
        value: payload.access_token,
        expiresAt: Date.now() + payload.expires_in * 1000,
    });
    return payload.access_token;
}

export function getAnnotationAccessToken(
    studyId: string,
    authScope = 'anonymousUser'
): Promise<string> {
    if (!studyId) {
        return Promise.reject(new Error('WSI study scope is required'));
    }
    const key = purposeTokenKey(studyId, 'annotations', authScope);
    const cached = annotationTokens.get(key);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
        return Promise.resolve(cached.value);
    }
    let request = pendingAnnotationTokens.get(key);
    if (!request) {
        request = requestAnnotationToken(studyId, authScope).finally(() => {
            pendingAnnotationTokens.delete(key);
        });
        pendingAnnotationTokens.set(key, request);
    }
    return request;
}

export function getAgentAccessToken(
    studyId: string,
    authScope = 'anonymousUser'
): Promise<string> {
    if (!studyId) {
        return Promise.reject(new Error('WSI study scope is required'));
    }
    const key = purposeTokenKey(studyId, 'agent', authScope);
    const cached = agentTokens.get(key);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
        return Promise.resolve(cached.value);
    }
    let request = pendingAgentTokens.get(key);
    if (!request) {
        request = requestAgentToken(studyId, authScope).finally(() => {
            pendingAgentTokens.delete(key);
        });
        pendingAgentTokens.set(key, request);
    }
    return request;
}

export function clearAnnotationAccessToken(studyId?: string): void {
    if (studyId) {
        for (const key of annotationTokens.keys()) {
            if (key.endsWith(`::${studyId}`)) annotationTokens.delete(key);
        }
        for (const key of pendingAnnotationTokens.keys()) {
            if (key.endsWith(`::${studyId}`))
                pendingAnnotationTokens.delete(key);
        }
        for (const key of agentTokens.keys()) {
            if (key.endsWith(`::${studyId}`)) agentTokens.delete(key);
        }
        for (const key of pendingAgentTokens.keys()) {
            if (key.endsWith(`::${studyId}`)) pendingAgentTokens.delete(key);
        }
        return;
    }
    annotationTokens.clear();
    pendingAnnotationTokens.clear();
    agentTokens.clear();
    pendingAgentTokens.clear();
}
