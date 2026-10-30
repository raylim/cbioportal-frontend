import {
    clearAnnotationAccessToken,
    clearWsiPurposeAccessTokens,
    clearWsiSlideSources,
    getAgentAccessToken,
    getAnnotationAccessToken,
    getWsiSlideSource,
    getWsiSourceFingerprint,
    registerWsiSlideSources,
    wsiSlideRegistryGeneration,
} from './wsiAuth';
import {
    makeTileMetadata,
    registerTestSlide,
    TEST_SEALED_SOURCE,
} from './wsiTestFixtures';
import { configureWsiViewerRuntime, WsiViewerConfig } from './wsiViewerConfig';

function hierarchy(
    slideKeys: string[],
    slideOverrides: Record<string, unknown> = {}
): any {
    return {
        patient_id: 'patient-1',
        samples: [
            {
                sample_id: 'S-1',
                parts: [
                    {
                        blocks: [
                            {
                                slides: slideKeys.map(slideKey => ({
                                    slide_key: slideKey,
                                    resource_id: 'WSI_SAMPLE',
                                    serving_key: slideKey,
                                    sealed_source: TEST_SEALED_SOURCE,
                                    tile_metadata: makeTileMetadata(),
                                    ...slideOverrides,
                                })),
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

describe('WSI slide sources', () => {
    beforeEach(() => {
        clearWsiSlideSources();
        global.fetch = jest.fn() as typeof fetch;
    });

    it('returns the serving fields of a registered slide without any request', () => {
        registerTestSlide('study-1', 'patient-1', 'slide-1');

        expect(getWsiSlideSource('study-1', 'slide-1')).toEqual({
            slideKey: 'slide-1',
            servingKey: 'slide-1',
            sealedSource: TEST_SEALED_SOURCE,
            tileMetadata: makeTileMetadata(),
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects tile metadata with a non-current decode policy', () => {
        registerWsiSlideSources(
            'study-1',
            hierarchy(['slide-1'], {
                tile_metadata: makeTileMetadata({
                    decode_policy_version:
                        'geometry-v2;tile-max=4194304;thumbnail-max=4194304',
                    max_decode_pixels: 4194304,
                    thumbnail_max_decode_pixels: 4194304,
                }),
            })
        );

        expect(() => getWsiSlideSource('study-1', 'slide-1')).toThrow(
            'Invalid WSI decode policy'
        );
    });

    it('rejects tile metadata without the schema version', () => {
        const { tile_metadata_schema_version, ...legacy } = makeTileMetadata();
        registerWsiSlideSources(
            'study-1',
            hierarchy(['slide-1'], { tile_metadata: legacy })
        );

        expect(() => getWsiSlideSource('study-1', 'slide-1')).toThrow(
            'Invalid WSI tile metadata schema'
        );
    });

    it('rejects an unknown slide', () => {
        registerWsiSlideSources('study-1', hierarchy(['slide-1']));

        expect(() => getWsiSlideSource('study-1', 'unknown-slide')).toThrow(
            'WSI resource selection is unavailable'
        );
        expect(() => getWsiSlideSource('other-study', 'slide-1')).toThrow(
            'WSI resource selection is unavailable'
        );
    });

    it('replaces every slide of a patient on re-registration', () => {
        registerWsiSlideSources('study-1', hierarchy(['slide-1', 'slide-2']));
        registerWsiSlideSources('study-1', hierarchy(['slide-1']));

        expect(getWsiSlideSource('study-1', 'slide-1').slideKey).toBe(
            'slide-1'
        );
        expect(() => getWsiSlideSource('study-1', 'slide-2')).toThrow(
            'WSI resource selection is unavailable'
        );
    });

    it('skips registration captured before a clear', () => {
        const generation = wsiSlideRegistryGeneration();
        clearWsiSlideSources('other-study');

        expect(
            registerWsiSlideSources(
                'study-1',
                hierarchy(['slide-1']),
                generation
            )
        ).toBe(false);
        expect(() => getWsiSlideSource('study-1', 'slide-1')).toThrow(
            'WSI resource selection is unavailable'
        );

        expect(
            registerWsiSlideSources(
                'study-1',
                hierarchy(['slide-1']),
                wsiSlideRegistryGeneration()
            )
        ).toBe(true);
        expect(getWsiSlideSource('study-1', 'slide-1').slideKey).toBe(
            'slide-1'
        );
    });

    it('does not advance the generation when registering', () => {
        const generation = wsiSlideRegistryGeneration();
        registerWsiSlideSources('study-1', hierarchy(['slide-1']));
        registerWsiSlideSources('study-1', hierarchy(['slide-2']));

        expect(wsiSlideRegistryGeneration()).toBe(generation);
    });

    it('forgets the slides of one study only', () => {
        registerWsiSlideSources('study-1', hierarchy(['slide-1']));
        registerWsiSlideSources('study-2', hierarchy(['slide-1']));

        clearWsiSlideSources('study-1');

        expect(() => getWsiSlideSource('study-1', 'slide-1')).toThrow(
            'WSI resource selection is unavailable'
        );
        expect(getWsiSlideSource('study-2', 'slide-1').slideKey).toBe(
            'slide-1'
        );
    });

    it.each(['serving_key', 'sealed_source', 'tile_metadata'])(
        'rejects a slide without %s',
        field => {
            registerWsiSlideSources(
                'study-1',
                hierarchy(['slide-1'], { [field]: undefined })
            );

            expect(() => getWsiSlideSource('study-1', 'slide-1')).toThrow(
                'WSI slide cannot serve tiles'
            );
        }
    );

    it('fingerprints a slide source by its slide key and pyramid shape', () => {
        const slideKey = '0123456789ab';
        const source = {
            slideKey,
            servingKey: slideKey,
            sealedSource: TEST_SEALED_SOURCE,
            tileMetadata: {
                dimensions: { width: 100, height: 80 },
                levels: 3,
                tile_size: 256,
            },
        } as any;

        expect(getWsiSourceFingerprint(source)).toBe(
            `wsi-v3:${slideKey}:100x80:3:256`
        );
        expect(
            getWsiSourceFingerprint({ ...source, sealedSource: 'other' })
        ).toBe(getWsiSourceFingerprint(source));
    });
});

function configureRuntime(overrides: Partial<WsiViewerConfig> = {}) {
    configureWsiViewerRuntime({
        buildApiUrl: (path: string) => `/${path}`,
        ...overrides,
    });
}

describe('WSI purpose access tokens', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        clearWsiPurposeAccessTokens();
        configureRuntime();
        global.fetch = jest.fn() as typeof fetch;
    });

    it('does not reuse annotation capabilities across authenticated subjects', async () => {
        jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'annotation-a',
                    expires_in: 300,
                }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'annotation-b',
                    expires_in: 300,
                }),
            } as Response);

        await expect(
            getAnnotationAccessToken('study-1', 'user-a')
        ).resolves.toBe('annotation-a');
        await expect(
            getAnnotationAccessToken('study-1', 'user-b')
        ).resolves.toBe('annotation-b');
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
            'purpose=annotations'
        );
        clearAnnotationAccessToken();
    });

    it('does not reuse agent capabilities across authenticated subjects', async () => {
        jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'agent-a',
                    expires_in: 300,
                }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'agent-b',
                    expires_in: 300,
                }),
            } as Response);

        await expect(getAgentAccessToken('study-1', 'user-a')).resolves.toBe(
            'agent-a'
        );
        await expect(getAgentAccessToken('study-1', 'user-b')).resolves.toBe(
            'agent-b'
        );
        expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
            'purpose=agent'
        );
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('keeps annotation and agent tokens apart', async () => {
        const fetchImpl = jest.fn(async (url: string) => {
            const purpose = new URL(url).searchParams.get('purpose');
            return {
                ok: true,
                json: async () => ({
                    access_token: `${purpose}-token`,
                    expires_in: 300,
                }),
            } as Response;
        });
        configureRuntime({ fetchImpl: (fetchImpl as unknown) as typeof fetch });

        await expect(
            getAnnotationAccessToken('study-1', 'user-a')
        ).resolves.toBe('annotations-token');
        await expect(getAgentAccessToken('study-1', 'user-a')).resolves.toBe(
            'agent-token'
        );
        await expect(getAgentAccessToken('study-1', 'user-a')).resolves.toBe(
            'agent-token'
        );
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('requests annotation tokens through the injected host services', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: 'annotation', expires_in: 300 }),
        } as Response);
        configureRuntime({
            buildApiUrl: (path: string) => `/portal/${path}`,
            fetchImpl: fetchImpl as typeof fetch,
        });

        await expect(
            getAnnotationAccessToken('study 1', 'user-a')
        ).resolves.toBe('annotation');
        await expect(
            getAnnotationAccessToken('study 1', ' user-a ')
        ).resolves.toBe('annotation');

        expect(global.fetch).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(url.pathname).toBe('/portal/api/wsi/access-token');
        expect(url.searchParams.get('studyId')).toBe('study 1');
        expect(url.searchParams.get('purpose')).toBe('annotations');
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({
            credentials: 'same-origin',
            cache: 'no-store',
        });
    });

    it('forgets the purpose tokens of one study only', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: 'annotation', expires_in: 300 }),
        } as Response);
        configureRuntime({ fetchImpl: fetchImpl as typeof fetch });

        await getAnnotationAccessToken('study-1', 'user-a');
        await getAnnotationAccessToken('study-2', 'user-a');
        clearWsiPurposeAccessTokens('study-1');
        await getAnnotationAccessToken('study-1', 'user-a');
        await getAnnotationAccessToken('study-2', 'user-a');
        expect(fetchImpl).toHaveBeenCalledTimes(3);

        clearAnnotationAccessToken();
        await getAnnotationAccessToken('study-2', 'user-a');
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it('does not cache an annotation token requested before a clear', async () => {
        let resolveFirst!: (response: Response) => void;
        const fetchImpl = jest
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<Response>(resolve => {
                        resolveFirst = resolve;
                    })
            )
            .mockResolvedValue({
                ok: true,
                json: async () => ({ access_token: 'fresh', expires_in: 300 }),
            } as Response);
        configureRuntime({ fetchImpl: fetchImpl as typeof fetch });

        const stale = getAnnotationAccessToken('study-1', 'user-a');
        clearAnnotationAccessToken('study-1');
        resolveFirst({
            ok: true,
            json: async () => ({ access_token: 'stale', expires_in: 300 }),
        } as Response);
        await expect(stale).resolves.toBe('stale');

        await expect(
            getAnnotationAccessToken('study-1', 'user-a')
        ).resolves.toBe('fresh');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('rejects an annotation token response without a lifetime', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: 'annotation', expires_in: 0 }),
        } as Response);

        await expect(getAnnotationAccessToken('study-1')).rejects.toThrow(
            'Invalid WSI authorization response'
        );
        await expect(getAnnotationAccessToken('')).rejects.toThrow(
            'WSI study scope is required'
        );
    });
});
