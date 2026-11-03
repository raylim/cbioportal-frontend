# Onboarding (public): cBioPortal pathology slides, annotations and AI assistant

Hackathon track 10 ("Pathology slides: annotation + AI assistant"), cBioPortal Hack & Specathon, Nov 3–4 2026.
Track lead: Raymond Lim (MSK). This guide is for contributors outside MSK. It uses only public code and public data.

## 1. What exists today

cBioPortal has a native whole-slide-image (WSI) viewer, shown as a **Pathology Slides** tab on the patient page. On top of it:

- **Annotations:** draw rectangles, ellipses, circles, lines and polygons; organize them in layers with colors; edit and delete them. They are stored server side per slide and study.
- **Research assistant:** a chat panel next to the viewer. It sees the current viewport (an image plus slide context), answers questions, and proposes annotations and viewer actions for the user to review and apply.
- **Text→region search:** "find areas that look like tumor" returns ranked tile regions, proposed as a batch of annotations. The search runs on pre-computed foundation-model tile embeddings that exist for MSK's slides only, so outside MSK this feature is off. The code is open, so new embedding backends for public slides are a good project (§6).

## 2. Architecture

```
Browser (cbioportal-frontend + packages/cbioportal-wsi-viewer)
  │  same origin (reverse proxy)
  ├── /api/...  → cBioPortal backend (Spring Boot, ClickHouse)
  │                - slide rows via the generic resource API (resource ids WSI_SAMPLE / WSI_PATIENT)
  │                - per-slide access, and study-scoped tokens for annotations and the assistant:
  │                  GET /api/wsi/access-token?studyId=&purpose=annotations|agent
  └── /wsi/...  → tile server (FastAPI)
                   - /tiles, /thumbnails             slide pixels (SVS/TIFF via tiffslide)
                   - /annotations                    annotation API (Postgres or SQLite)
                   - /agent/chat (SSE), /agent/actions/...   the assistant (LLM provider: openai | bedrock | databricks)
                   - /research/v1/...                region search, called by the assistant's tools
```

**Tokens:**
- **Pixels** need a short-lived per-slide token.
- **Annotations and the assistant** use study-scoped tokens (scopes `annotations:read annotations:write`, or `agent:chat research:read annotations:read annotations:write`). These can never fetch pixels.
- The portal and the tile server share one signing secret.

**Slide identity:** the browser only sees an opaque 12-hex `slide_key`. The slide's storage location is sealed with a server-side key, and only the tile server unseals it.

## 3. Repos, branches and PRs (all public on GitHub)

| Piece | Repo | Branch | PR |
|---|---|---|---|
| Viewer + Pathology Slides tab | raylim/cbioportal-frontend | `codex/wsi-viewer-package` | cBioPortal/cbioportal-frontend **#5732** |
| Annotations UI | raylim/cbioportal-frontend | `codex/wsi-rd-annotations` | raylim/cbioportal-frontend **#19** (on #5732) |
| Assistant UI | raylim/cbioportal-frontend | `codex/wsi-rd-agent` | raylim/cbioportal-frontend **#20** (on #19). **Start here for frontend work.** |
| Backend: generic resource API + slide access | raylim/cbioportal | `codex/wsi-resource-data` | cBioPortal/cbioportal **#12378** |
| Backend: study-scoped tokens | raylim/cbioportal | `codex/wsi-rd-annotation-capability` | raylim/cbioportal **#9** (on #12378) |
| Tile server: annotation service | cBioPortal/cbioportal-tile-server | `feature/wsi-native-annotation-backend` | **#4** |
| Tile server: assistant + region search | cBioPortal/cbioportal-tile-server | `codex/wsi-research-agent-child` | **#40** (on #4) |

The stacked branches use merges, not rebases: each child gets its parent merged in. Don't rebase or force-push them. Open your own branch from the one you build on, and open a PR against it (or against your fork) so Raymond can merge it into the stack.

## 4. Public slide data

**Slides already on cbioportal.org:**
- TCGA PanCancer Atlas studies (for example `brca_tcga_pan_can_atlas_2018` and `luad_tcga_pan_can_atlas_2018`) have an `IDC_SLIM` resource ("Slide Microscopy") linking each patient to the NCI Imaging Data Commons SLIM viewer:
  ```bash
  curl -s https://www.cbioportal.org/api/studies/brca_tcga_pan_can_atlas_2018/resource-definitions
  curl -s https://www.cbioportal.org/api/studies/brca_tcga_pan_can_atlas_2018/patients/TCGA-A2-A0CM/resource-data
  ```
