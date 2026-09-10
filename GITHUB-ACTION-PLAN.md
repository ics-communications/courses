# Course Catalogue — Switch from Live Fetch to a GitHub Action Bake

**Current architecture** (see SETUP.md): the public page (`index.html`)
fetches JSON from an Apps Script web app (`APPS_SCRIPT_URL`, line ~842)
every time a visitor loads it, falling back to `SAMPLE_DATA` if the fetch
fails.

**Problem with that for succession:** the Apps Script deployment is live
infrastructure. It runs as the deploying Google account ("Execute as: Me"),
so if that account is deactivated, the deployment is changed, or Google
alters Apps Script behavior, the *public page breaks for visitors* — and it
breaks for a successor who can't debug it. Visitors also pay the Apps
Script cold-start delay on every load, and the content is invisible to
search engines that don't execute JavaScript.

**Target architecture:**

```
Google Sheet (unchanged — sidebar editor keeps working)
      │  "File → Share → Publish to web" as CSV
      ▼
GitHub Action (hourly + manual "Run workflow" button)
      │  fetches CSV → converts to the same JSON shape doGet() serves
      │  → injects it INTO index.html between marker comments → commits
      ▼
Static page on GitHub Pages — renders instantly, no runtime dependencies
```

Key point: the page's existing rendering JavaScript stays as-is. We only
change where the data comes from: instead of `fetch(APPS_SCRIPT_URL)` at
load time, the data sits inline in the HTML, refreshed by the Action. If
the pipeline ever breaks, the page just shows slightly stale courses —
it never goes down.

**What we keep from the current setup:** the Google Sheet, the sidebar
editor form (ICS Catalogue menu), all its validation. Editors notice no
difference except changes now appear within the hour (or instantly via the
manual trigger) instead of within 5 minutes.

**What gets retired:** the `doGet()` web-app deployment and its cache
machinery — after cutover, nothing calls it.

**Caveat to accept before starting:** "Publish to web" makes the sheet's
data readable by anyone who has the (obscure) CSV URL — including rows
where `published` is FALSE. Draft courses are therefore technically public
before they appear on the page. If that's ever a real concern, the
alternative is a service-account credential stored as a GitHub secret;
start with publish-to-web because it's zero-maintenance.

**Prerequisite:** this repo must be on GitHub with GitHub Pages enabled
(Settings → Pages → Deploy from branch → `main`, root). If the page is
currently embedded in Google Sites via iframe, that embed should point at
the GitHub Pages URL — same as SETUP.md §7's "Permanent" option.

**How to use this plan:** phases in order; each says who acts. Claude
prompts are copy-paste blocks written for a fresh session with no memory —
run them from inside this repo folder.

---

## Phase 1 — Publish the sheet as CSV

**Who:** You (5 minutes, from the Google account that owns the sheet —
which should be a shared org account; if it's currently under your
personal account, transfer ownership first and note it in SETUP.md).

1. Open the ICS Course Catalogue sheet.
2. **File → Share → Publish to web** → select the **Courses** tab →
   format **Comma-separated values (.csv)** → Publish.
3. Copy the URL and keep it for Phase 2.

**Done when:** the URL downloads current course data in a private browser
window.

---

## Phase 2 — Rework the page to use baked-in data

**Who:** Claude.

**Prompt:**

