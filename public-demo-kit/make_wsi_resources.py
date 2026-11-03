#!/usr/bin/env python3
"""Write the cBioPortal WSI resource rows for the downloaded slides.

Runs inside the tile-server image (load_data.sh does this), because it reuses the tile
server's own code to read each slide, render its thumbnail and check the sealed source:

  docker compose run --rm --no-deps -v $STUDY:/study -v $DATA_DIR/slides/thumbnails:/thumbnails \
      -v ./make_wsi_resources.py:/kit/make_wsi_resources.py:ro tile \
      python /kit/make_wsi_resources.py --study-dir /study --thumbnail-dir /thumbnails \
      --origin http://localhost:27800

For every slide in /slides/manifest.json it:
  * reads level-0 size, levels, downsamples and mpp (app.tiles.slide_metadata);
  * renders a 1024 px JPEG thumbnail, served as /slides/thumbnails/<name>.jpg;
  * seals {image_id, tile_source, thumbnail_source} with WSI_SOURCE_SEAL_KEY
    (AES-256-GCM, AAD = slide_key; the format in app/sealed_source.py), so only the
    tile server can open the file path;
  * writes one WSI_SAMPLE row (the slide's TCGA sample is in the study).

Output, in the standard cBioPortal resource-data format (docs/File-Formats.md):
  data_resource_definition.txt  existing definitions + WSI_SAMPLE and WSI_PATIENT
  data_resource_sample.txt      + meta_resource_sample.txt   (WSI_SAMPLE rows)
  data_resource_patient.txt     existing rows, kept, with a DISPLAY_NAME column added
Re-running replaces the WSI rows; slide keys are derived from the GDC file id, so
annotations stay attached to the same slides across reloads.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import logging
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image

from app.auth import decode_source_seal_key, decrypt_sealed_claims
from app.sealed_source import SEALED_SOURCE_NONCE_BYTES, SLIDE_KEY_PATTERN
from app.slide_store import check_source_uri, open_slide
from app.tiles import get_thumbnail_bytes_with_plan, slide_metadata

RESOURCE_IDS = ("WSI_SAMPLE", "WSI_PATIENT")
SLIDES = Path("/slides")
THUMBNAIL_SIZE = 1024
# Keys the tile metadata carries that are not part of the published serving contract.
UNPUBLISHED_TILE_METADATA_KEYS = ("identity_version", "source_fingerprint")

# The metadata keys of a WSI row, declared so the importer can check every row and the
# portal's resource table can label them.
FIELDS = [
    ("slide_key", "Slide key", "string", False, True),
    ("stain_name", "Stain", "string", True, True),
    ("stain_group", "Stain group", "string", True, False),
    ("slide_type", "Slide type", "string", True, False),
    ("is_hne", "H&E", "string", True, False),
    ("is_ihc", "IHC", "string", True, False),
    ("magnification", "Magnification", "string", True, True),
    ("match_level", "Match level", "string", True, False),
    ("part_key", "Part key", "string", False, False),
    ("part_number", "Part", "string", False, True),
    ("part_description", "Part description", "string", False, True),
    ("block_key", "Block key", "string", False, False),
    ("block_number", "Block number", "string", False, False),
    ("block_label", "Block", "string", False, True),
    ("specimen_key", "Specimen key", "string", False, False),
    ("reference_sample_id", "Reference sample", "string", False, False),
    ("can_serve_tiles", "Viewable", "string", True, False),
    ("file_size_bytes", "File size (bytes)", "number", False, False),
    ("source_file_name", "GDC file name", "string", False, False),
    ("serving", "Serving", "string", False, False),
]


def custom_metadata() -> str:
    return json.dumps(
        {
            "version": 1,
            "fields": [
                {
                    "key": key,
                    "label": label,
                    "type": kind,
                    "filterable": filterable,
                    "visibleByDefault": visible,
                }
                for key, label, kind, filterable, visible in FIELDS
            ],
        },
        separators=(",", ":"),
    )


DEFINITIONS = {
    "WSI_SAMPLE": ("Pathology Slides", "SAMPLE", "Whole-slide images matched to a sample"),
    "WSI_PATIENT": ("Pathology Slides", "PATIENT", "Whole-slide images not matched to a sample"),
}


def short_key(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()[:12]


def seal(plaintext: dict, key: bytes, slide_key: str) -> str:
    nonce = os.urandom(SEALED_SOURCE_NONCE_BYTES)
    ciphertext = AESGCM(key).encrypt(
        nonce, json.dumps(plaintext, separators=(",", ":")).encode(), slide_key.encode()
    )
    return base64.urlsafe_b64encode(nonce + ciphertext).rstrip(b"=").decode()


def read_table(path: Path) -> tuple[list[str], list[dict]]:
    if not path.exists():
        return [], []
    lines = [line.rstrip("\n") for line in path.open(encoding="utf-8") if line.strip()]
    header = lines[0].split("\t")
    rows = [dict(zip(header, line.split("\t"))) for line in lines[1:]]
    return header, rows


def write_table(path: Path, header: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        handle.write("\t".join(header) + "\n")
        for row in rows:
            handle.write("\t".join(str(row.get(column, "")) for column in header) + "\n")


def slide_row(entry: dict, seal_key: bytes, study_id: str, origin: str, thumbnail_dir: Path) -> dict:
    name = entry["file_name"]
    stem = name.rsplit(".", 1)[0]
    tile_source = f"file:///slides/{name}"
    thumbnail_source = f"file:///slides/thumbnails/{stem}.jpg"
    check_source_uri(tile_source, kind="source", prefixes=["file:///slides/"])
    check_source_uri(thumbnail_source, kind="thumbnail", prefixes=["file:///slides/thumbnails/"])

    slide, _ = open_slide(tile_source, logging.getLogger("make_wsi_resources"))
    try:
        metadata = slide_metadata(slide)
        thumbnail, _ = get_thumbnail_bytes_with_plan(slide, THUMBNAIL_SIZE, THUMBNAIL_SIZE)
    finally:
        slide.close()
    for key in UNPUBLISHED_TILE_METADATA_KEYS:
        metadata.pop(key, None)
    if metadata.get("safe_min_level") is None:
        raise SystemExit(f"{name}: no level is safe to decode; pick another slide")
    (thumbnail_dir / f"{stem}.jpg").write_bytes(thumbnail)
    with Image.open(io.BytesIO(thumbnail)) as image:
        thumb_width, thumb_height = image.size

    # TCGA slide barcode: TCGA-XX-XXXX-<sample><vial>-<portion>-<slide>, e.g.
    # TCGA-A7-A0CD-01Z-00-DX1. The sample is the part; portion + slide name the block.
    barcode = stem.split(".", 1)[0]
    _, _, _, sample_vial, portion, slide_name = barcode.split("-")
    patient_id, sample_id = entry["patient_id"], entry["sample_id"]
    slide_key = short_key("slide", entry["file_id"])
    assert SLIDE_KEY_PATTERN.fullmatch(slide_key)
    image_id = entry["file_id"]
    sealed_source = seal(
        {"image_id": image_id, "tile_source": tile_source, "thumbnail_source": thumbnail_source},
        seal_key,
        slide_key,
    )
    # The tile server must be able to open what was sealed.
    opened = decrypt_sealed_claims(sealed_source, seal_key, slide_key)
    assert opened["tile_source"] == tile_source

    objective = metadata.get("objective_power")
    block_number = "".join(ch for ch in slide_name if ch.isdigit()) or "1"
    row_metadata = {
        "slide_key": slide_key,
        "stain_name": "H&E",
        "stain_group": "H&E initial",
        "slide_type": "H&E",
        "is_hne": True,
        "is_ihc": False,
        "magnification": f"{objective}x" if objective else "",
        "match_level": "BLOCK",
        "part_key": short_key("part", sample_id),
        "part_number": str(int(sample_vial[:2])),
        "part_description": "Breast, primary tumor",
        "block_key": short_key("block", sample_id, portion, slide_name),
        "block_number": block_number,
        "block_label": f"{portion}-{slide_name}",
        "specimen_key": short_key("specimen", sample_id, sample_vial),
        "reference_sample_id": sample_id,
        "can_serve_tiles": True,
        "file_size_bytes": entry["file_size"],
        "source_file_name": name,
        "serving": {
            "key": slide_key,
            "sealed_source": sealed_source,
            "thumbnail_content_type": "image/jpeg",
            "thumbnail_width": thumb_width,
            "thumbnail_height": thumb_height,
            "tile_metadata_json": metadata,
        },
    }
    url = f"{origin}/wsi/patient/{patient_id}?studyId={study_id}&slideKey={slide_key}"
    display = f"H&E · Part {row_metadata['part_number']} / Block {row_metadata['block_label']}"
    print(
        f"  {patient_id}  {sample_id}  slide_key={slide_key}  "
        f"{metadata['dimensions']['width']}x{metadata['dimensions']['height']}  "
        f"levels={metadata['levels']}  mpp={metadata['mpp']['x']:.4f}"
    )
    return {
        "PATIENT_ID": patient_id,
        "SAMPLE_ID": sample_id,
        "RESOURCE_ID": "WSI_SAMPLE",
        "URL": url,
        "DISPLAY_NAME": display,
        "METADATA": json.dumps(row_metadata, separators=(",", ":"), ensure_ascii=False),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--study-dir", type=Path, required=True)
    parser.add_argument("--origin", required=True, help="PUBLIC_ORIGIN, e.g. http://localhost:27800")
    parser.add_argument(
        "--thumbnail-dir",
        type=Path,
        default=SLIDES / "thumbnails",
        help="writable mount of the host directory served as /slides/thumbnails",
    )
    args = parser.parse_args()

    seal_key = decode_source_seal_key(os.environ.get("WSI_SOURCE_SEAL_KEY", ""))
    study_dir: Path = args.study_dir
    meta_study = (study_dir / "meta_study.txt").read_text(encoding="utf-8")
    study_id = next(
        line.split(":", 1)[1].strip()
        for line in meta_study.splitlines()
        if line.startswith("cancer_study_identifier:")
    )
    manifest = json.loads((SLIDES / "manifest.json").read_text())
    origin = args.origin.rstrip("/")

    print(f"Reading {len(manifest['slides'])} slides")
    args.thumbnail_dir.mkdir(parents=True, exist_ok=True)
    sample_rows = [
        slide_row(entry, seal_key, study_id, origin, args.thumbnail_dir) for entry in manifest["slides"]
    ]

    # Definitions: keep the study's own, replace ours.
    definition_path = study_dir / "data_resource_definition.txt"
    header, rows = read_table(definition_path)
    header = header or ["RESOURCE_ID", "DISPLAY_NAME", "RESOURCE_TYPE", "DESCRIPTION", "OPEN_BY_DEFAULT", "PRIORITY", "CUSTOM_METADATA"]
    for column in ("DESCRIPTION", "OPEN_BY_DEFAULT", "PRIORITY", "CUSTOM_METADATA"):
        if column not in header:
            header.append(column)
    rows = [row for row in rows if row["RESOURCE_ID"] not in RESOURCE_IDS]
    for resource_id, (display, scope, description) in DEFINITIONS.items():
        rows.append(
            {
                "RESOURCE_ID": resource_id,
                "DISPLAY_NAME": display,
                "RESOURCE_TYPE": scope,
                "DESCRIPTION": description,
                "OPEN_BY_DEFAULT": "FALSE",
                "PRIORITY": "1",
                "CUSTOM_METADATA": custom_metadata(),
            }
        )
    write_table(definition_path, header, rows)
    (study_dir / "meta_resource_definition.txt").write_text(
        f"cancer_study_identifier: {study_id}\nresource_type: DEFINITION\n"
        "data_filename: data_resource_definition.txt\n"
    )

    # Sample rows: the importer takes one sample resource file per study.
    sample_header = ["PATIENT_ID", "SAMPLE_ID", "RESOURCE_ID", "URL", "DISPLAY_NAME", "METADATA"]
    _, existing_samples = read_table(study_dir / "data_resource_sample.txt")
    existing_samples = [row for row in existing_samples if row["RESOURCE_ID"] not in RESOURCE_IDS]
    write_table(study_dir / "data_resource_sample.txt", sample_header, existing_samples + sample_rows)
    (study_dir / "meta_resource_sample.txt").write_text(
        f"cancer_study_identifier: {study_id}\nresource_type: SAMPLE\n"
        "data_filename: data_resource_sample.txt\n"
    )

    # Patient rows: keep the study's own; give the file the DISPLAY_NAME column so a
    # WSI_PATIENT row (a slide with no sample) can be added in the same format.
    patient_path = study_dir / "data_resource_patient.txt"
    header, rows = read_table(patient_path)
    if header:
        rows = [row for row in rows if row["RESOURCE_ID"] not in RESOURCE_IDS]
        write_table(patient_path, ["PATIENT_ID", "RESOURCE_ID", "URL", "DISPLAY_NAME", "METADATA"], rows)

    print(f"Wrote {len(sample_rows)} WSI_SAMPLE rows to {study_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
