#!/usr/bin/env bash
# API smoke test of a running demo: study, WSI rows, slide access, tiles, thumbnail,
# annotation capability and CRUD, and that an annotation capability cannot open tiles.
#
#   verify/api_check.sh [origin]      (default: PUBLIC_ORIGIN from .env)
set -euo pipefail
cd "$(dirname "$0")/.."
ORIGIN="${1:-$(grep -E '^PUBLIC_ORIGIN=' .env | cut -d= -f2-)}"
STUDY=brca_tcga_pan_can_atlas_2018
PATIENT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["slides"][0]["patient_id"])' slides.manifest.json)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got $2, want $3)"; fi; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "Checking $ORIGIN (study $STUDY, patient $PATIENT)"

n=$(curl -fsS "$ORIGIN/api/studies" | json "sum(1 for s in d if s['studyId'] == '$STUDY')")
check "study listed in /api/studies" "$n" 1

rows=$(curl -fsS -X POST -H 'Content-Type: application/json' "$ORIGIN/api/resource-table/query/fetch" \
    -d "{\"studyIds\":[\"$STUDY\"],\"resourceId\":\"WSI_SAMPLE\",\"patientIdentifiers\":[{\"studyId\":\"$STUDY\",\"patientId\":\"$PATIENT\"}],\"sampleIdentifiers\":[],\"pageNumber\":0,\"pageSize\":100}")
count=$(echo "$rows" | json "len(d)")
[ "$count" -ge 1 ] && ok "WSI_SAMPLE rows for $PATIENT ($count)" || bad "no WSI_SAMPLE rows for $PATIENT"
KEY=$(echo "$rows" | json "d[0]['metadata']['serving']['key']")
Z=$(echo "$rows" | json "d[0]['metadata']['serving']['tile_metadata_json']['safe_min_level']")
MAXZ=$(echo "$rows" | json "d[0]['metadata']['serving']['tile_metadata_json']['max_zoom']")

access=$(curl -fsS "$ORIGIN/api/resources/$STUDY/WSI_SAMPLE/access?key=$KEY&patientId=$PATIENT")
TOKEN=$(echo "$access" | json "d['accessToken']")
[ -n "$TOKEN" ] && ok "slide access token issued" || bad "slide access returned no token"
check "slide access for an unknown key" "$(code "$ORIGIN/api/resources/$STUDY/WSI_SAMPLE/access?key=000000000000&patientId=$PATIENT")" 404

check "tile z=$Z (lowest safe level)" "$(code -H "Authorization: Bearer $TOKEN" "$ORIGIN/wsi/tiles/zxy/$Z/0/0")" 200
check "tile z=$MAXZ (full resolution)" "$(code -H "Authorization: Bearer $TOKEN" "$ORIGIN/wsi/tiles/zxy/$MAXZ/100/40")" 200
check "thumbnail" "$(code -H "Authorization: Bearer $TOKEN" "$ORIGIN/wsi/thumbnails?width=256&height=256")" 200
check "tile without a token" "$(code "$ORIGIN/wsi/tiles/zxy/$Z/0/0")" 401

ann=$(curl -fsS "$ORIGIN/api/wsi/access-token?studyId=$STUDY&purpose=annotations")
ATOKEN=$(echo "$ann" | json "d['access_token']")
[ -n "$ATOKEN" ] && ok "annotation capability issued" || bad "annotation capability missing"
check "annotation capability on a tile" "$(code -H "Authorization: Bearer $ATOKEN" "$ORIGIN/wsi/tiles/zxy/$Z/0/0")" 401
check "slide capability on annotations" "$(code -H "Authorization: Bearer $TOKEN" "$ORIGIN/wsi/annotations?slide_id=$KEY&study_id=$STUDY")" 401

AUTH=(-H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json')
created=$(curl -fsS -X POST "${AUTH[@]}" "$ORIGIN/wsi/annotations" -d "{\"slide_id\":\"$KEY\",\"study_id\":\"$STUDY\",\"body\":{\"label\":\"api-check\",\"comment\":\"smoke test\",\"type\":\"rectangle\"},\"target\":{\"selector\":{\"type\":\"FragmentSelector\",\"conformsTo\":\"http://www.w3.org/TR/media-frags/\",\"value\":\"xywh=pixel:1000,1000,500,400\"}}}")
AID=$(echo "$created" | json "d['id']")
VER=$(echo "$created" | json "d['version']")
[ -n "$AID" ] && ok "annotation created" || bad "annotation create failed"
listed=$(curl -fsS "${AUTH[@]}" "$ORIGIN/wsi/annotations?slide_id=$KEY&study_id=$STUDY" | json "sum(1 for a in d if a['id'] == '$AID')")
check "annotation listed" "$listed" 1
updated=$(curl -fsS -X PUT "${AUTH[@]}" "$ORIGIN/wsi/annotations/$AID" -d "{\"body\":{\"label\":\"api-check (edited)\",\"type\":\"rectangle\"},\"version\":$VER}" | json "d['body']['label']")
check "annotation updated" "$updated" "api-check (edited)"
check "annotation deleted" "$(code -X DELETE "${AUTH[@]}" "$ORIGIN/wsi/annotations/$AID")" 204
check "annotation without a token" "$(code "$ORIGIN/wsi/annotations?slide_id=$KEY&study_id=$STUDY")" 401

agent=$(curl -fsS "$ORIGIN/wsi/agent/health")
echo "  info assistant: $agent"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
