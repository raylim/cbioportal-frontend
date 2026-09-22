import React, { useMemo } from 'react';
import {
    ClinicalDataBySampleId,
    ClinicalEvent,
} from 'cbioportal-ts-api-client';
import { groupTimelineData } from 'pages/patientView/timeline/timelineDataUtils';
import LazyMobXTable from 'shared/components/lazyMobXTable/LazyMobXTable';
import { DownloadControlOption } from 'cbioportal-frontend-commons';
import { getServerConfig } from 'config/config';
import { buildTimelineEventsSignature } from './pathologyTimelineUtils';
import { isWsiPathologyClinicalEvent } from './pathologyClinicalEventUtils';
import { usePathologyAugmentedClinicalEventsState } from './usePathologyAugmentedClinicalEvents';
import {
    buildPathologyPresentationItemClinicalEventSignature,
    buildPathologyPresentationItemsFromClinicalEvents,
    formatPathologyLinkoutLabel,
    groupPathologyPresentationItems,
    markPathologyLinkoutScope,
} from './pathologyPresentationUtils';

class EventsTable extends LazyMobXTable<{}> {}

const PATHOLOGY_TABLE_HEADERS = [
    'DATE (DAYS)',
    'SAMPLE',
    'MATCH',
    'SPECIMEN',
    'SLIDE TYPE',
    'SLIDES',
    'LINKOUT',
];
type ClinicalEventTableData = { [eventType: string]: string[][] };

type ClinicalEventTableSection = {
    key: string;
    dataRows: string[][];
    columns: ClinicalEventTableColumn[];
};

type ClinicalEventTablePayload = {
    data: ClinicalEventTableData;
    sections: ClinicalEventTableSection[];
};

type PartitionedClinicalEventsEntry = {
    nonWsiEvents: ClinicalEvent[];
    nonWsiEventsSignature: string;
    wsiPathologyEvents: ClinicalEvent[];
    wsiPathologyEventsSignature: string;
};

type ClinicalEventTableHeader = {
    cleanedHeaderRow: string[];
    columns: ClinicalEventTableColumn[];
    visibleColumnIndices: number[];
};

type ClinicalEventTableColumn = {
    name: string;
    render: (data: string[]) => JSX.Element;
    download: (data: string[]) => string;
    sortBy: (data: string[]) => string;
    filter: (
        txt: string,
        filterString: string,
        filterStringUpper: string
    ) => boolean;
};

type PathologyLinkoutClickHandler = (href: string) => boolean;

function buildPathologyClinicalTableDataUncached(
    events: ClinicalEvent[]
): string[][] {
    const rows = groupPathologyPresentationItems(
        buildPathologyPresentationItemsFromClinicalEvents(
            events.filter(isWsiPathologyClinicalEvent)
        )
    );

    const tableRows = new Array<string[][][number]>(rows.length + 1);
    tableRows[0] = PATHOLOGY_TABLE_HEADERS;
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        // The linkout already communicates the viewable/total split (for
        // example, "View 3 of 4"). Keep the Slides column to the total count
        // so the same information is not displayed twice.
        const slides = String(row.totalCount);
        tableRows[index + 1] = [
            row.date == null ? 'Unknown' : String(row.date),
            row.sampleId,
            row.matchLevel,
            row.specimens.join(', '),
            row.subtype,
            slides,
            row.servableCount > 0 && row.linkout
                ? `${formatPathologyLinkoutLabel(
                      row.servableCount,
                      row.totalCount
                  )}||${row.linkout}`
                : '',
        ];
    }

    return tableRows;
}

function buildPathologyClinicalTableData(
    events: ClinicalEvent[],
    studyId: string,
    patientId: string,
    eventsSignature?: string
): string[][] {
    return buildPathologyClinicalTableDataUncached(events);
}

export function buildClinicalEventTableData(
    events: ClinicalEvent[],
    studyId: string,
    patientId: string,
    eventsSignature?: string
): ClinicalEventTableData {
    return getPreparedClinicalEventTablePayload(
        events,
        studyId,
        patientId,
        eventsSignature
    ).data;
}

function getPartitionedClinicalEvents(
    events: ClinicalEvent[],
    topLevelSignature: string
): PartitionedClinicalEventsEntry {
    const wsiPathologyEvents: ClinicalEvent[] = [];
    const nonWsiEvents: ClinicalEvent[] = [];
    const wsiPathologyEventSignatures: string[] = [];
    const nonWsiEventSignatures: string[] = [];

    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const signature = buildPathologyPresentationItemClinicalEventSignature(
            event
        );
        if (isWsiPathologyClinicalEvent(event)) {
            wsiPathologyEvents.push(event);
            wsiPathologyEventSignatures.push(signature);
        } else {
            nonWsiEvents.push(event);
            nonWsiEventSignatures.push(signature);
        }
    }

    return {
        nonWsiEvents,
        nonWsiEventsSignature: nonWsiEventSignatures.join('||'),
        wsiPathologyEvents,
        wsiPathologyEventsSignature: wsiPathologyEventSignatures.join('||'),
    };
}

