import { getClinicalAttributeDisplayName } from './ClinicalAttributeDisplay';

describe('patient clinical attribute display names', () => {
    it('uses the patient presentation names for WSI attributes', () => {
        expect(
            getClinicalAttributeDisplayName({
                clinicalAttributeId: 'WSI_SLIDE_COUNT',
                displayName: 'WSI Slide Count',
            } as any)
        ).toBe('WSI Slide Count (Viewable)');
    });
});
