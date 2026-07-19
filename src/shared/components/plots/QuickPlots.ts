import {
    PlotsTabOption,
    PlotsTabDataSource,
    NONE_SELECTED_OPTION_STRING_VALUE,
    NONE_SELECTED_OPTION_LABEL,
} from './PlotsTabTypes';
import { AlterationTypeConstants } from 'shared/constants';
import { SpecialAttribute } from 'shared/cache/ClinicalDataCache';
import { CLIN_ATTR_DATA_TYPE } from './PlotsTabUtils';
import { GenericAssayTypeConstants } from 'shared/lib/GenericAssayUtils/GenericAssayConfig';

export type ButtonInfo = {
    selected: boolean;
    display: string;
    plotModel: {
        vertical: {
            dataSource: PlotsTabOption | undefined;
            dataType: PlotsTabOption | undefined;
            useSameGene?: boolean;
        };
        horizontal: {
            dataSource: PlotsTabOption | undefined;
            dataType: PlotsTabOption | undefined;
        };
    };
};

export type TypeSourcePair = {
    type: string | undefined;
    source: string | undefined;
};

/**
 * This is how the example links are created.
 * Each quickplot knows how to validate itself and produce a ButtonInfo
 * object.
 * To add a new example link, add a new object of type QuickPlot to
 * the quickPlots constant.
 */
type QuickPlot = {
    toButtonInfo: (
        vertical: TypeSourcePair,
        horizontal: TypeSourcePair,
        context: QuickPlotContext
    ) => ButtonInfo;
    isApplicableToQuery: (context: QuickPlotContext) => boolean;
};

type QuickPlotContext = {
    cancerTypes: string[];
    mutationCount: number;
    dataTypeByValue: { [value: string]: PlotsTabOption };
    dataSourceByTypeAndValue: {
        [dataType: string]: { [value: string]: PlotsTabOption };
    };
};

function buildQuickPlotContext(
    dataTypes: PlotsTabOption[],
    dataSources: PlotsTabDataSource,
    cancerTypes: string[],
    mutationCount: number
): QuickPlotContext {
    const dataTypeByValue: { [value: string]: PlotsTabOption } = {};
    for (let index = 0; index < dataTypes.length; index += 1) {
        const dataType = dataTypes[index];
        dataTypeByValue[dataType.value] = dataType;
    }

    const dataSourceByTypeAndValue: {
        [dataType: string]: { [value: string]: PlotsTabOption };
    } = {};
    for (const dataType in dataSources) {
        if (!Object.prototype.hasOwnProperty.call(dataSources, dataType)) {
            continue;
        }

        const dataSourceOptions = dataSources[dataType];
        const optionsByValue: { [value: string]: PlotsTabOption } = {};
        for (let index = 0; index < dataSourceOptions.length; index += 1) {
            const option = dataSourceOptions[index];
            optionsByValue[option.value] = option;
        }
        dataSourceByTypeAndValue[dataType] = optionsByValue;
    }

    return {
        cancerTypes,
        mutationCount,
        dataTypeByValue,
        dataSourceByTypeAndValue,
    };
}

function getDataType(
    context: QuickPlotContext,
    value: string
): PlotsTabOption | undefined {
    return context.dataTypeByValue[value];
}

function hasDataType(context: QuickPlotContext, value: string): boolean {
    return getDataType(context, value) !== undefined;
}

function getDataSource(
    context: QuickPlotContext,
    dataType: string,
    value: string
): PlotsTabOption | undefined {
    return context.dataSourceByTypeAndValue[dataType]?.[value];
}

function hasDataSource(
    context: QuickPlotContext,
    dataType: string,
    value: string
): boolean {
    return getDataSource(context, dataType, value) !== undefined;
}

