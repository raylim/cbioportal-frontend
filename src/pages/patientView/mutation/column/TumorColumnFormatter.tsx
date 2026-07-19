import * as React from 'react';
import 'rc-tooltip/assets/bootstrap_white.css';
import SampleManager from '../../SampleManager';
import { isUncalled } from 'shared/lib/MutationUtils';
import { ClinicalDataBySampleId } from 'cbioportal-ts-api-client';
import { noGenePanelUsed } from 'shared/lib/StoreUtils';
import SampleInline from 'pages/patientView/patientHeader/SampleInline';
import SampleLabelNotProfiled from 'shared/components/sampleLabel/SampleLabelNotProfiled';

export default class TumorColumnFormatter {
    // NOTE: entrezGeneId can be array of genes
    // in order to support structural variant
    // alteration type which are associated with
    // two genes
    public static renderFunction<
        T extends { sampleId: string; entrezGeneId: number | number[] }
    >(
        mutations: T[],
        sampleManager: SampleManager | null,
        sampleToGenePanelId: { [sampleId: string]: string | undefined },
        genePanelIdToGene: { [genePanelId: string]: number[] },
        onSelectGenePanel?: (name: string) => void,
        disableTooltip?: boolean
    ) {
        if (!sampleManager) {
            return <span></span>;
        }

        // Rules for icon:
        // - when sample->gene has mutation (present in _mutatedSamples_) show the `sample` icon
        // - when sample->gene has no mutation (absent from _mutatedSamples_) and was profiled, show `no mutation` icon
        // - when sample->gene has no mutation (absent from _mutatedSamples_) and was not profiled, show `not profiled` icon
        const samples = sampleManager.samples;
        const sampleIds = new Array<string>(samples.length);
        for (let i = 0; i < samples.length; i++) {
            sampleIds[i] = (samples[i] as ClinicalDataBySampleId).id;
        }
        const entrezGeneId = mutations[0].entrezGeneId;
        const mutatedSamples = TumorColumnFormatter.getPresentSamples(
            mutations
        );
        const profiledSamples = TumorColumnFormatter.getProfiledSamplesForGene(
            entrezGeneId,
            sampleIds,
            sampleToGenePanelId,
            genePanelIdToGene
        );
        const notProfiledText =
            'This gene was not profiled for this sample (absent from gene panel)';

        const tdValue = samples.map((sample: any) => {
            // hide labels for non-existent mutation data
            // decreased opacity for uncalled mutations
            // show not-profiled icon when gene was not analyzed
            const isMutated = sample.id in mutatedSamples;
            const isProfiled =
                sample.id in profiledSamples && profiledSamples[sample.id];

            let extraTooltipText = '';

            // mutations can be read which are not part of the target of the gene panel
            // therefore a sample can still have mutations even if the gene was not profiled
            if (isMutated) {
                if (!mutatedSamples[sample.id]) {
                    extraTooltipText =
                        "Mutation has supporting reads, but wasn't called. ";
                }
                if (!isProfiled) {
                    extraTooltipText = `${extraTooltipText}${notProfiledText}`;
                }
            } else {
                if (!isProfiled) {
                    extraTooltipText = `${notProfiledText}. It is unknown whether it is mutated.`;
                }
            }

            return (
                <li className={isProfiled && !isMutated ? 'invisible' : ''}>
                    {isProfiled ? (
                        // Sample is profiled AND is mutated
                        sampleManager.getComponentForSample(
                            sample.id,
                            mutatedSamples[sample.id] ? 1 : 0.1,
                            extraTooltipText,
                            null,
                            onSelectGenePanel,
                            disableTooltip
                        )
                    ) : (
                        // Sample is not profiled
                        <SampleLabelNotProfiled
                            sample={sample}
                            onSelectGenePanel={onSelectGenePanel}
                            disableTooltip={disableTooltip}
                        />
                    )}
                </li>
            );
        });

        return (
            <div style={{ position: 'relative' }} data-test="samples-cell">
                <ul
                    style={{ marginBottom: 0 }}
                    className="list-inline list-unstyled"
                >
                    {tdValue}
                </ul>
            </div>
        );
    }

    public static getSortValue<T extends { sampleId: string }>(
        d: T[],
        sampleManager: SampleManager | null
    ) {
        if (!sampleManager) {
            return [];
        } else {
            const presentSamples = TumorColumnFormatter.getPresentSamples(d);
            const ret = new Array<number>(
                sampleManager.getSampleIdsInOrder().length + 1
            );
            let calledCount = 0;
            for (const sampleId of Object.keys(presentSamples)) {
                if (presentSamples[sampleId]) {
                    calledCount++;
                }
            }
            // First, we sort by the number of present and called samples
            ret[0] = calledCount;
            // Then, we sort by the particular ones present
            const sampleIds = sampleManager.getSampleIdsInOrder();
            for (let i = 0; i < sampleIds.length; i++) {
                ret[i + 1] = +!!presentSamples[sampleIds[i]];
            }
            return ret;
        }
    }

    public static getPresentSamples<
        T extends {
            sampleId: string;
            tumorAltCount?: number;
            molecularProfileId?: string;
        }
    >(data: T[]) {
        const presentSamples = {} as { [s: string]: boolean };
        for (const next of data) {
            // Indicate called mutations with true,
            // uncalled mutations with supporting reads as false
            // exclude uncalled mutations without supporting reads completely
            if (
                next.molecularProfileId &&
                isUncalled(next.molecularProfileId)
            ) {
                if (next.tumorAltCount && next.tumorAltCount > 0) {
                    presentSamples[next.sampleId] = false;
                }
            } else {
                presentSamples[next.sampleId] = true;
            }
        }
        return presentSamples;
    }

    public static getProfiledSamplesForGene(
        entrezGeneId: number | number[],
        sampleIds: string[],
        sampleToGenePanelId: { [sampleId: string]: string | undefined },
        genePanelIdToEntrezGeneIds: { [genePanelId: string]: number[] }
    ) {
        // For a given gene indicate whether it was profiled in a particular sample
        const sampleIsProfiled = {} as { [s: string]: boolean };
        const geneIds = Array.isArray(entrezGeneId)
            ? entrezGeneId
            : [entrezGeneId];

        for (const nextSampleId of sampleIds) {
            const genePanelId = sampleToGenePanelId[nextSampleId];

            // NOTE: entrezGeneId can be an array in order to
            // support structural variant alteration types
            const wholeGenome = noGenePanelUsed(genePanelId);
            let isInGenePanel = false;

            if (
                !wholeGenome &&
                !!genePanelId &&
                genePanelId in genePanelIdToEntrezGeneIds
            ) {
                const panelGeneIds = genePanelIdToEntrezGeneIds[genePanelId];
                for (const geneId of geneIds) {
                    if (panelGeneIds.includes(geneId)) {
                        isInGenePanel = true;
                        break;
                    }
                }
            }

            sampleIsProfiled[nextSampleId] = wholeGenome || isInGenePanel;
        }

        return sampleIsProfiled;
    }

    public static getSample(
        data: Array<{ sampleId: string }>
    ): string | string[] {
        const result: string[] = [];
        if (data) {
            for (const datum of data) {
                result.push(datum.sampleId);
            }
        }
        if (result.length == 1) {
            return result[0];
        }
        return result;
    }
}
