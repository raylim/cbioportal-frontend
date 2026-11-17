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
| `POST {apiUrl}/annotations/batch?studyId=…` | Create 1–100 in one request, `{annotations: [...]}`; saved all or none |
| `PUT {apiUrl}/annotations/{id}?studyId=…` | Update one, with its `version` (creator only) |
| `POST {apiUrl}/annotations/{id}/review?studyId=…` | Accept or reject an AI annotation, with its `version` (any user of the study) |
| `DELETE {apiUrl}/annotations/{id}?studyId=…` | Delete one (creator only) |

The service sits behind a proxy that authorizes each request with the portal session cookie for the study in `studyId`, and forwards the user and study to the service. So every request:

- sends the cookie (`credentials: 'include'`) and no token or `Authorization` header;
- carries `studyId` exactly once in the query string;
- if it is a write (POST, PUT, PATCH, DELETE), sends `X-Requested-With: XMLHttpRequest`, and `Content-Type: application/json` with its body.

A 401 means the user is signed out: the **Annotate** button is disabled and says to sign in. A 403 means no access to the study: annotations are read-only. Neither is retried; a new slide or study tries again. `wsiServiceRequest.ts` holds the request rules.

#### Toolbar

The toolbar over the slide starts with only **Annotate**, **Display** (an eye) and a **⋯** menu, so viewing stays uncluttered. **Annotate** shows the drawing tools in one compact row, which wraps between groups on a narrow viewer:

| Control | Contents |
| --- | --- |
| **Select** (V) | Pan, and click a shape to select it; the user's own shapes can then be moved or reshaped |
| **Shape** (R) | Rectangle, ellipse or circle. The button draws with the last one picked; the arrow next to it opens the menu |
| **Line** (L) | A line, with its length shown while drawing |
| **Outline** | Polygon (P), freehand (F) or brush (B); like Shape, the button reuses the last one |
| **Point** (.) | Points, one per click |
| **Drawing as** | The layer, label and color of new annotations (see below) |
| **Undo**, **Redo** | See Editing and undo |

The brush width shows next to the tools only while the brush is on, and the point count only while the Point tool is on. Esc goes back to Select. Clicking the active tool again goes back to Select too. Single-key shortcuts work only while Annotate is on and the focus is not in a text field or menu; while Annotate is on, "." picks the Point tool instead of toggling the details sidebar, and OpenSeadragon's R (rotate) and F (flip) keys are off. **⋯** holds **Review AI annotations** (see Reviewing AI annotations), the sharing of new annotations (Shared or Private), **Export** (all annotations, or those on visible layers), **Import…**, and a list of the keyboard shortcuts.

**Drawing as** has a layer choice, the label field (see Labels) and a color swatch. The color belongs to the layer: choosing a layer switches to its color, and the swatch's palette (the named colors, plus a custom color with an optional name) sets the color of that layer's new annotations; annotations already drawn keep theirs. A layer's color is the one the user gave it, else the most common color of its annotations, else the default blue for **Default** and a color of its own for a new layer. Layer colors, Annotate on or off, and the Shape and Outline menus' last tools are remembered in `localStorage`.

While annotations load, after a failed load, signed out, or without access to the study, **Annotate** is disabled and a status next to it says why; only the ⋯ menu's export and shortcut list stay. Annotate off also turns shape editing off, so a click on a shape only shows its tooltip.

The toolbar is a `role="toolbar"`: the arrow keys, Home and End move between its controls (fields keep their own arrow keys). The Shape, Outline and ⋯ buttons are menu buttons (`aria-haspopup`, `aria-expanded`); their menus open with Enter, Space or the down arrow, move with the arrow keys, Home and End, and close with Escape or a pick, returning focus to the button. Every icon button has an `aria-label` that names its shortcut, and a tooltip.

#### Display

**Display**, the eye next to ⋯, opens a small popover that sets how annotations show on the slide, Annotate on or off:

- **Fill**: the fill opacity of shapes, 0–100% (20% by default).
- **Outlines only**: shapes without fill.
- **Labels on the slide**: each shape's label at the top-left corner of its box, in white on a dark band (at least 7:1 on any tissue). Larger shapes are labelled first; a label that would overlap one already shown is left out, shapes under 24 screen pixels on both sides get none (so zooming out drops them), points get none, and at most 150 show. The labels move with the slide.
- **Hide all annotations** (H): hides every annotation on the slide, also while Annotate is off; the list, counts and tools stay. A dot on the eye marks any setting that differs from the default, and the eye is crossed out while all are hidden.

