import {
    formatWsiHash,
    hashUrlState,
    readWsiHashFilters,
    readWsiHashState,
    writeOnlyWsiHashFilters,
    writeSelectedSlideState,
    writeWsiHashFilters,
} from './wsiViewStateUtils';

describe('slide list filters in the #wsi: hash', () => {
    beforeEach(() => {
        window.history.replaceState(null, '', '/patient?caseId=P-1');
    });

    it('formats and reads the filters beside the slide and viewport', () => {
        expect(
            formatWsiHash(
                { slideId: 'a', x: 1, y: 2, z: 0.5 },
                { stain: 'hne', match: 'unmatched' }
            )
        ).toBe('wsi:slide=a&x=1&y=2&z=0.500000&stain=hne&match=unmatched');
        expect(formatWsiHash(null, { stain: 'ihc' })).toBe('wsi:stain=ihc');
        expect(formatWsiHash(null)).toBe('');

        window.location.hash = 'wsi:slide=a&stain=ihc&match=block';
        expect(readWsiHashFilters()).toEqual({ stain: 'ihc', match: 'block' });
        expect(readWsiHashState()).toEqual({ slideId: 'a' });
    });

    it('ignores unknown filter values', () => {
        window.location.hash = 'wsi:slide=a&stain=all&match=bogus';
        expect(readWsiHashFilters()).toEqual({});
    });

    it('keeps the filters when the viewer writes or clears the slide', () => {
        writeWsiHashFilters('hne', 'all');
        hashUrlState.write({ slideId: 'b', x: 3, y: 4, z: 1 });
        expect(window.location.hash).toBe(
            '#wsi:slide=b&x=3&y=4&z=1.000000&stain=hne'
        );

        hashUrlState.clear();
        expect(window.location.hash).toBe('#wsi:stain=hne');

        writeWsiHashFilters('all', 'all');
        expect(window.location.hash).toBe('');
    });

    it('replaces the hash with only the filters for another patient', () => {
        window.location.hash = 'wsi:slide=a&x=1&y=2&z=1.000000&stain=ihc';
        writeOnlyWsiHashFilters(readWsiHashFilters());
        expect(window.location.hash).toBe('#wsi:stain=ihc');
    });

    it('gives another slide its own history entry, but not the first slide', () => {
        const push = jest.spyOn(window.history, 'pushState');
        try {
            writeSelectedSlideState(hashUrlState, 'first');
            expect(push).not.toHaveBeenCalled();

            writeSelectedSlideState(hashUrlState, 'second');
            expect(push).toHaveBeenCalledTimes(1);
            expect(window.location.hash).toBe('#wsi:slide=second');
        } finally {
            push.mockRestore();
        }
    });
});
