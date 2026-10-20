/**
 * ICS Course Submission — instructor-facing form (standalone Apps Script project).
 *
 * Serves Form.html as a web app that instructors fill in themselves. Each
 * submission is validated here, appended to the catalogue sheet's "Courses"
 * tab as an UNPUBLISHED course, and emailed to the Registrar, who checks it,
 * fills in the registrar-only fields in the Course Editor, and publishes it.
 *
 * Deliberately separate from the catalogue sheet's own project (Code.gs one
 * folder up), which runs with narrow permissions and already owns the doGet()
 * that bake.py reads. This project needs wider ones: open the sheet by id,
 * send mail, and fetch faculty.icscanada.edu for the instructor list.
 *
 * Setup: SETUP.md §11. Deploy as a web app — Execute as: Me, Who has access:
 * anyone within ICS — then embed the /exec URL in the private Google Site.
 */

const CATALOGUE_SHEET_ID = "1s4ynrR9GklFt0i5OvngqyonJIJ5QLgouP9eCkaojbjU";
const SHEET_NAME = "Courses";
const NOTIFY_EMAIL = "academic-registrar@icscanada.edu";
const ALLOWED_DOMAIN = "icscanada.edu";
const DEFAULT_REGISTRATION_EMAIL = "academic-registrar@icscanada.edu";

// Faculty directory pages, in the order their groups appear in the dropdown.
const FACULTY_BASE = "https://faculty.icscanada.edu/";
const FACULTY_PAGES = [
  { path: "",                   group: "ICS Faculty" },
  { path: "adjunct/",           group: "Adjunct Faculty" },
  { path: "sessional-faculty/", group: "Sessional Faculty" },
  { path: "emeriti/",           group: "Emeritus Faculty" }
];
const FACULTY_CACHE_KEY = "faculty-v1";
const FACULTY_CACHE_TTL = 6 * 60 * 60; // 6 hours (the CacheService maximum)

// Keep in step with PROGRAM_OPTIONS in ../Code.gs and PROGRAM_LABELS in index.html.
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

const FORMAT_OPTIONS = [
  "Online Synchronous",
  "Online Asynchronous",
  "Blended (Online Asynchronous/Synchronous)",
  "Online Intensive",
  "In Person",
  "In Person and Online"
];

const SEASONS = [
  { id: "fall",   label: "Fall (September – December)" },
  { id: "winter", label: "Winter (January – April)" },
  { id: "summer", label: "Summer (May – August)" }
];

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CSTC_AREAS = ["1", "2", "3", "4"];

// ============================================================================
//  WEB APP
// ============================================================================

