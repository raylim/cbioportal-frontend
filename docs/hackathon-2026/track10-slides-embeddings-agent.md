# Track 10: Slides, embeddings and the AI agent

cBioPortal Hack & Specathon, Nov 3–4 2026 · Raymond Lim

By the Wednesday 15:30 wrap-up we want a design the community can build on: how cBioPortal should present slide embeddings, annotations and an AI agent. We'll show it with a live demo of its first loop, on lung adenocarcinoma (LUAD).

## The story

The user is a translational researcher in a LUAD cohort. They start on one patient's slide and end with a morphology-defined cohort compared on genomics. The patient page is the entry point; the cohort and genomics context is what cBioPortal adds over a plain slide viewer.

1. **One slide.** On a LUAD patient's H&E slide, they ask the in-viewer assistant to *find regions with a solid growth pattern*. Matching tiles come back as proposed annotations; they accept a few into a "Solid pattern" layer. This works today.
2. **Who else looks like this?** One click, or one question to the assistant, takes them to the study. Every LUAD patient carries morphology scores for a fixed vocabulary (solid, micropapillary, lepidic, acinar, mucinous, necrosis, TIL-rich, desmoplastic stroma, and others). They show up in Study View as ordinary charts and filters.
3. **Morphology → cohort.** In cBioChat they ask: *compare patients with high solid-pattern scores to those with high lepidic scores*. cBioChat calls our slide tools, builds the two groups and opens Group Comparison.
4. **Genomics → morphology.** The same scores answer the reverse question: *which morphology concepts differ between KRAS G12C and EGFR-mutant tumors?*
5. **Back to the evidence.** From any patient in either group, one click opens their slide on the top-scoring tiles for that concept. The assistant explains what it found and offers to save the tiles as annotations.

**What keeps it credible:**

- Every score links to example tiles; nobody sees only a number.
- Scores are labeled as research signals, not diagnoses.
- IHC slides are left out or flagged, because text matching is weak on them.
- Every agent step is shown and editable: which concepts, which thresholds, which groups.

## What exists vs. what we build

Most of the loop already exists; the new pieces are the concept scores, their link into the study, and a few tools for cBioChat. Owners are proposals — claim or swap them.

| Piece | State | Proposed owner | Notes |
| --- | --- | --- | --- |
| Slide viewer, annotations, layers | Works today | — | cbioportal-frontend #5732, #19 |
| In-viewer assistant + text→region search on one slide | Works today | — | #20, tile server #40; MSK slides only |
| Group Comparison, Study View filters | Works today | — | Existing cBioPortal |
| Concept vocabulary for LUAD (~30 concepts, 2–4 prompts each) | To build | Raymond + a pathologist | Needs a pathologist's review |
| Concept-score batch over LUAD H&E slides | To build | Raymond | ~6,800 patients, ~53k H&E slides; overnight CPU job |
| Scores loaded into the study (attributes or a generic assay profile) | To build | Raymond / Darin | Then Study View and Group Comparison work unchanged |
| "Show me the tiles" link from a score into the viewer | To build | Darin | Opens the slide on the top tiles for a concept |
| Slide tools for cBioChat | To build | Darin + Track 2 | List concepts, filter cohort by concept, top tiles |
| Evidence-tile and heat-map UI in the viewer | Spec only | Carlos | Mockups + prototype on public data / mocks |
| Study-wide free-text search (ANN index) | Spec only | — | The scaling path; spec only for now |

## How morphology search works at study scale

We build on precomputed concept scores (A) and add one live free-text query on a narrowed cohort (B); an index over every tile (C) is the scaling path in the spec. Searching every tile of every slide live isn't possible: today's search takes under a second per cached slide, and a study has tens of thousands of slides with 1–30k tiles each.

The embeddings: each slide's stored H-optimus-1 tile features are mapped into the KEEP text-image space by a small adapter, then scored against the KEEP text embedding of a concept or query. Scores are cosines (about 0.2–0.4 at the top) and are only comparable within a slide, so per-concept normalization across the cohort is part of the batch.

| | A. Precomputed concept scores | B. Live free text on a narrowed cohort | C. Nearest-neighbor index over tiles |
| --- | --- | --- | --- |
| What it does | Offline, score every tile against ~30 concepts; keep per-slide max, top-k mean and fraction above threshold, plus the top tiles | Agent narrows the cohort with normal filters, then searches each slide | Index all adapted tile vectors; any text or example region returns matching tiles study-wide |
| Query speed | Instant (ordinary Study View data) | Minutes for thousands of cold slides | Milliseconds |
| Flexibility | Fixed vocabulary | Any text | Any text or example region |
| Build effort | One overnight CPU batch | Exists per slide; needs fan-out, a cap and progress | Tens of millions of vectors and the memory to hold them |
| Role here | Foundation of the demo and spec | One "wow" query in the demo | Spec: the scaling path |

A also gives the reverse direction for free: Group Comparison already compares any attribute between groups.

## The agent and cBioChat

cBioChat stays the one conversation for study and cohort questions; it calls our slide tools. The in-viewer assistant keeps only what needs the slide in front of it: seeing the viewport and proposing annotations.

