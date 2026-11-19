import {
    PatientHierarchy,
    Sample,
    Slide,
    UNMATCHED_SAMPLE_ID,
    WsiStainKind,
} from './wsiViewerTypes';
import { isServableDiagnosticSlide } from './wsiSlideUtils';
import {
    cleanStain,
    compareSamplesForNavigation,
    normalizeBlockLabel,
    stainQualifier,
} from './wsiNavUtils';
import { blockName, partDisplayName } from './wsiSpecimenUtils';

/**
 * How close a slide is to another in the patient's specimens: cut from the
 * same block, from another block of the same part, or anything else of the
 * patient's.
 */
export type WsiPairLevel = 'block' | 'part' | 'patient';

export interface WsiPairCandidate {
    slide: Slide;
    sample: Sample;
    level: WsiPairLevel;
    /** The other stain of an H&E/IHC pair (IHC for an H&E slide and back). */
    counterpart: boolean;
    /** The option group it is listed under, e.g. "Same block". */
    group: string;
}

const LEVEL_ORDER: Record<WsiPairLevel, number> = {
    block: 0,
    part: 1,
    patient: 2,
};

/**
 * The stains to offer first next to a slide: IHC for H&E, H&E for IHC or
 * anything else (the reference stain).
 */
export function counterpartKinds(kind: WsiStainKind): WsiStainKind[] {
    return kind === 'hne' ? ['ihc'] : ['hne'];
}

/** "H&E", "H&E recut", "IHC TTF-1", for a slide's stain. */
export function slideStainLabel(slide: Slide): string {
    const name = cleanStain(slide.stain_name);
    const group = (slide.stain_group || '').toLowerCase();
    if (slide.stain_kind === 'hne') {
        return group === '' || group.startsWith('h&e')
            ? stainQualifier(slide.stain_group)
            : name || 'H&E';
    }
    if (slide.stain_kind === 'ihc') {
        return /^ihc\b/i.test(name) ? name : `IHC ${name}`.trim();
    }
    return name || slide.stain_group || 'Slide';
}

/** "Part 1 · Block A1", for where a slide was cut from. */
export function slideSpecimenLabel(slide: Slide): string {
    // Some sources already write "Block 1".
    const block = blockName(
        normalizeBlockLabel(slide.block_label, slide.block_number)
    );
    return [partDisplayName(slide), block ? `Block ${block}` : null]
        .filter(Boolean)
        .join(' · ');
}

interface Placed {
    slide: Slide;
    sample: Sample;
    sampleIndex: number;
    partIndex: number;
    blockIndex: number;
    order: number;
}

/**
 * Every servable slide with the sample, part and block it sits in, samples
 * in the slide list's order (unmatched slides last).
 */
function placedSlides(hierarchy: PatientHierarchy): Placed[] {
    const placed: Placed[] = [];
    [...hierarchy.samples]
        .sort(compareSamplesForNavigation)
        .forEach((sample, sampleIndex) =>
            sample.parts.forEach((part, partIndex) =>
                part.blocks.forEach((block, blockIndex) =>
                    block.slides.forEach(slide => {
                        if (!isServableDiagnosticSlide(slide)) return;
                        placed.push({
                            slide,
                            sample,
                            sampleIndex,
                            partIndex,
                            blockIndex,
                            order: placed.length,
                        });
                    })
                )
            )
        );
    return placed;
}

const samePart = (x: Placed, y: Placed) =>
    x.sampleIndex === y.sampleIndex && x.partIndex === y.partIndex;

function otherGroupLabel(entry: Placed): string {
    const sample =
        entry.sample.sample_id === UNMATCHED_SAMPLE_ID
            ? 'Unmatched slides'
            : entry.sample.sample_id;
    const part = partDisplayName(entry.slide);
    return part ? `${sample} · ${part}` : sample;
}

/**
 * The slides to show next to `reference`, closest first: the same block,
 * then the same part, then the rest of the patient's slides by sample and
 * part (the reference's sample first). Within each, the counterpart stain comes first (IHC next to H&E,
 * H&E next to IHC), then the hierarchy's order. The reference itself is
 * left out.
 */
export function pairingCandidates(
    hierarchy: PatientHierarchy | null | undefined,
    reference: Slide | null | undefined
): WsiPairCandidate[] {
    if (!hierarchy) return [];
    const placed = placedSlides(hierarchy);
    const home = reference
        ? placed.find(entry => entry.slide.slide_key === reference.slide_key)
        : undefined;
    const wanted = counterpartKinds(reference?.stain_kind || 'hne');
    // The reference's own sample leads, then the list's order.
    const sampleRank = (entry: Placed) =>
        home && entry.sampleIndex === home.sampleIndex ? -1 : entry.sampleIndex;
    return placed
        .filter(entry => entry.slide.slide_key !== reference?.slide_key)
        .map(entry => {
            const level: WsiPairLevel =
                home && samePart(entry, home)
                    ? entry.blockIndex === home.blockIndex
                        ? 'block'
                        : 'part'
                    : 'patient';
            return {
                entry,
                candidate: {
                    slide: entry.slide,
                    sample: entry.sample,
                    level,
                    counterpart: wanted.includes(entry.slide.stain_kind),
                    group:
                        level === 'block'
                            ? 'Same block'
                            : level === 'part'
                            ? 'Same part'
                            : otherGroupLabel(entry),
                } as WsiPairCandidate,
            };
        })
        .sort(
            (x, y) =>
                LEVEL_ORDER[x.candidate.level] -
                    LEVEL_ORDER[y.candidate.level] ||
                // The rest stays grouped by sample and part.
                (x.candidate.level === 'patient'
                    ? sampleRank(x.entry) - sampleRank(y.entry) ||
                      x.entry.partIndex - y.entry.partIndex
                    : 0) ||
                Number(y.candidate.counterpart) -
                    Number(x.candidate.counterpart) ||
                x.entry.order - y.entry.order
        )
        .map(({ candidate }) => candidate);
}

/** The slide Compare opens next to `reference` first, if any. */
export function defaultPairCandidate(
    hierarchy: PatientHierarchy | null | undefined,
    reference: Slide | null | undefined
): WsiPairCandidate | undefined {
    return pairingCandidates(hierarchy, reference)[0];
}

/** Candidates in their option groups, in order. */
export function groupPairCandidates(
    candidates: WsiPairCandidate[]
): Array<{ group: string; candidates: WsiPairCandidate[] }> {
    const groups: Array<{ group: string; candidates: WsiPairCandidate[] }> = [];
    candidates.forEach(candidate => {
        const last = groups[groups.length - 1];
        if (last && last.group === candidate.group) {
            last.candidates.push(candidate);
        } else {
            groups.push({ group: candidate.group, candidates: [candidate] });
        }
    });
    return groups;
}
