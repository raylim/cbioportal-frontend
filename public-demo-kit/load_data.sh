#!/usr/bin/env bash
# Load the demo study (with its WSI resource rows) into ClickHouse.
#
#   1. trim the datahub study to the slide patients        (trim_study.py)
#   2. write the WSI resource rows and thumbnails           (make_wsi_resources.py, tile image)
#   3. validate + import with the cBioPortal importer       (cbioportal-core metaImport.py)
#   4. rebuild the derived tables                           (backend populate_derived_tables.sql)
#   5. restart the portal so it sees the new study
#
# Needs the study tarball and slides already downloaded (setup.sh does that) and the
# images built. Safe to re-run: the study is removed and imported again.
source "$(dirname "$0")/lib.sh"
load_env

[ -f "$STUDY_SRC/meta_study.txt" ] || die "study not found at $STUDY_SRC; run ./setup.sh"
[ -f "$DATA_DIR/slides/manifest.json" ] || die "no slides; run ./setup.sh"

log "Trimming $STUDY_ID to the slide patients"
python3 trim_study.py --src "$STUDY_SRC" --out "$STUDY_OUT" --patients-from "$DATA_DIR/slides/manifest.json"

log "Writing WSI resource rows and thumbnails"
mkdir -p "$DATA_DIR/slides/thumbnails"
dc run --rm --no-deps -T --user "$(id -u):$(id -g)" \
    -e PYTHONPATH=/app -e PROMETHEUS_MULTIPROC_DIR=/tmp \
    -v "$STUDY_OUT:/study" \
    -v "$DATA_DIR/slides/thumbnails:/thumbnails" \
    -v "$KIT_DIR/make_wsi_resources.py:/kit/make_wsi_resources.py:ro" \
    tile python /kit/make_wsi_resources.py --study-dir /study --thumbnail-dir /thumbnails \
    --origin "$PUBLIC_ORIGIN"

log "Starting ClickHouse and the portal (the validator checks genes against the portal API)"
dc up -d --wait clickhouse
wait_clickhouse
dc up -d --wait session portal

if [ "$(ch_query --query "SELECT count() FROM cancer_study WHERE cancer_study_identifier='$STUDY_ID'")" != "0" ]; then
    log "Removing the previously loaded $STUDY_ID"
    dc --profile tools run --rm -T importer sh -c '
        printf "%s\n" "spring.datasource.url=jdbc:ch://clickhouse:8123/cbioportal" \
            "spring.datasource.username=cbio" "spring.datasource.password=$CLICKHOUSE_PASSWORD" \
            "spring.datasource.driver-class-name=com.clickhouse.jdbc.ClickHouseDriver" > /application.properties
        python3 /scripts/importer/cbioportalImporter.py -c remove-study -id '"$STUDY_ID"
fi

log "Validating and importing $STUDY_ID (cbioportal-core metaImport.py)"
# -o: continue past validator warnings (the datahub study has some); errors still stop it.
dc --profile tools run --rm -T importer sh -c '
    printf "%s\n" "spring.datasource.url=jdbc:ch://clickhouse:8123/cbioportal" \
        "spring.datasource.username=cbio" "spring.datasource.password=$CLICKHOUSE_PASSWORD" \
        "spring.datasource.driver-class-name=com.clickhouse.jdbc.ClickHouseDriver" > /application.properties
    python3 /scripts/importer/metaImport.py -s /study/'"$STUDY_ID"' -u http://portal:8080 \
        -html /study/'"$STUDY_ID"'/validation-report.html -o --no-derive-tables'
echo "Validation report: $STUDY_OUT/validation-report.html"

log "Rebuilding derived tables"
derived_sql="$DATA_DIR/src/portal/src/main/resources/db-scripts/clickhouse/populate_derived_tables.sql"
sql_to_run="$DATA_DIR/populate_derived_tables.run.sql"
cp "$derived_sql" "$sql_to_run"
# EXCHANGE TABLES needs atomic rename support (renameat2) in the filesystem under Docker's
# data root; some network/cluster filesystems lack it. Probe, and swap with RENAME if needed.
ch_query --multiquery --query "
    DROP TABLE IF EXISTS _kit_xchg_a; DROP TABLE IF EXISTS _kit_xchg_b;
    CREATE TABLE _kit_xchg_a (x UInt8) ENGINE = MergeTree ORDER BY x;
    CREATE TABLE _kit_xchg_b (x UInt8) ENGINE = MergeTree ORDER BY x;" >/dev/null
if ! ch_query --query "EXCHANGE TABLES _kit_xchg_a AND _kit_xchg_b" >/dev/null 2>&1; then
    echo "  EXCHANGE TABLES is not supported here; using RENAME for the cutover"
    sed -E -i 's/^EXCHANGE TABLES ([a-z_]+) AND ([a-z_]+);/DROP TABLE IF EXISTS \1_kit_old; RENAME TABLE \1 TO \1_kit_old; RENAME TABLE \2 TO \1; DROP TABLE \1_kit_old;/' "$sql_to_run"
fi
ch_query --multiquery --query "DROP TABLE IF EXISTS _kit_xchg_a; DROP TABLE IF EXISTS _kit_xchg_b;" >/dev/null
ch_query --multiquery --param_optimize_backoff_secs=0 < "$sql_to_run"
rm -f "$sql_to_run"

log "Restarting the portal"
dc restart portal
dc up -d --wait portal

log "Loaded: $(ch_query --query "SELECT count() FROM sample_derived WHERE cancer_study_identifier = '$STUDY_ID'") samples, $(ch_query --query "SELECT count() FROM resource WHERE resource_id IN ('WSI_SAMPLE','WSI_PATIENT')") WSI rows"
