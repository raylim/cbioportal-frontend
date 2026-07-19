import * as React from 'react';
import {
    normalizeLevel,
    mergeAlterations,
    getPositionalVariant,
} from '../util/OncoKbUtils';
import Tooltip from 'rc-tooltip';
import _ from 'lodash';
import {
    defaultArraySortMethod,
    defaultSortMethod,
    LEVELS,
} from '../util/OncoKbUtils';
import { OncoKbCardDataType } from '../model/OncoKB';
import LevelIcon from './icon/LevelIcon';
import { LEVEL_DESC } from './levelDescriptions';

export default class OncoKbHelper {
    public static get TX_LEVELS(): string[] {
        return ['1', '2', '3A', '3B', '4', 'R1', 'R2'];
    }

    public static get DX_LEVELS(): string[] {
        return ['Dx1', 'Dx2', 'Dx3'];
    }

    public static get PX_LEVELS(): string[] {
        return ['Px1', 'Px2', 'Px3'];
    }

    public static get LEVELS(): string[] {
        return [...this.TX_LEVELS, ...this.DX_LEVELS, ...this.PX_LEVELS];
    }

    public static getLevelsDesc(dataType: OncoKbCardDataType) {
        switch (dataType) {
            case OncoKbCardDataType.TXS:
            case OncoKbCardDataType.TXR:
                return _.pick(LEVEL_DESC, this.TX_LEVELS);
            case OncoKbCardDataType.DX:
                return _.pick(LEVEL_DESC, this.DX_LEVELS);
            case OncoKbCardDataType.PX:
                return _.pick(LEVEL_DESC, this.PX_LEVELS);
            default:
                return {};
        }
    }

    public static get LEVEL_DESC(): { [level: string]: JSX.Element } {
        return LEVEL_DESC;
    }

    public static getDefaultColumnDefinition(
        columnKey: 'level' | 'alterations'
    ) {
        switch (columnKey) {
            case 'level':
                return {
                    id: 'level',
                    Header: <div style={{ textAlign: 'center' }}>Level</div>,
                    accessor: 'level',
                    maxWidth: 45,
                    sortMethod: (a: string, b: string) =>
                        defaultSortMethod(
                            LEVELS.all.indexOf(normalizeLevel(a) || ''),
                            LEVELS.all.indexOf(normalizeLevel(b) || '')
                        ),
                    Cell: (props: { value: string }) => {
                        const normalizedLevel =
                            normalizeLevel(props.value) || '';
                        return (
                            <LevelIcon
                                level={normalizedLevel}
                                showDescription
                            />
                        );
                    },
                };
            case 'alterations':
                return {
                    id: 'alterations',
                    Header: <span>Alteration(s)</span>,
                    accessor: 'alterations',
                    minWidth: 80,
                    sortMethod: (a: string[], b: string[]) =>
                        defaultArraySortMethod(a, b),
                };
        }
    }

    public static getAlterationsColumnCell = (
        alterations: string[],
        variant: string
    ) => {
        const mergedAlteration = mergeAlterations(alterations);
        let content = <span>{mergedAlteration}</span>;
        if (alterations.length > 5) {
            const lowerCasedQueryVariant = variant.toLowerCase();
            let matchedAlteration = _.find(
                alterations,
                alteration =>
                    alteration.toLocaleLowerCase() === lowerCasedQueryVariant
            );
            if (!matchedAlteration) {
                matchedAlteration = getPositionalVariant(variant);
            }
            let pickedAlteration =
                matchedAlteration === undefined
                    ? alterations[0]
                    : matchedAlteration;
            content = (
                <span>
                    {pickedAlteration} and{' '}
                    <Tooltip
                        overlay={
                            <div style={{ maxWidth: '400px' }}>
                                {mergedAlteration}
                            </div>
                        }
                        placement="right"
                        destroyTooltipOnHide={true}
                    >
                        <a>{alterations.length - 1} other alterations</a>
                    </Tooltip>
                </span>
            );
        }
        return (
            <div style={{ whiteSpace: 'normal', lineHeight: '1rem' }}>
                {content}
            </div>
        );
    };
}
