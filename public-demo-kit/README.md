# cBioPortal whole-slide image viewer: public demo kit

A self-contained, local cBioPortal with the native whole-slide image (WSI) viewer, slide
annotations and an optional slide assistant, on **public data only**:

- the TCGA breast cancer PanCancer Atlas study `brca_tcga_pan_can_atlas_2018` from the
  [cBioPortal datahub](https://github.com/cBioPortal/datahub), trimmed to the demo patients;
- 6 open-access TCGA-BRCA diagnostic H&E slides (Aperio SVS, 0.13 to 0.3 GB each) from the
  [NCI Genomic Data Commons](https://portal.gdc.cancer.gov).

Everything is built from pinned commits of public GitHub repositories. Nothing needs an
account, a registry login or a private network.

## Requirements

- Linux or macOS with Docker Engine or Docker Desktop, and Docker Compose v2 (`docker compose`).
- `git`, `curl`, `openssl`, `python3` (3.8 or newer, standard library only), `tar`.
- RAM: 8 GB free for the running demo; the frontend build needs about 6 GB on its own.
  With Docker Desktop, give the VM at least 10 GB.
- Disk: about 20 GB in total.
  - Data directory (`DATA_DIR`), about 4 GB: the study tarball and its unpacked copy
    (2 GB), 6 slides (1.4 GB), and the source checkouts (0.5 GB).
  - Docker, about 4.5 GB for the final images, plus the base images and build cache
    (Maven, pnpm), about 15 GB in all. The databases stay under 1 GB.
- Network access during setup: github.com, Docker Hub, registry.npmjs.org, Maven Central,
  PyPI, api.gdc.cancer.gov and datahub.assets.cbioportal.org.
- Time: the first setup takes 30 to 60 minutes, almost all of it building the four
  images. The downloads take a few minutes; loading the data takes about 1 minute.
  After that, `./setup.sh` starts the demo in under a minute.

## Quickstart

```bash
./setup.sh
```

Then open the URLs it prints. The default is <http://localhost:27800/patient/wsiHESlides?studyId=brca_tcga_pan_can_atlas_2018&caseId=TCGA-A7-A0CD>,
the patient page's **Pathology Slides** tab. Pick a slide; draw on it with the toolbar
(rectangle, ellipse, circle, line, polygon); manage colours and layers; your annotations
are saved.

`setup.sh` is idempotent and resumable: re-run it after an interruption. It:

1. creates `.env` from `.env.example`, generating every secret locally with `openssl`;
2. checks out the pinned commits under `$DATA_DIR/src/`;
3. downloads the study tarball and the slides (resuming partial downloads, verifying each
   slide's md5);
4. builds four images;
5. loads the study (`load_data.sh`);
6. starts everything.

Options:

- `./setup.sh --rebuild` rebuilds the images.
- `./setup.sh --reload` re-imports the study.
- On the first run, `DATA_DIR`, `SLIDE_COUNT`, `PUBLIC_ORIGIN`, `WEB_PORT` and
  `BIND_ADDRESS` from the environment go into `.env`. For example:

  ```bash
  DATA_DIR=/big/disk/wsi-demo SLIDE_COUNT=8 ./setup.sh
  ```

## What runs

| Service | Image (built from) | Role |
| --- | --- | --- |
| `web` | nginx + frontend build ([raylim/cbioportal-frontend](https://github.com/raylim/cbioportal-frontend) `codex/wsi-rd-agent`) | Single origin. It serves `/frontend/` and proxies `/wsi/*` to `tile` and everything else to `portal`. |
| `portal` | [raylim/cbioportal](https://github.com/raylim/cbioportal) `codex/wsi-rd-annotation-capability`, `docker/web/Dockerfile` | cBioPortal backend in ClickHouse mode, without login. It issues the slide and annotation capabilities. |
| `tile` | [cBioPortal/cbioportal-tile-server](https://github.com/cBioPortal/cbioportal-tile-server) `codex/wsi-research-agent-child` | Tiles and thumbnails from the local SVS files, plus the annotation service and the slide assistant. |
| `clickhouse` | `clickhouse/clickhouse-server:24.8` | The cBioPortal database (schema 3.1.0). |
| `session`, `session-db` | `cbioportal/session-service:0.6.4`, `mongo:4.2` | Saved sessions and virtual studies. |
| `annotation-db` | `postgres:16-alpine` | Annotations. |
| `redis` | `redis:7-alpine` | Tile cache coordination and rate limits. |
| `importer` (tool) | [cBioPortal/cbioportal-core](https://github.com/cBioPortal/cbioportal-core) `main` | Validator and importer. It runs only during `load_data.sh`. |

The exact commits are `PORTAL_SHA`, `FRONTEND_SHA`, `TILE_SHA` and `CORE_SHA` in `.env`.

How a slide is shown:

1. The viewer lists a patient's slides through the standard resource API
   (`POST /api/resource-table/query/fetch`, resources `WSI_SAMPLE` and `WSI_PATIENT`).
2. For a slide, it asks the portal for a 5-minute slide capability
   (`GET /api/resources/{studyId}/{resourceId}/access?key=&patientId=`).
3. It sends that capability with each tile request (`/wsi/tiles/...`).

The slide's file path never reaches the browser. Each resource row carries the path
sealed (AES-GCM) with `WSI_SOURCE_SEAL_KEY`, and only the tile server holds that key.

Annotations use a study-scoped capability: `GET /api/wsi/access-token?studyId=&purpose=annotations`.

### Ports

All ports are bound to `127.0.0.1` by default (`BIND_ADDRESS`).

| Port | What |
| --- | --- |
| 27800 (`WEB_PORT`) | The demo. |
| 27801 (`CLICKHOUSE_HTTP_PORT`) | ClickHouse HTTP. User `cbio`; the password is in `.env`. |

To use the demo from another machine:

1. Set `BIND_ADDRESS=0.0.0.0` and `PUBLIC_ORIGIN=http://<host>:27800` in `.env`.
2. Run `./setup.sh --reload`. The slide rows embed the origin, and the portal and tile
   server are configured for it.

The browser must use exactly `PUBLIC_ORIGIN`.

### Files

| File | What |
| --- | --- |
| `setup.sh` | One-command setup (see above). |
| `load_data.sh` | Trims the study, writes the WSI rows, validates and imports, rebuilds the derived tables, restarts the portal. |
| `download_slides.py` | Picks and downloads GDC slides and writes `manifest.json`. |
| `make_wsi_resources.py` | Writes the WSI resource rows and thumbnails. It runs inside the tile image. |
| `trim_study.py` | Copies the datahub study, restricted to the slide patients. |
| `reset.sh` | Deletes the databases (`--all`: also downloads and images). |
| `slides.manifest.json` | The default slide selection (GDC file ids, md5, sizes). |
| `compose.yml`, `nginx.conf`, `application.properties`, `clickhouse_user_settings.xml`, `docker/clickhouse-init.sh` | The stack. |
| `.env.example` | Settings and pinned commits. `.env` is generated from it and is git-ignored. |
| `verify/api_check.sh`, `verify/browser_check.js` | Smoke tests (see below). |

`$DATA_DIR` (default `./data`) holds:

- `study/`: the datahub tarball and its unpacked copy.
- `demo-study/`: the trimmed study that is imported, plus `validation-report.html`.
- `slides/`: the SVS files, `manifest.json` and `thumbnails/`.
- `src/`: the source checkouts.

## How the data is loaded

`load_data.sh` runs these steps. Every step is a standard cBioPortal route.

1. **Trim** (`trim_study.py`). The study is restricted to the 6 slide patients. It keeps
   the clinical data, mutations, discrete CNA, segments, structural variants, the gene
   panel matrix, timelines, the study's own resource files and the case lists.
   Expression, methylation, RPPA and generic-assay profiles are dropped to keep the
   import small.
2. **WSI resource rows** (`make_wsi_resources.py`). These are standard
   [Resource Data](https://docs.cbioportal.org/file-formats/#resource-data) files.
   - It adds `WSI_SAMPLE` and `WSI_PATIENT` to `data_resource_definition.txt`, with a
     `CUSTOM_METADATA` contract declaring every metadata key.
   - It writes one `WSI_SAMPLE` row per slide to `data_resource_sample.txt`.
     - The URL is the standalone viewer permalink.
     - `METADATA` holds `slide_key` (12 hex characters, derived from the GDC file id), the
       stain, part and block fields, and `serving`.
     - `serving` holds `key`, `sealed_source`, the thumbnail size and
       `tile_metadata_json`. The tile metadata is the level geometry and mpp, read with
       the tile server's own tiffslide code.
   - Slide `TCGA-A7-A0CD-01Z-00-DX1` is matched to sample `TCGA-A7-A0CD-01`.
   - The thumbnails are rendered once to `slides/thumbnails/` by the tile server's
     thumbnail code.
3. **Import** with `metaImport.py` (cbioportal-core), validating against the running
   portal. Warnings are allowed (`-o`); errors stop the import.
4. **Derived tables**: `populate_derived_tables.sql` from the pinned backend commit, run
   with `clickhouse-client`. Some filesystems under Docker's data root cannot do
   `EXCHANGE TABLES`, for example cluster or network filesystems. On those the script
   swaps the tables with `RENAME` instead.
5. **Restart** the portal.

To use more slides, set `SLIDE_COUNT` in `.env` and run `./setup.sh --reload`. Slides
beyond the default 6 are picked from the GDC with the same rule, so the GDC must be
reachable. The rule is: Diagnostic Slide, 100 to 300 MB, one per study patient, ordered
by file name.

## Slide assistant (optional, your own OpenAI key)

The assistant is off by default. The viewer then shows no assistant panel, and
`/wsi/agent/health` reports `"enabled": false`. To turn it on:

```bash
echo 'sk-...' > secrets/openai_api_key   # one line, your own key
./setup.sh                               # turns the assistant on and restarts
```

- Change the model with `WSI_AGENT_MODEL` in `.env` (default `gpt-4.1-mini`), then
  re-run `./setup.sh`.
- The key stays in the tile server. The browser only gets a 5-minute, study-scoped
  capability.
- Annotations the assistant proposes wait for your approval in the viewer.
- To turn it off, delete `secrets/openai_api_key` and re-run `./setup.sh`.

Region search ("find regions like this") needs a feature index that is not part of this
demo, so it stays off (`WSI_RESEARCH_ENABLED=false`).

## Day to day

```bash
docker compose -p wsi-public-demo ps                 # status
docker compose -p wsi-public-demo logs -f tile       # logs of one service
docker compose -p wsi-public-demo down               # stop (keeps all data)
./setup.sh                                           # start again
./reset.sh                                           # delete the databases; ./setup.sh reloads
./reset.sh --all                                     # also delete downloads, sources and images
verify/api_check.sh                                  # API smoke test
```

The browser check needs Playwright:

```bash
npm i -D @playwright/test && npx playwright install chromium
node verify/browser_check.js http://localhost:27800 TCGA-A7-A0CD
```

## Developing against the demo

**Frontend: live reload against this backend.** In a cbioportal-frontend checkout (for
example `$DATA_DIR/src/frontend`):

```bash
pnpm install --frozen-lockfile && pnpm run buildModules
export BRANCH_ENV=master
pnpm run start        # dev server on localhost:3000
```

Then open <http://localhost:27800>, run `localStorage.setItem("localdev", true)` in the
browser console and reload: the page now loads the frontend from the dev server, against
this demo's backend, tile server and data. `localStorage.clear()` undoes it.

This demo is served over plain HTTP, so `pnpm run start` is right. `pnpm run startSSL`
is for portals served over HTTPS (for example if you put TLS in front of the demo).

**Rebuilding one service.** Every image is built from `$DATA_DIR/src/<name>`. Edit or
check out code there, then rebuild and restart that service:

```bash
docker compose -p wsi-public-demo build tile && docker compose -p wsi-public-demo up -d tile
docker compose -p wsi-public-demo build portal && docker compose -p wsi-public-demo up -d portal
docker compose -p wsi-public-demo build web && docker compose -p wsi-public-demo up -d web
```

To move to other commits, change `*_SHA` in `.env` and run `./setup.sh --rebuild`. The
image tags follow the SHAs.

If you change something under `$DATA_DIR/demo-study/` by hand, re-import with
`./load_data.sh`. Note that `load_data.sh` regenerates `demo-study/` from the download
first.

## Known limits

- This is a demo. There is no login (`authenticate=false`): anyone who can reach the port
  sees everything and can write annotations, which are stored as the shared user
  `local-development`. Keep it on `127.0.0.1` or a trusted network.
- No region search, and the assistant only works with your own OpenAI key.
- The study is trimmed to the demo patients, and some profiles are dropped (see above).
  The study view shows only those patients.
- OncoKB annotation is off (it needs a token). Other annotation services (Genome Nexus,
  hotspots, CIViC) are called on the public internet from the browser, as on
  cbioportal.org.
- On the patient page, the browser console shows one 404: the "Pathology Report" tab
  looks up a TCGA pathology report on GitHub, and some patients have none. The other TCGA
  tabs ("Tissue Image", "Slide Microscopy") link to external viewers.
- The commits are pinned. The WSI work is on open pull requests, so the branches will
  move on, but the kit does not follow them.

## Data attribution and terms

- **Slides:** The Cancer Genome Atlas (TCGA) program, TCGA-BRCA diagnostic slides,
  open-access data from the NCI Genomic Data Commons (<https://portal.gdc.cancer.gov>).
  Use is subject to the [NIH GDC data use policies](https://gdc.cancer.gov/access-data/data-access-processes-and-tools)
  and the [TCGA publication guidelines](https://www.cancer.gov/ccg/research/genome-sequencing/tcga/using-tcga-data/citing).
  The results here are in whole or part based upon data generated by the TCGA Research
  Network: <https://www.cancer.gov/tcga>.
- **Study data:** `brca_tcga_pan_can_atlas_2018` from the cBioPortal datahub
  (<https://github.com/cBioPortal/datahub>); see the `LICENSE` and `README.md` shipped in
  the study. Please cite the TCGA PanCancer Atlas publications listed in the study's
  `meta_study.txt` and cBioPortal (Cerami et al., *Cancer Discov.* 2012; Gao et al.,
  *Sci. Signal.* 2013; de Bruijn et al., *Cancer Res.* 2023).
- **Software:** cBioPortal (AGPL-3.0 / Apache-2.0, per repository), the cBioPortal tile
  server, and their dependencies, under their own licenses.
