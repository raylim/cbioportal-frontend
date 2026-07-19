import * as React from 'react';
import { IMutationalSignature } from '../../model/MutationalSignature';
import { deriveDisplayTextFromGenericAssayType } from './GenericAssayCommonUtils';
import { GenericAssayData } from 'cbioportal-ts-api-client';
import { GenericAssayTypeConstants } from 'shared/lib/GenericAssayUtils/GenericAssayConfig';

export enum MutationalSignaturesVersion {
    V2 = 'v2',
    V3 = 'v3',
    SBS = 'SBS',
    DBS = 'DBS',
    ID = 'ID',
}

export enum MutationalSignatureStableIdKeyWord {
    MutationalSignatureContributionKeyWord = 'contribution',
    MutationalSignatureConfidenceKeyWord = 'pvalue',
    MutationalSignatureCountKeyWord = 'counts',
}

export const MUTATIONAL_SIGNATURES_SIGNIFICANT_PVALUE_THRESHOLD = 0.05;

export const RESERVED_MUTATIONAL_SIGNATURE_COLORS: {
    [category: string]: string;
} = {
    smoking: '#b221e8',
    hrd: '#f06b49',
    tmz: '#076b82',
    uv: '#ffec00',
    apobec: '#8ed14b',
    age: '#3b99d4',
    aging: '#3b99d4',
    pole: '#19413e',
    sequencing: '#651067',
    ber: '#5574a6',
    platinum: '#3b3eac',
    ros: '#b77322',
    haloalkane: '#b91383',
    aid: '#f4359e',
    aza: '#9c5935',
    'aid/apobec': '#aaaa11',
    'pol-eta': '#16d620',
    mmr: '#d92b45',
    'mmr/msi': '#d92b45',
    'defective mmr/msi': '#d92b45',
    'defective dna mismatch repair': '#d92b45',
    tabacco: '#50136d',
    'tobacco chewing': '#50136d',
    unknown: '#b03966',
    aflatoxin: '#e8e8e8',
    ighv: '#e8e8e8',
    'aristolochic acid': '#e8e8e8',
};

export function getColorByMutationalSignatureCategory(category: string) {
    return (
        RESERVED_MUTATIONAL_SIGNATURE_COLORS[category?.toLowerCase()] || '#000'
    );
}

export function getVersionOption(version: string) {
    return {
        label: `${deriveDisplayTextFromGenericAssayType(
            GenericAssayTypeConstants.MUTATIONAL_SIGNATURE
        )} ${version.toUpperCase()}`,
        value: version,
    };
}

export function getVersionOptions(versions: string[]) {
    const options = new Array(versions.length);
    for (let index = 0; index < versions.length; index += 1) {
        options[index] = getVersionOption(versions[index]);
    }
    return options;
}

export function getSampleOption(sample: string) {
    return {
        label: sample,
        value: sample,
    };
}

export function getSampleOptions(samples: string[]) {
    const options = new Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
        options[index] = getSampleOption(samples[index]);
    }
    return options;
}

export type ISampleProgressBarProps = {
    contribution: string;
    color: string;
};

export const SampleProgressBar: React.FunctionComponent<ISampleProgressBarProps> = ({
    contribution,
    color,
}) => {
    let contributionPerc = Math.round(parseFloat(contribution) * 100);

    let progressBarClassName: string = 'progress-bar-info';
    let progressBarStyle: { [s: string]: string } = {
        backgroundColor: color,
    };

    return (
        <div
            className="progress"
            style={{ position: 'relative', width: 100, marginBottom: 0 }}
        >
            <div
                data-test="progress-bar"
                className={`progress-bar ${progressBarClassName}`}
                role="progressbar"
                aria-valuenow={contributionPerc}
                aria-valuemin={0}
                aria-valuemax={100}
                style={Object.assign(progressBarStyle, {
                    width: `${contributionPerc}%`,
                })}
            />
            <div
                style={{
                    position: 'absolute',
                    textShadow:
                        '-1px 0 white, 0 1px white, 1px 0 white, 0 -1px white',
                    width: 100,
                    marginTop: 2,
                    textAlign: 'center',
                }}
            >
                {contributionPerc}%
            </div>
        </div>
    );
};

export function getSignificantMutationalSignatures(
    mutationalSignatureData: IMutationalSignature[],
    sampleId: string
): IMutationalSignature[] {
    const significantMutationalSignatures: IMutationalSignature[] = [];
    for (
        let index = 0;
        index < mutationalSignatureData.length;
        index += 1
    ) {
        const signature = mutationalSignatureData[index];
        if (
            signature.sampleId === sampleId &&
            signature.confidence <
                MUTATIONAL_SIGNATURES_SIGNIFICANT_PVALUE_THRESHOLD
        ) {
            significantMutationalSignatures.push(signature);
        }
    }
    significantMutationalSignatures.sort(
        (left, right) => right.value - left.value
    );
    return significantMutationalSignatures;
}

export function validateMutationalSignatureRawData(
    mutationalSignatureData: GenericAssayData[]
): boolean {
    const regex = new RegExp(
        `(${MutationalSignatureStableIdKeyWord.MutationalSignatureContributionKeyWord}|${MutationalSignatureStableIdKeyWord.MutationalSignatureConfidenceKeyWord})`
    );
    const profileIdsGroupByVersion: { [id: string]: number } = {};
    const seenProfileIds: { [id: string]: true } = {};
    for (
        let index = 0;
        index < mutationalSignatureData.length;
        index += 1
    ) {
        const id = mutationalSignatureData[index].molecularProfileId;
        if (regex.test(id) && !seenProfileIds[id]) {
            seenProfileIds[id] = true;
            const idParts = id.split('_');
            const version = idParts[idParts.length - 1];
            profileIdsGroupByVersion[version] =
                (profileIdsGroupByVersion[version] || 0) + 1;
        }
    }

    // we are expecting contribution and pvalue profiles are in pairs
    for (const version in profileIdsGroupByVersion) {
        if (profileIdsGroupByVersion[version] !== 2) {
            return false;
        }
    }
    return true;
}

export function retrieveMutationalSignatureVersionFromData(
    signatureProfiles: string[]
): string {
    const uniqueProfileVersions: string[] = [];
    const seenVersions: { [version: string]: true } = {};
    for (let index = 0; index < signatureProfiles.length; index += 1) {
        const parts = signatureProfiles[index].split('_');
        const version = parts[parts.length - 1];
        if (!seenVersions[version]) {
            seenVersions[version] = true;
            uniqueProfileVersions.push(version);
        }
    }
    if (uniqueProfileVersions.length > 0) {
        if (
            uniqueProfileVersions.includes('v3') &&
            uniqueProfileVersions.includes('v2')
        ) {
            return 'v3';
        } else if (uniqueProfileVersions.includes('SBS')) {
            // if there is no explicit version, we want to prefer SBS
            return 'SBS';
        } else {
            return uniqueProfileVersions[0]!;
        }
    }
    return 'v2';
}
