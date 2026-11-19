import { WsiPoint } from './wsiAnnotationGeometryUtils';
import { WsiAlignmentPair, WsiTransformModel } from './wsiCompareTransform';

/**
 * A slide pair's alignment as kept in this browser: the point pairs, the
 * model, and the anchor of unaligned sync. Stored under the two slide keys
 * in sorted order, with the points of the first-sorted slide as `first`, so
 * the pair finds it with either slide on the left.
 */
export interface WsiStoredAlignment {
    pairs: WsiAlignmentPair[];
    model: WsiTransformModel;
    anchor: { left: WsiPoint; right: WsiPoint } | null;
}

interface StoredRecord {
    v: 1;
    model: WsiTransformModel;
    pairs: Array<{
        id: string;
        first: WsiPoint | null;
        second: WsiPoint | null;
    }>;
    anchor: { first: WsiPoint; second: WsiPoint } | null;
    savedAt: string;
}

export const WSI_ALIGNMENT_STORAGE_PREFIX = 'wsi-compare-alignment:v1:';

/** The storage key of a slide pair, the same either way round. */
export function alignmentStorageKey(leftKey: string, rightKey: string): string {
    const [first, second] = [leftKey, rightKey].sort();
    return `${WSI_ALIGNMENT_STORAGE_PREFIX}${first}:${second}`;
}

function storage(): Storage | null {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch (_) {
        return null;
    }
}

function isPoint(value: unknown): value is WsiPoint {
    const point = value as WsiPoint | null;
    return (
        !!point &&
        typeof point === 'object' &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y)
    );
}

function pointOrNull(value: unknown): WsiPoint | null {
    return isPoint(value) ? { x: value.x, y: value.y } : null;
}

/**
 * The stored alignment of the slide pair, read with `leftKey` on the left;
 * null when there is none, it cannot be read, or storage is off.
 */
export function loadAlignment(
    leftKey: string,
    rightKey: string
): WsiStoredAlignment | null {
    let raw: string | null = null;
    try {
        raw =
            storage()?.getItem(alignmentStorageKey(leftKey, rightKey)) ?? null;
    } catch (_) {
        return null;
    }
    if (!raw) return null;
    try {
        const record = JSON.parse(raw) as StoredRecord;
        if (!record || record.v !== 1 || !Array.isArray(record.pairs)) {
            return null;
        }
        const leftFirst = leftKey <= rightKey;
        const pairs = record.pairs
            .filter(pair => pair && typeof pair.id === 'string')
            .map(pair => {
                const first = pointOrNull(pair.first);
                const second = pointOrNull(pair.second);
                return {
                    id: pair.id,
                    left: leftFirst ? first : second,
                    right: leftFirst ? second : first,
                };
            })
            .filter(pair => pair.left || pair.right);
        const anchor =
            record.anchor &&
            isPoint(record.anchor.first) &&
            isPoint(record.anchor.second)
                ? leftFirst
                    ? { left: record.anchor.first, right: record.anchor.second }
                    : { left: record.anchor.second, right: record.anchor.first }
                : null;
        return {
            pairs,
            model: record.model === 'affine' ? 'affine' : 'similarity',
            anchor,
        };
    } catch (_) {
        return null;
    }
}

/**
 * Keeps the slide pair's alignment; an empty one (no points, no anchor) is
 * removed. Returns whether it was written.
 */
export function saveAlignment(
    leftKey: string,
    rightKey: string,
    alignment: WsiStoredAlignment
): boolean {
    const store = storage();
    if (!store) return false;
    const key = alignmentStorageKey(leftKey, rightKey);
    try {
        if (!alignment.pairs.length && !alignment.anchor) {
            store.removeItem(key);
            return true;
        }
        const leftFirst = leftKey <= rightKey;
        const record: StoredRecord = {
            v: 1,
            model: alignment.model,
            pairs: alignment.pairs.map(pair => ({
                id: pair.id,
                first: leftFirst ? pair.left : pair.right,
                second: leftFirst ? pair.right : pair.left,
            })),
            anchor: alignment.anchor
                ? leftFirst
                    ? {
                          first: alignment.anchor.left,
                          second: alignment.anchor.right,
                      }
                    : {
                          first: alignment.anchor.right,
                          second: alignment.anchor.left,
                      }
                : null,
            savedAt: new Date().toISOString(),
        };
        store.setItem(key, JSON.stringify(record));
        return true;
    } catch (_) {
        return false;
    }
}

/** Forgets the slide pair's alignment. */
export function clearAlignment(leftKey: string, rightKey: string): void {
    try {
        storage()?.removeItem(alignmentStorageKey(leftKey, rightKey));
    } catch (_) {
        // storage off
    }
}
