import { GenePanelIdSpecialValue } from 'shared/lib/StoreUtils';
import { Mutation } from 'cbioportal-ts-api-client';
import { MutationFrequenciesBySample } from 'pages/patientView/vafPlot/VAFPlot';

export interface IIconData {
    genePanelId: string | undefined;
    color: string;
    label: string;
}

export interface IKeyedIconData {
    [id: string]: IIconData;
}

export const IGV_TRACK_SAMPLE_EXPAND_HEIGHT = 18;
export const COLOR_GENEPANEL_ICON = 'blue';
export const COLOR_WHOLEGENOME_ICON = '#007fff';
export const PREFIX_GENEPANEL_LABEL = 'P';
export const WHOLEGENOME_LABEL = 'W';
export const wholeGenomeIconData: IIconData = {
    label: WHOLEGENOME_LABEL,
    color: COLOR_WHOLEGENOME_ICON,
    genePanelId: undefined,
};

export function getGenePanelIds(
    sampleIdToMutationGenePanelId?: { [sampleId: string]: string },
    sampleIdToCopyNumberGenePanelId?: { [sampleId: string]: string }
) {
    const seen = new Set<string>();
    const genePanelIds: string[] = [];

    if (sampleIdToMutationGenePanelId) {
        for (const genePanelId of Object.values(sampleIdToMutationGenePanelId)) {
            if (!seen.has(genePanelId)) {
                seen.add(genePanelId);
                genePanelIds.push(genePanelId);
            }
        }
    }

    if (sampleIdToCopyNumberGenePanelId) {
        for (const genePanelId of Object.values(
            sampleIdToCopyNumberGenePanelId
        )) {
            if (!seen.has(genePanelId)) {
                seen.add(genePanelId);
                genePanelIds.push(genePanelId);
            }
        }
    }

    return genePanelIds;
}

export function genePanelIdToIconData(
    genePanelIds: (string | undefined)[]
): IKeyedIconData {
    const lookupTable: IKeyedIconData = {};
    const uniqueGenePanelIds: string[] = [];
    const seen = new Set<string>();
    const wholeGenomeIndicators = new Set<string>();
    for (const indicator of Object.values(GenePanelIdSpecialValue)) {
        if (indicator !== undefined) {
            wholeGenomeIndicators.add(indicator);
        }
    }

    for (const genePanelId of genePanelIds) {
        if (genePanelId !== undefined && !seen.has(genePanelId)) {
            seen.add(genePanelId);
            uniqueGenePanelIds.push(genePanelId);
        }
    }

    uniqueGenePanelIds.sort();

    let genePanelIndex = 1;
    for (const genePanelId of uniqueGenePanelIds) {
        if (wholeGenomeIndicators.has(genePanelId)) {
            lookupTable[genePanelId] = {
                ...wholeGenomeIconData,
                genePanelId,
            };
        } else {
            lookupTable[genePanelId] = {
                genePanelId,
                label: PREFIX_GENEPANEL_LABEL + genePanelIndex,
                color: COLOR_GENEPANEL_ICON,
            };
            genePanelIndex++;
        }
    }

    return lookupTable;
}

export function sampleIdToIconData(
    sampleIdToGenePanelId:
        | { [sampleId: string]: string | undefined }
        | undefined,
    iconLookupTable: IKeyedIconData
): IKeyedIconData {
    if (!sampleIdToGenePanelId) {
        return {};
    }

    const wholeGenomeIndicators = new Set<string>();
    for (const indicator of Object.values(GenePanelIdSpecialValue)) {
        if (indicator !== undefined) {
            wholeGenomeIndicators.add(indicator);
        }
    }
    let hasNonWholeGenomeGenePanelId = false;

    for (const genePanelId of Object.values(sampleIdToGenePanelId)) {
        if (
            genePanelId !== undefined &&
            !wholeGenomeIndicators.has(genePanelId)
        ) {
            hasNonWholeGenomeGenePanelId = true;
            break;
        }
    }

    if (!hasNonWholeGenomeGenePanelId) {
        return {};
    }

    // samples where genePanelId is undefined represent a whole-genome analysis
    // undefined genePanelIds are not represented in the lookup table
    const lookupTable: IKeyedIconData = {};
    for (const sampleId of Object.keys(sampleIdToGenePanelId)) {
        const genePanelId = sampleIdToGenePanelId[sampleId];
        if (
            genePanelId !== undefined &&
            Object.prototype.hasOwnProperty.call(iconLookupTable, genePanelId)
        ) {
            lookupTable[sampleId] = iconLookupTable[genePanelId];
        } else {
            lookupTable[sampleId] = wholeGenomeIconData;
        }
    }

    return lookupTable;
}

export function computeMutationFrequencyBySample(
    mergedMutations: Mutation[][],
    sampleOrder: { [s: string]: number }
): MutationFrequenciesBySample {
    const ret: MutationFrequenciesBySample = {};
    let sampleId;
    let freq;
    for (const mutations of mergedMutations) {
        for (const mutation of mutations) {
            if (mutation.tumorAltCount >= 0 && mutation.tumorRefCount >= 0) {
                sampleId = mutation.sampleId;
                freq =
                    mutation.tumorAltCount /
                    (mutation.tumorRefCount + mutation.tumorAltCount);
                ret[sampleId] = ret[sampleId] || [];
                ret[sampleId].push(freq);
            }
        }
    }
    for (const sampleId of Object.keys(sampleOrder)) {
        ret[sampleId] = ret[sampleId] || [];
        const shouldAdd = mergedMutations.length - ret[sampleId].length;
        for (let i = 0; i < shouldAdd; i++) {
            ret[sampleId].push(NaN);
        }
    }
    return ret;
}

export function doesFrequencyExist(frequencies: MutationFrequenciesBySample) {
    for (const frequencyId of Object.keys(frequencies)) {
        if (frequencies.hasOwnProperty(frequencyId)) {
            for (const frequency of frequencies[frequencyId]) {
                return !isNaN(frequency);
            }
        }
    }

    return false;
}