const quickPlots: QuickPlot[] = [
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, CLIN_ATTR_DATA_TYPE) &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    'MUTATION_COUNT'
                ) &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    'CANCER_TYPE_DETAILED'
                ) &&
                context.cancerTypes.length > 1 &&
                context.cancerTypes.length < 16
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === CLIN_ATTR_DATA_TYPE &&
                vertical.source === 'MUTATION_COUNT' &&
                horizontal.type === CLIN_ATTR_DATA_TYPE &&
                horizontal.source === 'CANCER_TYPE_DETAILED';

            return {
                selected,
                display: 'Mut# vs Dx',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'MUTATION_COUNT'
                        ),
                    },
                    horizontal: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'CANCER_TYPE_DETAILED'
                        ),
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, CLIN_ATTR_DATA_TYPE) &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    'MUTATION_COUNT'
                ) &&
                hasDataSource(context, CLIN_ATTR_DATA_TYPE, 'CANCER_TYPE') &&
                context.cancerTypes.length > 15
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === CLIN_ATTR_DATA_TYPE &&
                vertical.source === 'MUTATION_COUNT' &&
                horizontal.type === CLIN_ATTR_DATA_TYPE &&
                horizontal.source === 'CANCER_TYPE_DETAILED';

            return {
                selected,
                display: 'Mut# vs Dx',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'MUTATION_COUNT'
                        ),
                    },
                    horizontal: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'CANCER_TYPE'
                        ),
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, CLIN_ATTR_DATA_TYPE) &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    'FRACTION_GENOME_ALTERED'
                ) &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    'CANCER_TYPE_DETAILED'
                ) &&
                context.cancerTypes.length > 1 &&
                context.cancerTypes.length < 16
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === CLIN_ATTR_DATA_TYPE &&
                vertical.source === 'FRACTION_GENOME_ALTERED' &&
                horizontal.type === CLIN_ATTR_DATA_TYPE &&
                horizontal.source === 'CANCER_TYPE_DETAILED';

            return {
                selected,
                display: 'FGA vs Dx',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'FRACTION_GENOME_ALTERED'
                        ),
                    },
                    horizontal: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'CANCER_TYPE_DETAILED'
                        ),
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, CLIN_ATTR_DATA_TYPE) &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    'FRACTION_GENOME_ALTERED'
                ) &&
                hasDataSource(context, CLIN_ATTR_DATA_TYPE, 'CANCER_TYPE') &&
                context.cancerTypes.length > 15
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === CLIN_ATTR_DATA_TYPE &&
                vertical.source === 'FRACTION_GENOME_ALTERED' &&
                horizontal.type === CLIN_ATTR_DATA_TYPE &&
                horizontal.source === 'CANCER_TYPE_DETAILED';

            return {
                selected,
                display: 'FGA vs Dx',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'FRACTION_GENOME_ALTERED'
                        ),
                    },
                    horizontal: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'CANCER_TYPE'
                        ),
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, CLIN_ATTR_DATA_TYPE) &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    'MUTATION_COUNT'
                ) &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    'FRACTION_GENOME_ALTERED'
                )
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === CLIN_ATTR_DATA_TYPE &&
                vertical.source === 'MUTATION_COUNT' &&
                horizontal.type === CLIN_ATTR_DATA_TYPE &&
                horizontal.source === 'FRACTION_GENOME_ALTERED';

            return {
                selected,
                display: 'Mut# vs FGA',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'MUTATION_COUNT'
                        ),
                    },
                    horizontal: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'FRACTION_GENOME_ALTERED'
                        ),
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, CLIN_ATTR_DATA_TYPE) &&
                hasDataType(context, 'MRNA_EXPRESSION') &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    'CANCER_TYPE_DETAILED'
                ) &&
                context.cancerTypes.length > 1
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === 'MRNA_EXPRESSION' &&
                horizontal.type === CLIN_ATTR_DATA_TYPE &&
                horizontal.source === 'CANCER_TYPE_DETAILED';

            return {
                selected,
                display: 'mRNA vs Dx',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, 'MRNA_EXPRESSION'),
                        dataSource: undefined,
                    },
                    horizontal: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            'CANCER_TYPE_DETAILED'
                        ),
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, 'MUTATION_EXTENDED') &&
                hasDataType(context, 'MRNA_EXPRESSION') &&
                context.mutationCount > 0
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === 'MRNA_EXPRESSION' &&
                horizontal.type === 'MUTATION_EXTENDED';

            return {
                selected,
                display: 'mRNA vs mut type',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, 'MRNA_EXPRESSION'),
                        dataSource: undefined,
                        useSameGene: true,
                    },
                    horizontal: {
                        dataType: getDataType(context, 'MUTATION_EXTENDED'),
                        dataSource: undefined,
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, 'COPY_NUMBER_ALTERATION') &&
                hasDataType(context, 'MRNA_EXPRESSION')
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === 'MRNA_EXPRESSION' &&
                horizontal.type === 'COPY_NUMBER_ALTERATION';

            return {
                selected,
                display: 'mRNA vs CNA',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, 'MRNA_EXPRESSION'),
                        dataSource: undefined,
                        useSameGene: true,
                    },
                    horizontal: {
                        dataType: getDataType(
                            context,
                            'COPY_NUMBER_ALTERATION'
                        ),
                        dataSource: undefined,
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, 'METHYLATION') &&
                hasDataType(context, 'MRNA_EXPRESSION')
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === 'MRNA_EXPRESSION' &&
                horizontal.type === 'METHYLATION';

            return {
                selected,
                display: 'mRNA vs methyl',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, 'MRNA_EXPRESSION'),
                        dataSource: undefined,
                        useSameGene: true,
                    },
                    horizontal: {
                        dataType: getDataType(context, 'METHYLATION'),
                        dataSource: undefined,
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, 'PROTEIN_LEVEL') &&
                hasDataType(context, 'MRNA_EXPRESSION')
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === 'PROTEIN_LEVEL' &&
                horizontal.type === 'MRNA_EXPRESSION';

            return {
                selected,
                display: 'Protein vs mRNA',
                plotModel: {
                    vertical: {
                        dataType: getDataType(context, 'PROTEIN_LEVEL'),
                        dataSource: getDataSource(
                            context,
                            'PROTEIN_LEVEL',
                            'brca_tcga_protein_quantification'
                        ),
                        useSameGene: true,
                    },
                    horizontal: {
                        dataType: getDataType(context, 'MRNA_EXPRESSION'),
                        dataSource: undefined,
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(
                    context,
                    GenericAssayTypeConstants.TREATMENT_RESPONSE
                )
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type ===
                    GenericAssayTypeConstants.TREATMENT_RESPONSE &&
                horizontal.type === NONE_SELECTED_OPTION_STRING_VALUE;

            return {
                selected,
                display: 'Tx Waterfall',
                plotModel: {
                    horizontal: {
                        dataType: {
                            value: NONE_SELECTED_OPTION_STRING_VALUE,
                            label: NONE_SELECTED_OPTION_LABEL,
                        },
                        dataSource: undefined,
                    },
                    vertical: {
                        dataType: getDataType(
                            context,
                            GenericAssayTypeConstants.TREATMENT_RESPONSE
                        ),
                        dataSource: undefined,
                    },
                },
            };
        },
    },
    {
        isApplicableToQuery: (context: QuickPlotContext): boolean => {
            return (
                hasDataType(context, 'MRNA_EXPRESSION') &&
                hasDataType(context, CLIN_ATTR_DATA_TYPE) &&
                hasDataSource(
                    context,
                    CLIN_ATTR_DATA_TYPE,
                    SpecialAttribute.StudyOfOrigin
                )
            );
        },
        toButtonInfo: (
            vertical: TypeSourcePair,
            horizontal: TypeSourcePair,
            context: QuickPlotContext
        ): ButtonInfo => {
            const selected =
                vertical.type === AlterationTypeConstants.MRNA_EXPRESSION &&
                horizontal.type === CLIN_ATTR_DATA_TYPE &&
                horizontal.source === SpecialAttribute.StudyOfOrigin;

            return {
                selected,
                display: 'mRNA vs Study',
                plotModel: {
                    vertical: {
                        dataType: getDataType(
                            context,
                            AlterationTypeConstants.MRNA_EXPRESSION
                        ),
                        dataSource: undefined,
                    },
                    horizontal: {
                        dataType: getDataType(context, CLIN_ATTR_DATA_TYPE),
                        dataSource: getDataSource(
                            context,
                            CLIN_ATTR_DATA_TYPE,
                            SpecialAttribute.StudyOfOrigin
                        ),
                    },
                },
            };
        },
    },
];

export function generateQuickPlots(
    dataTypes: PlotsTabOption[],
    dataSources: PlotsTabDataSource,
    cancerTypes: string[],
    mutationCount: number,
    horizontal: TypeSourcePair,
    vertical: TypeSourcePair
): ButtonInfo[] {
    const context = buildQuickPlotContext(
        dataTypes,
        dataSources,
        cancerTypes,
        mutationCount
    );

    return quickPlots
        .filter(plot => plot.isApplicableToQuery(context))
        .map(plot => plot.toButtonInfo(vertical, horizontal, context));
}
