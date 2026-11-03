# Shared helpers for setup.sh, load_data.sh and reset.sh (sourced, not executed).
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$KIT_DIR"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

load_env() {
    [ -f .env ] || die ".env is missing; run ./setup.sh"
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
    # Relative DATA_DIR is relative to the kit.
    case "$DATA_DIR" in /*) ;; *) DATA_DIR="$KIT_DIR/${DATA_DIR#./}" ;; esac
    export DATA_DIR
    STUDY_ID=brca_tcga_pan_can_atlas_2018
    STUDY_SRC="$DATA_DIR/study/$STUDY_ID"
    STUDY_OUT="$DATA_DIR/demo-study/$STUDY_ID"
}

dc() { docker compose --env-file .env -p wsi-public-demo "$@"; }

ch_query() {
    dc exec -T clickhouse clickhouse-client --user cbio --password "$CLICKHOUSE_PASSWORD" \
        --database cbioportal "$@"
}

# fetch_source <name> <repo-url> <sha>: shallow checkout of one commit at $DATA_DIR/src/<name>.
fetch_source() {
    local name="$1" repo="$2" sha="$3" dir="$DATA_DIR/src/$1"
    if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$sha" ]; then
        echo "  $name: $sha (already checked out)"
        return
    fi
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" remote remove origin 2>/dev/null || true
    git -C "$dir" remote add origin "$repo"
    git -C "$dir" fetch -q --depth 1 origin "$sha"
    git -C "$dir" -c advice.detachedHead=false checkout -q --force FETCH_HEAD
    echo "  $name: $sha"
}

# On an empty volume the ClickHouse image loads the schema with a temporary server and then
# restarts; wait until the final server is up and stays up.
wait_clickhouse() {
    local tries=0 first second
    while :; do
        first="$(ch_query --query 'SELECT uptime()' 2>/dev/null || true)"
        sleep 5
        second="$(ch_query --query 'SELECT uptime()' 2>/dev/null || true)"
        if [ -n "$first" ] && [ -n "$second" ] && [ "$second" -gt "$first" ]; then
            return 0
        fi
        tries=$((tries + 1))
        [ "$tries" -lt 60 ] || die "ClickHouse did not come up; see: docker compose -p wsi-public-demo logs clickhouse"
    done
}