- These are links to IDC's viewer (DICOM), not our native viewer. Our tile server reads SVS/TIFF.

**Slides our viewer can open:** the same TCGA patients' diagnostic slides are **open-access SVS files on the GDC**; TCGA-BRCA alone has 1,133. File names start with the TCGA barcode (`TCGA-A7-A0DC-01Z-00-DX1.<uuid>.svs`), so they match `brca_tcga_pan_can_atlas_2018` patient and sample IDs.
```bash
# list a few TCGA-BRCA diagnostic slides
curl -s 'https://api.gdc.cancer.gov/files' -H 'Content-Type: application/json' -d '{
  "filters": {"op":"and","content":[
    {"op":"in","content":{"field":"cases.project.project_id","value":["TCGA-BRCA"]}},
    {"op":"in","content":{"field":"data_type","value":["Slide Image"]}},
    {"op":"in","content":{"field":"experimental_strategy","value":["Diagnostic Slide"]}}]},
  "fields": "file_id,file_name,file_size,cases.submitter_id", "size": 5}'
# download one (about 100–1000 MB each)
curl -L -o slide.svs https://api.gdc.cancer.gov/data/<file_id>
```
The study itself (`brca_tcga_pan_can_atlas_2018`) is in the public cBioPortal datahub and loads into a local stack with `cbioportal-docker-compose`.

## 5. Developing

### 5.1 Frontend against mocked backends (no data needed; the fastest start)
The viewer's Playwright specs fake every backend route (`page.route`), so a static production build is enough.
```bash
git clone https://github.com/raylim/cbioportal-frontend.git && cd cbioportal-frontend
git checkout codex/wsi-rd-agent && git checkout -b <you>/<feature>
corepack enable
pnpm install --frozen-lockfile
pnpm run buildAll                     # buildModules + the app; rebuild after changing packages/
```
Serve `dist/` with a fallback to `index.html` for SPA routes (`http-server` has none):
```python
# spa_server.py: python3 spa_server.py 8099 dist
import http.server, os, sys
port, root = int(sys.argv[1]), sys.argv[2]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def send_head(self):
        if not os.path.exists(self.translate_path(self.path)): self.path = '/index.html'
        return super().send_head()
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
```
Run the WSI specs:
```bash
cd end-to-end-test-playwright && pnpm install --ignore-workspace && npx playwright install chromium
PW_SUITE=wsi LOCALDEV=0 CBIOPORTAL_URL=http://127.0.0.1:8099 \
  npx playwright test tests/wsi-foundation-mocked.spec.ts tests/wsi-annotation-agent.spec.ts
```
- Mocks and fixtures: `end-to-end-test-playwright/tests/wsi-foundation-mocks.ts`. Extend them for new features.
- Run Playwright with `--headed` or `--ui` to see the viewer and click around.

Where the code is:
- `packages/cbioportal-wsi-viewer/src/` is the viewer package:
  - `WsiAgentPanel.tsx`: the assistant chat. SSE events are `message.delta`, `tool.called`, `tool.error`, `proposal` and `complete {proposal_ids, success, error?}`.
  - `WsiAgentProposalOverlay.tsx`: draws proposals on the slide.
  - `wsiAnnotationControls.tsx` and neighbours: the annotation toolbar, layers and list.
- `src/shared/components/wsiViewer/`: portal-side wiring (config, controllers, geometry utils).
- Config comes from portal properties: `wsi.tile_server.url`, `wsi.annotation_api.url`, `wsi.agent.enabled`.

Unit tests: `pnpm run testMain` (`GREP=<file>.spec.ts pnpm run testMain` for one file) and `pnpm run testPackages`. Prettier runs on commit: 4-space indent, single quotes, ES5 trailing commas.

### 5.2 Tile server, annotation service and assistant
```bash
git clone https://github.com/cBioPortal/cbioportal-tile-server.git && cd cbioportal-tile-server
git checkout codex/wsi-research-agent-child && git checkout -b <you>/<feature>
uv sync && uv run pytest                  # unit tests; no network or data needed
```
Key modules:
- `app/main.py`: app, routers, slide-token gate, CORS. The `/wsi` prefix is stripped.
- `app/auth.py`: per-slide tokens, plus `validate_scoped_capability`, `scoped_user_dependency` and `require_user` for study tokens.
- `app/annotations.py`, `app/annotation_db.py`: the annotation API and its migrations.
- `app/agent.py`: the assistant. Providers are `openai`, `bedrock` and `databricks`. Its tools are `propose_annotation*`, `propose_viewer_action`, `wsi_find_regions` and `wsi_propose_retrieval_annotations`.
- `app/research.py`: region search (manifest, calls to the embedding worker, fallback).