Fill, outlines only and labels are remembered in `localStorage` (and the viewer works without it); hiding all is not, so a slide never opens looking empty. Labels and highlights are drawn over the slide in their own layer that ignores the pointer: GeoJSON exports hold annotation data only, and the downloaded view is the slide's canvas without them.

Each row under **Layers** has a solo button (a circle, filled when on) that shows only that layer; pressing it again, or **Show all layers** in the Display popover, shows the layers hidden before again. Showing or hiding a layer with its eye ends the solo.

#### Keyboard shortcuts

Keys do nothing while the focus is in a text field. On a Mac, ⌘ works for Ctrl. The ⋯ menu's **Keyboard shortcuts** lists the same.

| Key | Does | When |
| --- | --- | --- |
| V | Select | Annotate on |
| R | Shape (the menu's last: rectangle, ellipse or circle) | Annotate on, review card closed |
| L | Line | Annotate on |
| P, F, B | Polygon, freehand, brush | Annotate on |
| . | Point (otherwise "." shows or hides the details sidebar) | Annotate on |
| Esc | Back to Select | A drawing tool is on |
| H | Hide or show all annotations on the slide | Always |
| Ctrl+Z; Ctrl+Shift+Z or Ctrl+Y | Undo; redo | Something to undo or redo |
| A | Accept the annotation under review, then the next | Review card open |
| R | Reject it, then the next | Review card open |
| S or → | Skip it | Review card open |
| ← | The previous one still unreviewed | Review card open |
| Esc | Close the review card | Review card open |

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

Rows written before the viewer used `layer_name` kept the layer in `comment` and sent no `layer_name`, `color` or `provenance`, so the service stored its defaults (`Default`, `#2f80ed`). The viewer reads `comment` as the layer only for such rows: when `provenance` is missing or null, `layer_name` is missing or `Default`, `color` is missing or exactly `#2f80ed`, and `comment` is one line of at most 100 characters. Other writers (the assistant, scripts, loaders) set `provenance`, so their one-line comment stays a note. The viewer always writes `color`, and writes `#2f80ed` as `#2F80ED` (the service keeps the letter case), so a note on a row it wrote is never read as a layer. Saving an edit to a legacy row writes its layer to `layer_name` and sends its stored `comment` back unchanged until the user edits the note, so no note is lost. A `comment` that only repeats `layer_name`, as the service writes for a saved assistant proposal, is not shown as a note. `wsiAnnotationBody.ts` holds the rules.

#### Private and shared annotations

`visible_to` decides who sees an annotation: `null` keeps it private to its creator, and `[]` shares it with everyone who can read the study. The toolbar's ⋯ menu sets whether new annotations are **Shared** or **Private** (shared unless the user chose private; remembered in `localStorage`), and each list row shows a **Private** or **Shared** badge that switches the annotation with a versioned `PUT`. The service also accepts group names, but the proxy sends no groups, so the viewer offers no group choice; a row shared with groups shows **Groups**.

#### AI annotations

An annotation a machine made shows an **AI** badge: **AI · unreviewed** until a user reviews it, then **AI · accepted**. Its `provenance.source` says what made it, and the badge's tooltip says which:

- `agent` or `assistant`: the research assistant (the service writes `agent` when it saves an assistant proposal);
- `model`, `ai` or `precomputed`: a model (`precomputed` marks model output loaded in bulk); the tooltip names `provenance.model` when it is set.

The service treats the same sources as machine-made. The list can hide unreviewed AI annotations, on the slide too.

Any user who can edit in the study may review an unreviewed AI annotation, whoever created it. **Accept** and **Reject** send `POST /annotations/{id}/review` with `{decision: "accept" | "reject", version}`. The service records `provenance.review_status`, `reviewed_by` and `reviewed_at` and bumps the version. An accepted annotation shows **AI · accepted**. A rejected one is kept by the service as a review record but no longer listed, so the viewer drops it. A 409 (changed meanwhile) or a 404 for the annotation reloads the slide. Reviews are not on the undo history.

An older service without the review route answers the review with a 405, or a 404 whose JSON `detail` is "Not Found". The viewer then falls back for the rest of the session: an AI annotation's creator accepts it with a versioned `PUT` of the accepted provenance and rejects it by deleting it, neither on the undo history, and a note says how it was recorded; other users get no review buttons. Any other 404 (such as a proxy's page) says the review was not saved and does not decide whether the route exists.

