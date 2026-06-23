/**
 * ICS Course Catalogue — Apps Script backend.
 *
 * Lives in a Google Sheet (container-bound). Exposes:
 *   - doGet()           → JSON of published courses for the public catalogue page
 *   - onOpen()          → adds an "ICS Catalogue" menu to the sheet
 *   - showSidebar()     → opens the editor form (no need to touch raw columns)
 *   - saveCourse()      → upsert from the sidebar form
 *   - listCourses()     → list rows for the edit-existing dropdown
 *   - getCourse()       → load one row into the form
 *   - deleteCourse()    → soft-delete by clearing the row
 *   - initializeSheet() → one-time: creates the "Courses" sheet with headers + validation
 *   - clearCache()      → forces the public page to re-fetch on next load
 *
 * See SETUP.md in the repo for deployment steps.
 */

const SHEET_NAME = "Courses";
const CACHE_KEY  = "catalogue-v1";
const CACHE_TTL  = 300; // seconds (5 min)

const HEADERS = [
  "id", "published", "sectionOrder",
  "title", "code", "termCode", "term", "termLabel",
  "programs", "programTagsDisplay", "credits",
  "instructorName", "instructorUrl",
  "subtitle", "descriptionShort", "descriptionMore",
  "tstCode", "format", "meetingDay", "meetingTime",
  "syllabusUrl", "requiredBooks",
  "prerequisites", "cstcArea", "certificateTags",
  "enrolmentNotes", "registrationEmail",
  "lastDateToRegister", "maxEnrolment",
  "updatedAt"
];

const PROGRAM_OPTIONS = [
  { id: "ma",    label: "MA" },
  { id: "mws",   label: "MWS" },
  { id: "mael",  label: "MA-EL" },
  { id: "mwse",  label: "MWS-E" },
  { id: "phd",   label: "PhD" },
  { id: "cilc",  label: "CILC" },
  { id: "csac",  label: "CSAC" },
  { id: "cstc",  label: "CSTC" },
  { id: "tcpce", label: "TCPCE" }
];

// Whitelist of fields exposed in the public JSON payload. Anything not listed
// here (e.g. future internal-only columns) is never served to the public page.
const PUBLIC_FIELDS = [
  "id", "published",
  "title", "code", "termCode", "term", "termLabel",
  "programs", "programTagsDisplay", "credits",
  "instructorName", "instructorUrl",
  "subtitle", "descriptionShort", "descriptionMore",
  "tstCode", "format", "meetingDay", "meetingTime",
  "syllabusUrl", "requiredBooks",
  "prerequisites", "cstcArea", "certificateTags",
  "enrolmentNotes", "registrationEmail",
  "lastDateToRegister", "maxEnrolment"
];

// ============================================================================
//  PUBLIC WEB APP
// ============================================================================

function doGet(e) {
  const cache = CacheService.getScriptCache();
  let json = cache.get(CACHE_KEY);
  if (!json) {
    json = JSON.stringify(buildPayload_());
    cache.put(CACHE_KEY, json, CACHE_TTL);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function buildPayload_() {
  const rows = readAllRows_();
  const courses = rows
    .map(normalizeCourseForPublic_)
    .filter(c => c.published === true);
  // expose the most recent updatedAt as the catalogue version
  let updated = "";
  for (const r of rows) {
    if (r.updatedAt && (!updated || String(r.updatedAt) > updated)) updated = String(r.updatedAt);
  }
  return {
    updated: updated ? updated.slice(0, 10) : "",
    courses
  };
}

function normalizeCourseForPublic_(row) {
  // Only copy whitelisted fields into the public payload — never leak
  // internal-only columns (e.g. updatedAt or any future private fields).
  const out = {};
  PUBLIC_FIELDS.forEach(h => { if (row[h] !== undefined) out[h] = row[h]; });
  // coerce published into a boolean
  out.published = (row.published === true || /^(true|yes|1)$/i.test(String(row.published || "").trim()));
  // serialize dates
  if (row.lastDateToRegister instanceof Date) {
    out.lastDateToRegister = Utilities.formatDate(row.lastDateToRegister, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return out;
}

// ============================================================================
//  MENU + SIDEBAR
// ============================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("ICS Catalogue")
    .addItem("Add or edit course…",         "showSidebar")
    .addSeparator()
    .addItem("Republish (clear cache)",     "clearCache")
    .addItem("Initialize / repair sheet…",  "initializeSheet")
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile("Sidebar")
    .setTitle("ICS Course Editor")
    .setWidth(360);
  SpreadsheetApp.getUi().showSidebar(html);
}

function clearCache() {
  CacheService.getScriptCache().remove(CACHE_KEY);
  SpreadsheetApp.getActive().toast("Cache cleared — public catalogue will refresh on next load.", "ICS Catalogue", 5);
}

// ============================================================================
//  SHEET BOOTSTRAP
// ============================================================================

function initializeSheet() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  // Write or update headers
  const currentHeaders = sheet.getLastColumn() > 0
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    : [];
  const needsHeaders = HEADERS.some((h, i) => currentHeaders[i] !== h);
  if (needsHeaders) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight("bold")
      .setBackground("#F0E9DD")
      .setFontColor("#7A0A1C");
  }

  // Apply data validation on the typed columns
  const dataRange = 999; // apply to a generous range so editors can paste in
  const colIndex = h => HEADERS.indexOf(h) + 1;

  applyDropdown_(sheet, colIndex("published"),    2, dataRange, ["TRUE", "FALSE"]);

  // Column widths for readable editing
  sheet.setColumnWidth(colIndex("id"), 90);
  sheet.setColumnWidth(colIndex("title"), 280);
  sheet.setColumnWidth(colIndex("descriptionShort"), 360);
  sheet.setColumnWidth(colIndex("descriptionMore"), 360);
  sheet.setColumnWidth(colIndex("requiredBooks"), 360);

  SpreadsheetApp.getActive().toast("Sheet initialized — open the menu and click 'Add or edit course…'", "ICS Catalogue", 6);
}

function applyDropdown_(sheet, col, fromRow, toRow, options) {
  if (col < 1) return;
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(options, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(fromRow, col, toRow - fromRow + 1, 1).setDataValidation(rule);
}

// ============================================================================
//  SIDEBAR CRUD
// ============================================================================

function getFormOptions() {
  return {
    programs: PROGRAM_OPTIONS
  };
}

function listCourses() {
  return readAllRows_().map(r => ({
    id: r.id,
    title: r.title,
    code: r.code,
    termCode: r.termCode,
    published: r.published === true || /^(true|yes|1)$/i.test(String(r.published || ""))
  })).filter(r => r.id);
}

function getCourse(id) {
  const sheet = sheet_();
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][HEADERS.indexOf("id")]) === String(id)) {
      return rowToObject_(rows[i]);
    }
  }
  return null;
}

