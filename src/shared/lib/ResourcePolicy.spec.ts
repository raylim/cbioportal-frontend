import { assert } from 'chai';
import { getServerConfig } from 'config/config';
import {
    isHiddenFromResourceViews,
    isHiddenFromStudyResourceTable,
    isWsiResourceId,
    isWsiTileServerConfigured,
    patientViewPathForResource,
    resourceMetadataDisplayValue,
    resourceSearchTermForQuery,
    slideKeyFromSlideUrl,
    shouldHideLegacyHeResourceTab,
    slideStainFilterForColumnFilters,
    slideStainFilterQuery,
} from './ResourcePolicy';

describe('legacy H&E resource policy', () => {
    let savedTileServerUrl: unknown;

    beforeEach(() => {
        savedTileServerUrl = (getServerConfig() as any).wsi_tile_server_url;
        (getServerConfig() as any).wsi_tile_server_url =
            'https://slides.example.com';
    });

    afterEach(() => {
        (getServerConfig() as any).wsi_tile_server_url = savedTileServerUrl;
    });

    it('returns false for an empty tile server URL', () => {
        (getServerConfig() as any).wsi_tile_server_url = '';
        assert.isFalse(isWsiTileServerConfigured());
    });

    it('returns true for a non-empty tile server URL', () => {
        assert.isTrue(isWsiTileServerConfigured());
    });

    it('hides legacy H&E resource tabs when the native viewer is configured', () => {
        assert.isTrue(shouldHideLegacyHeResourceTab('HE'));
        assert.isTrue(shouldHideLegacyHeResourceTab('MSK_HNE'));
        assert.isFalse(shouldHideLegacyHeResourceTab('OTHER'));
    });

    it('keeps legacy H&E resources visible when no tile server is configured', () => {
        (getServerConfig() as any).wsi_tile_server_url = '';
        assert.isFalse(shouldHideLegacyHeResourceTab('MSK_HNE'));
    });

    it('lists the slide table in study view and no slide resources in the patient view', () => {
        // With the viewer configured, the Pathology Slides tab shows the slide table.
        assert.isTrue(isHiddenFromStudyResourceTable('WSI_SAMPLE'));
        assert.isTrue(isHiddenFromStudyResourceTable('WSI_PATIENT'));
        assert.isFalse(isHiddenFromStudyResourceTable('OTHER'));
        assert.isTrue(isHiddenFromResourceViews('WSI_SAMPLE'));
        assert.isTrue(isHiddenFromResourceViews('WSI_PATIENT'));
        assert.isFalse(isHiddenFromResourceViews('OTHER'));

        (getServerConfig() as any).wsi_tile_server_url = '';
        assert.isFalse(isHiddenFromStudyResourceTable('WSI_SAMPLE'));
        assert.isTrue(isHiddenFromStudyResourceTable('WSI_PATIENT'));
    });

    it('reads the slide key from a slide row link', () => {
        const key = '0123456789ab';
        assert.equal(
            slideKeyFromSlideUrl(
                `https://portal.example.org/wsi/patient/P-1?studyId=s&slideKey=${key}`
            ),
            key
        );
        assert.isUndefined(
            slideKeyFromSlideUrl(
                'https://portal.example.org/wsi/patient/P-1?studyId=s'
            )
        );
        assert.isUndefined(slideKeyFromSlideUrl('?slideKey=short'));
        // A retired 32-hex key is not a slide key.
        assert.isUndefined(
            slideKeyFromSlideUrl(`?slideKey=${key}0123456789abcdef0123`)
        );
        assert.isUndefined(slideKeyFromSlideUrl(undefined));
    });

    it('links slide rows to Pathology Slides and other rows to Files & Links', () => {
        assert.equal(
            patientViewPathForResource('WSI_SAMPLE'),
            'patient/wsiHESlides'
        );
        assert.equal(
            patientViewPathForResource('IDC_OHIF_V2'),
            'patient/filesAndLinks'
        );
        assert.equal(
            patientViewPathForResource(undefined),
            'patient/filesAndLinks'
        );
    });

    it('carries a single stain group filter to the slide links', () => {
        const stainGroup = (operator: string, values: string[]) => [
            { columnId: 'metadata:stain_group', operator, values },
        ];
        assert.equal(
            slideStainFilterForColumnFilters(stainGroup('in', ['IHC'])),
            'ihc'
        );
        assert.equal(
            slideStainFilterForColumnFilters(stainGroup('in', ['H&E'])),
            'hne'
        );
        assert.isUndefined(
            slideStainFilterForColumnFilters(stainGroup('in', ['H&E', 'IHC']))
        );
        assert.isUndefined(
            slideStainFilterForColumnFilters(stainGroup('notIn', ['IHC']))
        );
        assert.isUndefined(
            slideStainFilterForColumnFilters([
                {
                    columnId: 'metadata:magnification',
                    operator: 'in',
                    values: ['40x'],
                },
            ])
        );
        assert.deepEqual(slideStainFilterQuery('ihc'), {
            pathologySlideSettings: '{"stainFilter":"ihc"}',
        });
        assert.deepEqual(slideStainFilterQuery(undefined), {});
    });

    it('keeps legacy H&E resources out of both resource tables', () => {
        assert.isTrue(isHiddenFromStudyResourceTable('MSK_HNE'));
        assert.isTrue(isHiddenFromResourceViews('HE'));
    });

    it('recognises the whole-slide image resource ids', () => {
        assert.isTrue(isWsiResourceId('WSI_SAMPLE'));
        assert.isTrue(isWsiResourceId('WSI_PATIENT'));
        assert.isFalse(isWsiResourceId('HE'));
        assert.isFalse(isWsiResourceId(undefined));
    });
});

describe('slide ID display', () => {
    it('shows a slide table slide key as a WSI- Slide ID', () => {
        assert.equal(
            resourceMetadataDisplayValue(
                'WSI_SAMPLE',
                'slide_key',
                '1234094d6bc6'
            ),
            'WSI-1234-094d-6bc6'
        );
    });

    it('leaves other columns and other resources unchanged', () => {
        assert.equal(
            resourceMetadataDisplayValue('WSI_SAMPLE', 'stain_name', 'H&E'),
            'H&E'
        );
        assert.equal(
            resourceMetadataDisplayValue('NOTES', 'slide_key', '1234094d6bc6'),
            '1234094d6bc6'
        );
    });

    it.each([
        'WSI-1234-094D-6bc6',
        'wsi-1234-094d-6bc6',
        '1234-094d-6bc6',
        'WSI-1234094d6bc6',
    ])(
        'searches a slide table for the bare key of a pasted Slide ID %p',
        term => {
            assert.equal(
                resourceSearchTermForQuery('WSI_SAMPLE', term),
                '1234094d6bc6'
            );
        }
    );

    it('leaves other searches unchanged', () => {
        assert.equal(
            resourceSearchTermForQuery('WSI_SAMPLE', 'P-0000012-T06-IM7'),
            'P-0000012-T06-IM7'
        );
        assert.equal(
            resourceSearchTermForQuery('WSI_SAMPLE', '1234094d6bc6'),
            '1234094d6bc6'
        );
        assert.equal(
            resourceSearchTermForQuery('NOTES', '1234-094d-6bc6'),
            '1234-094d-6bc6'
        );
        assert.equal(
            resourceSearchTermForQuery('NOTES', 'WSI-1234-094d-6bc6'),
            'WSI-1234-094d-6bc6'
        );
    });
});
