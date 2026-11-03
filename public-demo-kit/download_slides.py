#!/usr/bin/env python3
"""Pick and download open-access TCGA-BRCA diagnostic slides from the NCI GDC.

Selection (deterministic for a given GDC release):
  project TCGA-BRCA, data_type "Slide Image", experimental_strategy "Diagnostic Slide",
  access open, file_size between --min-mb and --max-mb, patient present in the
  cBioPortal study's clinical file, one slide per patient, ordered by file name.

Writes <out>/manifest.json (file_id, file_name, md5sum, file_size, patient_id, sample_id)
and downloads each file to <out>/<file_name>, resuming partial downloads and verifying
the md5 of every file. Re-running is safe: verified files are skipped.

If <out>/manifest.json already lists at least --count slides it is reused as-is, so a
selection stays fixed once made (delete it, or pass --refresh, to select again).

Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

GDC_FILES = "https://api.gdc.cancer.gov/files"
GDC_DATA = "https://api.gdc.cancer.gov/data/"
CHUNK = 4 * 1024 * 1024


def gdc_candidates(min_bytes: int, max_bytes: int) -> list[dict]:
    filters = {
        "op": "and",
        "content": [
            {"op": "=", "content": {"field": "cases.project.project_id", "value": "TCGA-BRCA"}},
            {"op": "=", "content": {"field": "data_type", "value": "Slide Image"}},
            {"op": "=", "content": {"field": "experimental_strategy", "value": "Diagnostic Slide"}},
            {"op": "=", "content": {"field": "access", "value": "open"}},
            {"op": ">=", "content": {"field": "file_size", "value": min_bytes}},
            {"op": "<=", "content": {"field": "file_size", "value": max_bytes}},
        ],
    }
    body = json.dumps(
        {
            "filters": filters,
            "fields": "file_id,file_name,md5sum,file_size,cases.submitter_id,cases.samples.submitter_id",
            "size": "5000",
            "format": "JSON",
        }
    ).encode()
    request = urllib.request.Request(
        GDC_FILES, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)["data"]["hits"]


def study_patients(study_dir: Path) -> set[str]:
    path = study_dir / "data_clinical_patient.txt"
    patients: set[str] = set()
    header: list[str] | None = None
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            fields = line.rstrip("\n").split("\t")
            if header is None:
                header = fields
                continue
            patients.add(fields[header.index("PATIENT_ID")])
    return patients


def select(hits: list[dict], patients: set[str], count: int) -> list[dict]:
    chosen: list[dict] = []
    seen: set[str] = set()
    for hit in sorted(hits, key=lambda h: h["file_name"]):
        cases = hit.get("cases") or []
        if len(cases) != 1:
            continue
        patient = cases[0]["submitter_id"]
        samples = cases[0].get("samples") or []
        if patient not in patients or patient in seen or len(samples) != 1:
            continue
        # GDC sample barcodes carry a vial letter (TCGA-XX-XXXX-01Z); cBioPortal uses the
        # first 15 characters (TCGA-XX-XXXX-01).
        sample = samples[0]["submitter_id"][:15]
        seen.add(patient)
        chosen.append(
            {
                "file_id": hit["file_id"],
                "file_name": hit["file_name"],
                "md5sum": hit["md5sum"],
                "file_size": hit["file_size"],
                "patient_id": patient,
                "sample_id": sample,
            }
        )
        if len(chosen) == count:
            break
    return chosen


def md5_of(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def download(entry: dict, out_dir: Path, attempts: int = 5) -> None:
    target = out_dir / entry["file_name"]
    if target.exists() and target.stat().st_size == entry["file_size"]:
        if md5_of(target) == entry["md5sum"]:
            print(f"  ok      {entry['file_name']}")
            return
        target.unlink()
    partial = target.with_name(target.name + ".part")
    for attempt in range(1, attempts + 1):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > entry["file_size"]:
            partial.unlink()
            offset = 0
        request = urllib.request.Request(GDC_DATA + entry["file_id"])
        if offset:
            request.add_header("Range", f"bytes={offset}-")
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                if offset and response.status != 206:
                    offset = 0  # server ignored the range; start over
                mode = "ab" if offset else "wb"
                with partial.open(mode) as handle:
                    while True:
                        block = response.read(CHUNK)
                        if not block:
                            break
                        handle.write(block)
            if partial.stat().st_size == entry["file_size"]:
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            print(f"  retry {attempt}/{attempts} {entry['file_name']}: {error}", file=sys.stderr)
            time.sleep(min(30, 2 ** attempt))
    else:
        raise SystemExit(f"download failed: {entry['file_name']}")
    actual = md5_of(partial)
    if actual != entry["md5sum"]:
        partial.unlink()
        raise SystemExit(f"md5 mismatch for {entry['file_name']}; partial file removed, re-run to retry")
    os.replace(partial, target)
    print(f"  fetched {entry['file_name']} ({entry['file_size'] / 1e6:.0f} MB, md5 ok)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--out", type=Path, required=True, help="slide directory")
    parser.add_argument("--study-dir", type=Path, required=True, help="unpacked cBioPortal study")
    parser.add_argument("--min-mb", type=int, default=100)
    parser.add_argument("--max-mb", type=int, default=300)
    parser.add_argument("--refresh", action="store_true", help="select again even if a manifest exists")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    manifest = None
    if manifest_path.exists() and not args.refresh:
        existing = json.loads(manifest_path.read_text())
        if len(existing["slides"]) >= args.count:
            manifest = existing
            if len(existing["slides"]) > args.count:
                manifest["slides"] = existing["slides"][: args.count]
                manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    if manifest is None:
        print("Querying the GDC for open-access TCGA-BRCA diagnostic slides...")
        hits = gdc_candidates(args.min_mb * 1_000_000, args.max_mb * 1_000_000)
        slides = select(hits, study_patients(args.study_dir), args.count)
        if len(slides) < args.count:
            print(f"warning: only {len(slides)} slides match the selection", file=sys.stderr)
        manifest = {
            "source": "NCI Genomic Data Commons (https://portal.gdc.cancer.gov), open access",
            "project": "TCGA-BRCA",
            "selection": f"Diagnostic Slide, {args.min_mb}-{args.max_mb} MB, one per study patient, by file name",
            "slides": slides,
        }
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    total = sum(s["file_size"] for s in manifest["slides"])
    print(f"Downloading {len(manifest['slides'])} slides ({total / 1e9:.2f} GB) to {args.out}")
    for entry in manifest["slides"]:
        download(entry, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