> Read GITHUB-ACTION-PLAN.md in this repo — we are doing Phase 2. The goal:
> stop `index.html` fetching from the Apps Script web app at page load, and
> instead have the data baked into the file itself, refreshed later by a
> GitHub Action.
>
> 1. Write `bake.py` (Python, standard library only) that downloads the
>    published sheet CSV, converts rows into EXACTLY the JSON shape the
>    page currently receives from the web app — port the field whitelist,
>    `published` filtering, term-key derivation (e.g. `fall26` → code
>    `F26`, label), and any other transformations from
>    `apps-script/Code.gs` `doGet()` and its helpers — and injects the
>    result into `index.html` between two marker comments
>    (`<!-- BAKED-DATA-START -->` / `<!-- BAKED-DATA-END -->`) as
>    `const BAKED_DATA = {...};`.
> 2. Edit `index.html`: add those markers with the current data baked in,
>    and change the loading logic (around line 1442) to render from
>    `BAKED_DATA`, keeping `SAMPLE_DATA` only as a last-resort fallback if
>    `BAKED_DATA` is somehow absent. Remove the runtime fetch and the
>    "Sample data mode" status banner path for the baked case. Do NOT
>    change any rendering, filtering, or styling code.
> 3. `bake.py` must fail loudly (non-zero exit) without touching
>    `index.html` if the CSV download fails, is empty, or yields zero
>    published courses — never bake a bad payload.
> 4. Verify: run the bake, open the page, and confirm it renders the same
>    catalogue as the live version, with filters and course-details
>    expanders working. Tell me what you compared.
>
> The published CSV URL is: [PASTE URL HERE]

**Done when:** `python3 bake.py` refreshes the data inside `index.html`,
and the page renders correctly opened straight from disk (no network).

---

## Phase 3 — The GitHub Action

**Who:** Claude.

**Prompt:**

> Read GITHUB-ACTION-PLAN.md in this repo — we are doing Phase 3. Phase 2
> created `bake.py`, which refreshes the course data inside `index.html`.
> Create `.github/workflows/bake-catalogue.yml`: runs hourly on a schedule,
> supports manual workflow_dispatch, and also runs on pushes that change
> `bake.py`. It runs `python3 bake.py` and commits `index.html` back to
> `main` only if it actually changed (commit as the github-actions bot;
> ensure the workflow can't trigger itself in a loop). If `bake.py` exits
> non-zero, the workflow fails without committing. Also update SETUP.md:
> replace the web-app deployment instructions (§4, §5) and the cache notes
> with the new architecture — sheet edits reach the page via the hourly
> Action or the manual "Run workflow" button on GitHub, and the
> troubleshooting section should cover: how to check whether the last bake
> succeeded (Actions tab), and that a failing bake means the page is stale,
> not broken.

**Done when:** manual "Run workflow" completes green and commits (or
correctly skips committing when nothing changed).

---

## Phase 4 — Cutover test and retire the web app

**Who:** You (10 minutes).

1. Edit a course via the sidebar (ICS Catalogue → Add or edit course…) —
   e.g. append "TEST" to a title.
2. GitHub → Actions → *Bake catalogue* → **Run workflow**. Wait for green.
3. Confirm the change on the public GitHub Pages URL (private browser
   window). Revert the edit and re-run.
4. Confirm wherever the page is embedded (Google Sites iframe?) points at
   the GitHub Pages URL, not at an old copy.
5. Retire the web app: Apps Script editor → Deploy → Manage deployments →
   archive the web-app deployment. (Wait a week or two after cutover if
   you're cautious — nothing references it anymore, so archiving is safe
   whenever.) The onOpen menu / sidebar editor is unaffected: it's
   container-bound to the sheet, not part of the web-app deployment.

**Done when:** a sidebar edit reaches the public page through the Action,
and the hourly run shows up green in the Actions tab the next day.

---

## Rollback

Everything the Action does is a git commit — revert from github.com
(Commits → "..." → Revert) if a bake ever publishes something wrong. To
pause the pipeline: Actions tab → Bake catalogue → "..." → Disable
workflow; the page keeps serving the last-baked data indefinitely. Full
rollback to the live-fetch architecture is a single git revert of the
Phase 2 commit plus re-enabling the web-app deployment.

## Optional later enhancement

For maximum SEO the course content could be rendered into real HTML at
bake time instead of inline JSON rendered by JavaScript. Skipped for now:
it's a bigger change to a working page, and the catalogue's discoverability
matters less than its reliability. Ask Claude for
"server-side-render the catalogue at bake time" if it ever matters.
