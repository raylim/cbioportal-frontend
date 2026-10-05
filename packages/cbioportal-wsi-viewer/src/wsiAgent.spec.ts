import {
    buildWsiAgentEmbeddingContext,
    buildWsiAgentSlideMetadata,
} from './wsiAgent';

describe('buildWsiAgentSlideMetadata', () => {
    it('keeps only the pyramid shape and scan properties', () => {
        const metadata = buildWsiAgentSlideMetadata({
            dimensions: { width: 100, height: 80 },
            levels: 1,
            level_dimensions: [{ width: 100, height: 80 }],
            level_downsamples: [1],
            max_zoom: 7,
            tile_size: 256,
            mpp: { x: 0.25, y: 0.25 },
            objective_power: 40,
            vendor: 'aperio',
            decode_policy_version: 'v1',
            image_id: 'leaked-image-id',
            source: 's3://bucket/leaked-image-id.svs',
        } as any);

        expect(metadata).toEqual({
            dimensions: { width: 100, height: 80 },
            levels: 1,
            level_dimensions: [{ width: 100, height: 80 }],
            level_downsamples: [1],
            max_zoom: 7,
            tile_size: 256,
            mpp: { x: 0.25, y: 0.25 },
            objective_power: 40,
            vendor: 'aperio',
        });
    });
});

describe('buildWsiAgentEmbeddingContext', () => {
    it('names the study slides by their unique slide keys', () => {
        const a = '0123456789abcdef0123456789abcdef';
        const b = 'fedcba9876543210fedcba9876543210';
        expect(
            buildWsiAgentEmbeddingContext('coad_msk_2025', [a, b, a, ''])
        ).toEqual({ provider: 'quiltnet', scope: 'study', slide_keys: [a, b] });
        expect(buildWsiAgentEmbeddingContext('other_study', [a])).toBe(
            undefined
        );
    });
});
