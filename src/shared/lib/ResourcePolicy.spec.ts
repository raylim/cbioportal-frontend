import { assert } from 'chai';
import { getServerConfig } from 'config/config';
import {
    isPatientViewResourceTab,
    isStudyViewResourceTab,
    isWsiResourceId,
    isWsiTileServerConfigured,
    patientViewPathForResource,
    shouldHideLegacyHeResource,
    shouldHideLegacyHeResourceTab,
    slideStainFilterForColumnFilters,
    withSlideStainFilter,
} from './ResourcePolicy';

describe('legacy H&E resource policy', () => {
    let savedTileServerUrl: unknown;

    beforeEach(() => {
        savedTileServerUrl = (getServerConfig() as any).msk_wsi_tile_server_url;
        (getServerConfig() as any).msk_wsi_tile_server_url =
            'https://slides.example.com';
    });

    afterEach(() => {
        (getServerConfig() as any).msk_wsi_tile_server_url = savedTileServerUrl;
    });

    it('returns false for an empty tile server URL', () => {
        (getServerConfig() as any).msk_wsi_tile_server_url = '';
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

    it('hides legacy H&E resources by id only', () => {
        assert.isTrue(shouldHideLegacyHeResource({ resourceId: 'MSK_HNE' }));
        assert.isTrue(
            shouldHideLegacyHeResource({
                resourceDefinition: { resourceId: 'HE' } as any,
            })
        );
        assert.isFalse(
            shouldHideLegacyHeResource({
                resourceDefinition: {
                    resourceId: 'OTHER',
                    displayName: 'H&E Slides',
                } as any,
            })
        );
    });

    it('keeps legacy H&E resources visible when no tile server is configured', () => {
        (getServerConfig() as any).msk_wsi_tile_server_url = '';
        assert.isFalse(shouldHideLegacyHeResourceTab('MSK_HNE'));
        assert.isFalse(shouldHideLegacyHeResource({ resourceId: 'MSK_HNE' }));
    });

    it('lists the slide table in study view and no slide resources in the patient view', () => {
        assert.isTrue(isStudyViewResourceTab('WSI_SAMPLE'));
        assert.isFalse(isStudyViewResourceTab('WSI_PATIENT'));
        assert.isTrue(isStudyViewResourceTab('OTHER'));
        assert.isFalse(isPatientViewResourceTab('WSI_SAMPLE'));
        assert.isFalse(isPatientViewResourceTab('WSI_PATIENT'));
        assert.isTrue(isPatientViewResourceTab('OTHER'));
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
        assert.equal(
            withSlideStainFilter(
                '/patient/wsiHESlides?studyId=s&caseId=P-1',
                'ihc'
            ),
            '/patient/wsiHESlides?studyId=s&caseId=P-1&pathologySlideSettings=%7B%22stainFilter%22%3A%22ihc%22%7D'
        );
        assert.equal(
            withSlideStainFilter('/patient/wsiHESlides?caseId=P-1', undefined),
            '/patient/wsiHESlides?caseId=P-1'
        );
    });

    it('keeps legacy H&E resources out of both resource tables', () => {
        assert.isFalse(isStudyViewResourceTab('MSK_HNE'));
        assert.isFalse(isPatientViewResourceTab('HE'));
    });

    it('recognises the whole-slide image resource ids', () => {
        assert.isTrue(isWsiResourceId('WSI_SAMPLE'));
        assert.isTrue(isWsiResourceId('WSI_PATIENT'));
        assert.isFalse(isWsiResourceId('HE'));
        assert.isFalse(isWsiResourceId(undefined));
    });
});
