import { getWsiViewerRuntime } from './wsiViewerConfig';

/**
 * Requests to the WSI annotation service. A proxy in front of the service
 * authorizes every request with the portal session cookie for the study in
 * the `studyId` query parameter, and forwards the user and study to the
 * service. Each request therefore sends the cookie and exactly one `studyId`.
 * Writes also send `X-Requested-With`, which a cross-site page cannot add
 * without a CORS preflight that the service refuses.
 */
export const WSI_CSRF_HEADER = 'X-Requested-With';
export const WSI_CSRF_HEADER_VALUE = 'XMLHttpRequest';

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/** The service URL for `path`, with the study appended to its query. */
export function wsiServiceUrl(
    apiUrl: string,
    path: string,
    studyId: string
): string {
    const base = apiUrl.replace(/\/+$/, '');
    const separator = path.includes('?') ? '&' : '?';
    return `${base}${path}${separator}studyId=${encodeURIComponent(studyId)}`;
}

/**
 * Calls the annotation service for `studyId` with the portal session cookie.
 * Writes send the CSRF header, and a request with a body is sent as JSON
 * unless it names another content type.
 */
export function wsiServiceFetch(
    apiUrl: string,
    path: string,
    studyId: string | undefined,
    init: RequestInit = {}
): Promise<Response> {
    if (!studyId) {
        return Promise.reject(new Error('WSI study is required'));
    }
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (!SAFE_METHODS.includes(method)) {
        headers.set(WSI_CSRF_HEADER, WSI_CSRF_HEADER_VALUE);
    }
    if (init.body != null && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }
    return getWsiViewerRuntime().fetchImpl(
        wsiServiceUrl(apiUrl, path, studyId),
        { ...init, headers, credentials: 'include' }
    );
}

/**
 * Why the service refused a request: the user is signed out (401), or may
 * not read the study (403). Neither is retried.
 */
export type WsiServiceAccessIssue = 'signedOut' | 'forbidden';

export function wsiServiceAccessIssue(
    status: number
): WsiServiceAccessIssue | null {
    if (status === 401) return 'signedOut';
    if (status === 403) return 'forbidden';
    return null;
}

/**
 * A page of a list the service may page (comments, slide notes): an
 * older service answers the whole list (an array, or the object without
 * paging fields), a newer one `{…, total, offset, limit, has_more,
 * next_offset}`.
 */
export function readPage<T>(
    raw: unknown,
    key: string
): { items: T[]; total: number | null; nextOffset: number | null } {
    if (Array.isArray(raw)) {
        return { items: raw as T[], total: null, nextOffset: null };
    }
    const page = (raw || {}) as Record<string, unknown>;
    const items = Array.isArray(page[key]) ? (page[key] as T[]) : [];
    const next =
        page.has_more === true && typeof page.next_offset === 'number'
            ? page.next_offset
            : null;
    return {
        items,
        total: typeof page.total === 'number' ? page.total : null,
        nextOffset: next,
    };
}