Only an annotation's creator may edit, move or delete it, or change its note or sharing. With the signed-in user known (`annotationUser`: the portal's `AppStore.userName`, the user the study access check forwards as `X-Auth-Request-User` and the service records as `created_by`), the list shows those controls only on the user's own annotations, and only those shapes can be dragged on the slide. Deleting a layer deletes only the user's annotations in it; its confirmation gives that count and says the layer stays while other users have annotations in it. The service answers another user's edit with a 403 whose `detail` says so; the viewer shows that and keeps the study editable. Any other 403 means no access to the study.

#### Reviewing AI annotations

**Review AI (N)**, next to the sidebar's "Hide unreviewed AI annotations", or **Review AI annotations** in the toolbar's ⋯ menu, opens a review card at the bottom left of the slide. N counts the slide's unreviewed AI annotations (from the assistant and from models) that the user may review. The card steps through them one at a time: each is fitted in the view and highlighted with a dashed yellow frame, and the card shows its label, who made it, its layer, size and note.

- **Accept** (A) and **Reject** (R) record the review as above and move to the next annotation; **Skip** (S or →) leaves it unreviewed and moves on; **←** goes back to the previous one still unreviewed; Esc or × closes the card. The order wraps around, so skipped annotations come back after the last one.
- The card counts "N of M reviewed": of the annotations it started with, those reviewed by anyone (or gone).
- **Order**: nearest next. The first annotation is the one nearest the slide's top-left corner, and each next one is the nearest not yet visited, so the view usually moves by about one annotation and only the last few steps can jump further. Above 3,000 annotations the order is by horizontal bands, alternately left to right and right to left. A fixed reading order (rows from the top left) was not used: it jumps back across the slide at every row.
- **Keys**: while the card is open, A, R, S, → and ← belong to the review and come before the tool shortcuts (R rejects; it does not pick the Shape tool), and OpenSeadragon does not pan with them. They do nothing while typing in a field, and the arrows still move between toolbar controls when one has the focus. Closing the card gives the keys back to the tools. The card says so, and the ⋯ menu's shortcut list has them in their own section.
- A 409 (changed meanwhile) reloads the slide and keeps the card on the same annotation while it still needs review, so Accept or Reject can be pressed again; if someone else reviewed it meanwhile, the card moves on. The annotation under review shows even when its layer is hidden or unreviewed AI annotations are hidden.
- Without the review route (see above), only an annotation's creator can review it: the queue holds only the user's own AI annotations, and when there are none the entry is disabled and says why. Signed out, read-only, or while annotations load, the entry is disabled with the reason; a refusal mid-review ends the queue with the sign-in or read-only message.
- The card is a non-modal `role="dialog"` named "Review AI annotations". It takes the focus on Accept when it opens, keeps it inside as it moves on, and gives it back to the button that opened it when it closes. Progress and what each decision did are `role="status"` messages.

#### Labels

The **Drawing as** label field sets the label of new annotations; left empty, a new shape is auto-labelled with the layer color's name and a number (and a point with the color's name, or "Point" for the default color). With a `labelVocabulary` the field and the list's label editor suggest those terms, then the labels already used on the slide, and still accept free text. With `labelVocabularyStrict` they become a choice of the terms only, new shapes default to the first term, and a label outside the list cannot be saved (an annotation that already has one keeps it until it is relabelled). Strict is ignored without terms.

The viewer ships no default vocabulary: which terms fit depends on the site and the study, and a built-in list would quietly steer labels everywhere. Without one the field suggests the slide's existing labels, which keeps them consistent within a slide.

#### Notes

Each annotation can carry a free-text note, kept in `body.comment` and separate from its label. The list shows it under the annotation, with **+ Note** / **Edit note** for users who can edit (Ctrl/Cmd+Enter saves, Esc cancels); saving sends a `PUT` with the annotation's `version`. The click tooltip shows it too.

