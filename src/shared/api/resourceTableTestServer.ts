// Type-only imports keep this module free of path aliases, so the Playwright
// specs can import it too.
import {
    ResourceColumnInfo,
    ResourceFacetOption,
    ResourceTableGroup,
    ResourceTableGroupPage,
    ResourceTableMetadataResult,
    ResourceTableQuery,
    ResourceTableRow,
    ResourceTableTab,
    ResourceTabsRequest,
} from './resourceTableClient';

/** A resource row as the test server holds it. */
export interface TestResourceRow {
    studyId: string;
    resourceId: string;
    patientId: string | null;
    sampleId: string | null;
    url?: string;
    metadata: { [key: string]: unknown };
}

export interface ResourceTableTestServerOptions {
    /**
     * Whether a row is in a request's `studyViewFilter` cohort. The server does not resolve
     * study-view filters itself; without this every row of the filter's studies is in it.
     */
    inStudyViewCohort?: (
        row: TestResourceRow,
        query: ResourceTableQuery
    ) => boolean;
}

function text(value: unknown): string {
    return value === null || value === undefined ? '' : String(value);
}

function columnValue(row: TestResourceRow, columnId: string): string {
    if (columnId.startsWith('metadata:')) {
        return text(row.metadata[columnId.slice('metadata:'.length)]);
    }
    return text((row as any)[columnId]);
}

/**
 * The resource-table endpoints (tabs, query, metadata and groups) over a fixed row list, for
 * tests. It follows the API's rules for what a test can observe: the cohort, resourceId and
 * resourceIds, search over ids and metadata, `in` column filters, grouping by patient or sample
 * (sample grouping keeps only sample-level rows), counts, the default and rowCount sorts,
 * locate, paging, and metadata columns and facets; the facets ignore the column filters and,
 * under grouping, count groups.
 */
export class ResourceTableTestServer {
    constructor(
        private readonly allRows: () => TestResourceRow[],
        private readonly options: ResourceTableTestServerOptions = {}
    ) {}

    tabs(request: ResourceTabsRequest): ResourceTableTab[] {
        const rows = this.allRows().filter(
            row =>
                request.studyIds.includes(row.studyId) &&
                this.inIdentifiers(row, request)
        );
        const ids = Array.from(new Set(rows.map(row => row.resourceId)));
        return ids.map(resourceId => {
            const own = rows.filter(row => row.resourceId === resourceId);
            return {
                resourceId,
                label: resourceId,
                totalCount: own.length,
                patientCount: new Set(own.map(r => r.patientId)).size,
                sampleCount: new Set(
                    own.filter(r => r.sampleId).map(r => r.sampleId)
                ).size,
            };
        });
    }

    rows(query: ResourceTableQuery): ResourceTableRow[] {
        return this.filtered(query, true)
            .slice(
                query.pageNumber * query.pageSize,
                (query.pageNumber + 1) * query.pageSize
            )
            .map(row => ({
                studyId: row.studyId,
                resourceId: row.resourceId,
                resourceDisplayName: row.resourceId,
                resourceType: row.sampleId ? 'SAMPLE' : 'PATIENT',
                patientId: row.patientId,
                sampleId: row.sampleId,
                url: row.url || '',
                displayName: null,
                metadata: row.metadata,
            }));
    }

    groups(query: ResourceTableQuery): ResourceTableGroupPage {
        const groups = this.grouped(this.filtered(query, true), query);
        const located = query.locate
            ? groups.findIndex(
                  g =>
                      g.studyId === query.locate!.studyId &&
                      (query.groupBy === 'sample'
                          ? g.sampleId === query.locate!.sampleId
                          : g.patientId === query.locate!.patientId)
              )
            : -1;
        return {
            totalGroups: groups.length,
            totalRows: groups.reduce((sum, g) => sum + g.rowCount, 0),
            locatedIndex: located >= 0 ? located : null,
            groups: groups.slice(
                query.pageNumber * query.pageSize,
                (query.pageNumber + 1) * query.pageSize
            ),
        };
    }

    metadata(query: ResourceTableQuery): ResourceTableMetadataResult {
        const filtered = this.filtered(query, true);
        // Facets read the rows before column filters, as the API's do.
        const scoped = this.filtered(query, false);
        const keys = Array.from(
            new Set(
                scoped.flatMap(row =>
                    Object.keys(row.metadata).filter(
                        key =>
                            typeof row.metadata[key] === 'string' ||
                            typeof row.metadata[key] === 'boolean'
                    )
                )
            )
        );
        const facets: { [columnId: string]: ResourceFacetOption[] } = {};
        keys.forEach(key => {
            const counted = new Map<string, Set<string>>();
            scoped.forEach((row, index) => {
                const value = text(row.metadata[key]);
                if (!value) return;
                const unit = query.groupBy
                    ? this.groupKey(row, query)
                    : String(index);
                if (unit === undefined) return;
                if (!counted.has(value)) counted.set(value, new Set());
                counted.get(value)!.add(unit);
            });
            facets[`metadata:${key}`] = Array.from(counted.entries())
                .map(([value, units]) => ({ value, count: units.size }))
                .sort((a, b) => b.count - a.count);
        });
        // Every key the rows carry is a column, shown by default.
        const columns: ResourceColumnInfo[] = Array.from(
            new Set(scoped.flatMap(row => Object.keys(row.metadata)))
        ).map(key => ({
            id: `metadata:${key}`,
            label: key,
            source: 'metadata',
            dataType: 'string',
            filterable: keys.includes(key),
            sortable: true,
            visibleByDefault: true,
        }));
        return {
            columns,
            totalRowCount: filtered.length,
            filteredPatientCount: new Set(
                filtered.map(r => `${r.studyId}:${r.patientId}`)
            ).size,
            filteredSampleCount: new Set(
                filtered
                    .filter(r => r.sampleId)
                    .map(r => `${r.studyId}:${r.sampleId}`)
            ).size,
            facets,
            facetRanges: {},
            distinctValueCounts: {},
        };
    }