function buildClinicalEventTableDataUncached(
    events: ClinicalEvent[],
    studyId: string,
    patientId: string,
    eventsSignature?: string
): ClinicalEventTableData {
    const resolvedEventsSignature =
        eventsSignature || buildTimelineEventsSignature(events);
    const {
        nonWsiEvents,
        wsiPathologyEvents,
        wsiPathologyEventsSignature,
    } = getPartitionedClinicalEvents(events, resolvedEventsSignature);
    const data = groupTimelineData(nonWsiEvents);
    if (data.PATHOLOGY) {
        data['PATHOLOGY BIOMARKERS'] = data.PATHOLOGY;
        delete data.PATHOLOGY;
    }
    if (wsiPathologyEvents.length > 0) {
        data['PATHOLOGY SLIDES'] = buildPathologyClinicalTableData(
            wsiPathologyEvents,
            studyId,
            patientId,
            wsiPathologyEventsSignature
        );
    }
    return data;
}

function makeColumns(
    headerRow: string[],
    onPathologyLinkoutClick?: PathologyLinkoutClickHandler
): ClinicalEventTableColumn[] {
    const headerSignature = headerRow.join('|');
    const columns = new Array<ClinicalEventTableColumn>(headerRow.length);
    for (let index = 0; index < headerRow.length; index += 1) {
        const item = headerRow[index];
        columns[index] = {
            name: item,
            render: (data: string[]) => {
                const value = data[index];
                if (item === 'LINKOUT' && value) {
                    const [label, href] = value.split('||');
                    const rowDate = Number(data[0]);
                    const scopedHref = onPathologyLinkoutClick
                        ? markPathologyLinkoutScope(
                              href,
                              Number.isFinite(rowDate) ? rowDate : undefined
                          )
                        : href;
                    const isInternalWsiLinkout = scopedHref.startsWith(
                        '/patient/wsiHESlides'
                    );
                    const handleLinkoutClick = (
                        event: React.MouseEvent<HTMLAnchorElement>
                    ) => {
                        event.stopPropagation();
                        if (
                            !onPathologyLinkoutClick ||
                            !isInternalWsiLinkout ||
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                        ) {
                            return;
                        }

                        if (onPathologyLinkoutClick(scopedHref)) {
                            event.preventDefault();
                        }
                    };
                    return (
                        <a
                            href={scopedHref}
                            target={
                                onPathologyLinkoutClick && isInternalWsiLinkout
                                    ? undefined
                                    : '_blank'
                            }
                            rel={
                                onPathologyLinkoutClick && isInternalWsiLinkout
                                    ? undefined
                                    : 'noopener noreferrer'
                            }
                            onClick={handleLinkoutClick}
                        >
                            {label}
                        </a>
                    );
                }
                return <span>{value}</span>;
            },
            download: (data: string[]) => data[index],
            sortBy: (data: string[]) => data[index],
            filter: (
                txt: string,
                filterString: string,
                filterStringUpper: string
            ) =>
                txt
                    ?.toString()
                    .toUpperCase()
                    .includes(filterStringUpper),
        };
    }

    return columns;
}

function getPreparedClinicalEventTableHeader(
    headerRow: string[],
    onPathologyLinkoutClick?: PathologyLinkoutClickHandler
): ClinicalEventTableHeader {

    const visibleColumnIndices: number[] = [];
    for (let index = 0; index < headerRow.length; index += 1) {
        const item = headerRow[index];
        if (item !== 'PATIENT_ID' && !/^STYLE_/.test(item)) {
            visibleColumnIndices.push(index);
        }
    }

    const cleanedHeaderRow = new Array<string>(visibleColumnIndices.length);
    for (let index = 0; index < visibleColumnIndices.length; index += 1) {
        cleanedHeaderRow[index] = headerRow[visibleColumnIndices[index]];
    }

    const entry = {
        cleanedHeaderRow,
        columns: makeColumns(cleanedHeaderRow, onPathologyLinkoutClick),
        visibleColumnIndices,
    };
    return entry;
}

