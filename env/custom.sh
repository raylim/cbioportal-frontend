# Dev overrides: empty string = use relative URLs so the proxy handles routing
# (avoids CORS when accessing the dev server from a remote hostname)
export CBIOPORTAL_URL=""
# WSI tile server — used only for the rspack dev-server proxy target.
# The frontend reads msk.wsi.tile_server.url from application.properties at runtime;
# this env var only affects where the proxy forwards /patient/ and /tiles/ requests.
export WSI_TILE_SERVER="http://localhost:8081"
# Bind to all interfaces so the dev server is reachable by hostname
export HOST=0.0.0.0
# Annotation API URL (Option C) — when set, the rspack dev server intercepts
# /config_service and injects msk_wsi_annotation_api_url so the Annotations
# button appears in the WSI viewer without any localStorage override.
export ANNOTATION_API_URL="http://pllimsksparky3:8081"
