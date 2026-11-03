#!/usr/bin/env bash
# One-command setup of the public cBioPortal WSI demo. Idempotent and resumable: every
# step skips work that is already done, so re-run it after an interruption.
#
#   ./setup.sh              set up (or resume) and start the demo
#   ./setup.sh --rebuild    also rebuild the images
#   ./setup.sh --reload     also re-import the study (e.g. after changing SLIDE_COUNT)
#
# Settings: .env (created from .env.example on the first run). On that first run,
# DATA_DIR, SLIDE_COUNT, PUBLIC_ORIGIN, WEB_PORT and BIND_ADDRESS from the environment
# are written into it, e.g.  DATA_DIR=/big/disk/wsi-demo SLIDE_COUNT=8 ./setup.sh
source "$(dirname "$0")/lib.sh"

REBUILD=0
RELOAD=0
for arg in "$@"; do
    case "$arg" in
        --rebuild) REBUILD=1 ;;
        --reload) RELOAD=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) die "unknown option: $arg" ;;
    esac
done
START=$(date +%s)

log "Checking requirements"
for tool in docker git python3 openssl curl tar; do
    command -v "$tool" >/dev/null || die "$tool is required"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 ('docker compose') is required"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || die "python3 >= 3.8 is required"

# ---- .env ----------------------------------------------------------------------------
set_env() {  # set_env KEY VALUE: replace or append KEY=VALUE in .env
    local key="$1" value="$2" tmp
    tmp="$(mktemp .env.XXXXXX)"
    if grep -q "^$key=" .env; then
        awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > "$tmp"
    else
        cat .env > "$tmp"; printf '%s=%s\n' "$key" "$value" >> "$tmp"
    fi
    cat "$tmp" > .env; rm -f "$tmp"
}
env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }

if [ ! -f .env ]; then
    log "Creating .env"
    (umask 077; cp .env.example .env)
    for key in DATA_DIR SLIDE_COUNT PUBLIC_ORIGIN WEB_PORT BIND_ADDRESS; do
        if [ -n "${!key:-}" ]; then set_env "$key" "${!key}"; fi
    done
fi
chmod 600 .env
[ -n "$(env_value CLICKHOUSE_PASSWORD)" ] || set_env CLICKHOUSE_PASSWORD "$(openssl rand -hex 24)"
[ -n "$(env_value ANNOTATION_PG_PASSWORD)" ] || set_env ANNOTATION_PG_PASSWORD "$(openssl rand -hex 24)"
[ -n "$(env_value WSI_AUTH_SECRET)" ] || set_env WSI_AUTH_SECRET "$(openssl rand -hex 32)"
[ -n "$(env_value WSI_SOURCE_SEAL_KEY)" ] || set_env WSI_SOURCE_SEAL_KEY "$(openssl rand -base64 32)"

# Slide assistant: on when the user has put an OpenAI key in secrets/openai_api_key.
mkdir -p secrets
chmod 700 secrets
if [ -s secrets/openai_api_key ]; then
    grep -q '^sk-' secrets/openai_api_key || die "secrets/openai_api_key must hold an OpenAI key (sk-...)"
    chmod 644 secrets/openai_api_key  # read by the tile server's non-root user
    chmod 755 secrets
    set_env WSI_AGENT_ENABLED true
    set_env OPENAI_API_KEY_FILE_IN_CONTAINER /run/demo-secrets/openai_api_key
    echo "  slide assistant: enabled (OpenAI, model $(env_value WSI_AGENT_MODEL))"
else
    set_env WSI_AGENT_ENABLED false
    set_env OPENAI_API_KEY_FILE_IN_CONTAINER ""
    echo "  slide assistant: off (no secrets/openai_api_key)"
fi
load_env
mkdir -p "$DATA_DIR"
echo "  data: $DATA_DIR"
echo "  free disk there: $(df -h "$DATA_DIR" | awk 'NR==2 {print $4}') (needs about 4 GB here for 6 slides, plus about 15 GB for Docker)"

