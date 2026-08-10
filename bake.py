#!/usr/bin/env python3
"""Bake course data into index.html.

Downloads the catalogue data and injects it into index.html between the
<!-- BAKED-DATA-START --> / <!-- BAKED-DATA-END --> markers as a
`const BAKED_DATA = {...};` script block. Run by the "Bake catalogue"
GitHub Action (hourly + manual), or by hand: python3 bake.py

SOURCE_URL accepts either form:
  - the Apps Script web-app URL (current setup) — already serves the final
    JSON payload {updated, courses: [...]}
  - a Google Sheets "Publish to web" CSV URL of the Courses tab — rows are
    converted here using the same whitelist/normalization as doGet() in
    apps-script/Code.gs (see GITHUB-ACTION-PLAN.md Phase 1 for how to
    publish; switching source is just replacing this URL)

Fails loudly (non-zero exit) without touching index.html if the download
fails, the payload is malformed, or it contains zero published courses.
Standard library only.
"""

import csv
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

SOURCE_URL = "https://script.google.com/macros/s/AKfycbzzC-hmu2I2qSbcBlsfPOS9SfShCOv2HFx5jOIxFDyLQ3JElCOSh9oRZU57JyDYwr8/exec"

INDEX = Path(__file__).parent / "index.html"
START = "<!-- BAKED-DATA-START -->"
END = "<!-- BAKED-DATA-END -->"

# Mirrors PUBLIC_FIELDS in apps-script/Code.gs — only these columns are
# ever exposed in the public payload (CSV source only; the web app already
# whitelists server-side).
PUBLIC_FIELDS = [
    "id", "published",
    "title", "code", "term",
    "programs", "credits",
    "instructorName", "instructorUrl",
    "subtitle", "descriptionShort", "descriptionMore",
    "tstCode", "format", "meetingDay", "meetingTime",
    "syllabusUrl", "requiredBooks",
    "prerequisites", "cstcArea", "certificateTags",
    "enrolmentNotes", "registrationEmail",
    "lastDateToRegister", "maxEnrolment",
]

TRUTHY = re.compile(r"^(true|yes|1)$", re.I)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ics-catalogue-bake/1.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read().decode("utf-8")


def payload_from_csv(text):
    """Convert published-CSV rows to the doGet() payload shape (Code.gs)."""
    rows = list(csv.DictReader(io.StringIO(text)))
    courses, updated = [], ""
    for row in rows:
        if not any((v or "").strip() for v in row.values()):
            continue
        u = (row.get("updatedAt") or "").strip()
        if u and (not updated or u > updated):
            updated = u
        course = {f: row[f].strip() for f in PUBLIC_FIELDS if row.get(f)}
        course["published"] = bool(TRUTHY.match((row.get("published") or "").strip()))
        if not course["published"]:
            continue
        courses.append(course)
    return {"updated": updated[:10], "courses": courses}


def main():
    raw = fetch(SOURCE_URL)
    try:
        data = json.loads(raw)
    except ValueError:
        data = payload_from_csv(raw)

    if not isinstance(data, dict) or not isinstance(data.get("courses"), list):
        sys.exit("bake: payload is not {updated, courses: [...]} — index.html untouched")
    published = [c for c in data["courses"] if c.get("published") is True]
    if not published:
        sys.exit("bake: zero published courses in payload — index.html untouched")
    for field in ("id", "title", "term"):
        missing = [c for c in published if not c.get(field)]
        if missing:
            sys.exit(f"bake: {len(missing)} course(s) missing '{field}' — index.html untouched")

    html = INDEX.read_text(encoding="utf-8")
    if START not in html or END not in html:
        sys.exit("bake: BAKED-DATA markers not found in index.html")

    # </ must not appear inside a <script> block; escape it the JSON-safe way
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    block = f"{START}\n<script>const BAKED_DATA = {blob};</script>\n{END}"
    new_html = re.sub(
        re.escape(START) + r".*?" + re.escape(END), lambda _: block, html, count=1, flags=re.S
    )

    if new_html != html:
        INDEX.write_text(new_html, encoding="utf-8")
        print(f"bake: wrote {len(published)} published courses (updated {data.get('updated') or 'n/a'})")
    else:
        print("bake: no change")


if __name__ == "__main__":
    main()