#### Measurements

The list and the click tooltip show each annotation's size: the length of a line, and the area and perimeter of a rectangle, ellipse, circle or polygon (including freehand and brush shapes). Coordinates are level-0 image pixels, scaled by the slide's microns-per-pixel (`tile_metadata.mpp`, the scale the status bar uses) on each axis, so slides with unequal x and y scales measure correctly. Lengths are shown in µm, or mm from 1 mm; areas in µm², or mm² from 0.01 mm². An ellipse's perimeter uses Ramanujan's approximation. Without a valid mpp the sizes are in pixels and the panel says so, also before any annotation exists. Drawing a line, rectangle, ellipse or circle shows its length or area next to the cursor. `wsiAnnotationGeometryUtils.ts` holds the math.

#### Points

The **Point** tool drops a point at each click (a drag still pans the slide) and stays on until Esc. A point is stored as an `SvgSelector` holding a circle of radius 0, in level-0 image pixels: `<svg><circle cx="…" cy="…" r="0" /></svg>`. Points are labelled with the active label, else the active color's name (or "Point" for the default color), so counting mitoses means picking a "Mitosis" color or label and clicking. The viewer draws points itself, as fixed-size markers on one canvas redrawn per frame, because Annotorious has no point shape; that keeps hundreds of points fast. A point shows and counts at once, before it is saved. Points are saved together: half a second after the last click, when the tool changes, and when the page is hidden, in batch requests of up to 100 (see Batch saves). Each saved point still undoes on its own, and undo first waits for unsent points. A point not yet sent can be relabelled or deleted without a request; one being saved is relabelled or deleted on its saved id once the save returns. Points still unsent when another slide or study opens, or the page unloads, are sent with `keepalive` without waiting for the answer: in batch requests when the batch route is known to exist, else one `POST` per point, all at once. Points the service refuses for access (401 or 403) stay on the slide marked **Not saved**, with "N points were not saved." and **Retry** (for example after signing in again); points that could not be sent before another slide opened are reported there. The toolbar shows the count for the active layer and label while the tool is on, and the Annotations section has a **Point counts** table per label and layer. Clicking a marker shows its tooltip.

#### Zooming while drawing

The wheel and the zoom buttons pan and zoom the slide while a shape is being drawn. Each pointer position is converted to level-0 image pixels when it happens, with the slide as shown at that moment (also mid-animation), and the shape being drawn is kept in image pixels. The outline, the live measurement and the brush circle are redrawn as the slide moves, so they stay on the tissue they were drawn over, and a polygon closes on its first vertex where that vertex is now. Only the pointer that started a press draws (a second finger is ignored); a press the browser cancels, or whose pointer capture is lost, drops the drag shape or stroke, and a polygon keeps the vertices placed so far.

#### Freehand and brush

**Freehand** draws while the mouse button is held and saves the outline as a polygon. **Brush** paints a band and saves the band's outline as a polygon: the stroke is offset to both sides with mitred corners and round caps (`strokeOutline`). Both record a point every 2 screen pixels and simplify the stroke with Douglas–Peucker at 1.5 screen pixels before saving, measured at the finest zoom the stroke was drawn at, so zooming out mid-stroke does not erase detail drawn closer in.

The brush width is chosen in the toolbar in µm of tissue (10–500 µm, 50 µm by default). It is converted to image pixels with the slide's microns-per-pixel (the mean of x and y, since the band is round), so a stroke covers the same tissue at every zoom. While the brush is on, a circle under the pointer shows its size on screen at the current zoom, and the stroke previews at that width. A slide without a valid mpp has no scale: the width is then in screen pixels (8–64 px at the zoom the stroke starts at, kept for the whole stroke), and the toolbar says so. `brushWidthInImagePixels` holds the conversion.

The brush is stored as a polygon, not as a line with a width, so it has an area and perimeter, edits like any polygon, and exports to QuPath as a region. A stroke that doubles back sharply can give an outline that touches itself.

#### Editing and undo

While Annotate is on, clicking a rectangle, ellipse, line or polygon (including freehand and brush shapes) with Select selects it for editing: Annotorious shows handles to move it or drag its vertices. The viewer saves the new geometry with a versioned `PUT` and keeps the label, note, layer, sharing and provenance as stored. Points are not draggable; delete one and drop it again.

