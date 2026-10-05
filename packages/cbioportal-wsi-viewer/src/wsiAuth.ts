import { getWsiViewerRuntime } from './wsiViewerConfig';
import { PatientHierarchy, WsiSlideAccess } from './wsiViewerTypes';
import { deleteExpiredEntries } from './wsiCacheUtils';

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

export function isWsiAuthConfigured(): boolean {
    return getWsiViewerRuntime().authEnabled;
}

export function getWsiSessionStorage(): Storage | null {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        const storage = window.sessionStorage;
        if (!isWsiAuthConfigured()) {
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
/**
 * Patient of every slide a loaded hierarchy published, keyed by study and
 * slide key. Access is only ever requested for these slides.
 */
const slidePatients = new Map<string, string>();

function registryKey(studyId: string, slideKey: string): string {
    return `${studyId}::${slideKey}`;
}

/**
 * Registers the slides of a loaded hierarchy. The hierarchy is authoritative
 * for its study and patient, so slides from an earlier load of the same
 * patient are replaced rather than merged.
 */
export function registerWsiResourceAccess(
    studyId: string,
    hierarchy: PatientHierarchy
): void {
    clearWsiResourceAccessTargets(studyId, hierarchy.patient_id);
    hierarchy.samples.forEach(sample =>
        sample.parts.forEach(part =>
            part.blocks.forEach(block =>
                block.slides.forEach(slide => {
                    slidePatients.set(
                        registryKey(studyId, slide.slide_key),
                        hierarchy.patient_id
                    );
                })
            )
        )
    );
}

/** Registers one slide when a caller already has it selected. */
export function registerWsiResourceAccessTarget(
    studyId: string,
    slideKey: string,
    patientId: string
): void {
    slidePatients.set(registryKey(studyId, slideKey), patientId);
}

/**
 * Forgets registered slides. With no arguments every slide is forgotten; with
 * a study (and optionally a patient) only matching slides are.
 */
export function clearWsiResourceAccessTargets(
    studyId?: string,
    patientId?: string
): void {
    if (studyId === undefined) {
        slidePatients.clear();
        return;
    }
    for (const [key, slidePatient] of slidePatients) {
        if (
            key.startsWith(`${studyId}::`) &&
            (patientId === undefined || slidePatient === patientId)
        ) {
            slidePatients.delete(key);
        }
    }
}

function fetchSlideAccess(
    studyId: string,
    patientId: string,
    slideKey: string
): Promise<Response> {
    const { buildApiUrl, fetchImpl } = getWsiViewerRuntime();
    // The host builds only the path: the portal's URL builder encodes a `?`
    // inside it, so the slide key is added as a query parameter afterwards.
    const url = new URL(
        buildApiUrl(
            `api/wsi/v2/resources/${encodeURIComponent(
                studyId
            )}/${encodeURIComponent(patientId)}/access`
        ),
        typeof window === 'undefined'
            ? 'http://localhost'
            : window.location.origin
    );
    url.search = `?slideKey=${encodeURIComponent(slideKey)}`;
    return fetchImpl(url.toString(), {
        credentials: 'same-origin',
        cache: 'no-store',
    });
}

async function requestSlideAccess(
    studyId: string,
    patientId: string,
    slideKey: string
): Promise<WsiSlideAccess> {
    const response = await fetchSlideAccess(studyId, patientId, slideKey);
    if (!response.ok) {
        throw new Error(`WSI authorization failed (${response.status})`);
    }
    const payload = (await response.json()) as WsiSlideAccess;
    if (
        !payload ||
        payload.slideKey !== slideKey ||
        !payload.accessToken ||
        !payload.tileMetadata ||
        !payload.thumbnail ||
        !Number.isFinite(payload.thumbnail.width) ||
        !Number.isFinite(payload.thumbnail.height) ||
        !Number.isFinite(payload.expiresIn) ||
        payload.expiresIn <= 0
    ) {
        throw new Error('Invalid WSI slide access response');
    }
    validateWsiTileMetadata(payload.tileMetadata);
    // Copy only the contract fields so nothing else from the response is
    // retained client-side.
    return {
        slideKey,
        tileMetadata: payload.tileMetadata,
        thumbnail: {
            width: payload.thumbnail.width,
            height: payload.thumbnail.height,
            contentType: payload.thumbnail.contentType,
        },
        accessToken: payload.accessToken,
        tokenType: payload.tokenType,
        expiresIn: payload.expiresIn,
        expiresAt: Date.now() + payload.expiresIn * 1000,
    };
}

export function getWsiSlideAccess(
    studyId: string,
    slideKey: string,
    forceRefresh = false,
    authScope = 'anonymousUser'
): Promise<WsiSlideAccess> {
    if (!studyId || !slideKey) {
        return Promise.reject(new Error('WSI study and slide are required'));
    }
    // Unknown slides fail here, before any request or cached capability:
    // access is only ever used for a slide published by a loaded hierarchy.
    const patientId = slidePatients.get(registryKey(studyId, slideKey));
    if (patientId === undefined) {
        return Promise.reject(
            new Error('WSI resource selection is unavailable')
        );
    }
    const key = [
        normalizeWsiAuthScope(authScope),
        studyId,
        patientId,
        slideKey,
    ].join('::');
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
        request = requestSlideAccess(studyId, patientId, slideKey)
            .then(access => {
                deleteExpiredEntries(slideAccess);
                slideAccess.set(key, access);
                return access;
            })
            .finally(() => {
                pendingSlideAccess.delete(key);
            });
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
        clearWsiResourceAccessTargets(studyId);
        clearWsiPurposeAccessTokens(studyId);
        return;
    }
    slideAccess.clear();
    pendingSlideAccess.clear();
    clearWsiResourceAccessTargets();
    clearWsiPurposeAccessTokens();
}

/**
 * Identifies the tile source of a slide access: the capability's
 * `tile_source_sha256` claim when present, the source URL otherwise, and the
 * slide dimensions.
 */
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

/** Services that accept a study-scoped portal access token. */
export type WsiAccessTokenPurpose = 'annotations' | 'agent';

type WsiAccessTokenResponse = {
    access_token: string;
    expires_in: number;
};

type WsiPurposeAccessToken = {
    value: string;
    expiresAt: number;
};

const purposeTokens = new Map<string, WsiPurposeAccessToken>();
const pendingPurposeTokens = new Map<string, Promise<string>>();

function purposeTokenKey(
    studyId: string,
    purpose: WsiAccessTokenPurpose,
    authScope: string
): string {
    return `${normalizeWsiAuthScope(authScope)}::${purpose}::${studyId}`;
}

async function requestPurposeAccessToken(
    studyId: string,
    purpose: WsiAccessTokenPurpose
): Promise<WsiPurposeAccessToken> {
    const { buildApiUrl, fetchImpl } = getWsiViewerRuntime();
    const url = new URL(
        buildApiUrl('api/wsi/access-token'),
        typeof window === 'undefined'
            ? 'http://localhost'
            : window.location.origin
    );
    url.searchParams.set('studyId', studyId);
    url.searchParams.set('purpose', purpose);
    const response = await fetchImpl(url.toString(), {
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!response.ok) {
        throw new Error(`WSI authorization failed (${response.status})`);
    }
    const payload = (await response.json()) as WsiAccessTokenResponse;
    if (
        !payload.access_token ||
        !Number.isFinite(payload.expires_in) ||
        payload.expires_in <= 0
    ) {
        throw new Error('Invalid WSI authorization response');
    }
    return {
        value: payload.access_token,
        expiresAt: Date.now() + payload.expires_in * 1000,
    };
}

/**
 * Study-scoped portal token for a WSI companion service, cached per subject,
 * purpose and study until 30 seconds before it expires.
 */
export function getWsiPurposeAccessToken(
    studyId: string,
    purpose: WsiAccessTokenPurpose,
    authScope = 'anonymousUser'
): Promise<string> {
    if (!studyId) {
        return Promise.reject(new Error('WSI study scope is required'));
    }
    const key = purposeTokenKey(studyId, purpose, authScope);
    const cached = purposeTokens.get(key);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
        return Promise.resolve(cached.value);
    }
    purposeTokens.delete(key);
    let request = pendingPurposeTokens.get(key);
    if (!request) {
        const pending: Promise<string> = requestPurposeAccessToken(
            studyId,
            purpose
        )
            .then(token => {
                // A clear while the request was in flight discards its result.
                if (pendingPurposeTokens.get(key) === pending) {
                    deleteExpiredEntries(purposeTokens);
                    purposeTokens.set(key, token);
                }
                return token.value;
            })
            .finally(() => {
                if (pendingPurposeTokens.get(key) === pending) {
                    pendingPurposeTokens.delete(key);
                }
            });
        request = pending;
        pendingPurposeTokens.set(key, request);
    }
    return request;
}

export function getAnnotationAccessToken(
    studyId: string,
    authScope = 'anonymousUser'
): Promise<string> {
    return getWsiPurposeAccessToken(studyId, 'annotations', authScope);
}

export function getAgentAccessToken(
    studyId: string,
    authScope = 'anonymousUser'
): Promise<string> {
    return getWsiPurposeAccessToken(studyId, 'agent', authScope);
}

/** Forgets purpose tokens for one study, or for every study. */
export function clearWsiPurposeAccessTokens(studyId?: string): void {
    for (const tokens of [purposeTokens, pendingPurposeTokens] as Array<
        Map<string, unknown>
    >) {
        if (studyId === undefined) {
            tokens.clear();
            continue;
        }
        for (const key of tokens.keys()) {
            if (key.endsWith(`::${studyId}`)) tokens.delete(key);
        }
    }
}

export function clearAnnotationAccessToken(studyId?: string): void {
    clearWsiPurposeAccessTokens(studyId);
}