    private inIdentifiers(
        row: TestResourceRow,
        request: Pick<
            ResourceTableQuery,
            'patientIdentifiers' | 'sampleIdentifiers'
        >
    ): boolean {
        const patients = request.patientIdentifiers || [];
        const samples = request.sampleIdentifiers || [];
        const inPatients = () =>
            patients.some(
                p => p.studyId === row.studyId && p.patientId === row.patientId
            );
        const inSamples = () =>
            samples.some(
                s => s.studyId === row.studyId && s.sampleId === row.sampleId
            );
        // As the API matches them: with both lists, each row at its own level; with one, every
        // row by that list.
        if (patients.length > 0 && samples.length > 0) {
            return row.sampleId ? inSamples() : inPatients();
        }
        if (patients.length > 0) {
            return inPatients();
        }
        return samples.length === 0 || inSamples();
    }

    private filtered(
        query: ResourceTableQuery,
        withColumnFilters: boolean
    ): TestResourceRow[] {
        const resourceIds = [
            ...(query.resourceId ? [query.resourceId] : []),
            ...(query.resourceIds || []),
        ];
        const search = (query.search || '').toLowerCase();
        return this.allRows().filter(row => {
            if (
                !query.studyIds.includes(row.studyId) ||
                !resourceIds.includes(row.resourceId)
            ) {
                return false;
            }
            if (query.studyViewFilter) {
                if (
                    this.options.inStudyViewCohort &&
                    !this.options.inStudyViewCohort(row, query)
                ) {
                    return false;
                }
            } else if (!this.inIdentifiers(row, query)) {
                return false;
            }
            if (
                search &&
                ![
                    row.patientId,
                    row.sampleId,
                    ...Object.values(row.metadata).map(text),
                ].some(value =>
                    text(value)
                        .toLowerCase()
                        .includes(search)
                )
            ) {
                return false;
            }
            return (
                !withColumnFilters ||
                (query.filters || []).every(
                    filter =>
                        filter.operator !== 'in' ||
                        filter.values.includes(
                            columnValue(row, filter.columnId)
                        )
                )
            );
        });
    }

    private groupKey(
        row: TestResourceRow,
        query: ResourceTableQuery
    ): string | undefined {
        const key = query.groupBy === 'sample' ? row.sampleId : row.patientId;
        return key ? `${row.studyId}\u0000${key}` : undefined;
    }

    private grouped(
        rows: TestResourceRow[],
        query: ResourceTableQuery
    ): ResourceTableGroup[] {
        const byKey = new Map<string, ResourceTableGroup>();
        rows.forEach(row => {
            const key = this.groupKey(row, query);
            if (key === undefined) return;
            let group = byKey.get(key);
            if (!group) {
                group = {
                    studyId: row.studyId,
                    patientId: row.patientId || '',
                    ...(query.groupBy === 'sample'
                        ? { sampleId: row.sampleId || '' }
                        : {}),
                    rowCount: 0,
                    counts: {},
                };
                (query.groupCounts || []).forEach(
                    column => (group!.counts[column] = {})
                );
                byKey.set(key, group);
            }
            group.rowCount += 1;
            (query.groupCounts || []).forEach(column => {
                const value =
                    column === 'resourceId'
                        ? row.resourceId
                        : columnValue(row, column);
                if (value) {
                    group!.counts[column][value] =
                        (group!.counts[column][value] || 0) + 1;
                }
            });
        });
        const direction = query.direction === 'desc' ? -1 : 1;
        const name = (g: ResourceTableGroup) =>
            query.groupBy === 'sample' ? g.sampleId || '' : g.patientId;
        return Array.from(byKey.values()).sort((a, b) =>
            query.sortBy === 'rowCount'
                ? direction * (a.rowCount - b.rowCount) ||
                  a.studyId.localeCompare(b.studyId) ||
                  name(a).localeCompare(name(b))
                : direction * name(a).localeCompare(name(b)) ||
                  a.studyId.localeCompare(b.studyId)
        );
    }
}

/** Lets pending requests and reactions run. */
export async function settle() {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}
