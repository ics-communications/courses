# ICS Course Catalogue — Setup

This repo contains:

```
index.html              ← the public catalogue page (single file, data baked in)
bake.py                 ← refreshes the course data inside index.html
.github/workflows/
  bake-catalogue.yml    ← runs bake.py hourly (+ manual "Run workflow" button)
apps-script/
  appsscript.json       ← Apps Script manifest
  Code.gs               ← backend (web app + sheet menu + CRUD)
  Sidebar.html          ← the editor form opened from the sheet menu
```

The architecture: a Google Sheet holds the courses, and the course data is
**baked into `index.html` itself** by `bake.py`, which a GitHub Action runs
hourly (or on demand). Visitors load a fully static page — no runtime calls
to Google, so the catalogue renders instantly and never breaks if Apps
Script is unavailable; at worst it shows data up to an hour old. The bake
script currently reads the Apps Script web app's JSON; it can be switched
to a published-CSV URL later (see GITHUB-ACTION-PLAN.md) to retire the web
app entirely. Editors never touch HTML or columns directly — they use a
sidebar form built into the sheet.

---

## 1. Create the Google Sheet

1. Go to [sheets.new](https://sheets.new) and create a new sheet.
2. Rename it something like **"ICS Course Catalogue"**.
3. *(Don't worry about columns — the script will create them in step 3.)*

## 2. Open the Apps Script editor

From the sheet menu: **Extensions → Apps Script**.

A new project opens. You'll see a `Code.gs` file by default and (in a
hidden panel) a `appsscript.json` manifest.

### Paste in the three files

1. **`Code.gs`** — Replace the entire contents of the default `Code.gs`
   with the contents of `apps-script/Code.gs` from this repo.

2. **`Sidebar.html`** — Click **+ → HTML**, name it `Sidebar` (no `.html`
   suffix — Apps Script adds it), then paste in the contents of
   `apps-script/Sidebar.html`.

3. **`appsscript.json`** — In the Apps Script editor settings (gear icon
   in left rail) tick **"Show 'appsscript.json' manifest file in editor"**.
   Open the now-visible `appsscript.json` and replace its contents with
   `apps-script/appsscript.json`.

Click **Save** (💾).

## 3. Initialize the sheet

Back in the Google Sheet, **reload the page**. A new menu appears in
the top bar: **ICS Catalogue**.

Click **ICS Catalogue → Initialize / repair sheet…**

The script asks for permission the first time — approve it (you'll see
an "unverified app" warning because the script is private to your
account; choose **Advanced → Go to ICS Course Catalogue (unsafe)** and
**Allow**).

This creates a `Courses` sheet with all the right columns, frozen
headers, and dropdown validation on the `published` column.

## 4. Deploy the web app (data source for the bake)

Back in Apps Script: **Deploy → New deployment**.

- **Type**: Web app
- **Description**: `ICS catalogue public JSON v1`
- **Execute as**: Me
- **Who has access**: Anyone

Click **Deploy**. Authorize when prompted. You'll get a URL that ends in
`/exec` — copy it.

Note: visitors never call this URL. Only `bake.py` reads it, on the
GitHub Action's hourly schedule.

## 5. Wire the URL into `bake.py`

Open `bake.py`, find the `SOURCE_URL` constant near the top, and paste
the `/exec` URL inside the quotes. Save, commit, push.

The hourly **Bake catalogue** Action (or a local `python3 bake.py`) now
refreshes the data inside `index.html` between the `BAKED-DATA` marker
comments and commits the result. If the baked block is ever missing,
the page falls back to a small bundled sample so the layout is still
visible.

`SOURCE_URL` also accepts a Google Sheets "Publish to web" CSV URL for
the Courses tab — use that to remove the web-app dependency entirely
(GITHUB-ACTION-PLAN.md, Phase 1).

## 6. Add or edit courses

In the sheet: **ICS Catalogue → Add or edit course…**

A sidebar opens with the editor form. Pick "Edit Existing Course" to
load a row, or click **+ Add new course**. Fill in the fields and
**Save**. The form handles all the columns; editors never have to know
the schema.

> **When changes appear:** the public page updates when the **Bake
> catalogue** GitHub Action next runs — hourly on a schedule. For an
> urgent update, open the repo on GitHub → **Actions** tab → **Bake
> catalogue** → **Run workflow**; the page refreshes within a minute
> or two of the run going green.

## 7. Embed in Google Sites (for now)

Until the page is hosted in this repo on GitHub Pages, you can embed it
in Google Sites by hosting `index.html` somewhere publicly fetchable and
using **Insert → Embed → By URL** (or the **Embed code** option for a
raw iframe). The page is designed to render fine inside an iframe — set
the iframe height generously (the catalogue is a few thousand pixels
tall).

If you don't have hosting handy, the simplest options are:

- **Quick**: Drop `index.html` into a Google Drive folder shared as "Anyone
  with the link", then use Drive's "Embed item" code (works for static
  HTML in some Workspace setups).