function saveCourse(form) {
  const sheet = sheet_();
  const rows = sheet.getDataRange().getValues();
  const idCol = HEADERS.indexOf("id");

  // Coerce types & normalize before writing
  const clean = sanitizeForm_(form);
  clean.updatedAt = new Date().toISOString();

  // Find existing row by id
  if (clean.id) {
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][idCol]) === String(clean.id)) {
        const merged = mergeRow_(rows[i], clean);
        sheet.getRange(i + 1, 1, 1, HEADERS.length).setValues([merged]);
        clearCache();
        return { id: clean.id, action: "updated" };
      }
    }
  }

  // New row
  clean.id = clean.id || generateId_(clean.code, clean.termCode);
  const newRow = HEADERS.map(h => clean[h] !== undefined ? clean[h] : "");
  sheet.appendRow(newRow);
  clearCache();
  return { id: clean.id, action: "created" };
}

function deleteCourse(id) {
  const sheet = sheet_();
  const rows = sheet.getDataRange().getValues();
  const idCol = HEADERS.indexOf("id");
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idCol]) === String(id)) {
      sheet.deleteRow(i + 1);
      clearCache();
      return { id, action: "deleted" };
    }
  }
  throw new Error("Course not found: " + id);
}

// ============================================================================
//  HELPERS
// ============================================================================

function sheet_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error("Sheet '" + SHEET_NAME + "' not found. Run 'Initialize / repair sheet' from the menu.");
  return sheet;
}

function readAllRows_() {
  const sheet = sheet_();
  if (sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  return values
    .filter(row => row.some(v => v !== "" && v !== null))
    .map(rowToObject_);
}

function rowToObject_(row) {
  const obj = {};
  HEADERS.forEach((h, i) => { obj[h] = row[i]; });
  return obj;
}

function mergeRow_(existingRow, form) {
  // For each header, prefer form value if explicitly provided (including ""),
  // otherwise keep existing.
  return HEADERS.map((h, i) =>
    Object.prototype.hasOwnProperty.call(form, h) ? form[h] : existingRow[i]
  );
}

function sanitizeForm_(form) {
  const out = {};
  HEADERS.forEach(h => {
    if (form[h] !== undefined) out[h] = form[h];
  });
  // Normalize booleans
  if (out.published !== undefined) {
    out.published = (out.published === true || /^(true|yes|1)$/i.test(String(out.published).trim())) ? true : false;
  }
  // Trim programs token list, lowercase
  if (typeof out.programs === "string") {
    out.programs = out.programs.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean).join(" ");
  } else if (Array.isArray(out.programs)) {
    out.programs = out.programs.map(s => String(s).toLowerCase()).join(" ");
  }
  // Coerce numbers
  if (out.sectionOrder !== undefined && out.sectionOrder !== "") out.sectionOrder = Number(out.sectionOrder);
  if (out.maxEnrolment !== undefined && out.maxEnrolment !== "") out.maxEnrolment = Number(out.maxEnrolment);
  return out;
}

function generateId_(code, termCode) {
  const base = [code, termCode].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (base) return base + "-" + Math.random().toString(36).slice(2, 7);
  return Utilities.getUuid().slice(0, 8);
}
