import { spatialOrder } from './wsiAnnotationSpatial';

const box = (id: string, x: number, y: number, size = 10) => ({
    id,
    bounds: { minX: x, minY: y, maxX: x + size, maxY: y + size },
});

describe('spatialOrder', () => {
    it('starts at the top left and goes to the nearest next item', () => {
        expect(
            spatialOrder([
                box('far', 5000, 5000),
                box('b', 120, 0),
                box('topLeft', 0, 0),
                box('c', 120, 130),
                box('a', 0, 110),
            ])
        ).toEqual(['topLeft', 'a', 'c', 'b', 'far']);
    });

    it('keeps one or no items as they are', () => {
        expect(spatialOrder([])).toEqual([]);
        expect(spatialOrder([box('only', 7, 7)])).toEqual(['only']);
    });

    it('orders many items by bands, alternating direction', () => {
        const items = [];
        for (let i = 0; i < 3100; i++) {
            items.push(
                box(
                    `r${Math.floor(i / 100)}-${i % 100}`,
                    (i % 100) * 20,
                    Math.floor(i / 100) * 40
                )
            );
        }
        const order = spatialOrder(items);
        expect(order).toHaveLength(3100);
        // The first band goes left to right, the next right to left.
        expect(order.slice(0, 2)).toEqual(['r0-0', 'r0-1']);
        expect(order.slice(100, 102)).toEqual(['r1-99', 'r1-98']);
    });
});