function doGet() {
  return HtmlService.createHtmlOutputFromFile("Form")
    .setTitle("Submit a Course — ICS")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    // Required for embedding in Google Sites.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Everything the form needs to build its dropdowns and checkboxes. */
function getFormData() {
  const user = requireIcsUser_();
  return {
    user,
    faculty: getFaculty_().map(f => ({ key: f.url, name: f.name, siteName: f.siteName, group: f.group })),
    programs: PROGRAM_OPTIONS,
    formats: FORMAT_OPTIONS,
    seasons: SEASONS,
    years: termYears_(),
    weekdays: WEEKDAYS,
    times: timeOptions_(),
    cstcAreas: CSTC_AREAS
  };
}

/** Validate, append to the catalogue sheet as a draft, and notify the Registrar. */
function submitCourse(form) {
  const user = requireIcsUser_();
  const course = validate_(form || {});
  course.id = generateId_(course);
  course.published = false;
  course.registrationEmail = DEFAULT_REGISTRATION_EMAIL;
  course.updatedAt = new Date().toISOString();

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = SpreadsheetApp.openById(CATALOGUE_SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error("The catalogue sheet has no '" + SHEET_NAME + "' tab.");
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
    // Write through "@" (plain text) so Sheets doesn't turn values like the
    // term or updatedAt into dates — see serializeForClient_ in ../Code.gs.
    const row = headers.map(h => course[h] !== undefined ? course[h] : "");
    const r = sheet.getLastRow() + 1;
    const range = sheet.getRange(r, 1, 1, headers.length);
    range.setNumberFormat("@");
    // …except `published`: in a text cell the boolean lands as the string
    // "false", which the column's TRUE/FALSE validation rejects — failing
    // the whole write. Kept as a real boolean it reads FALSE and passes.
    const pub = headers.indexOf("published");
    if (pub >= 0) sheet.getRange(r, pub + 1).setNumberFormat("General");
    range.setValues([row]);
    course.rowNumber = r;
  } finally {
    lock.releaseLock();
  }

  notifyRegistrar_(course, user);
  return { id: course.id, title: course.title, term: termLabel_(course.term) };
}

// ============================================================================
//  FACULTY DIRECTORY
// ============================================================================

/**
 * The instructor dropdown: every living person listed on faculty.icscanada.edu,
 * with their profile URL. Display names follow the catalogue's existing
 * convention — the name already used in the sheet for that profile URL (e.g.
 * "Dr. Ron Kuipers"), else "Dr. <name>" for doctorates, else the plain name.
 * Cached for 6 hours; if the site can't be read, the last good list (kept in
 * script properties) is used so the form never loses its dropdown.
 */
function getFaculty_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(FACULTY_CACHE_KEY);
  if (hit) return JSON.parse(hit);

  const props = PropertiesService.getScriptProperties();
  let list;
  try {
    list = fetchFaculty_();
    if (!list.length) throw new Error("no faculty entries found");
    props.setProperty(FACULTY_CACHE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("Faculty fetch failed, using last good list: " + err);
    list = JSON.parse(props.getProperty(FACULTY_CACHE_KEY) || "[]");
  }
  cache.put(FACULTY_CACHE_KEY, JSON.stringify(list), FACULTY_CACHE_TTL);
  return list;
}

function fetchFaculty_() {
  const knownNames = sheetInstructorNamesByUrl_();
  const seen = {};
  const out = [];
  FACULTY_PAGES.forEach(page => {
    const pageUrl = FACULTY_BASE + page.path;
    const html = UrlFetchApp.fetch(pageUrl, { muteHttpExceptions: true }).getContentText();
    // The home page also lists cross-appointed faculty under their own heading.
    const crossAt = html.indexOf('id="cross-appointed"');
    html.split('<article class="entry"').slice(1).forEach(chunk => {
      const offset = html.indexOf(chunk);
      const group = crossAt >= 0 && offset > crossAt ? "Cross-Appointed (King's University)" : page.group;
      const nameMatch = chunk.match(/class="entry__name"[^>]*>([\s\S]*?)<\/h\d>/);
      if (!nameMatch) return;
      if (/deceased|†/.test(nameMatch[1])) return;
      const name = decodeEntities_(nameMatch[1].replace(/<span[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, "")).trim();
      const moreMatch = chunk.match(/class="entry__more"[^>]*href="([^"]+)"/) ||
                        chunk.match(/href="([^"]+)"[^>]*class="entry__more"/) ||
                        nameMatch[1].match(/href="([^"]+)"/);
      if (!name || !moreMatch) return;
      const url = resolveUrl_(pageUrl, moreMatch[1]);
      if (seen[url]) return;
      seen[url] = true;
      const degrees = (chunk.match(/class="entry__degrees"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "";
      const display = knownNames[url] ||
        (/\b(PhD|DPhil|ThD|EdD|DMin|DTh)\b/.test(degrees) ? "Dr. " + name : name);
      out.push({ url, name: display, siteName: name, group });
    });
  });
  return out;
}

/** Map normalized profile URL → instructorName already used in the sheet. */
function sheetInstructorNamesByUrl_() {
  const map = {};
  try {
    const sheet = SpreadsheetApp.openById(CATALOGUE_SHEET_ID).getSheetByName(SHEET_NAME);
    const values = sheet.getDataRange().getDisplayValues();
    const h = values[0];
    const nameCol = h.indexOf("instructorName"), urlCol = h.indexOf("instructorUrl");
    values.slice(1).forEach(r => {
      const url = normalizeUrl_(r[urlCol]);
      const name = String(r[nameCol] || "").trim();
      // Skip co-taught rows ("A and B") — they don't name one person.
      if (url && name && !/\band\b|&/.test(name)) map[url] = name;
    });
  } catch (err) {
    console.warn("Could not read existing instructor names: " + err);
  }
  return map;
}

function resolveUrl_(base, href) {
  if (/^https?:\/\//i.test(href)) return normalizeUrl_(href);
  let path = base.replace(/[^/]*$/, "") + href;
  while (/\/[^/]+\/\.\.\//.test(path)) path = path.replace(/\/[^/]+\/\.\.\//, "/");
  return normalizeUrl_(path);
}

// Catalogue URLs are stored without a trailing slash (faculty.icscanada.edu/nansell).
function normalizeUrl_(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function decodeEntities_(s) {
  return s.replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&#8217;/g, "’").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
}

/**
 * Match a typed-in name against the directory: exact (ignoring titles and
 * punctuation), else same surname + same first initial ("Ron Kuipers" →
 * "Ronald A. Kuipers"). Returns the faculty entry or null.
 */
function matchFaculty_(typed, faculty) {
  const norm = s => String(s).toLowerCase()
    .replace(/\b(dr|prof|professor|rev|mr|mrs|ms)\b\.?/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-zÀ-ɏ\s-]/g, " ")
    .split(/\s+/).filter(Boolean);
  const t = norm(typed);
  if (!t.length) return null;
  const key = t.join(" ");
  const exact = faculty.find(f => norm(f.siteName || f.name).join(" ") === key || norm(f.name).join(" ") === key);
  if (exact) return exact;
  const last = t[t.length - 1], initial = t[0][0];
  const loose = faculty.filter(f => {
    const n = norm(f.siteName || f.name);
    return n[n.length - 1] === last && n[0][0] === initial;
  });
  return loose.length === 1 ? loose[0] : null;
}

// ============================================================================
//  VALIDATION — nothing reaches the sheet that the form's controls don't allow
// ============================================================================

function validate_(f) {
  const errors = [];
  const text = (v, max) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").trim().slice(0, max);
  const oneLine = (v, max) => text(v, max).replace(/\s*\n\s*/g, " ");
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  const faculty = getFaculty_();
  const resolveInstructor = (inst, label, required) => {
    inst = inst || {};
    if (inst.key) {
      const hit = faculty.find(x => x.url === inst.key);
      need(hit, label + ": please choose a name from the list.");
      return hit ? { name: hit.name, url: hit.url } : null;
    }
    const typed = oneLine(inst.custom, 100);
    if (!typed) { need(!required, label + " is required."); return null; }
    need(!/https?:|www\.|@/.test(typed), label + ": enter a name only.");
    const hit = matchFaculty_(typed, faculty);
    return hit ? { name: hit.name, url: hit.url } : { name: typed, url: "" };
  };

  const c = {};
  const lead = resolveInstructor(f.instructor, "Instructor", true);
  const co = resolveInstructor(f.coInstructor, "Co-instructor", false);
  if (lead) {
    c.instructorName = co && co.name !== lead.name ? lead.name + " and " + co.name : lead.name;
    c.instructorUrl = lead.url;
  }

  c.title = oneLine(f.title, 200);
  need(c.title.length >= 3, "Course title is required.");
  c.subtitle = oneLine(f.subtitle, 120);
  c.code = oneLine(f.code, 40);

  const season = SEASONS.some(s => s.id === f.season) ? f.season : "";
  const year = termYears_().indexOf(Number(f.year)) >= 0 ? Number(f.year) : 0;
  need(season, "Choose a term.");
  need(year, "Choose a year.");
  c.term = season && year ? season + String(year).slice(-2) : "";

  const progIds = PROGRAM_OPTIONS.map(p => p.id);
  const programs = (Array.isArray(f.programs) ? f.programs : []).filter(p => progIds.indexOf(p) >= 0);
  need(programs.length, "Tick at least one program.");
  c.programs = progIds.filter(p => programs.indexOf(p) >= 0).join(" ");

  c.descriptionShort = text(f.description, 5000);
  need(c.descriptionShort.length >= 40, "Please write a course description (at least a sentence or two).");
  need((c.descriptionShort.match(/\*/g) || []).length % 2 === 0, "The description has an unmatched * (italics need one before and one after).");
  c.descriptionMore = "";

  c.format = FORMAT_OPTIONS.indexOf(f.format) >= 0 ? f.format : "";
  need(c.format, "Choose a format.");

  const times = timeOptions_().map(t => t.value);
  if (f.schedule === "weekly") {
    const days = WEEKDAYS.filter(d => (f.days || []).indexOf(d) >= 0);
    const si = times.indexOf(f.startTime), ei = times.indexOf(f.endTime);
    need(days.length, "Tick the day(s) the class meets.");
    need(si >= 0 && ei >= 0, "Choose a start and end time.");
    need(si < 0 || ei < 0 || ei > si, "The end time must be after the start time.");
    c.meetingDay = joinList_(days.map(d => d + "s"));
    if (si >= 0 && ei > si) c.meetingTime = times[si] + " – " + times[ei] + " ET";
  } else if (f.schedule === "dates") {
    c.meetingDay = oneLine(f.scheduleDates, 1500);
    need(c.meetingDay, "List the class dates and times.");
    c.meetingTime = "";
  } else if (f.schedule === "none") {
    c.meetingDay = ""; c.meetingTime = "";
  } else {
    need(false, "Choose how the class meets.");
  }

  c.syllabusUrl = oneLine(f.syllabusUrl, 500);
  need(!c.syllabusUrl || /^https:\/\/\S+$/.test(c.syllabusUrl), "The syllabus link must start with https://");
  c.requiredBooks = text(f.requiredBooks, 4000).split("\n").map(s => s.trim()).filter(Boolean).join("\n");
  c.prerequisites = oneLine(f.prerequisites, 300);
  c.tstCode = oneLine(f.tstCode, 60);

  const areas = programs.indexOf("cstc") >= 0 ? CSTC_AREAS.filter(a => (f.cstcAreas || []).indexOf(a) >= 0) : [];
  c.cstcArea = areas.length ? (areas.length === 1 ? "Area " : "Areas ") + joinList_(areas) : "";

  c.notesForRegistrar = text(f.notes, 2000); // email only — not a sheet column

  if (errors.length) throw new Error(errors.join("\n"));
  return c;
}

function joinList_(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

function termYears_() {
  const y = new Date().getFullYear();
  return [y, y + 1, y + 2];
}

// 7:00am – 10:00pm in half hours, labelled like the catalogue ("6:30pm").
function timeOptions_() {
  const out = [];
  for (let m = 7 * 60; m <= 22 * 60; m += 30) {
    const h = Math.floor(m / 60), mm = m % 60;
    const label = ((h + 11) % 12 + 1) + ":" + (mm ? "30" : "00") + (h < 12 ? "am" : "pm");
    out.push({ value: label, label });
  }
  return out;
}

function termLabel_(term) {
  const m = String(term).match(/^(fall|winter|summer)(\d{2})$/);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) + " 20" + m[2] : term;
}

// Same shape as generateId_ in ../Code.gs, falling back to a title slug when
// the instructor doesn't know the course code.
function generateId_(c) {
  const base = (c.code ? [c.code, c.term] : [c.title.slice(0, 30), c.term])
    .filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return base + "-" + Math.random().toString(36).slice(2, 7);
}

// ============================================================================
//  ACCESS + NOTIFICATION
// ============================================================================

// The deployment already limits access to ICS accounts; this is the backstop.
function requireIcsUser_() {
  const email = String(Session.getActiveUser().getEmail() || "").toLowerCase();
  if (!email.endsWith("@" + ALLOWED_DOMAIN)) {
    throw new Error("Please sign in with your @" + ALLOWED_DOMAIN + " Google account to use this form.");
  }
  return email;
}

function notifyRegistrar_(c, submitter) {
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  const programLabels = c.programs.split(" ").filter(Boolean)
    .map(id => (PROGRAM_OPTIONS.find(p => p.id === id) || {}).label || id).join(", ");

  const rows = [
    ["Instructor", c.instructorName + (c.instructorUrl ? "" : "  (not matched to a faculty profile — no link)")],
    ["Title", c.title],
    ["Subtitle", c.subtitle],
    ["Course code", c.code],
    ["Term", termLabel_(c.term)],
    ["Programs", programLabels],
    ["CSTC area", c.cstcArea],
    ["Format", c.format],
    ["Schedule", [c.meetingDay, c.meetingTime].filter(Boolean).join(" · ")],
    ["Syllabus", c.syllabusUrl],
    ["Prerequisites", c.prerequisites],
    ["TST code", c.tstCode],
    ["Required books", c.requiredBooks],
    ["Description", c.descriptionShort]
  ];
  const stillNeeded = [
    !c.code && "Course code",
    "Enrolment notes (deadline and class limit, as students should read them)",
    "Last date to register",
    "Max enrolment",
    "Credits",
    !c.instructorUrl && "Instructor bio link (the name didn't match anyone on faculty.icscanada.edu)",
    "Tick Published when everything is confirmed"
  ].filter(Boolean);

  const sheetUrl = "https://docs.google.com/spreadsheets/d/" + CATALOGUE_SHEET_ID + "/edit";
  const td = "padding:6px 10px;border-bottom:1px solid #eee;vertical-align:top;";
  const body =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2E1318;max-width:640px">' +
    "<p><strong>" + esc(submitter) + "</strong> submitted a course for the catalogue. " +
    "It has been added to the sheet as an <strong>unpublished draft</strong>. It won't appear on courses.icscanada.edu until you publish it.</p>" +
    (c.notesForRegistrar ? '<p style="background:#F9F5ED;border-left:3px solid #A85A32;padding:8px 12px"><strong>Note from the instructor:</strong><br>' + esc(c.notesForRegistrar) + "</p>" : "") +
    '<table style="border-collapse:collapse;width:100%">' +
    rows.filter(r => r[1]).map(r =>
      '<tr><td style="' + td + 'font-weight:bold;white-space:nowrap;color:#7A0A1C">' + esc(r[0]) + '</td><td style="' + td + '">' + esc(r[1]) + "</td></tr>").join("") +
    "</table>" +
    "<p><strong>Still needed from you:</strong></p><ul>" + stillNeeded.map(s => "<li>" + esc(s) + "</li>").join("") + "</ul>" +
    '<p><a href="' + sheetUrl + '">Open the catalogue sheet</a>, then <strong>ICS Catalogue → Add or edit course…</strong> and choose ' +
    "<em>" + esc(c.title) + " · " + esc(c.term) + " [draft]</em> (row " + c.rowNumber + ").</p>" +
    '<p style="color:#857E78;font-size:12px">Reply to this email to reach the instructor.</p></div>';

  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    replyTo: submitter,
    subject: "New course submission: " + c.title + " (" + termLabel_(c.term) + ")",
    htmlBody: body,
    name: "ICS Course Submissions"
  });
}
