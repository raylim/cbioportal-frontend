#!/usr/bin/env python3
"""Copy a cBioPortal datahub study, restricted to a set of patients.

Keeps the study meta, clinical data, mutations, discrete copy number, segments,
structural variants, gene panel matrix, timelines, the study's own resource files and
case lists, each filtered to the given patients (and their samples). Expression,
methylation, protein and generic-assay profiles are left out to keep the import fast.

  trim_study.py --src <datahub study dir> --out <new dir> --patients-from <manifest.json>

Standard library only. The output directory is replaced.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

# meta file -> (data file, how rows are filtered)
KEEP = {
    "meta_study.txt": None,
    "meta_clinical_patient.txt": ("data_clinical_patient.txt", "patient_column"),
    "meta_clinical_sample.txt": ("data_clinical_sample.txt", "patient_column"),
    "meta_mutations.txt": ("data_mutations.txt", "maf"),
    "meta_cna.txt": ("data_cna.txt", "sample_columns"),
    "meta_cna_hg19_seg.txt": ("data_cna_hg19.seg", "seg"),
    "meta_sv.txt": ("data_sv.txt", "sv"),
    "meta_gene_panel_matrix.txt": ("data_gene_panel_matrix.txt", "sample_column"),
    "meta_timeline_sample_acquisition.txt": ("data_timeline_sample_acquisition.txt", "patient_column"),
    "meta_timeline_status.txt": ("data_timeline_status.txt", "patient_column"),
    "meta_timeline_treatment.txt": ("data_timeline_treatment.txt", "patient_column"),
    "meta_resource_definition.txt": ("data_resource_definition.txt", "copy"),
    "meta_resource_patient.txt": ("data_resource_patient.txt", "patient_column"),
}
# Case lists for profiles that are kept.
CASE_LISTS = ("cases_all.txt", "cases_cna.txt", "cases_cnaseq.txt", "cases_sequenced.txt", "cases_sv.txt")


def filter_by_column(src: Path, dst: Path, column: str, keep: set[str]) -> None:
    header_seen = False
    index = -1
    with src.open(encoding="utf-8") as fin, dst.open("w", encoding="utf-8") as fout:
        for line in fin:
            if line.startswith("#") or not line.strip():
                fout.write(line)
                continue
            fields = line.rstrip("\n").split("\t")
            if not header_seen:
                header_seen = True
                index = fields.index(column)
                fout.write(line)
                continue
            if fields[index] in keep:
                fout.write(line)


def filter_sample_columns(src: Path, dst: Path, samples: set[str]) -> None:
    with src.open(encoding="utf-8") as fin, dst.open("w", encoding="utf-8") as fout:
        header = fin.readline().rstrip("\n").split("\t")
        keep = [i for i, name in enumerate(header) if i < 2 or name in samples]
        fout.write("\t".join(header[i] for i in keep) + "\n")
        for line in fin:
            fields = line.rstrip("\n").split("\t")
            fout.write("\t".join(fields[i] for i in keep) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--patients-from", type=Path, required=True, help="slide manifest.json")
    args = parser.parse_args()

    patients = {s["patient_id"] for s in json.loads(args.patients_from.read_text())["slides"]}
    # Every sample of those patients, from the clinical sample file.
    samples: set[str] = set()
    header = None
    for line in (args.src / "data_clinical_sample.txt").open(encoding="utf-8"):
        if line.startswith("#"):
            continue
        fields = line.rstrip("\n").split("\t")
        if header is None:
            header = fields
            continue
        if fields[header.index("PATIENT_ID")] in patients:
            samples.add(fields[header.index("SAMPLE_ID")])

    if args.out.exists():
        shutil.rmtree(args.out)
    (args.out / "case_lists").mkdir(parents=True)
    for name in ("LICENSE", "README.md"):
        if (args.src / name).exists():
            shutil.copy2(args.src / name, args.out / name)

    for meta, spec in KEEP.items():
        if not (args.src / meta).exists():
            continue
        shutil.copy2(args.src / meta, args.out / meta)
        if spec is None:
            continue
        data, how = spec
        src, dst = args.src / data, args.out / data
        if how == "copy":
            shutil.copy2(src, dst)
        elif how == "patient_column":
            filter_by_column(src, dst, "PATIENT_ID", patients)
        elif how == "sample_column":
            filter_by_column(src, dst, "SAMPLE_ID", samples)
        elif how == "maf":
            filter_by_column(src, dst, "Tumor_Sample_Barcode", samples)
        elif how == "seg":
            filter_by_column(src, dst, "ID", samples)
        elif how == "sv":
            filter_by_column(src, dst, "Sample_Id", samples)
        elif how == "sample_columns":
            filter_sample_columns(src, dst, samples)

    for name in CASE_LISTS:
        src = args.src / "case_lists" / name
        if not src.exists():
            continue
        lines = src.read_text(encoding="utf-8").splitlines()
        out = []
        ids: list[str] = []
        for line in lines:
            if line.startswith("case_list_ids:"):
                ids = [i for i in line.split(":", 1)[1].strip().split("\t") if i in samples]
                line = "case_list_ids: " + "\t".join(ids)
            out.append(line)
        if ids:
            (args.out / "case_lists" / name).write_text("\n".join(out) + "\n", encoding="utf-8")

    print(f"Trimmed study: {len(patients)} patients, {len(samples)} samples -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
