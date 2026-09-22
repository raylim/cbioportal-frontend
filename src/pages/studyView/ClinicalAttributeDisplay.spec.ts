import { getClinicalAttributeDisplayName } from './ClinicalAttributeDisplay';

describe('study clinical attribute display names', () => {
    it('uses the study presentation names for WSI attributes', () => {
        expect(
            getClinicalAttributeDisplayName({
                clinicalAttributeId: 'WSI_TIMEPOINT',
                displayName: 'WSI Timepoint',
            } as any)
        ).toBe('WSI Timepoint Bin');
    });
});