function prepareClinicalEventTableSections(
    data: ClinicalEventTableData,
    onPathologyLinkoutClick?: PathologyLinkoutClickHandler
): ClinicalEventTableSection[] {
    let sectionCount = 0;
    for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            sectionCount += 1;
        }
    }

    const sections = new Array<ClinicalEventTableSection>(sectionCount);
    let dataIndex = 0;
    for (const key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
            continue;
        }
        const dataCategory = data[key];
        const {
            cleanedHeaderRow,
            columns,
            visibleColumnIndices,
        } = getPreparedClinicalEventTableHeader(
            dataCategory[0],
            onPathologyLinkoutClick
        );

        const dataRows = new Array<string[]>(dataCategory.length - 1);
        for (let rowIndex = 1; rowIndex < dataCategory.length; rowIndex += 1) {
            const row = dataCategory[rowIndex];
            const cleanedRow = new Array<string>(visibleColumnIndices.length);

            for (
                let columnIndex = 0;
                columnIndex < visibleColumnIndices.length;
                columnIndex += 1
            ) {
                cleanedRow[columnIndex] =
                    row[visibleColumnIndices[columnIndex]];
            }

            dataRows[rowIndex - 1] = cleanedRow;
        }

        sections[dataIndex] = {
            key,
            dataRows,
            columns,
        };
        dataIndex += 1;
    }

    return sections;
}

function getPreparedClinicalEventTablePayload(
    events: ClinicalEvent[],
    studyId: string,
    patientId: string,
    eventsSignature?: string,
    onPathologyLinkoutClick?: PathologyLinkoutClickHandler
): ClinicalEventTablePayload {

    const data = buildClinicalEventTableDataUncached(
        events,
        studyId,
        patientId,
        eventsSignature
    );
    const entry = {
        data,
        sections: prepareClinicalEventTableSections(
            data,
            onPathologyLinkoutClick
        ),
    };
    return entry;
}

const ClinicalEventsTables: React.FunctionComponent<{
    patientId: string;
    studyId: string;
    augmentedEvents: ClinicalEvent[];
    augmentedEventsSignature?: string;
    onPathologyLinkoutClick?: PathologyLinkoutClickHandler;
}> = function({
    augmentedEvents,
    augmentedEventsSignature,
    patientId,
    studyId,
    onPathologyLinkoutClick,
}) {
    const resolvedAugmentedEventsSignature =
        augmentedEventsSignature ||
        buildTimelineEventsSignature(augmentedEvents);

    const { sections } = useMemo(
        () =>
            getPreparedClinicalEventTablePayload(
                augmentedEvents,
                studyId,
                patientId,
                resolvedAugmentedEventsSignature,
                onPathologyLinkoutClick
            ),
        [
            resolvedAugmentedEventsSignature,
            patientId,
            studyId,
            onPathologyLinkoutClick,
        ]
    );

    return (
        <div>
            {(() => {
                const renderedSections = new Array<JSX.Element>(
                    sections.length
                );
                for (let index = 0; index < sections.length; index += 1) {
                    const { key, dataRows, columns } = sections[index];
                    renderedSections[index] = (
                        <React.Fragment key={key}>
                            <h3
                                className={'pull-left'}
                                style={{ textTransform: 'capitalize' }}
                            >
                                {key.toLowerCase()}
                            </h3>
                            <EventsTable
                                data={dataRows}
                                columns={columns}
                                showPagination={false}
                                showColumnVisibility={false}
                                showFilter={true}
                                showCopyDownload={
                                    getServerConfig()
                                        .skin_hide_download_controls ===
                                    DownloadControlOption.SHOW_ALL
                                }
                            />
                        </React.Fragment>
                    );
                }
                return renderedSections;
            })()}
        </div>
    );
};

const ClinicalEventsTablesWithAugmentation: React.FunctionComponent<{
    clinicalEvents: ClinicalEvent[];
    clinicalEventsSignature?: string;
    patientId: string;
    studyId: string;
    samples: ClinicalDataBySampleId[];
    onPathologyLinkoutClick?: PathologyLinkoutClickHandler;
}> = function({
    clinicalEvents,
    clinicalEventsSignature,
    patientId,
    studyId,
    samples,
    onPathologyLinkoutClick,
}) {
    const resolvedClinicalEventsSignature =
        clinicalEventsSignature || buildTimelineEventsSignature(clinicalEvents);
    const augmentedEventsState = usePathologyAugmentedClinicalEventsState({
        clinicalEvents,
        clinicalEventsSignature: resolvedClinicalEventsSignature,
        patientId,
        samples,
        studyId,
    });
    const augmentedEvents = augmentedEventsState.events;
    const augmentedEventsSignature = augmentedEventsState.eventsSignature;

    return (
        <ClinicalEventsTables
            patientId={patientId}
            studyId={studyId}
            augmentedEvents={augmentedEvents}
            augmentedEventsSignature={augmentedEventsSignature}
            onPathologyLinkoutClick={onPathologyLinkoutClick}
        />
    );
};

export { ClinicalEventsTables as ClinicalEventsTablesContent };
export default ClinicalEventsTablesWithAugmentation;
