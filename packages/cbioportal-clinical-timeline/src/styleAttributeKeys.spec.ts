import { COLOR_ATTRIBUTE_KEY, SHAPE_ATTRIBUTE_KEY } from './styleAttributeKeys';

describe('styleAttributeKeys', () => {
    it('exports the canonical color style attribute key', () => {
        expect(COLOR_ATTRIBUTE_KEY).toBe('STYLE_COLOR');
    });

    it('exports the canonical shape style attribute key', () => {
        expect(SHAPE_ATTRIBUTE_KEY).toBe('STYLE_SHAPE');
    });

    it('keeps the style attribute keys distinct', () => {
        expect(COLOR_ATTRIBUTE_KEY).not.toBe(SHAPE_ATTRIBUTE_KEY);
    });
});