**Undo** in the toolbar, or Ctrl+Z / Cmd+Z outside text fields, reverses this session's last change on the slide: a created annotation is deleted, an edit is reversed by saving the previous version over the current one (with the current `version`), and a deleted annotation is created again (with a new id, so later undos follow it). A layer delete and an import each undo as one step. **Redo**, or Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y, applies an undone change again the same way, in one step for an import or a layer delete; annotations created again get new ids, and the rest of the history follows them. A new change clears what can be redone. Reviews are on neither history. The history holds 50 changes each way and is cleared when another slide or study opens.

#### Annotation list

The sidebar's Annotations section lists the slide's annotations on visible layers. It filters by label or note text, layer, author (when there is more than one) and AI origin (when any annotation is from the assistant or a model), and shows how many listed annotations each layer and each label group has. A label groups under its base term: a trailing count such as " (13 tiles)" is dropped, so "Solid region (13 tiles)" and "Solid region (9 tiles)" group as Solid region, and an auto-label (a palette color's name or hex and a number) counts under its base, so "Tumor 1" and "Tumor 2" count as Tumor. Vocabulary terms and other labels count as written, so "Grade 1" and "Grade 2" or "Gleason pattern 4" stay apart. The eight largest groups show, the rest behind **+N more**. Clicking a label count filters the list to that group, and clicking it again clears it. Clicking an annotation's label (or Enter on it) pans and zooms the slide to it. The filters reset when another slide opens.

Drawing and editing stay off until the slide's annotations have loaded; a failed load shows an alert with **Retry**. Icon buttons are labelled by their target (for example "Delete annotation Tumor 1"), and after an accept, reject, delete or label save the focus moves to the row, else the next row, else the list. Text on an annotation's color is black or white by luminance.

#### Export and import (GeoJSON)

The toolbar's ⋯ menu exports the slide's annotations, all of them or only those on visible layers, as a GeoJSON `FeatureCollection` that QuPath imports. Each annotation is a `Feature`:

- `geometry`: a `Point`, `LineString` or `Polygon` in level-0 image pixels (x right, y down). Rectangles become 4-corner polygons and ellipses 72-vertex polygons.
- `properties`: `objectType: "annotation"`, `name` (the label), `classification: { name, color: [r, g, b] }` (the label, or an auto-label's base, and the annotation's color), `layer`, `note`, and `measurements` in QuPath's naming (`Area µm^2`, `Perimeter µm`, `Length µm`, or `px` without an mpp). AI annotations add `ai_generated` and `ai_review_status`.

The collection's `wsi` member names the slide by its opaque slide key and gives the mpp. Exports never contain image ids, sealed sources or object keys, nor creators or provenance details.

**Import…** in the ⋯ menu refuses a file over 25 MB before reading it. It reads a GeoJSON `FeatureCollection`, `Feature` or array of features, such as a QuPath export, and validates it before anything is saved: points, lines and polygons (and their multi- forms, split into one annotation each) with finite coordinates inside the slide and at most 5,000 vertices are kept; a polygon's holes are dropped; anything else is skipped with a reason. At most 2,000 annotations are imported at once. A preview under the toolbar shows how many points, lines and polygons will be created and what was skipped; **Create** then saves them in batch requests (see Batch saves), with the file's name or class as the label, its class color, layer and note, else the active ones; the annotations saved undo as one step. If some are refused, the rest are still created and the message names the refused ones by their number in the preview and the service's reason. With a strict vocabulary, features whose label is not a term are skipped, named by their feature number.

#### Batch saves

Imports and dropped points are created with `POST /annotations/batch`, at most 100 annotations and about 3 MiB per request (the service caps bodies at 4 MiB; `keepalive` requests at 60 KiB). The service saves a request whole or not at all and returns the saved annotations in request order.

- A 422 that names items (its `loc` gives each item's index) marks those as refused, with the service's message, and sends the rest once more.
- A 413 splits the request in two.
- Any other failure marks the request's annotations as not saved.
- A 404 or 405 means the service has no batch route: that save and later ones in the session use one `POST /annotations` each, four at a time (all at once with `keepalive`).

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