- **Permanent**: Push this repo to GitHub and turn on **Pages** (Settings
  → Pages → Source: `main` branch, root). Within a minute you'll have a
  URL like `https://<your-org>.github.io/courses/` you can point Sites at.

## 8. Field reference

Each row in the `Courses` sheet is one course. The columns map 1:1 to
fields in the editor sidebar — the dropdowns there are the source of
truth for accepted values.

Important fields:

| Column                    | Notes                                                              |
|---------------------------|--------------------------------------------------------------------|
| `id`                      | Auto-generated. Don't edit.                                        |
| `published`               | `TRUE` shows on the page, `FALSE` hides it (draft).                |
| `programs`                | Space-separated lowercase tokens (`mael mwse cilc`). Drives the program filter **and** the program tags shown on the card. |
| `term`                    | Entered once via the sidebar's Season + Year. Stored as a key like `fall26`. The card's term code (`F26`) and label (`Fall Term`) are derived from it automatically. |
| `descriptionShort`        | Always-visible blurb. Use `*asterisks*` for italic.                |
| `descriptionMore`         | Shown after `descriptionShort` when a card is expanded ("Show more") — separate paragraphs with a blank line. |
| `requiredBooks`           | One citation per line. `*asterisks*` for italic titles.            |

If you ever need to add a new program, edit two places:

1. In `index.html`, add to the `PROGRAM_LABELS` constant near the top of
   the `<script>` block.
2. In `apps-script/Code.gs`, add to `PROGRAM_OPTIONS`.

## Troubleshooting

**Changes don't appear on the page**
The hourly bake hasn't run yet. Check the repo's **Actions** tab: the
latest **Bake catalogue** run shows whether the data was refreshed. Use
**Run workflow** there to force an immediate update.

**A bake run shows red (failed) in the Actions tab**
The page is *stale, not broken* — it keeps serving the last successfully
baked data. Open the failed run's log: `bake.py` refuses to touch
`index.html` if the download fails or the payload looks wrong (empty, or
zero published courses), and the log says which. Usually this means the
Apps Script deployment was archived or made private — check **Deploy →
Manage deployments** (access must be "Anyone").

**"Catalogue data unavailable" banner on the page**
The `BAKED-DATA` block is missing from `index.html` (the page is showing
bundled sample data). Run `python3 bake.py` locally or trigger the
**Bake catalogue** Action, then commit/push the refreshed `index.html`.

**Editor menu doesn't show up**
You need to reload the sheet tab once after pasting in the script.

**Permission error when saving**
The Apps Script project may have lost its connection to the sheet.
Re-open from **Extensions → Apps Script** and try again — Google will
prompt to re-authorize.

**Embedded page is cut off in Google Sites**
Google Sites iframes have a fixed height set by the editor. In the Sites
editor, drag the iframe taller (or set its height to ~3000px to be safe).
