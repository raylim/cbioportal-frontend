import * as React from 'react';
import { GenePanel, GenePanelToGene } from 'cbioportal-ts-api-client';
import { observer } from 'mobx-react';
import { SimpleCopyDownloadControls } from 'shared/components/copyDownloadControls/SimpleCopyDownloadControls';
import { serializeData } from 'shared/lib/Serializer';
import styles from './styles.module.scss';
import { observable, action, computed, makeObservable } from 'mobx';
import autobind from 'autobind-decorator';
import classnames from 'classnames';
import SimpleTable from 'shared/components/simpleTable/SimpleTable';

interface IGenesListProps {
    genePanel: GenePanel;
    columns?: number;
    id?: string | undefined;
}

@observer
export default class GenesList extends React.Component<IGenesListProps, {}> {
    @observable filter: string = '';

    constructor(props: IGenesListProps) {
        super(props);
        makeObservable(this);
    }

    @action.bound
    handleChangeInput(value: string) {
        this.filter = value;
    }

    @computed get filteredGenes() {
        const { genes } = this.props.genePanel;
        if (this.filter) {
            const regex = new RegExp(this.filter, 'i');
            return genes.filter(
                gene =>
                    regex.test(gene.entrezGeneId.toString()) ||
                    regex.test(gene.hugoGeneSymbol)
            );
        }
        return genes;
    }

    genesDividedToColumns = (genes: GenePanelToGene[]) => {
        const result: GenePanelToGene[][] = [];
        let remainingStartIndex = 0;
        let remainingGenes = genes.length;
        let remainingColumns = this.columnCount;

        while (remainingColumns > 0) {
            const columnSize = Math.ceil(remainingGenes / remainingColumns);
            const nextStartIndex = remainingStartIndex + columnSize;
            result.push(genes.slice(remainingStartIndex, nextStartIndex));
            remainingStartIndex = nextStartIndex;
            remainingGenes -= columnSize;
            remainingColumns -= 1;
        }

        return result;
    };

    @computed get renderTableRows() {
        const filtered = this.filteredGenes;
        if (filtered.length === 0) {
            return [];
        }
        const rows: JSX.Element[] = [];
        const genesByRows = this.genesDividedToRows(filtered);
        for (let rowIndex = 0; rowIndex < genesByRows.length; rowIndex += 1) {
            const row = genesByRows[rowIndex];
            const tdValues = new Array<JSX.Element>(row.length);
            for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
                const gene = row[columnIndex];
                tdValues[columnIndex] = (
                    <td key={`${rowIndex}:${columnIndex}:${gene}`}>{gene}</td>
                );
            }
            rows.push(<tr key={`row-${rowIndex}`}>{tdValues}</tr>);
        }
        return rows;
    }

    getDownloadData = () => {
        const downloadData = [
            ['Genes'],
            ...this.props.genePanel.genes.map(gene => [gene.hugoGeneSymbol]),
        ];
        return serializeData(downloadData);
    };

    genesDividedToRows = (genes: GenePanelToGene[]) => {
        const genesByColumns = this.genesDividedToColumns(genes);
        const geneCountPerColumn = this.geneCountPerColumn(genes.length);
        const genesByRows = new Array<string[]>(geneCountPerColumn);
        for (let i = 0; i < geneCountPerColumn; i++) {
            const genesPerRow = new Array<string>(this.columnCount);
            for (let j = 0; j < this.columnCount; j++) {
                genesPerRow[j] =
                    genesByColumns[j] && genesByColumns[j][i]
                        ? genesByColumns[j][i].hugoGeneSymbol
                        : '';
            }
            genesByRows[i] = genesPerRow;
        }
        return genesByRows;
    };

    @computed get columnCount() {
        return this.props.columns || 1;
    }

    geneCountPerColumn = (totalLength: number) => {
        return Math.ceil(totalLength / this.columnCount);
    };

    @computed get renderTableHeaders() {
        const headers = new Array<JSX.Element>(this.columnCount);
        headers[0] = <th key="header-0">Genes</th>;
        for (let index = 1; index < this.columnCount; index += 1) {
            headers[index] = <th key={`header-${index}`}></th>;
        }
        return headers;
    }

    render() {
        return (
            <div id={this.props.id} className={styles.genesList}>
                <h4 className={styles.panelName}>
                    {this.props.genePanel.genePanelId}
                </h4>
                <span>
                    Number of genes: {this.props.genePanel.genes.length}
                </span>
                <div
                    className={classnames(
                        'pull-right has-feedback input-group-sm',
                        styles.searchInput
                    )}
                >
                    <input
                        type="text"
                        value={this.filter}
                        onInput={(e: React.ChangeEvent<HTMLInputElement>) =>
                            this.handleChangeInput(e.target.value)
                        }
                        className="form-control"
                    />
                    <span
                        className="fa fa-search form-control-feedback"
                        aria-hidden="true"
                    />
                </div>
                <SimpleCopyDownloadControls
                    className={classnames(
                        'pull-right',
                        styles.copyDownloadControls
                    )}
                    downloadData={this.getDownloadData}
                    downloadFilename={`gene_panel_${this.props.genePanel.genePanelId}.tsv`}
                    controlsStyle="BUTTON"
                    containerId={this.props.id}
                />
                <SimpleTable
                    headers={this.renderTableHeaders}
                    rows={this.renderTableRows}
                    noRowsText="No matches"
                />
            </div>
        );
    }
}