| Agent | Where | Does |
| --- | --- | --- |
| cBioChat (Track 2) | Study and cohort level | Builds cohorts, compares groups, calls the slide tools below |
| Slide assistant | Next to the viewer | Reads the current viewport, finds regions on this slide, proposes annotations and viewer moves |

Slide tools we'd expose to cBioChat (a tool server, e.g. MCP, over the tile server's research endpoints):

| Tool | Input | Returns |
| --- | --- | --- |
| `list_morphology_concepts` | Study | The concept vocabulary and how each was scored |
| `cohort_by_concept` | Study, concept, threshold or top-N | Patient and sample IDs, ready for a Study View filter or a comparison group |
| `concept_evidence` | Patient or slide, concept | Top tiles with scores and a link that opens the viewer on them |
| `find_regions` | Slide, free text | Ranked regions on one slide (today's search) |

Access control overlaps Track 2's study-level authorization question. The slide tools already use short-lived, study-scoped tokens that can't fetch pixels, and that could be a starting point for LLM tools generally.

## Plan to Wednesday's wrap-up

The concept-score batch has to start tonight, so the vocabulary is the first thing to agree on. Everything else can run in parallel.

**Tuesday, before the 16:30 day-one wrap-up**

- [ ] Agree on the LUAD concept vocabulary and prompts, with a pathologist's eye (Raymond, Darin)
- [ ] Talk to Track 2: cBioChat's tool interface and how it handles auth (Darin)
- [ ] Sketch the evidence-tile and heat-map views (Carlos)
- [ ] Give a 2-minute status at the day-one wrap-up (Raymond)

**Tuesday night**

- [ ] Run the concept-score batch over LUAD H&E slides; keep the top tiles per concept (Raymond)

**Wednesday, 10:30–12:00**

- [ ] Load the scores into the LUAD cohort and check them in Study View (Raymond, Darin)
- [ ] Spot-check the top and bottom scorers per concept on their slides (Darin)
- [ ] Build `cohort_by_concept` and `concept_evidence`, and wire one of them into cBioChat (Darin + Track 2)
- [ ] Prototype the evidence-tile strip or heat-map overlay on mocks (Carlos)

**Wednesday, 13:00–15:30**

- [ ] Rehearse the five-step demo end to end, with a fallback recording (all)
- [ ] Finish the spec: the story, the three search approaches, the agent split, and what's next (all)
- [ ] Present at 15:30 (Raymond)

## More user stories

Five more stories go in the spec. Three reuse the concept scores or the existing viewer and agent; two need a new lookup or a new export.

| Story | Persona | What it needs | Effort this week |
| --- | --- | --- | --- |
| **Morphology and outcome:** do patients with high TIL-rich scores live longer? | Researcher | Concept scores + Group Comparison's survival tab | Nearly free once the batch runs |
| **Which morphology tracks a mutation?** The agent ranks concepts by how well they separate EGFR from KRAS tumors and shows example tiles for the top hits | Researcher | Concept scores + Group Comparison statistics + `concept_evidence` | Small |
| **Similar prior cases:** on a slide, show similar slides from other patients with their mutations and outcomes | Pathologist | Nearest-neighbor lookup over stored slide-level (TITAN) embeddings — tens of thousands of vectors, not tens of millions | Possibly buildable; otherwise spec |
| **Label propagation:** annotate a few regions; the agent finds similar tiles across many slides and proposes them in batches to accept or reject | Computational pathologist | Region search across a set of slides + batch proposals in the viewer | Demo on a few slides; spec at scale |
| **Training-data export:** accepted annotations and tile coordinates as GeoJSON or CSV, for QuPath or model training | Computational pathologist | An export (and import) in the annotation panel or API | Small; good for Carlos on public data |

**Later:**

- Query by example region across the cohort (needs the tile index, approach C)
- Rare-pattern finder: patients with unusually high scores for an uncommon concept
- Pan-cancer view of one concept across cancer types
- Report-style estimates (tumor area, TIL density) from accepted annotations, clearly approximate
- Slide quality and linkage checks: pen marks, blur, folds, or a slide whose morphology doesn't fit its sample
- Model comparison: the same query across embedding models
- A one-paragraph morphology-plus-genomics patient summary, as a research aid only
- Annotation provenance (person vs. accepted AI proposal), sharing scopes and audit
- Shareable evidence views: a link to a slide, viewport and layers
- A public version on TCGA with open GDC slides and a public text-image model

## Open questions

- **Vocabulary:** which LUAD concepts matter most to researchers? WHO growth patterns, immune and stromal features, or both? And who reviews the prompts?
- **How scores reach the study:** clinical attributes (simplest, but ~30 more charts) or one generic assay profile (tidier, a few more steps)?
- **Patient-level roll-up:** max over a patient's slides, or the primary tumor sample only?
- **cBioChat:** what's its tool interface today (MCP or other), and can it pass a cohort to Group Comparison? Track 2, can you confirm?
- **Public version:** can the same loop run on TCGA LUAD with open GDC slides? That would need a public text-image model, since the adapter is MSK-internal. Good follow-up for outside contributors.
- **How to show uncertainty:** what's the right way to say "research signal, not diagnosis" in Study View and Group Comparison?
