#!/bin/bash
# First start of an empty ClickHouse volume: load the cBioPortal schema and the
# reference seed (genes, cancer types, ...) for the pinned backend commit.
set -eo pipefail
CH=(clickhouse-client --user "${CLICKHOUSE_USER}" --password "${CLICKHOUSE_PASSWORD}" --database "${CLICKHOUSE_DB}" --multiquery)
echo "Loading cBioPortal schema..."
"${CH[@]}" < /db-scripts/schema.sql
echo "Loading cBioPortal seed data..."
gunzip -c /db-scripts/seed-*.sql.gz | "${CH[@]}"
echo "Schema version: $("${CH[@]}" --query 'SELECT db_schema_version FROM info')"
