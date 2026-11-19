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
| `requestedAnnotationId`, `requestedAnnotationSlideKey`, `onRequestedAnnotationUsed`, `annotationLink` | An annotation to open once its slide (the slide key the link names) loads, a callback once it was opened or found missing (so the host drops it from the URL), and how to make a link to one (see Stepping through annotations, and links to one) |
| `hidden` | The host hides the viewer without unmounting it, e.g. in an inactive tab. The panel and annotation shortcuts are off (so a key pressed on another tab never reviews the AI annotation under review) and OpenSeadragon ignores the collapsed container's size meanwhile |

### Side by side (Compare)

**Compare** in the main slide's status bar opens a second viewer next to the slide, split by a draggable divider (`role="separator"`; the arrow keys move it by 5%, Home and End to the limits; each slide keeps at least 20% of the width). It is disabled, saying why, when the patient has no other slide. The bar above the slides holds **Lock views**, how the views follow each other, **Set anchor** / **Clear anchor**, **Align and copy** and close (×).

- **Panes**: each is a labelled region ("Left slide: H&E · WSI-0123-4567-89ab") with a header: the stain (dot and name), a slide picker and the Slide ID. The left pane is the main slide (the slide list and the `#wsi:` link follow it); the right pane keeps no URL state and has no copy-link button. Each pane shows its own slide's annotations, status bar and zoom buttons.
- **Active pane**: a press or the focus in a pane makes it active (blue header line). Only the active pane shows the annotation toolbar and takes the annotation keys (tools, undo, H, `]`/`[`, the review keys); the other pane's drawing stops. The details sidebar (image properties, pathology, clinical, slide notes, layers, annotations) shows the active pane's slide. **F6** moves the focus to the other slide's view.
- **Pairing**: the picker lists the patient's servable slides relative to the other pane's slide, in option groups: **Same block**, then **Same part** (other blocks), then the rest by sample and part (the other slide's sample first, unmatched slides last). Within a group the counterpart stain comes first: IHC next to H&E, H&E next to IHC or anything else. Compare opens the first one, so an H&E opens with the same block's IHC and an IHC with the same block's H&E. The groups come from the hierarchy the viewer already has (sample → part → block), and the stain from `stain_kind`.
- **Sync** (Lock views, on by default): pan, zoom and rotation of the pane last pressed, scrolled or typed in move the other, through its target view, so both animate together. The map used:
  - **Aligned**, with 3 or more point pairs: the other view's centre is the fitted map of this one's, its zoom this one's divided by the map's scale (the square root of its area ratio), its rotation turned by the map's. A mirrored section (the fit includes a reflection) keeps the leader's orientation, mirrored left to right; the view itself is not mirrored, since OpenSeadragon maps screen points without its flip and annotations would be drawn in the wrong place;
  - **Anchor**: after **Set anchor** with both slides centred on the same tissue, the views follow by distance in µm from the two centres (per-axis mpp; pixels when a slide has no scale), at the same µm per screen pixel;
  - **Same relative position** otherwise: the same place relative to each image's size, and the same share of the image width on screen.
  Unlocked, the views move separately; locking again moves the other pane to the active one.
- **Align and copy** opens a panel above the slides (fixed height, so the slides do not move as points come and go). **Place points** (on at first while there is no alignment): a click (not a drag, which still pans) on a tissue feature of either slide, then on the same feature of the other, makes a numbered pair; clicks go to points then, not to shapes. The markers are numbered buttons: drag one to move it, or focus it and use the arrow keys (1 screen pixel, 10 with Shift); Delete removes its pair, as does the × on its chip. A complete pair shows a dashed ring where the fit puts the other slide's point, with a line to it.
  - **Fit**: **Similarity** (rotation, one scale and shift; least squares in closed form; a mirrored fit is taken only when it has under half the squared error of the plain one) or **Affine** (also shear and a scale per axis; least squares). Either needs 3 complete pairs; points on one line give no affine fit.
  - **Error**: each pair's residual, the distance between its point on the right slide and where the fit puts its left point, in µm of the right slide (pixels without a scale); the panel shows the RMS and the largest, and each chip its pair's. With exactly 3 pairs an affine map fits exactly, and the panel says to add a fourth to measure the error.
  - **Reset** puts the points, model and anchor back as they were when the panel opened; **Clear points** removes them all (Reset brings them back).
  - **Kept** per slide pair in this browser's `localStorage` (`wsi-compare-alignment:v1:<key>:<key>`, the two slide keys sorted, so it is found with either slide on the left; points in level-0 pixels of each slide), with try/catch; an empty alignment is removed. A server-side store needs a service change and is not built.
- **Copying annotations** (needs an alignment and annotating on the other slide): **Selected (N)** copies the active pane's selection and **Layer … (N)** one of its layers to the other slide, through the fit (its inverse from right to left). See Transferred annotations.

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
| `PUT {apiUrl}/annotations/{id}?studyId=…` | Update one, with its `version` (creator only). A 409 (changed meanwhile) or 404 (deleted meanwhile) reloads the slide and says so. A 422 whose `loc` names `target` (a shape outside the service's selector rules) says "This shape can't be saved", as a create or batch item refused for its `target` does |
| `POST {apiUrl}/annotations/{id}/review?studyId=…` | Accept or reject an AI annotation, with its `version` (any user of the study) |
| `DELETE {apiUrl}/annotations/{id}?studyId=…` | Delete one (creator only) |
| `POST {apiUrl}/annotations/batch-update?studyId=…` | Update 1–100, `{items: [{id, version, body, target, visible_to}]}`, all or none |
| `POST {apiUrl}/annotations/batch-delete?studyId=…` | Delete 1–100, `{items: [{id, version}]}`, all or none |
| `POST {apiUrl}/annotations/batch-review?studyId=…` | Review 1–100, `{items: [{id, version, decision}]}`, all or none |
| `GET {apiUrl}/annotations/{id}/comments?studyId=…[&offset=…]` | The annotation's comment thread, oldest first: a page `{annotation_id, comments, total, offset, limit, has_more, next_offset}` (100 by default), or the whole thread as an array from an older service |
| `POST {apiUrl}/annotations/{id}/comments?studyId=…` | Add `{body}` (1–4,000 characters) |
| `PUT` / `DELETE {apiUrl}/annotations/{id}/comments/{cid}?studyId=…` | Edit `{body}` or delete one's own comment |
| `GET {apiUrl}/slide-notes?slide_id=…&studyId=…[&offset=…]` | The slide's notes the user may see, `{slide_id, notes, tags: [{tag, count}]}`, paged by a newer service (`total`, `offset`, `limit`, `has_more`, `next_offset`; `tags` over all the notes) |
| `POST {apiUrl}/slide-notes?studyId=…` | Add `{slide_id, study_id, text, tags, visible_to}` |
| `PUT {apiUrl}/slide-notes/{id}?studyId=…` / `DELETE …/slide-notes/{id}?studyId=…&version=…` | Edit or delete one's own note, with its `version` |

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
| **Shape** | Rectangle (R), ellipse, circle or HPF field. The button draws with the last one picked; the arrow next to it opens the menu. R is always the rectangle |
| **Line** (L) | A line, with its length shown while drawing |
| **Measure** (M) | A quick ruler that is never saved (see Quick ruler) |
| **Outline** | Polygon (P), freehand (F), brush (B), smart brush (Shift+B) or magic wand (W); like Shape, the button reuses the last one |
| **Point** (C) | Points, one per click |
| **Drawing as** | The layer, label and color of new annotations (see below) |
| **Undo**, **Redo** | See Editing and undo |
| Save status | "Saved", "Saving… N" or "N not saved" with **Retry** (see below) |

The active tool's options show in a strip just under the toolbar's left end: the brush width while the brush or smart brush is on, the tolerance while the magic wand or smart brush is on, the field area with the HPF tool, and the point count with the Point tool. The strip is out of the toolbar's layout, so the tools, Drawing as and the rest never move as tools change; it is a labelled group ("Brush options") that follows the tools in the arrow-key order. The save status keeps its width while Annotate is on (and counts use tabular figures), so the controls after it stay put too. A drawing tool stays on after each shape, so shapes can be drawn one after another without picking the tool again; the toolbar keeps it highlighted. It stays on until Esc, Select (V), clicking the active tool again, or picking another tool. Esc first drops a shape being drawn (a drag, a stroke, or a polygon's vertices so far) and keeps the tool; with nothing being drawn it goes back to Select; with Select it clears the selection. A polygon ends with a double-click or a click on its first vertex, and the next click starts a new one. Each new shape gets the next auto label. Shift+click and Shift+drag select only with Select. Single-key shortcuts work only while Annotate is on and the focus is not in a text field or menu. Each key has one meaning: "." always shows or hides the details sidebar (Annotate on or off, and while reviewing), and the Point tool is C. OpenSeadragon's R (rotate), F (flip) and W (pan up) keys are off, Annotate on or off, so a stray key never turns or flips the slide (the arrow keys still pan). **⋯** holds **Review AI annotations** (see Reviewing AI annotations), the sharing of new annotations (Shared or Private), **Export** (all annotations, or those shown: layers and Show), **Import…**, and a list of the keyboard shortcuts.

The **save status**, before the Display eye, says whether changes are saved: **Saving… N** while N annotations, comments or notes are being sent or wait to be sent (dropped points not yet sent, and the items of each write request not yet answered: a batch counts its items), **N not saved** with **Retry** for dropped points the service refused (Retry sends them again, as the Annotations section's Retry does), and **Saved** once a change on this slide was saved. "Saved" shows only while Annotate is on; saving and not saved show either way. A hidden `role="status"` region stays on the page beside it, so screen readers announce it: a change of state (saving, saved, not saved) at once, a changing count ("Saving… 3", "Saving… 4") as it settles, at most every 1.5 s, so counting points does not read out every click. Its tooltip says more. Failed edits, deletes and reviews reload the slide and say so in the Annotations section instead, since the slide then shows what is stored.

**Drawing as** has a layer choice, the label field (see Labels) and a color swatch. The color belongs to the layer: choosing a layer switches to its color, and the swatch's palette (the named colors, plus a custom color with an optional name) sets the color of that layer's new annotations; annotations already drawn keep theirs. A layer's color is the one the user gave it, else the most common color of its annotations, else the default blue for **Default** and a color of its own for a new layer. Layer colors, Annotate on or off, and the Shape and Outline menus' last tools are remembered in `localStorage`.

While annotations load, after a failed load, signed out, or without access to the study, **Annotate** is disabled and a status next to it says why; only the ⋯ menu's export and shortcut list stay. Annotate off also turns shape editing off, so a click on a shape only shows its tooltip.

The toolbar is a `role="toolbar"` with one Tab stop (a roving `tabindex`: the control last focused, else the first): Tab enters and leaves it in one step, and the arrow keys, Home and End move between its controls (fields keep their own arrow keys). The Shape, Outline and ⋯ buttons are menu buttons (`aria-haspopup`, `aria-expanded`); their menus open with Enter, Space or the down arrow, move with the arrow keys, Home and End, and close with Escape or a pick, returning focus to the button. Every icon button has an `aria-label` that names its shortcut, and a tooltip.

#### Display

**Display**, the eye next to ⋯, opens a small popover that sets how annotations show on the slide, Annotate on or off:

- **Fill**: the fill opacity of shapes, 0–100% (20% by default).
- **Outlines only**: shapes without fill.
- **Labels on the slide**: each shape's label at the top-left corner of its box, in white on a dark band (at least 7:1 on any tissue). Larger shapes are labelled first; a label that would overlap one already shown is left out, shapes under 24 screen pixels on both sides get none (so zooming out drops them), points get none, and at most 150 show. The labels move with the slide.
- **Hide all annotations** (H): hides every annotation on the slide, also while Annotate is off; the list, counts and tools stay. A dot on the eye marks any setting that differs from the default, and the eye is crossed out while all are hidden.
- **Show: Mine, Others, AI unreviewed, AI accepted**, each with its count on the shown layers (see below).

Fill, outlines only and labels are remembered in `localStorage` (and the viewer works without it); hiding all is not, so a slide never opens looking empty. Labels, highlights and selection frames are drawn over the slide in their own layer that ignores the pointer. GeoJSON exports hold annotation data only.

The status bar's download button saves the view as shown: the slide's canvas with the annotations drawn over it (`wsiAnnotationSnapshot.ts`). Only what shows on the slide is drawn: shown layers (solo and hidden layers count) and the kinds under Show, nothing while all are hidden (H) or annotations are off, with the Display fill opacity or outlines only, and the labels on the slide when they are on. Shapes are traced in level-0 image pixels through the same image-to-screen mapping as the overlay (a region's holes filled even-odd, so they stay empty) and drawn at the snapshot's own resolution (the measured canvas-to-screen pixel ratio), so they land on the same tissue at any device pixel ratio; outlines are 2 screen pixels and points are the same markers as on screen. The quick ruler is drawn too while it shows, even with H. The copy is first filled with the color shown behind the slide (the stage's gray, read from the page), so the area around a zoomed-out slide is gray as on screen rather than black (the slide's canvas is transparent there and a JPEG has no transparency); this holds with annotations off too. The shape being drawn, the selection, the selection box and the review highlight are left out. The file name is unchanged (`wsi-{patient}-{slide key}-x{x}-y{y}.jpg`).

Each row under **Layers** has a solo button (a circle, filled when on) that shows only that layer; pressing it again, or **Show all layers** in the Display popover, shows the layers hidden before again. Showing or hiding a layer with its eye ends the solo.

**What shows** is decided in one place: the layers' eyes and solo, and **Show**. Show has four kinds: **Mine** (the user's own, including annotations the user made from AI ones, "AI, edited"), **Others** (other users' shared annotations), **AI unreviewed** and **AI accepted** (made by a machine, the assistant or a model, as the AI badge; by their review). With the signed-in user unknown there is no Others, and Mine reads **Manual** (every annotation not made by a machine). Show sits in the Display popover as checkboxes and at the top of the sidebar's Annotations section as toggle chips (`aria-pressed`), each with its count on the shown layers, so the counts of the kinds shown add up to what the slide shows; both set the same state. Together they decide what is drawn on the slide, listed, counted (the section's title, the list's per-layer and per-label counts, the point counts), stepped through with `]`/`[`, selected with Ctrl+A, held by the review queue (**Review AI (N)**) and exported as "visible"; the list's own filters (text, layer, author, label) narrow the list further. Whenever anything is left out of the list (a hidden layer, a kind under Show, a list filter) or all are hidden on the slide (H), a hint above the list says "N hidden by filters" with **Show all**, which shows every layer and kind, clears the list's filters and turns H off. The annotation under review still shows, and a link to a hidden annotation shows its layer and kind again. Show is for this visit only, like hiding all, so a slide never opens looking empty; it was never stored, so there is nothing to migrate.

#### Keyboard shortcuts

Keys do nothing while the focus is in a text field (a slider, such as the tolerance, a checkbox or a radio button is not one). On a Mac, ⌘ works for Ctrl. The ⋯ menu's **Keyboard shortcuts** lists the same.

| Key | Does | When |
| --- | --- | --- |
| V | Select | Annotate on |
| R | Rectangle (ellipse, circle and HPF field are in the Shape menu) | Annotate on, review card closed |
| L | Line | Annotate on |
| P, F, B | Polygon, freehand, brush | Annotate on |
| Shift+B | Smart brush | Annotate on |
| W | Magic wand | Annotate on |
| Click; Shift+click; Alt+click | Outline the tissue of similar color; add it to the outline; cut it out (see Magic wand) | Magic wand on |
| Drag up or down; scroll | Raise or lower the tolerance of the outline waiting (scroll does not zoom then) | Magic wand on, an outline waiting |
| Enter or double-click; Esc; Ctrl+Z | Save the outline; discard it; take back its last click | Magic wand on, an outline waiting |
| C | Point | Annotate on |
| M | Measure: a quick ruler, not saved | Annotate on |
| Esc | Drop the shape being drawn, else clear the ruler, else back to Select | A drawing tool is on, or a ruler shows |
| H | Hide or show all annotations on the slide | Always |
| . | Show or hide the details sidebar | Always |
| \| | Show or hide the slide list | Always |
| ] and [ | Next and previous listed annotation, fitted and highlighted | Review card closed |
| Shift+click; Shift+drag | Add or remove an annotation; add those inside the box | No drawing tool on |
| Alt (held as a shape ends) | Cut the shape out of the selected regions instead of saving it | A drawing tool is on and a region is selected |
| Ctrl+A | Select every listed annotation | Focus in the viewer, or nowhere with Annotate on |
| Esc | Clear the selection, else stop highlighting the annotation | No drawing tool on |
| Ctrl+Z; Ctrl+Shift+Z or Ctrl+Y | Undo; redo | Something to undo or redo |
| A or Enter | Accept the annotation under review, then the next (Enter on a focused button is that button's own) | Review card open |
| X, then X or Enter | Reject it (the first X asks; Esc cancels), then the next | Review card open |
| S or → | Skip it | Review card open |
| ← | The previous one still unreviewed | Review card open |
| Esc | Close the review card | Review card open |
| F6 | Move the focus to the other slide | Side by side |
| Click | A point on this slide, then the same feature on the other (a drag still pans) | Side by side, Place points on |
| Arrows; Shift+arrows | Move the focused numbered point by 1 or 10 screen pixels | Side by side, a point focused |
| Delete | Delete the focused point's pair | Side by side, a point focused |
| ← and → | Make the left slide narrower or wider | Side by side, the divider focused |

Side by side, the annotation keys go to the active slide only (see Side by side). Nothing acts while the host hides the viewer (`hidden`).

#### Annotation body

The viewer writes the service's `AnnotationBody` fields as follows:

| Field | Holds |
| --- | --- |
| `label` | The annotation's label |
| `comment` | The user's free-text note (empty when there is none) |
| `layer_name` | The layer the annotation is drawn on |
| `type` | The named color, as `name|#hex` |
| `color` | The color as `#hex` |
| `provenance` | Kept as stored; the viewer never drops it on an update. Shape editing adds `edited: true` to an AI annotation whose shape a person changed, and gives annotations it makes `source: "manual"`, `operation`, `derived_from` and, from AI annotations, `derived_from_ai: true` (see Editing shapes). A copy made side by side gets `source: "manual"`, `operation: "transfer"`, `transferred_from: {slide_key, annotation_id}`, `transform_model`, `transform_residual_um` (or `transform_residual_px`), `verified: false` and, from an AI annotation, `derived_from_ai: true`; Mark verified sets `verified: true`, `verified_by` and `verified_at` (see Transferred annotations) |

Rows written before the viewer used `layer_name` kept the layer in `comment` and sent no `layer_name`, `color` or `provenance`, so the service stored its defaults (`Default`, `#2f80ed`). The viewer reads `comment` as the layer only for such rows: when `provenance` is missing or null, `layer_name` is missing or `Default`, `color` is missing or exactly `#2f80ed`, and `comment` is one line of at most 100 characters. Other writers (the assistant, scripts, loaders) set `provenance`, so their one-line comment stays a note. The viewer always writes `color`, and writes `#2f80ed` as `#2F80ED` (the service keeps the letter case), so a note on a row it wrote is never read as a layer. Saving an edit to a legacy row writes its layer to `layer_name` and sends its stored `comment` back unchanged until the user edits the note, so no note is lost. A `comment` that only repeats `layer_name`, as the service writes for a saved assistant proposal, is not shown as a note. `wsiAnnotationBody.ts` holds the rules.

#### Transferred annotations

A copy made side by side (see Side by side) is an independent annotation on the other slide, owned by the user: a new annotation with the source's label, layer, color and note, its geometry moved through the alignment, and the default sharing. Rectangles and ellipses become polygons (a turned or sheared box is no longer axis-aligned); polygons keep every ring, so holes and parts stay holes and parts; points, lines and polylines keep their kind. The copies are saved with batch saves (`POST /annotations/batch`) and undo as one step ("Undo transfer of 3 annotations") on the target slide, whose pane becomes active so its Undo is at hand; redo saves them again with the same provenance.

Its `provenance` is `source: "manual"`, so the service's trusted-writer rule (only trusted writers create machine-made annotations) accepts it, plus `operation: "transfer"`, `transferred_from: {slide_key, annotation_id}`, `transform_model` and the alignment's RMS error (`transform_residual_um`, or `transform_residual_px` without a scale), and `verified: false`. A copy of an AI annotation (or of one made from AI annotations) keeps `derived_from_ai: true`, so it shows **AI, edited** and counts as the user's, not as an AI annotation to review.

The list row and the tooltip show **Transferred · unverified** (dashed amber) or **Transferred · verified** (solid green), with the slide it came from and the error in the badge's tooltip. **Mark verified** (row and tooltip; the creator only) saves `verified: true`, `verified_by` and `verified_at` with a versioned `PUT`; like reviews it is not on the undo history. History says "Created (copied from slide WSI-… through an alignment)" and "Place verified".

#### Private and shared annotations

`visible_to` decides who sees an annotation: `null` keeps it private to its creator, and `[]` shares it with everyone who can read the study. Note for services and loaders: an annotation created with `visible_to` null (or without it) is creator-only, so other users of the study never see it; machine-made annotations meant for review must be created with `[]`. The viewer sends `[]` for new annotations unless the user chose Private. The toolbar's ⋯ menu sets whether new annotations are **Shared** or **Private** (shared unless the user chose private; remembered in `localStorage`), and each list row shows a **Private** or **Shared** badge that switches the annotation with a versioned `PUT`. The service also accepts group names, but the proxy sends no groups, so the viewer offers no group choice; a row shared with groups shows **Groups**.

#### AI annotations

An annotation a machine made shows an **AI** badge: **AI · unreviewed** until a user reviews it, then **AI · accepted**. An AI annotation a person changed shows **AI, edited** (**AI, edited · unreviewed** while still to review): a machine-made one whose shape its creator edited, cut or split (`provenance.edited: true`, the source kept), or an annotation a person made from AI annotations by a merge, cut, split or other shape operation (`provenance.derived_from_ai: true`; see Editing shapes). The latter is the person's own annotation, not machine-made, so it is not in the review queue and counts as Mine. Its `provenance.source` says what made it, and the badge's tooltip says which (the badge is a `role="img"` whose name is its text and that description):

- `agent` or `assistant`: the research assistant (the service writes `agent` when it saves an assistant proposal);
- `model`, `ai` or `precomputed`: a model (`precomputed` marks model output loaded in bulk); the tooltip names `provenance.model` when it is set.

The service treats the same sources as machine-made. **Show** hides AI annotations by their review (AI unreviewed, AI accepted), on the slide and in the list alike (see Display).

Any user who can edit in the study may review an unreviewed AI annotation, whoever created it. **Accept** and **Reject** send `POST /annotations/{id}/review` with `{decision: "accept" | "reject", version}`. The service records `provenance.review_status`, `reviewed_by` and `reviewed_at` and bumps the version. An accepted annotation shows **AI · accepted**. A rejected one is kept by the service as a review record but no longer listed, so the viewer drops it. A 409 (changed meanwhile) or a 404 for the annotation reloads the slide. Reviews are not on the undo history, so a reject always asks first: the review card's X or Reject asks in the card (X or Enter again confirms, Esc cancels), and the list row's and the selection bar's Reject ask in a confirmation that names how many and what a reject does. Undo right after a review says "Reviews can't be undone." instead of undoing an earlier edit; pressed again, it undoes that edit. Restoring a rejected annotation to unreviewed would need a service change (see Known gaps).

An older service without the review route answers the review with a 405, or a 404 whose JSON `detail` is "Not Found". The viewer then falls back for the rest of the session: an AI annotation's creator accepts it with a versioned `PUT` of the accepted provenance and rejects it by deleting it, neither on the undo history, and a note says how it was recorded; other users get no review buttons. Any other 404 (such as a proxy's page) says the review was not saved and does not decide whether the route exists.

Only an annotation's creator may edit, move or delete it, or change its note or sharing. With the signed-in user known (`annotationUser`: the portal's `AppStore.userName`, the user the study access check forwards as `X-Auth-Request-User` and the service records as `created_by`), the list shows those controls only on the user's own annotations, and only those shapes can be dragged on the slide. Deleting a layer deletes only the user's annotations in it; its confirmation gives that count and says the layer stays while other users have annotations in it. The service answers another user's edit with a 403 whose `detail` says so; the viewer shows that and keeps the study editable. Any other 403 means no access to the study.

#### Reviewing AI annotations

**Review AI (N)**, next to Show at the top of the sidebar's Annotations section, or **Review AI annotations** in the toolbar's ⋯ menu, opens a review card at the bottom left of the slide. N counts the unreviewed AI annotations (from the assistant and from models) that the user may review among those shown: on shown layers, with AI unreviewed on under Show. When Show or the layers hide them all, the entry is disabled and says so. The card steps through them one at a time: each is fitted in the view and highlighted with a dashed yellow frame, and the card shows its label, who made it, its layer, size and note.

- **Accept** (A or Enter) and **Reject** (X, then X or Enter to confirm; the card says what a reject does, and Esc cancels) record the review as above and move to the next annotation; **Skip** (S or →) leaves it unreviewed and moves on; **←** goes back to the previous one still unreviewed; Esc or × closes the card. The order wraps around, so skipped annotations come back after the last one.
- The card counts "N of M reviewed": of the annotations it started with, those reviewed by anyone (or gone).
- **Order**: nearest next. The first annotation is the one nearest the slide's top-left corner, and each next one is the nearest not yet visited, so the view usually moves by about one annotation and only the last few steps can jump further. Above 3,000 annotations the order is by horizontal bands, alternately left to right and right to left. A fixed reading order (rows from the top left) was not used: it jumps back across the slide at every row.
- **Keys**: while the card is open, A, Enter, X, S, → and ← belong to the review and come before the tool shortcuts (tool keys wait until the card closes), and OpenSeadragon does not pan with them. They do nothing while typing in a field, and the arrows still move between toolbar controls when one has the focus. Closing the card gives the keys back to the tools. The card says so, and the ⋯ menu's shortcut list has them in their own section.
- A 409 (changed meanwhile) reloads the slide and keeps the card on the same annotation while it still needs review, so Accept or Reject can be pressed again; if someone else reviewed it meanwhile, the card moves on. The annotation under review shows even when its layer or its kind is hidden.
- Without the review route (see above), only an annotation's creator can review it: the queue holds only the user's own AI annotations, and when there are none the entry is disabled and says why. Signed out, read-only, or while annotations load, the entry is disabled with the reason; a refusal mid-review ends the queue with the sign-in or read-only message.
- The card is a non-modal `role="dialog"` named "Review AI annotations". It takes the focus on Accept when it opens, keeps it inside as it moves on, and gives it back to the button that opened it when it closes. Progress and what each decision did are `role="status"` messages.

#### Labels

The **Drawing as** label field sets the label of new annotations; left empty, a new shape is auto-labelled with the layer color's name and a number (and a point with the color's name, or "Point" for the default color). With a `labelVocabulary` the field and the list's label editor suggest those terms, then the labels already used on the slide, and still accept free text. With `labelVocabularyStrict` they become a choice of the terms only, new shapes default to the first term, and a label outside the list cannot be saved (an annotation that already has one keeps it until it is relabelled). Strict is ignored without terms.

The viewer ships no default vocabulary: which terms fit depends on the site and the study, and a built-in list would quietly steer labels everywhere. Without one the field suggests the slide's existing labels, which keeps them consistent within a slide.

#### History

Under each annotation the list shows who created it and when, and **History ▸** (a disclosure, `aria-expanded`) lists what the service stores about its changes: created (by whom, when, and by which assistant or model), the review (accepted or rejected, by whom, when, from `provenance.review_status`, `reviewed_by`, `reviewed_at`), and the last change with the version number (`version`, `updated_at`). The service records no editor for an update, so the last change is credited to the reviewer when it is the review (saved within 5 seconds of `reviewed_at`), else to the creator, the only user who may edit. The click tooltip says "By alice · version 3". Earlier changes are not kept: a full audit log would need a change table in the annotation service, and the History block says so.

#### Notes

Each annotation can carry a free-text note, kept in `body.comment` and separate from its label. The list shows it under the annotation, with **+ Note** / **Edit note** for users who can edit (Ctrl/Cmd+Enter saves, Esc cancels); saving sends a `PUT` with the annotation's `version`. The click tooltip shows it too.

#### Slide notes and tags

The sidebar's **Slide notes** section, above Layers, holds notes on the open slide itself rather than on a shape, such as "Recut ordered" or "Margin involved", with tags. Each note shows its text, its tags, its author and time ("(edited)" once changed) and **Private** or **Shared**. Above them, the slide's tags with how many notes carry each, most used first; a tag filters the notes to those carrying it (`aria-pressed`), and pressing it again shows all.

Users who can edit in the study add a note under the list: text (up to 4,000 characters; Ctrl/Cmd+Enter adds it), tags (Enter or a comma adds what was typed, Backspace in the empty field removes the last, × removes one; the field suggests the slide's tags; up to 20 tags of 1–40 letters, digits, spaces or `_ - . : / + #`, starting with a letter or digit, checked before sending, a repeat in another letter case dropped) and who sees it: **Shared with the study** or **Private (only you)**, starting from the ⋯ menu's default for new annotations. A note needs text or a tag. After adding, the text field empties and keeps the focus. Users edit (**Edit**, which focuses the text; Escape cancels and the focus returns to Edit) and delete (**Delete**, after a confirmation) only their own notes, each with its `version`; a 409 or a note gone meanwhile reloads the notes and says so.

The notes load when the section first shows (a collapsed section loads nothing) and again on another slide or study. The section's title gives the count (the service's `total` when it pages). A service that pages the notes sends the first 100: **Show more notes (N more)** loads the next page (a note already shown is not repeated), the tags above count all the notes, and a tag filter applies to the notes loaded. A service that holds at most so many notes per slide answers a new one with a 422 whose message is shown. On a service without slide notes (404 "Not Found" or 405 from `/slide-notes`) the section goes away for the session. The proxy's 401 and 403 give the usual sign-in or read-only state.

#### Comment threads

Each saved annotation has a comment thread for discussion, separate from its note (the note is the creator's own text in `body.comment`). The list row shows **Comments** with the thread's count (`comment_count` from the service) as a badge; it is a disclosure (`aria-expanded`, `aria-controls`) that loads the thread and shows it under the row, oldest first, each comment with its author, time and "(edited)" when changed. Users who can edit in the study add a comment in the field under it (**Comment**, or Ctrl/Cmd+Enter; 1–4,000 characters, with a count near the limit), and edit or delete their own (**Edit**, **Delete** after a confirmation); others' comments have no controls, and the service refuses them anyway. Opening the thread focuses the field; after a post the field empties and keeps the focus, and after a delete the focus goes to it. The click tooltip says "2 comments".

Deleting an annotation deletes its thread, and an annotation Undo creates again is a new one, so its comments cannot come back. Deleting one with comments (its row's delete, the selection bar's Delete, a layer delete) or merging it away therefore asks first, naming how many comments and whether other users wrote some (the threads not loaded yet are loaded to tell, up to 20); Undo that creates it again says its comments could not be restored. Keeping them would need the service to restore a deleted annotation under its id (see Known gaps).

A service that pages threads sends the first 100 comments, oldest first: **Show more comments (N more)** at the end of the thread loads the next page, and a new comment is added at the end. An older service answers the whole thread as an array, read the same way. A thread the service caps (its 422 with a message, e.g. at 1,000 comments) shows that message.

The thread appears only on a service that has threads, known from the `comment_count` on the listed annotations. A 404 whose JSON `detail` is "Not Found", or a 405, from the thread route turns threads off for the session. The service's refusals show on the thread (`role="alert"`): another user's comment ("Only its author can change this comment."), and a comment deleted meanwhile (the thread reloads); an annotation gone or no longer shared (404 "Annotation not found") reloads the slide. A 401 or 403 from the proxy is the usual sign-in or read-only state.

#### Measurements

The list and the click tooltip show each annotation's size: the length of a line, and the area and perimeter of a rectangle, ellipse, circle or polygon (including freehand and brush shapes). A region with holes or several parts measures the area of its outer rings less its holes, and a perimeter along every ring, the holes' too. Coordinates are level-0 image pixels, scaled by the slide's microns-per-pixel (`tile_metadata.mpp`, the scale the status bar uses) on each axis, so slides with unequal x and y scales measure correctly. Lengths are shown in µm, or mm from 1 mm; areas in µm², or mm² from 0.01 mm². An ellipse's perimeter uses Ramanujan's approximation. Without a valid mpp the sizes are in pixels and the panel says so, also before any annotation exists. Drawing a line, rectangle, ellipse or circle shows its length or area next to the cursor. `wsiAnnotationGeometryUtils.ts` holds the math.

#### High-power fields and points inside regions

**What an HPF is**, as the viewer explains it wherever HPFs appear (the Shape menu item's tooltip, an info icon by the area picker, and one by the field table, each also the `aria-describedby` description of its control; `wsiHpfHelp.tsx`): "HPF (high-power field): the area of tissue seen through the microscope at high magnification (40× objective). Mitoses and other counts are often reported per 10 HPF. The field's area depends on the microscope's eyepiece (its field number): pick your microscope's area, or enter it in mm². Default 0.237 mm² (0.55 mm diameter)." The table's info icon adds what its rate columns mean.

**HPF field**, in the Shape menu, places a high-power field with a click (a drag still pans): a circle of a set area of tissue, centred on the click and saved as a circle annotation (an ellipse in pixels on a slide whose x and y scales differ) labelled "HPF 1", "HPF 2", … (the next number after the highest on the slide), on the active layer in its color. While the tool is on, a dashed circle under the pointer shows the field, and the toolbar offers the field area, each with its field diameter ("0.237 mm² (0.55 mm), default"): 0.159, 0.196, 0.237 (the default), 0.283, 0.332 or 0.374 mm² (fields of 0.45 to 0.69 mm), or a custom area of 0.01–5 mm², remembered in `localStorage`. The tool needs the slide's mpp; without one its menu item is disabled and says why. An annotation counts as a field when its label is "HPF" and a number and it is an ellipse or circle.

Every region (rectangle, ellipse, circle, polygon, freehand, brush, and regions with holes or parts) shows **Points inside: N (label n, …) · d per mm²** in the list and its tooltip when it holds points: all points on the slide, whatever layer or filter hides them, counted by label term (as the point tally groups them), with the density from the region's area on a slide with a scale. Points in a hole are not inside. A region without points shows no count, except while the Point or HPF field tool is on and on a field itself, where 0 is a count. With fields on the slide, the Annotations section adds a table of the points inside them per label, with the count **per 10 HPF** (the count over the number of fields, times 10: the rate pathology reports give) and **per mm²** (the count over the fields' area, which compares between microscopes with different field sizes), and the fields' area. It counts the user's own fields and points by default, so one reader's count is not mixed with another's; **Count fields and points of** switches to the drawing layer or all users (all, when the user is unknown). A point inside two fields counts once, and the area counts an overlap once (fields are circles of tissue; their pairwise lens is subtracted); overlapping fields are named under the table, since the rate per 10 HPF is then low. With fewer than 10 fields the rate per 10 HPF is provisional: shown in italics, not bold, with "Provisional: based on N fields". Each rate column has an info icon with its explanation (also its header's `aria-describedby`). Counting uses the points sorted by x, so each region only tests the points within its bounds. GeoJSON exports add `Num points`, `Num points: <label>` and `Points per mm^2` to a region's `measurements`.

#### Quick ruler

**Measure** (M), next to Line, measures without saving anything: drag on the slide and the length (µm, or mm from 1 mm, scaled per axis by the slide's mpp; pixels without one) and the angle from the horizontal (0–179°, counter-clockwise as seen) show next to the pointer. On release the ruler stays on the slide, a yellow line with end ticks and its reading, and follows the slide as it pans and zooms. It stays until the next measurement or Esc (a click without a drag keeps it); like the drawing tools, Measure stays on until Esc, V or another tool. Esc first drops a measurement being dragged, then clears the ruler, then goes back to Select. The ruler is not an annotation: it is never sent to the service, is not on the undo history, is not in GeoJSON exports, and goes when another slide opens. The downloaded view includes it while it shows, also while the annotations are hidden (H).

#### Points

The **Point** tool drops a point at each click (a drag still pans the slide) and stays on until Esc. A point is stored as an `SvgSelector` holding a circle of radius 0, in level-0 image pixels: `<svg><circle cx="…" cy="…" r="0" /></svg>`. Points are labelled with the active label, else the active color's name (or "Point" for the default color), so counting mitoses means picking a "Mitosis" color or label and clicking. The viewer draws points itself, as fixed-size markers on one canvas redrawn per frame, because Annotorious has no point shape; that keeps hundreds of points fast. A point shows and counts at once, before it is saved. Points are saved together: half a second after the last click, when the tool changes, and when the page is hidden, in batch requests of up to 100 (see Batch saves). Points dropped one after another undo as one step ("Undo create of 12 points"): a run is the drops of one Point tool session with no other change recorded in between and at most 3 seconds between two drops (`POINT_UNDO_GROUP_MS`); picking another tool or the Point tool again, Esc, any other change, undo or redo, or a longer pause starts a new step. The pause bounds what one undo can take back while counting at a steady pace. Each point is still its own annotation, relabelled or deleted on its own. A run undoes with `batch-delete` (one by one without it) and redoes with batch saves; undo first waits for unsent points. A point not yet sent can be relabelled or deleted without a request; one being saved is relabelled or deleted on its saved id once the save returns. Points still unsent when another slide or study opens, or the page unloads, are sent with `keepalive` without waiting for the answer: in batch requests when the batch route is known to exist, else one `POST` per point, all at once. Points the service refuses for access (401 or 403) stay on the slide marked **Not saved**, with "N points were not saved." and **Retry** (for example after signing in again); points that could not be sent before another slide opened are reported there. The toolbar shows the count for the active layer and label while the tool is on (announced as it settles, at most every 1.5 s), and the Annotations section has a **Point counts** table per label and layer. Clicking a marker shows its tooltip.

#### Zooming while drawing

The wheel and the zoom buttons pan and zoom the slide while a shape is being drawn. Each pointer position is converted to level-0 image pixels when it happens, with the slide as shown at that moment (also mid-animation), and the shape being drawn is kept in image pixels. The outline, the live measurement and the brush circle are redrawn as the slide moves, so they stay on the tissue they were drawn over, and a polygon closes on its first vertex where that vertex is now. Only the pointer that started a press draws (a second finger is ignored); a press the browser cancels, or whose pointer capture is lost, drops the drag shape or stroke, and a polygon keeps the vertices placed so far.

#### Freehand and brush

**Freehand** draws while the mouse button is held and saves the outline as a polygon. **Brush** paints a band and saves the band's outline as a polygon: the stroke is offset to both sides with mitred corners and round caps (`strokeOutline`). Both record a point every 2 screen pixels, appended to the stroke in place (no copy per pointer move), and the preview adds each new point to its polyline (`SVGPointList.appendItem`), placing the whole stroke again only when the slide moves; so capture and preview cost the same per move however long the stroke is. They simplify the stroke with Douglas–Peucker at 1.5 screen pixels before saving, measured at the finest zoom the stroke was drawn at, so zooming out mid-stroke does not erase detail drawn closer in.

The brush width is chosen in the toolbar in µm of tissue (10–500 µm, 50 µm by default). It is converted to image pixels with the slide's microns-per-pixel (the mean of x and y, since the band is round), so a stroke covers the same tissue at every zoom. While the brush is on, a circle under the pointer shows its size on screen at the current zoom, and the stroke previews at that width. A slide without a valid mpp has no scale: the width is then in screen pixels (8–64 px at the zoom the stroke starts at, kept for the whole stroke), and the toolbar says so. `brushWidthInImagePixels` holds the conversion.

The brush is stored as a polygon, not as a line with a width, so it has an area and perimeter, edits like any polygon, and exports to QuPath as a region. A stroke that doubles back sharply can give an outline that touches itself.

#### Magic wand and smart brush

Both select tissue by color, with classical image processing (no model), and save ordinary regions: a polygon, or a region with holes or parts (see Editing shapes), drawn as the toolbar's layer, label and color. They load with their Web Worker as their own async chunk (`wsi-tissue`, about 70 KB) when either is first picked.

**Magic wand** (W, in the Outline menu). A click on tissue shows, at once, a dashed outline of the connected region of similar color around the click (a flood fill). While it waits:

- dragging the press up raises the tolerance and down lowers it (2 screen pixels per step), and the scroll wheel does the same (up raises, Shift by 5); the outline follows, and the tolerance shows next to the click and in the toolbar (1–80, 15 by default; an info icon there explains it, also the slider's `aria-describedby`). While an outline waits the wheel does not zoom: the scroll would otherwise also change which pixels the wand reads. The zoom buttons and keys still zoom; Enter or Esc gives the wheel back;
- **Shift+click** adds the region at the click (a union; regions apart stay parts), **Alt+click** cuts it out of the outline (a hole, or a notch). Each click has its own tolerance: a drag or scroll changes the last one's. A plain click outside the outline starts a new one; a press inside it only adjusts the tolerance;
- **Enter** or a double-click saves it, **Esc** discards it, **Ctrl+Z** takes back the last click. The wand stays on for the next outline, and the saved region undoes like any shape;
- **Alt** as the first click, with regions selected, makes an outline (dashed red) that Enter cuts out of the selected regions, as Alt does with any shape; in **Cut a hole…** the outline is the shape cut out.

**Smart brush** (Shift+B, in the Outline menu next to Brush). Paints like the brush, with the same width in µm, but only pixels within the tolerance of the color under the start of the stroke, and only those connected within the band to the stroke itself: it stops at a tissue edge and does not jump a gap to similar tissue beyond. The painted area shows as a live dashed outline while painting, and the stroke saves as its outline (a polygon, or a region with parts and holes). Alt held as it ends cuts it out of the selected regions; nothing painted says so and saves nothing.

**Color distance.** Pixels are compared with the clicked color (the mean within 2.5 µm of the click) in CIELAB: `√((0.5·ΔL*)² + Δa*² + Δb*²)`. Lab is close to perceptually uniform, so one tolerance means about the same visible difference on any stain: eosin pink, hematoxylin blue-purple, DAB brown and the white background differ mostly in hue and chroma (a*, b*), which count in full; staining intensity within one tissue varies with section thickness and focus more than the hue does, so lightness counts half. The pixels are first smoothed with a box blur about 1 µm each way (3×3 at 1 µm per pixel, 9×9 at 0.25), so nuclei and noise do not break a region up. The blur and the seed window are in µm, so the same click outlines alike whatever the zoom and pixel source. A stain-separation measure (color deconvolution) needs stain vectors per stain and scanner; Lab needs none and works the same for H&E and IHC. Colors are quantized to 5 bits per channel for a 32,768-color Lab table, a smaller error (under about 2) than the tolerance step matters.

**Outline.** The selection is a pixel mask: holes smaller than 500 µm² (about 25 µm across: nuclei, specks) are filled, larger holes (lumens, vessels) are kept, and the smart brush drops parts smaller than 50 µm². The mask's boundary is followed pixel edge by pixel edge (4-connected regions, so regions touching only at a corner stay apart) and placed through the edge midpoints, which is the marching-squares contour of the mask, then simplified with Douglas–Peucker at 1 µm of tissue (and at least 0.75 analysis pixels), so the result does not depend on the zoom it was made at. Without a scale, holes under 64 analysis pixels are filled and the outline is simplified at 0.75 pixels.

**Where the pixels come from.** At an effective magnification of 10× or more (as the status bar shows it: the objective power times screen pixels per image pixel, or 1 µm per screen pixel without one), the wand reads the pixels OpenSeadragon has drawn, from its canvas at the canvas's resolution (CSS pixels × devicePixelRatio), mapped to level-0 image pixels through the viewport: instant, and only what is in view (a canvas larger than 4096 pixels a side, such as a wide view at a high devicePixelRatio, is read in a 4096-pixel window around the click or the stroke's start), so an outline that reaches the edge of the view stops there and says so. It waits up to 5 s for the view's tiles to finish loading first, and uses tiles instead when they are still loading, so an outline never comes from a half-drawn view. Zoomed out further, or when the slide is rotated or flipped, or the canvas cannot be read, it fetches the tile server's tiles of the level nearest 10× (about 1 µm per pixel) around the click, with the viewer's own tile URLs (`/wsi/tiles/zxy/…?studyId&key&enc`, the session cookie, as blobs, so they can always be read), stitched into an offscreen raster. That starts at about 512 pixels square (2 or 3 tiles each way, so a small click needs few requests) and grows on each side the selection reaches, by half its span (at least 2 tiles), so a large selection reaches the limit of 4096 pixels a side (about 4 mm at 10×) in a few steps; the outline so far shows at each step, a newer tolerance or click stops the growing, and a selection cut at the limit says so (the rest can be added with Shift+click). A spinner shows while tiles load. A new outline (a plain click) or Esc cancels the tile requests still waiting (`AbortSignal`), and nothing they or an earlier click finish shows afterwards. The time shown is from the click to the first outline. Either way the outline is in level-0 image pixels, and the two sources give nearly the same outline for the same click (the tests compare them on a synthetic slide: within 3% of the area). The status under the slide names the source and that time.

**Responsiveness.** The flood fill, hole filling and contour tracing run in a Web Worker (built into the package with `rollup-plugin-web-worker-loader` and started from a Blob URL, so hosts serve no extra file); the raster is transferred to it once per click and kept for tolerance changes. Clicks are computed one at a time, in order, each at its latest tolerance, so Shift+clicks made while one is computing are all added. A raster stays in the worker while any click of the outline, a stroke or the next click can use it (a click's raster grown for a later click is replaced by the grown one), and is dropped when nothing refers to it. Smart brush strokes finish on their own: a stroke started while the previous one is still being painted or saved is drawn and saved too. Where a worker cannot start (no `Worker`, or a Content Security Policy without `blob:` workers), the same code runs on the main thread, each request after yielding to the page once.

#### Editing and undo

While Annotate is on, clicking a rectangle, ellipse, line or polygon (including freehand and brush shapes) with Select selects it for editing: Annotorious shows handles to move it or drag its vertices. The viewer saves the new geometry with a versioned `PUT` and keeps the label, note, layer, sharing and provenance as stored. Points are not draggable; delete one and drop it again.

**Undo** in the toolbar, or Ctrl+Z / Cmd+Z outside text fields, reverses this session's last change on the slide: a created annotation is deleted, an edit is reversed by saving the previous version over the current one (with the current `version`), and a deleted annotation is created again (with a new id, so later undos follow it). A layer delete and an import each undo as one step. **Redo**, or Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y, applies an undone change again the same way, in one step for an import or a layer delete; annotations created again get new ids, and the rest of the history follows them. A new change clears what can be redone. Reviews are on neither history. The history holds 50 changes each way and is cleared when another slide or study opens.

#### Editing shapes: holes, merge, split

Regions can have holes and several parts. With regions selected (Shift+click, Shift+drag or the list's checkboxes; the order of selection counts), the selection bar's **Edit shapes…** menu offers, each with the count it applies to and disabled with the reason when the selection does not allow it:

| Operation | Result |
| --- | --- |
| **Merge N regions** | One new annotation covering all of them (their union; parts that do not touch stay parts of it), with the label, layer and color of the first selected |
| **Subtract** | The other selected regions cut out of the first selected |
| **Intersect N regions** | One new annotation where all of them overlap; the originals stay |
| **Cut a hole…** | The next closed shape drawn (rectangle, ellipse, circle, polygon, freehand or brush, which then works as an eraser) is cut out of each selected region it overlaps: a hole when it lies inside, a notch at an edge, pieces when it cuts across. Picks the Outline menu's last tool unless a closed-shape tool is on, and stays on for further holes until Esc, **Done** or Select. Holding **Alt** as any shape ends does the same once, without the menu |
| **Split … by a line…** | One selected region: the next line drawn across it (the Line tool, or a freehand or polygon path), from edge to edge, splits it; each piece becomes its own annotation with the region's label, layer and color. A line that does not cross it says so and saves nothing. The pieces are selected afterwards |
| **Separate parts** | Each part of a multi-part region becomes its own annotation |

A bar under the menu says what to draw while a cut or split waits ("Cut a hole: draw a shape inside "Tumor"; it is cut out. Esc stops."), and the selection bar's status says what was done, kept and not saved.

**Ownership.** Results are always the user's own annotations. Merge and intersect make a new annotation (shared or private as the first selected when it is the user's, else as the default for new annotations). Merge may combine any regions the user can see, the user's own and others' shared ones: the user's own originals are deleted, other users' stay as they are and the status names them ("Kept "Theirs": it is not yours, so it stays as it is."). The user's own AI originals also stay: only the service's trusted writers may create a machine-made annotation, so undo could not bring a deleted one back; the status says so, and they can be rejected or deleted. Subtract, cut, split and separate change the user's own region in place (a split or separation keeps the largest or first piece under its id and makes the others new); on another user's region they make new annotations of the user's and leave the original. A rectangle or ellipse that is cut or split becomes a polygon (an ellipse with 96 vertices).

**AI, edited.** A shape operation on an AI annotation keeps where it came from. The user's own machine-made region changed in place keeps its `provenance.source` (the service lets an annotation's creator keep its source on an update, and keeps its review fields) and gets `edited: true`; so does one whose vertices are dragged. A new annotation made from AI annotations cannot be machine-made, so it is written with `{source: "manual", operation, derived_from: [ids], derived_from_ai: true}`; one from other annotations with the same fields but no `derived_from_ai`. Both show **AI, edited**, History says "Created (merge of 2 annotations, from AI)" or "Shape edited by a person", and exports add `ai_edited`.

**Undo.** Each operation is one undo step ("Undo merge", "Undo cut", "Undo split", …): undo deletes what it created, puts the previous shape back on what it changed (a versioned `PUT`) and creates what it deleted again; redo applies it again.

**All or nothing.** New annotations are saved first (batch saves), then the changed shapes (versioned `PUT`s), then the deletes of the originals (one all-or-none `batch-delete` where the service has it). When any part fails, such as a merge whose originals cannot be deleted or a split whose region changed elsewhere meanwhile (409), what was saved is taken back: the new annotations are deleted, changed shapes put back and deleted ones created again, so no overlapping shapes are left; the status says what failed and that nothing changed, and there is nothing to undo. Operations run one after another, so a second cut drawn while the first saves applies to the saved shape and version.

**Storage.** A region with one ring stays an `SvgSelector` `<polygon points="x,y …" />` as before, so existing annotations read, render and edit unchanged. A region with holes or several parts is stored as Annotorious writes a multi-polygon: one `<path fill-rule="evenodd">` per part in a `<g>`, its outer ring then its holes as closed subpaths, in level-0 image pixels rounded to 0.01:

```html
<svg><g><path fill-rule="evenodd" d="M 0,0 L 100,0 L 100,100 L 0,100 Z M 40,40 L 40,60 L 60,60 L 60,40 Z" /></g></svg>
```

The service stores the selector as given. Annotorious draws such a region with its holes empty and edits its vertices, holes included; the viewer measures it, counts the points inside it and hit-tests it with the holes left out (`wsiAnnotationGeometryUtils.ts`, `wsiAnnotationSpatial.ts`). An older viewer draws it (Annotorious reads the paths) but lists it without a size or count.

The operations use [polygon-clipping](https://github.com/mfogel/polygon-clipping) 0.15.7 (MIT; with splaytree, MIT, and robust-predicates, Unlicense): about 29 KB minified and 9 KB gzipped, loaded with the operations (`wsiAnnotationShapeOps.ts`) as their own async chunk, `wsi-shapeops`, when an operation first runs (`wsiShapeOpsLoader.ts`; the magic wand's Shift+ and Alt+clicks load it too). Area, bounds and parts of a region (`wsiRegionUtils.ts`) need no clipping and stay in the viewer. A split cuts a band 0.2 image pixels wide along the line (about 0.05 µm at 0.25 µm per pixel), so the pieces do not touch; pieces under 1 square image pixel are dropped.

#### Annotation list

The sidebar's Annotations section lists the annotations shown on the slide (layers and Show). It filters by label or note text, layer and author (when there is more than one), and shows how many listed annotations each layer and each label group has. A label groups under its base term: a trailing count such as " (13 tiles)" is dropped, so "Solid region (13 tiles)" and "Solid region (9 tiles)" group as Solid region, and an auto-label (a palette color's name or hex and a number) counts under its base, so "Tumor 1" and "Tumor 2" count as Tumor. Vocabulary terms and other labels count as written, so "Grade 1" and "Grade 2" or "Gleason pattern 4" stay apart. The eight largest groups show, the rest behind **+N more**. Clicking a label count filters the list to that group, and clicking it again clears it. Clicking an annotation's label (or Enter on it) pans and zooms the slide to it and highlights it (see Stepping through annotations). The filters reset when another slide opens.

A list of more than 100 annotations is virtualized: only the rows in and near the view are rendered (about 15 of 5,000), each placed at its offset, with heights measured as rows first render or change (a `ResizeObserver` catches a note or thread opening; a render measures only rows not measured yet, and the view's height is measured on resize, so a render forces no layout) and estimated elsewhere; the scroll position is applied once per animation frame; rows carry `aria-posinset`/`aria-setsize`. The row holding the focus stays rendered while it is scrolled away. In any list, ↑ and ↓ move from a row's label to the next or previous row's, Home and End to the first and last, scrolling (and rendering) the row first; checkboxes select as usual; and the list scrolls to the annotation the slide is pointed at (`]`/`[`, the review card, a link).

Drawing and editing stay off until the slide's annotations have loaded; a failed load shows an alert with **Retry**. Icon buttons are labelled by their target (for example "Delete annotation Tumor 1"), and after an accept, reject, delete or label save the focus moves to the row, else the next row, else the list. Text on an annotation's color is black or white by luminance.

#### Stepping through annotations, and links to one

**]** and **[** step to the next and previous annotation the list shows (what shows on the slide, and the list's filters), Annotate on or off, in the review queue's nearest-next order, wrapping around. Each is fitted in the view and highlighted with the dashed yellow frame. A bar at the bottom of the slide says which it is ("3 of 17: Tumor 1", a `role="status"`), with ‹ and › buttons, **Copy link** and ×; Esc or × stops highlighting. `]` and `[` were chosen because N/P would clash with P (polygon), and the arrow keys belong to the review card and to OpenSeadragon's panning. They do nothing while the review card is open.

**Copy link** (in the bar, and the link icon on each list row) copies a URL that opens the slide at that annotation, fitted and highlighted. The host makes the link (`annotationLink`), naming the slide by its opaque key and the annotation by its id, never by an image id:

- the patient page's Pathology Slides tab: `/patient/wsiHESlides?studyId=…&caseId=…&pathologySlideSettings={"annotationId":"…"}#wsi:slide=<slide key>`, the deep-link hash selecting the slide as for slide links and the annotation in the tab's `pathologySlideSettings` URL node;
- the `/wsi/patient/{patient}` permalink: `?studyId=…&slideKey=…&annotationId=…`.

The host passes the link's annotation as `requestedAnnotationId` and its slide as `requestedAnnotationSlideKey` (the hash's slide on the tab, `slideKey` on the permalink). It opens only on that slide, once its annotations have loaded, and only once: the viewer then calls `onRequestedAnnotationUsed`, and both hosts drop `annotationId` from the address (`history.replaceState`, keeping the `#wsi:` hash), so a reload or another slide does not open it again. Opening it: its layer is shown if hidden (ending a solo), its kind is turned on under Show, hide all is turned off, and it is fitted and highlighted. A link to an annotation that is not there (deleted, rejected in review, or private to another user, which the service does not list) shows "The linked annotation is not on this slide…" in the bar instead. Without the Clipboard API the bar shows the link to copy by hand. Without `annotationLink`, there is no Copy link.

#### Selecting several annotations

With Select (no drawing tool on), Annotate on or off:

- **Shift+click** a shape or point on the slide adds or removes it; where shapes overlap, the smallest under the pointer is picked. **Shift+drag** draws a box and adds the annotations that lie wholly inside it.
- Each list row has a checkbox. **Ctrl+A** (⌘A) selects every annotation the list shows (what shows on the slide, and the list's filters) when the focus is in the viewer, or nowhere while Annotate is on; elsewhere it selects the page's text as usual.
- **Esc** clears the selection. Selected shapes are drawn with a thicker outline and a dashed blue frame.

While any are selected, a bar under the toolbar says "N selected" and offers, each button naming how many it applies to:

- **Relabel**, **Move to layer…** and **Sharing…** (shared or private): for the user's own annotations; a layer move keeps their colors. Move to layer…, Sharing… and Edit shapes… are menu buttons (the toolbar's `role="menu"`): they act on a pick (click, Enter or Space), never while the arrow keys move through them.
- **Accept** and **Reject**: for the unreviewed AI annotations the user may review, anyone's, with the review route as above (without the route, only the user's own). Reject asks first, with the count.
- **Edit shapes…**, while regions are selected: merge, subtract, intersect, cut a hole, split, separate parts (see Editing shapes).
- **Delete**: the user's own, after a confirmation.

Others are skipped, and a status says what was done and skipped, e.g. "Relabelled 2 annotations; skipped 1 that is not yours.", and how many could not be saved. Relabel, move and sharing undo and redo as one step, as does a delete; reviews are not on the history. The selection is cleared when another slide opens.

Bulk actions use the service's batch routes: `POST /annotations/batch-update` (relabel, move, sharing), `batch-delete` and `batch-review` (accept, reject), with `{items: [{id, version, …}]}` of up to 100 annotations per request, each from its current `version`; the service saves a request whole or not at all. When it refuses one:

- **409**, listing every stale annotation: those are reported as changed elsewhere ("\"Tumor 3\": changed elsewhere; reloaded"), the slide reloads so they show as stored, and the rest of the request is sent again from the reloaded versions.
- **403** or **404** naming the first refused annotation (`{msg, index, id}`): it is reported by its label with the service's reason, and the rest are sent again; a missing one also reloads the slide at the end.
- **404** "Not Found" or **405**: the service has no such route, so that action and later ones of its kind in the session send one request per annotation (`PUT`, `DELETE`, `POST …/review`), four at a time, with the per-annotation handling above. Without the review route, reviews always go one by one (the creator-only fallback).

The status names up to three annotations that could not be saved, and why. Relabel, move and sharing still undo and redo as one step, and a delete as one step.

#### Export and import (GeoJSON)

The toolbar's ⋯ menu exports the slide's annotations, all of them or only those shown (layers and Show; **Export shown**), as a GeoJSON `FeatureCollection` that QuPath imports. Each annotation is a `Feature`:

- `geometry`: a `Point`, `LineString`, `Polygon` or `MultiPolygon` in level-0 image pixels (x right, y down). Rectangles become 4-corner polygons and ellipses 72-vertex polygons. A region with holes is a `Polygon` whose outer ring comes first and its holes after; a region of several parts is a `MultiPolygon`.
- `properties`: `objectType: "annotation"`, `name` (the label), `classification: { name, color: [r, g, b] }` (the label, or an auto-label's base, and the annotation's color), `layer`, `note`, and `measurements` in QuPath's naming (`Area µm^2`, `Perimeter µm`, `Length µm`, or `px` without an mpp). AI annotations add `ai_generated` and `ai_review_status`, and "AI, edited" ones `ai_edited`.

The collection's `wsi` member names the slide by its opaque slide key and gives the mpp. Exports never contain image ids, sealed sources or object keys, nor creators or provenance details.

**Import…** in the ⋯ menu refuses a file over 25 MB before reading it. It reads a GeoJSON `FeatureCollection`, `Feature` or array of features, such as a QuPath export, and validates it before anything is saved: points, lines and polygons with finite coordinates inside the slide and at most 5,000 vertices (all rings together) are kept: a `Polygon` with its holes, and a `MultiPolygon` as one annotation of all its parts and their holes, while `MultiPoint` and `MultiLineString` split into one annotation per part. A ring of fewer than 3 vertices or a bad part skips the feature, the reason naming the part ("part 2: fewer than 3 vertices"); anything else is skipped with a reason. At most 2,000 annotations are imported at once. A preview under the toolbar shows how many points, lines and polygons will be created and what was skipped; **Create** then saves them in batch requests (see Batch saves), with the file's name or class as the label, its class color, layer and note, else the active ones; the annotations saved undo as one step. If some are refused, the rest are still created and the message names the refused ones by their number in the preview and the service's reason. With a strict vocabulary, features whose label is not a term are skipped, named by their feature number.

#### Batch saves

Imports and dropped points are created with `POST /annotations/batch`, at most 100 annotations and about 3 MiB per request (the service caps bodies at 4 MiB; `keepalive` requests at 60 KiB). The service saves a request whole or not at all and returns the saved annotations in request order.

- A 422 that names items (its `loc` gives each item's index) marks those as refused, with the service's message, and sends the rest once more.
- A 413 splits the request in two.
- Any other failure marks the request's annotations as not saved.
- A 404 or 405 means the service has no batch route: that save and later ones in the session use one `POST /annotations` each, four at a time (all at once with `keepalive`).

#### Known gaps (service changes)

- **Undoing a review**: a reject cannot be taken back to unreviewed, so it always asks first. A review decision that clears the review (`POST /annotations/{id}/review` with `{decision: "reset", version}`, restoring `review_status` to unset and recording who reset it) would let Undo take back a review.
- **Comments of a deleted annotation**: deleting an annotation deletes its thread, and Undo creates a new annotation. A soft delete with a restore under the same id (`POST /annotations/{id}/restore` with its `version`, keeping the thread) would let Undo bring the comments back.

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
- Keep `openseadragon` behind the dynamic import in `wsiOpenSeadragonLoader.ts`, the tissue tools behind the one in `wsiTissueLoader.ts`, and the shape operations (polygon-clipping) behind the one in `wsiShapeOpsLoader.ts` (`checkWsiBundle` checks all three: polygon-clipping only in the `wsi-shapeops` chunk).
- The controller's `annotations` is an `observable.ref` (replace the array, never mutate it), and comment threads, comment counts and the selection are observable maps read per key, so a change re-renders only the rows it touches.
- Export from the light entry only what hosts import statically. Components and anything heavy belong in `viewer`.
