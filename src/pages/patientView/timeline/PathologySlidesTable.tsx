import React from 'react';
import { Link } from 'react-router-dom';
import { ClinicalEvent } from 'cbioportal-ts-api-client';
import { DefaultTooltip } from 'cbioportal-frontend-commons';
import LazyMobXTable, {
    Column,
} from 'shared/components/lazyMobXTable/LazyMobXTable';
import { buildWsiSampleTimelineMap } from 'cbioportal-wsi-viewer';
import {
    buildPathologySlideRows,
    PathologySlideRow,
} from './pathologySlidesTableUtils';

class PathologySlidesLazyTable extends LazyMobXTable<PathologySlideRow> {}

function withTooltip(text: string, tooltip: string | undefined): JSX.Element {
    if (!text || !tooltip) {
        return <span>{text}</span>;
    }
    return (
        <DefaultTooltip
            placement="top"
            overlay={<div style={{ maxWidth: 320 }}>{tooltip}</div>}
        >
            <span style={{ cursor: 'help' }}>{text}</span>
        </DefaultTooltip>
    );
}

function textColumn(
    name: string,
    text: (row: PathologySlideRow) => string,
    tooltip?: (row: PathologySlideRow) => string | undefined,
    sortBy?: (row: PathologySlideRow) => number | string | null
): Column<PathologySlideRow> {
    return {
        name,
        render: row => withTooltip(text(row), tooltip?.(row)),
        download: row => text(row),
        sortBy: sortBy || text,
        filter: (row, _filterString, filterStringUpper) =>
            text(row)
                .toUpperCase()
                .includes(filterStringUpper || ''),
    };
}

export const PATHOLOGY_SLIDES_COLUMNS: Column<PathologySlideRow>[] = [
    textColumn(
        'Procedure',
        row => row.procedureText,
        row => row.procedureTooltip,
        row => row.procedureDays ?? null
    ),
    textColumn('Sample', row => row.sampleText),
    textColumn(
        'vs sequencing',
        row => row.sequencingText,
        row => row.sequencingTooltip,
        row =>
            row.procedureDays != null && row.sequencingDays != null
                ? row.sequencingDays - row.procedureDays
                : null
    ),
    textColumn('Stain', row => row.stain),
    textColumn(
        'Match',
        row => row.matchText,
        row => row.matchTooltip
    ),
    textColumn('Specimen', row => row.specimen),
    textColumn(
        'Slides',
        row => row.slidesText,
        row => row.slidesTooltip,
        row => row.viewableCount
    ),
    {
        name: '',
        render: row =>
            row.openPath ? (
                <Link
                    to={row.openPath}
                    className="btn btn-default btn-xs"
                    aria-label={row.openLabel}
                    title={row.openLabel}
                >
                    Open
                </Link>
            ) : (
                <span />
            ),
        download: row => row.openPath || '',
        headerDownload: () => 'Link',
        togglable: false,
    },
];

/** Clinical Data table for PATHOLOGY SLIDES timeline events. */
const PathologySlidesTable: React.FunctionComponent<{
    events: ClinicalEvent[];
    /** All patient events; sequencing days are read from them. */
    clinicalEvents: ClinicalEvent[];
    showCopyDownload: boolean;
}> = function({ events, clinicalEvents, showCopyDownload }) {
    const rows = React.useMemo(
        () =>
            buildPathologySlideRows(
                events,
                buildWsiSampleTimelineMap(clinicalEvents)
            ),
        [events, clinicalEvents]
    );
    return (
        <PathologySlidesLazyTable
            data={rows}
            columns={PATHOLOGY_SLIDES_COLUMNS}
            showPagination={false}
            showColumnVisibility={false}
            showFilter={true}
            showCopyDownload={showCopyDownload}
        />
    );
};

export default PathologySlidesTable;
