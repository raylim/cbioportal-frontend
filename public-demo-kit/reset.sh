#!/usr/bin/env bash
# Reset the demo.
#
#   ./reset.sh            stop and delete the databases (ClickHouse, annotations, sessions);
#                         downloads, sources and images are kept, so ./setup.sh reloads quickly
#   ./reset.sh --all      also delete $DATA_DIR (study, slides, sources) and the built images
source "$(dirname "$0")/lib.sh"
load_env

ALL=0
case "${1:-}" in
    --all) ALL=1 ;;
    "") ;;
    *) sed -n '2,7p' "$0"; exit 1 ;;
esac

log "Stopping the demo and deleting its volumes"
dc --profile tools down -v --remove-orphans

if [ "$ALL" = 1 ]; then
    log "Deleting the built images"
    for image in "tile:$TILE_SHA" "portal:$PORTAL_SHA" "web:$FRONTEND_SHA" "importer:$CORE_SHA"; do
        docker image rm "wsi-public-demo/$image" 2>/dev/null || true
    done
    log "Deleting $DATA_DIR"
    rm -rf "$DATA_DIR"
fi
echo "Done. Run ./setup.sh to start again."
