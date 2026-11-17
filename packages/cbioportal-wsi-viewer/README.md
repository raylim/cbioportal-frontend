# cbioportal-wsi-viewer

The cBioPortal whole-slide image (WSI) viewer. It lists a patient's pathology slides by specimen and shows the selected one with OpenSeadragon. Tiles and thumbnails come from the cBioPortal tile server.

The package holds the viewer only. It never imports cBioPortal app code: the host injects portal services at startup, and puts the viewer inside its own pages, such as the patient Pathology Slides tab or the standalone `/wsi/patient/:id` route.

## Entries

| Import | Contents | Load |
| --- | --- | --- |
| `cbioportal-wsi-viewer` | Types, `configureWsiViewerRuntime`, `fetchWsiPatientHierarchy` (loads a patient's hierarchy through the viewer's cache, e.g. to decide whether to show a slides tab), `#wsi:` URL-state helpers, the theme (`WSI_THEME`, widths, section-title and list styles) and the panel chrome (`WsiPanelHideButton`, `WsiCollapsedRail`, stored panel flags) | Static, and small |
| `cbioportal-wsi-viewer/viewer` | The React viewer (default export, also `WsiViewer`) | Lazily, e.g. with `React.lazy` |

OpenSeadragon is not in either entry. The viewer loads it on the first slide open as its own async chunk (`wsi-openseadragon`), so pages without slides never download it. In the app, `pnpm run checkWsiBundle` (`scripts/assert_wsi_osd_bundle.js`) checks this on a production build; CI runs it after the build.

## Using it in a host

1. **Configure the runtime once, at startup, before any viewer renders:**

   ```ts
   import { configureWsiViewerRuntime } from 'cbioportal-wsi-viewer';

   configureWsiViewerRuntime({
       buildApiUrl: path => buildCBioPortalAPIUrl(path), // adds the portal's context path
       buildPageUrl: (path, query) => buildCBioPortalPageUrl(path, query), // optional: sidebar patient/sample links (default: root-relative)
       osdPrefixUrl: '/reactapp/osd-images/', // optional: OpenSeadragon button images
       // fetchImpl: …                  // optional (default: the global fetch)
   });
   ```

2. **Render the viewer lazily:**

   ```tsx
   const WsiViewer = React.lazy(() => import('cbioportal-wsi-viewer/viewer'));

   <React.Suspense fallback={<Loading />}>
       <WsiViewer
           studyId="mskimpact"
           patientId="P-0000689"
           tileServerUrl="/wsi"        // same-origin with the portal
           authScope={userName}        // isolates the in-memory caches per user
           height={720}
       />
   </React.Suspense>
   ```

The cBioPortal app does both in `src/shared/components/wsiViewer/wsiAppConfig.tsx` (`buildWsiViewerConfig`, `AppWsiViewer`). `src/appBootstrapper.tsx` installs the runtime.

### Main props (`WsiViewerProps`)

| Prop | Purpose |
| --- | --- |
| `studyId`, `patientId` | The patient whose slides are shown. Changing `patientId` reloads the viewer in place |
| `tileServerUrl` | Tile-server base URL, the portal's `wsi_tile_server_url`. It must be same-origin with the portal, e.g. `/wsi` on the portal host (see [Portal contract](#portal-contract)). A trailing slash is optional |
| `authScope` | Subject used to isolate protected in-memory caches, normally the user name |
| `height` | Viewer height in pixels |
| `requestedSlideKey` | Slide to open, as from a `slideKey` viewer link. A `#wsi:` hash with a viewport takes precedence |
| `initialStainFilter`, `initialMatchFilter`, `preferredSampleId`, `pathologyFilter` | Initial slide-list filters and selection, e.g. from a table link |
| `clinicalRows` | Rows for the sidebar's Clinical section, in display order. A row with a `sampleId` shows only for that sample's slides. Unset hides the section |
| `navCollapsed` / `metadataCollapsed` (+ change callbacks) | Control the hideable slide list and details sidebar. Unset, the viewer remembers the user's choice in `localStorage` |
| `showDownload`, `renderLoading` | Show the download-view control; a custom loading indicator |
| `hidden` | The host hides the viewer without unmounting it, e.g. in an inactive tab. The panel shortcuts are off and OpenSeadragon ignores the collapsed container's size meanwhile |

## Portal contract

The viewer talks to the cBioPortal backend and tile server only:

| Request | Use |
| --- | --- |
| `POST {api}/api/resource-table/query/fetch` (`WSI_SAMPLE`, `WSI_PATIENT`) | The patient's slide rows. The viewer groups them into samples → parts → blocks → slides; no rows means no slides |
| `{tileServerUrl}/tiles/zxy/{z}/{x}/{y}?studyId=…&key=…&enc=…` | One tile of a slide |
| `{tileServerUrl}/thumbnails?studyId=…&key=…&enc=…&width=…&height=…` | A slide's thumbnail, at most `width`×`height`; the tile server sizes it from the stored one |

Slides are rows of the `WSI_SAMPLE`/`WSI_PATIENT` resources, one per slide, written by the data provider's pipeline. A row's `metadata` carries the slide's fields and, for a slide that can serve tiles, `serving` with its key (`serving.key`, equal to `slide_key`), sealed source (`serving.sealed_source`) and tile metadata (`serving.tile_metadata_json`). Tile and thumbnail requests name the slide by `studyId`, `key` and `enc` (the sealed source), all URL-encoded; the viewer never sends the source image id, and never displays the sealed source. Only the tile server can open the sealed source.

Access is checked in front of the tile server, not by the viewer: tile and thumbnail requests carry the portal session cookie, and the ingress allows them only if that session can read the study (`GET {api}/api/studies/{studyId}`). No token or `Authorization` header is sent.

So `wsi_tile_server_url` must be same-origin with the portal, such as `/wsi` on the portal host. Thumbnails are fetched with `credentials: 'same-origin'` and tiles with OpenSeadragon's XHR without credentials, so a cross-origin tile server never receives the cookie and the ingress refuses every request. The viewer logs a `console.error` once when the configured URL is cross-origin.

Only the ingress answers 401/403, meaning the session expired or lacks access to the study; the tile server answers its own refusals (a source it will not open, an `enc` that does not match the `key`) with 404. A tile answered 401/403 puts the viewer in its error state, asking the user to reload or sign in again. A failed thumbnail never fails the slide: the slide list retries or hides it, and the slide opens without its preview.

### Annotation service

