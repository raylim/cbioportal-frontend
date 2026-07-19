import * as React from 'react';
import { DefaultTooltip } from 'cbioportal-frontend-commons';
import { getPercentage } from 'shared/lib/FormatUtils';

export interface IFrequencyBarProps {
    totalCount: number;
    counts: number[];
    mainCountIndex?: number;
    freqColors?: string[];
    barColor?: string;
    barWidth?: number;
    barHeight?: number;
    textMargin?: number;
    textWidth?: number;
    tooltip?: JSX.Element;
}

/**
 * @author Selcuk Onur Sumer
 */
export default class FrequencyBar extends React.Component<
    IFrequencyBarProps,
    {}
> {
    public static defaultProps = {
        freqColors: ['lightgreen', 'green'],
        barColor: '#ccc',
        textMargin: 6,
        textWidth: 35,
        barWidth: 30,
        barHeight: 8,
    };

    constructor(props: IFrequencyBarProps) {
        super(props);
    }

    private getSafeProportion(count: number, totalCount: number) {
        if (
            !Number.isFinite(count) ||
            !Number.isFinite(totalCount) ||
            totalCount <= 0
        ) {
            return 0;
        }

        return Math.max(0, count / totalCount);
    }

    public mainContent() {
        const {
            barWidth,
            barHeight,
            barColor,
            totalCount,
            counts,
            textMargin,
            textWidth,
        } = this.props;

        const freqColors =
            this.props.freqColors || FrequencyBar.defaultProps.freqColors;

        // if no mainCountIndex is provided or it is not a valid index, then use the first count in the list
        // (main count is used to calculate the percentage to display)
        const mainCountIndex =
            this.props.mainCountIndex &&
            this.props.mainCountIndex >= 0 &&
            this.props.mainCountIndex < counts.length
                ? this.props.mainCountIndex
                : 0;

        const mainProportion = this.getSafeProportion(
            counts[mainCountIndex],
            totalCount
        );
        const textPos = (barWidth || 0) + (textMargin || 0);
        const totalWidth = textPos + (textWidth || 0);

        // create a frequency rectangle for each count
        const freqRects: JSX.Element[] = [];

        counts.forEach((count: number, index: number) => {
            const colorIdx = index % freqColors.length;
            const color = colorIdx >= 0 ? freqColors[colorIdx] : freqColors[0];

            freqRects.push(
                this.frequencyRectangle(
                    count,
                    totalCount,
                    color,
                    `${index}-${count}-${totalCount}`
                )
            );
        });

        return (
            <svg width={totalWidth} height="12">
                <text x={textPos} y="9.5" textAnchor="start" fontSize="10">
                    {getPercentage(mainProportion)}
                </text>
                <rect
                    y="2"
                    width={barWidth}
                    height={barHeight}
                    fill={barColor}
                />
                {freqRects}
            </svg>
        );
    }

    public frequencyRectangle(
        count: number,
        totalCount: number,
        color: string,
        key: string
    ) {
        const proportion = this.getSafeProportion(count, totalCount);
        const { barWidth, barHeight } = this.props;

        return (
            <rect
                key={key}
                y="2"
                width={proportion * (barWidth || 0)}
                height={barHeight}
                fill={color}
            />
        );
    }

    public render() {
        let content = this.mainContent();

        // add tooltip if provided
        if (this.props.tooltip) {
            content = (
                <DefaultTooltip
                    placement="left"
                    overlay={this.props.tooltip}
                    arrowContent={<div className="rc-tooltip-arrow-inner" />}
                >
                    {content}
                </DefaultTooltip>
            );
        }

        return content;
    }
}
