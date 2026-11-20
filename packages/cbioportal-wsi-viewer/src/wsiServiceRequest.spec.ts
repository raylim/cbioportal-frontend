import {
    wsiServiceAccessIssue,
    wsiServiceFetch,
    wsiServiceUrl,
} from './wsiServiceRequest';
import { configureWsiViewerRuntime } from './wsiViewerConfig';

describe('wsiServiceRequest', () => {
    const fetchImpl = jest.fn();

    beforeEach(() => {
        fetchImpl.mockReset().mockResolvedValue({ ok: true } as Response);
        configureWsiViewerRuntime({
            buildApiUrl: path => `/${path}`,
            fetchImpl: fetchImpl as typeof fetch,
        });
    });

    it('appends the study once to the query', () => {
        expect(wsiServiceUrl('/wsi/', '/slide-notes', 'study 1')).toBe(
            '/wsi/slide-notes?studyId=study%201'
        );
        expect(
            wsiServiceUrl('/wsi', '/annotations?slide_id=abc', 'study1')
        ).toBe('/wsi/annotations?slide_id=abc&studyId=study1');
    });

    it('sends reads with the cookie and without the CSRF header', async () => {
        await wsiServiceFetch('/wsi', '/annotations?slide_id=abc', 'study1');

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('/wsi/annotations?slide_id=abc&studyId=study1');
        expect(init.credentials).toBe('include');
        const headers = init.headers as Headers;
        expect(headers.has('X-Requested-With')).toBe(false);
        expect(headers.has('Content-Type')).toBe(false);
        expect(headers.has('Authorization')).toBe(false);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
        'sends %s with the CSRF header',
        async method => {
            await wsiServiceFetch('/wsi', '/annotations/a1', 'study1', {
                method,
            });

            const [url, init] = fetchImpl.mock.calls[0];
            expect(url).toBe('/wsi/annotations/a1?studyId=study1');
            expect(init.credentials).toBe('include');
            const headers = init.headers as Headers;
            expect(headers.get('X-Requested-With')).toBe('XMLHttpRequest');
            expect(headers.has('Content-Type')).toBe(false);
            expect(headers.has('Authorization')).toBe(false);
        }
    );

    it('sends a body as JSON unless it names another type', async () => {
        await wsiServiceFetch('/wsi', '/annotations', 'study1', {
            method: 'POST',
            body: '{}',
        });
        await wsiServiceFetch('/wsi', '/slide-notes', 'study1', {
            method: 'POST',
            body: '{}',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/geo+json',
            },
        });

        const [first, second] = fetchImpl.mock.calls.map(
            ([, init]) => init.headers as Headers
        );
        expect(first.get('Content-Type')).toBe('application/json');
        expect(second.get('Content-Type')).toBe('application/json');
        expect(second.get('Accept')).toBe('application/geo+json');
    });

    it('sends nothing without a study', async () => {
        await expect(
            wsiServiceFetch('/wsi', '/annotations', undefined)
        ).rejects.toThrow('WSI study is required');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('names 401 and 403 only', () => {
        expect(wsiServiceAccessIssue(401)).toBe('signedOut');
        expect(wsiServiceAccessIssue(403)).toBe('forbidden');
        expect(wsiServiceAccessIssue(404)).toBeNull();
        expect(wsiServiceAccessIssue(500)).toBeNull();
    });
});