With `annotations: { apiUrl }` in the runtime (the portal's `wsi_annotation_api_url`, e.g. `/wsi`), the viewer adds annotation authoring:

```ts
annotations: {
    apiUrl: '/wsi',
    // Optional: terms the label field offers (wsi_annotation_label_vocabulary,
    // comma-separated), and whether only those are allowed
    // (wsi_annotation_label_vocabulary_strict).
    labelVocabulary: ['Tumor', 'Stroma', 'Necrosis', 'Lymphocytes', 'Mitosis'],
    labelVocabularyStrict: false,
}
```


| Request | Use |
| --- | --- |
| `GET {apiUrl}/annotations?slide_id=…&studyId=…` | The slide's annotations in the authorized study |
| `POST {apiUrl}/annotations?studyId=…` | Create one; the body names `slide_id` and `study_id` |
| `PUT {apiUrl}/annotations/{id}?studyId=…` | Update one, with its `version` |
| `DELETE {apiUrl}/annotations/{id}?studyId=…` | Delete one |

The service sits behind a proxy that authorizes each request with the portal session cookie for the study in `studyId`, and forwards the user and study to the service. So every request:

- sends the cookie (`credentials: 'include'`) and no token or `Authorization` header;
- carries `studyId` exactly once in the query string;
- if it is a write (POST, PUT, PATCH, DELETE), sends `X-Requested-With: XMLHttpRequest`, and `Content-Type: application/json` with its body.

A 401 means the user is signed out: the toolbar asks them to sign in and editing is off. A 403 means no access to the study: annotations are read-only. Neither is retried; a new slide or study tries again. `wsiServiceRequest.ts` holds the request rules.

#### Annotation body

The viewer writes the service's `AnnotationBody` fields as follows:

| Field | Holds |
| --- | --- |
| `label` | The annotation's label |
| `comment` | The user's free-text note (empty when there is none) |
| `layer_name` | The layer the annotation is drawn on |
| `type` | The named color, as `name|#hex` |
| `color` | The color as `#hex` |
| `provenance` | Kept as stored; the viewer never drops it on an update |

Rows written before the viewer used `layer_name` kept the layer in `comment` and sent no `layer_name` or `color`, so the service stored its defaults (`Default`, `#2f80ed`). The viewer reads `comment` as the layer only for such rows: when `layer_name` is missing or `Default`, `color` is missing or exactly `#2f80ed`, and `comment` is one line of at most 100 characters. The viewer always writes `color`, and writes `#2f80ed` as `#2F80ED`, so a note on a row it wrote is never read as a layer. Saving an edit to a legacy row writes its layer to `layer_name` and clears `comment`. A `comment` that only repeats `layer_name`, as the service writes for a saved assistant proposal, is not shown as a note. `wsiAnnotationBody.ts` holds the rules.

#### Private and shared annotations

`visible_to` decides who sees an annotation: `null` keeps it private to its creator, and `[]` shares it with everyone who can read the study. The toolbar's **Shared**/**Private** button sets the default for new annotations (shared unless the user chose private; remembered in `localStorage`), and each list row shows a **Private** or **Shared** badge that switches the annotation with a versioned `PUT`. The service also accepts group names, but the proxy sends no groups, so the viewer offers no group choice; a row shared with groups shows **Groups**.

#### AI annotations

An annotation a machine made shows an **AI** badge: **AI · unreviewed** until a user reviews it, then **AI · accepted**. Its `provenance.source` says what made it, and the badge's tooltip says which:

- `agent` or `assistant`: the research assistant (the service writes `agent` when it saves an assistant proposal);
- `model`, `ai` or `precomputed`: a model (`precomputed` marks model output loaded in bulk); the tooltip names `provenance.model` when it is set.

The service treats the same sources as machine-made. A rejected AI annotation (`provenance.review_status: "rejected"`) is not shown. **Accept** saves `provenance.review_status: "accepted"` and `reviewed_at` with a `PUT` carrying the annotation's `version`; **Reject** deletes it. The list can hide unreviewed AI annotations, on the slide too.

Only an annotation's creator may change it. The service answers another user's edit with a 403 whose `detail` says so; the viewer shows that and keeps the study editable. Any other 403 means no access to the study.

#### Labels

The toolbar's label field sets the label of new annotations; left empty, a new shape is auto-labelled with the active color's name and a number (and a point with the color's name). With a `labelVocabulary` the field and the list's label editor suggest those terms, then the labels already used on the slide, and still accept free text. With `labelVocabularyStrict` they become a choice of the terms only, new shapes default to the first term, and a label outside the list cannot be saved (an annotation that already has one keeps it until it is relabelled). Strict is ignored without terms.

The viewer ships no default vocabulary: which terms fit depends on the site and the study, and a built-in list would quietly steer labels everywhere. Without one the field suggests the slide's existing labels, which keeps them consistent within a slide.

#### Notes

Each annotation can carry a free-text note, kept in `body.comment` and separate from its label. The list shows it under the annotation, with **+ Note** / **Edit note** for users who can edit (Ctrl/Cmd+Enter saves, Esc cancels); saving sends a `PUT` with the annotation's `version`. The click tooltip shows it too.

#### Measurements

The list and the click tooltip show each annotation's size: the length of a line, and the area and perimeter of a rectangle, ellipse, circle or polygon (including freehand and brush shapes). Coordinates are level-0 image pixels, scaled by the slide's microns-per-pixel (`tile_metadata.mpp`, the scale the status bar uses) on each axis, so slides with unequal x and y scales measure correctly. Lengths are shown in µm, or mm from 1 mm; areas in µm², or mm² from 0.01 mm². An ellipse's perimeter uses Ramanujan's approximation. Without a valid mpp the sizes are in pixels and the list says so. Drawing a line, rectangle, ellipse or circle shows its length or area next to the cursor. `wsiAnnotationGeometryUtils.ts` holds the math.

#### Points

The **Point** tool drops a point at each click (a drag still pans the slide) and stays on until Esc. A point is stored as an `SvgSelector` holding a circle of radius 0, in level-0 image pixels: `<svg><circle cx="…" cy="…" r="0" /></svg>`. Points are labelled with the active color's name, so counting mitoses means picking a "Mitosis" color and clicking. The viewer draws points itself, as fixed-size markers on one canvas redrawn per frame, because Annotorious has no point shape; that keeps hundreds of points fast. A point shows and counts at once, before its save returns. The toolbar shows the count for the active layer and label while the tool is on, and the Annotations section has a **Point counts** table per label and layer. Clicking a marker shows its tooltip.

#### Freehand and brush

**Free** draws while the mouse button is held and saves the outline as a polygon. **Brush** paints a band of a fixed on-screen width (8–64 px at the zoom it is drawn, chosen in the toolbar) and saves the band's outline as a polygon: the stroke is offset to both sides with mitred corners and round caps (`strokeOutline`). Both record a point every 2 screen pixels and simplify the stroke with Douglas–Peucker at 1.5 screen pixels before saving.

The brush is stored as a polygon, not as a line with a width, so it has an area and perimeter, edits like any polygon, and exports to QuPath as a region. Its width is in screen pixels because that is how a brush feels; in image pixels it depends on the zoom. A stroke that doubles back sharply can give an outline that touches itself.

#### Editing and undo

Clicking a rectangle, ellipse, line or polygon (including freehand and brush shapes) selects it for editing: Annotorious shows handles to move it or drag its vertices. The viewer saves the new geometry with a versioned `PUT` and keeps the label, note, layer, sharing and provenance as stored. Points are not draggable; delete one and drop it again.

**Undo** in the toolbar, or Ctrl+Z / Cmd+Z outside text fields, reverses this session's last change on the slide: a created annotation is deleted, an edit is reversed by saving the previous version over the current one (with the current `version`), and a deleted annotation is created again (with a new id, so later undos follow it). A layer delete and an import each undo as one step. The history holds 50 changes and is cleared when another slide or study opens.

#### Annotation list

The sidebar's Annotations section lists the slide's annotations on visible layers. It filters by label or note text, layer, author (when there is more than one) and AI origin (when any annotation is from the assistant or a model), and shows how many listed annotations each layer and each label has. Labels count by their text without a trailing number, so "Tumor 1" and "Tumor 2" count as Tumor; clicking a label count filters the list to it. Clicking an annotation's label (or Enter on it) pans and zooms the slide to it. The filters reset when another slide opens.

#### Export and import (GeoJSON)

The Annotations section exports the slide's annotations, all of them or only those on visible layers, as a GeoJSON `FeatureCollection` that QuPath imports. Each annotation is a `Feature`:

- `geometry`: a `Point`, `LineString` or `Polygon` in level-0 image pixels (x right, y down). Rectangles become 4-corner polygons and ellipses 72-vertex polygons.
- `properties`: `objectType: "annotation"`, `name` (the label), `classification: { name, color: [r, g, b] }` (the label without a trailing number, and the annotation's color), `layer`, `note`, and `measurements` in QuPath's naming (`Area µm^2`, `Perimeter µm`, `Length µm`, or `px` without an mpp). AI annotations add `ai_generated` and `ai_review_status`.

The collection's `wsi` member names the slide by its opaque slide key and gives the mpp. Exports never contain image ids, sealed sources or object keys, nor creators or provenance details.

**Import…** reads a GeoJSON `FeatureCollection`, `Feature` or array of features, such as a QuPath export, and validates it before anything is saved: points, lines and polygons (and their multi- forms, split into one annotation each) with finite coordinates inside the slide and at most 5,000 vertices are kept; a polygon's holes are dropped; anything else is skipped with a reason. At most 2,000 annotations are imported at once. A preview shows how many points, lines and polygons will be created and what was skipped; **Create** then saves them, four requests at a time, with the file's name or class as the label, its class color, layer and note, else the active ones. With a strict vocabulary, features whose label is not a term are skipped.

The viewer stores the selected slide and viewport in the URL hash (`#wsi:slide=…&x=…&y=…&z=…`) so a view can be shared.

## Development

```sh
pnpm --filter cbioportal-wsi-viewer run build   # rollup: dist/ (CJS) and dist/es/ (ESM), one file per module
pnpm --filter cbioportal-wsi-viewer run watch
pnpm --filter cbioportal-wsi-viewer run test    # Jest (jsdom)
```

From the repository root, `pnpm run buildModules` builds every package, and the app resolves this one from `dist/`. So rebuild after changing the package, before running the app's typecheck, tests or build.

`viewer.js` at the package root re-exports `dist/viewer.js`, for resolvers that ignore `package.json` `exports`, such as Jest 27.

Rules for changes:

- Keep the package free of app imports (`config/…`, `shared/…`, `pages/…`). Anything portal-specific goes through `WsiViewerConfig` or a prop.
- Keep `openseadragon` behind the dynamic import in `wsiOpenSeadragonLoader.ts`.
- Export from the light entry only what hosts import statically. Components and anything heavy belong in `viewer`.