Settings for local runs (see the README's env table):
- **Annotations:**
  - SQLite with `ANNOTATION_DB_PATH=/tmp/annotations.db`, or Postgres with `ANNOTATION_DATABASE_URL`.
  - `ANNOTATION_AUTH_ENABLED=false` gives a `dev-user` identity with no portal; use it for local experiments only.
  - Postgres integration test: start `postgres:16`, then run `POSTGRES_TEST_DSN=postgresql://… uv run pytest -m integration tests/test_postgres_integration.py`.
- **The assistant, with your own OpenAI key:** `WSI_AGENT_ENABLED=true WSI_AGENT_PROVIDER=openai OPENAI_API_KEY_FILE=~/.openai_key` (an `sk-…` key), with the model set via `WSI_AGENT_MODEL`. You can also use `WSI_AGENT_PROVIDER=bedrock` with your own AWS account.
- **Region search:** leave `WSI_RESEARCH_ENABLED=false` unless you build a public embedding backend (§6). Its HTTP contract is `POST /v1/search` with `{model, model_record, query_plan:{primary, positive[], negative[], summary}, top_k, slide_width, slide_height}`, returning `{regions:[{candidate_id, model, points:[{x,y},{x+w,y+h}] in 0..1000, score, rank, …}], warning?}`.
- **Local slides:** `WSI_ALLOWED_SOURCE_SCHEMES=file`, with `WSI_ALLOWED_SOURCE_PREFIXES=file:///path/to/slides/`.

### 5.3 A full local stack with public data: the demo kit
The kit is in this repo on the branch `hackathon/wsi-public-demo-kit`, directory `public-demo-kit/`. It brings up a local cBioPortal with the native viewer, annotations and (with your own OpenAI key) the assistant, using public data only:
- `brca_tcga_pan_can_atlas_2018` from the cBioPortal datahub, trimmed to the slide patients;
- 6 open-access TCGA-BRCA diagnostic slides from the GDC (about 1.4 GB), md5-checked;
- WSI resource rows generated for those slides, sealed with a key the kit generates on your machine.

```bash
git clone -b hackathon/wsi-public-demo-kit https://github.com/raylim/cbioportal-frontend.git
cd cbioportal-frontend/public-demo-kit && cp .env.example .env   # then read README.md
./setup.sh
```
- **Needs:** Docker with Compose, `git`, about 8 GB for images and data plus up to about 20 GB of Docker build cache, and a first build of 30–45 minutes.
- **Pinned versions:** it builds from source at the last commits of #9, #20 and tile #40 that work together. Those still use per-slide tile tokens. The newest branch heads have moved to tokenless tile access behind an ingress check, which the kit will follow once the matching tile-server merge is published.
- **Known limit:** no region search (that needs non-public embeddings), and no login.

## 6. Good tasks for this track

**Annotations**
1. **GeoJSON import/export** for QuPath round-trips. Frontend buttons in the annotation panel; coordinates are already in slide pixels.
2. **Sharing and visibility.** `visible_to` is already a list field; add a private/group/study UI and enforce it in `annotations.py`.
3. **Comment threads** on an annotation (new table plus UI).
4. **Study-level annotation browser:** list annotations across a study, filter by label or layer, click through to the slide.

**Assistant**

5. **Patient context:** give the assistant a tool that calls the public cBioPortal API (mutations, clinical attributes, timeline) for the current patient.
6. **Search UX:** show ranks and scores, accept or reject individual proposed regions instead of the whole batch, and add a heat-map overlay.
7. **A public embedding backend:** a worker that implements the `/v1/search` contract above for public slides, e.g. an open text–image pathology model over tiles of GDC SVS files.

**Specathon**

8. Pathologist workflow in cBioPortal (review → annotate → compare → build a cohort): mockups plus a short spec.

## 7. Working together
- **Talk:** the hackathon Slack channel `#cbioportal-fall-hackathon-2026` (cbioportal.slack.com) and GitHub PR comments.
- **Claim a task** in Slack before starting, so two people don't build the same thing.
- **Share work** as PRs against the branch you started from (or from your fork); Raymond merges them into the stack.

## 8. Rules
- **Never commit secrets:** API keys, `.env` files or signing and sealing keys.
- **Use public data only** (cbioportal.org, the datahub, GDC open access). Respect the GDC and TCGA data use terms.
- **Comments** describe what the code does now, not its history. **PR descriptions** describe current functionality only.
- **After viewer changes,** check that tiles still load (network tab), not only your feature.