# ---- sources -------------------------------------------------------------------------
log "Fetching pinned sources"
fetch_source portal https://github.com/raylim/cbioportal.git "$PORTAL_SHA"
fetch_source frontend https://github.com/raylim/cbioportal-frontend.git "$FRONTEND_SHA"
fetch_source tile https://github.com/cBioPortal/cbioportal-tile-server.git "$TILE_SHA"
fetch_source core https://github.com/cBioPortal/cbioportal-core.git "$CORE_SHA"

# ---- study ---------------------------------------------------------------------------
log "Downloading the $STUDY_ID study (cBioPortal datahub)"
mkdir -p "$DATA_DIR/study"
tarball="$DATA_DIR/study/$STUDY_ID.tar.gz"
if [ ! -f "$STUDY_SRC/.complete" ]; then
    if ! { [ -f "$tarball" ] && gzip -t "$tarball" 2>/dev/null; }; then
        curl -fL --retry 5 -C - -o "$tarball" "https://datahub.assets.cbioportal.org/$STUDY_ID.tar.gz" \
            || die "study download failed; re-run to resume"
    fi
    rm -rf "$STUDY_SRC"
    tar -xzf "$tarball" -C "$DATA_DIR/study" || { rm -f "$tarball"; die "corrupt study tarball removed; re-run"; }
    touch "$STUDY_SRC/.complete"
else
    echo "  already downloaded"
fi

# ---- slides --------------------------------------------------------------------------
log "Downloading $SLIDE_COUNT TCGA-BRCA diagnostic slides (NCI GDC, open access)"
mkdir -p "$DATA_DIR/slides"
if [ ! -f "$DATA_DIR/slides/manifest.json" ]; then
    # The kit's default selection, so every install gets the same slides.
    cp slides.manifest.json "$DATA_DIR/slides/manifest.json"
fi
python3 download_slides.py --count "$SLIDE_COUNT" --out "$DATA_DIR/slides" --study-dir "$STUDY_SRC"

# ---- images --------------------------------------------------------------------------
log "Building images (first time: 30-60 minutes)"
to_build=()
need_image() {  # need_image <service> <image>
    if [ "$REBUILD" = 1 ] || ! docker image inspect "$2" >/dev/null 2>&1; then
        to_build+=("$1")
    else
        echo "  $1: $2 (already built)"
    fi
}
need_image tile "wsi-public-demo/tile:$TILE_SHA"
need_image importer "wsi-public-demo/importer:$CORE_SHA"
need_image portal "wsi-public-demo/portal:$PORTAL_SHA"
need_image web "wsi-public-demo/web:$FRONTEND_SHA"
if [ "${#to_build[@]}" -gt 0 ]; then
    echo "  building in parallel: ${to_build[*]}"
    dc --profile tools build "${to_build[@]}"
fi

# ---- data ----------------------------------------------------------------------------
log "Starting the databases"
dc up -d --wait clickhouse session-db session annotation-db redis
wait_clickhouse
loaded_rows="$(ch_query --query "SELECT count() FROM resource r JOIN cancer_study c ON r.cancer_study_id = c.cancer_study_id WHERE c.cancer_study_identifier = '$STUDY_ID' AND r.resource_id = 'WSI_SAMPLE'")"
derived="$(ch_query --query "SELECT count() FROM sample_derived WHERE cancer_study_identifier = '$STUDY_ID'")"
if [ "$RELOAD" = 1 ] || [ "$loaded_rows" != "$SLIDE_COUNT" ] || [ "$derived" = "0" ]; then
    ./load_data.sh
else
    echo "  $STUDY_ID is loaded with $loaded_rows slides"
fi

# ---- start ---------------------------------------------------------------------------
log "Starting the demo"
dc up -d --wait
first_patient="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["slides"][0]["patient_id"])' "$DATA_DIR/slides/manifest.json")"
cat <<EOF

Ready after $(( ($(date +%s) - START) / 60 )) min.

  Portal:         $PUBLIC_ORIGIN/
  Study:          $PUBLIC_ORIGIN/study/summary?id=$STUDY_ID
  Slides (demo):  $PUBLIC_ORIGIN/patient/wsiHESlides?studyId=$STUDY_ID&caseId=$first_patient
                  (patient page, "Pathology Slides" tab)

  Stop:   docker compose -p wsi-public-demo down      (keeps data)
  Reset:  ./reset.sh
EOF
