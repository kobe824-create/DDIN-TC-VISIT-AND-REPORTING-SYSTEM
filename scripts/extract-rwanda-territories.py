#!/usr/bin/env python3
"""Extract the official Rwanda village register from its text-based PDF."""

import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path


SOURCE = Path(sys.argv[1])
OUTPUT = Path(sys.argv[2])


xml = subprocess.run(
    ["pdftotext", "-bbox-layout", str(SOURCE), "-"],
    check=True,
    stdout=subprocess.PIPE,
).stdout
root = ET.fromstring(xml)
rows = []
for page in root.findall(".//{*}page"):
    words = []
    for word in page.findall(".//{*}word"):
        words.append((float(word.attrib["yMin"]), float(word.attrib["xMin"]), word.text or ""))
    words.sort()
    header_y = min(y for y, _x, text in words if text == "DISTRICT")
    header_words = [(x, text) for y, x, text in words if abs(y - header_y) < 1 and text in {"DISTRICT", "SECTOR", "CELL", "VILLAGE"}]
    headers = {}
    for label in ("DISTRICT", "SECTOR", "CELL"):
        positions = [x for x, text in header_words if text == label]
        if positions:
            headers[label.lower()] = min(positions)
    village_positions = sorted(x for x, text in header_words if text == "VILLAGE")
    if len(village_positions) < 2 or len(headers) != 3:
        raise SystemExit("Could not identify the table columns on a PDF page.")
    headers["village"] = village_positions[0]
    headers["code"] = village_positions[1]
    code_positions = [x for _y, x, text in words if re.fullmatch(r"\d{9}", text)]
    headers["village_code"] = min(code_positions) if code_positions else headers["code"]

    def col_for(x):
        if x < headers["sector"]:
            return "district"
        if x < headers["cell"]:
            return "sector"
        if x < headers["village"]:
            return "cell"
        if x < headers["village_code"]:
            return "village"
        return None

    lines = []
    for y, x, text in words:
        if not lines or abs(y - lines[-1][0]) > 0.8:
            lines.append([y, [(x, text)]])
        else:
            lines[-1][1].append((x, text))
    for _y, line_words in lines:
        code = next((text for _x, text in line_words if re.fullmatch(r"\d{9}", text)), None)
        if not code:
            continue
        fields = defaultdict(list)
        for column in ("district", "sector", "cell", "village"):
            candidates = []
            for line_y, candidate_words in lines:
                if abs(line_y - _y) > 6:
                    continue
                values = [text for x, text in candidate_words if col_for(x) == column]
                if values:
                    candidates.append((abs(line_y - _y), values))
            if candidates:
                fields[column] = min(candidates, key=lambda candidate: candidate[0])[1]
        record = {key: " ".join(fields[key]).strip() for key in ("district", "sector", "cell", "village")}
        record["villageCode"] = code
        if not all(record[key] for key in ("district", "sector", "cell", "village")):
            raise SystemExit(f"Incomplete row for code {code}: {record}")
        rows.append(record)

if not rows:
    raise SystemExit("No village rows found in the PDF.")
if len({row["villageCode"] for row in rows}) != len(rows):
    raise SystemExit("Duplicate village codes found in the PDF extraction.")


def best_name(values):
    counts = Counter(values)
    return sorted(counts, key=lambda name: (-counts[name], name.casefold()))[0]


def proper_name(value):
    def proper_word(word):
        if re.fullmatch(r"[ivxlcdm]+", word, re.IGNORECASE):
            return word.upper()
        return word[:1].upper() + word[1:].lower()

    return " ".join("-".join(proper_word(part) for part in word.split("-")) for word in value.split())


def normalize_name(value):
    return re.sub(r"\s+", " ", value.casefold().strip())


district_rows = defaultdict(list)
sector_rows = defaultdict(list)
cell_rows = defaultdict(list)
for row in rows:
    code = row["villageCode"]
    district_rows[code[:3]].append(row)
    sector_rows[code[:5]].append(row)
    cell_rows[code[:7]].append(row)

label_conflicts = []


def code_name(code, group, field):
    labels = Counter(normalize_name(row[field]) for row in group)
    winner, winner_count = sorted(labels.items(), key=lambda entry: (-entry[1], entry[0]))[0]
    if len(labels) > 1:
        label_conflicts.append({"level": field, "sourceCode": code, "labels": dict(labels), "selected": winner})
    spellings = [row[field] for row in group if normalize_name(row[field]) == winner]
    return proper_name(best_name(spellings))


districts = []
for district_code, district_group in sorted(district_rows.items()):
    district = {"name": code_name(district_code, district_group, "district"), "code": district_code, "sectors": []}
    for sector_code, sector_group in sorted((key, value) for key, value in sector_rows.items() if key.startswith(district_code)):
        sector = {"name": code_name(sector_code, sector_group, "sector"), "sourceCode": sector_code, "cells": []}
        for cell_code, cell_group in sorted((key, value) for key, value in cell_rows.items() if key.startswith(sector_code)):
            cell = {"name": code_name(cell_code, cell_group, "cell"), "sourceCode": cell_code, "villages": []}
            village_groups = defaultdict(list)
            for row in cell_group:
                village_groups[normalize_name(row["village"])].append(row)
            for village_key, village_group in sorted(village_groups.items()):
                cell["villages"].append({
                    "name": proper_name(best_name([row["village"] for row in village_group])),
                    "sourceCodes": sorted({row["villageCode"] for row in village_group}),
                })
            sector["cells"].append(cell)
        district["sectors"].append(sector)
    districts.append(district)

payload = {
    "source": SOURCE.name,
    "districtCount": len(districts),
    "sectorCount": sum(len(district["sectors"]) for district in districts),
    "cellCount": sum(len(sector["cells"]) for district in districts for sector in district["sectors"]),
    "sourceRowCount": len(rows),
    "sourceNameConflicts": label_conflicts,
    "villageCount": sum(len(cell["villages"]) for district in districts for sector in district["sectors"] for cell in sector["cells"]),
    "districts": districts,
}
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
print(json.dumps({key: payload[key] for key in ("districtCount", "sectorCount", "cellCount", "sourceRowCount", "villageCount")}, indent=2))
