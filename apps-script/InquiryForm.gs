/**
 * ICS Course Catalogue — Registration Inquiry Form
 * One-time setup for the Google Form behind the catalogue's inquiry popout,
 * plus the email notification sent on every submission.
 *
 * HOW TO USE
 * 1. Go to https://script.new — a NEW standalone Apps Script project.
 *    (Don't paste this into the catalogue sheet's script project: that one
 *    deliberately runs with narrow permissions, and this needs Forms, Drive,
 *    Sheets, and Mail access.)
 * 2. Paste this whole file over the default Code.gs and save.
 * 3. In the toolbar, pick `createInquiryForm` in the function dropdown and
 *    click Run. Approve the permission prompts (Advanced → Go to … (unsafe)
 *    if Google shows the unverified-app warning — the script is private to
 *    your account).
 * 4. Open the Execution log. It prints a filled-in INQUIRY_FORM constant —
 *    paste it over the empty `const INQUIRY_FORM = {…}` near the top of the
 *    <script> block in index.html, commit, and push. The popout option
 *    appears on the course cards as soon as that config is non-empty.
 * 5. Done. Submissions land in the "ICS Course Registration Inquiry
 *    (Responses)" spreadsheet in your Drive, and each one is emailed to
 *    INQUIRY_NOTIFY_EMAIL with the inquirer set as Reply-To.
 *
 * Run createInquiryForm ONCE. Running it again creates a second, separate
 * form (with new entry ids), which is only useful if you want to start over.
 */

const INQUIRY_NOTIFY_EMAIL = 'academic-registrar@icscanada.edu';
const INQUIRY_FORM_TITLE = 'ICS Course Registration Inquiry';

// Item titles — onInquirySubmit looks answers up by these, so if you rename
// a question in the Form editor later, rename it here too.
const INQUIRY_ITEMS = {
  course: 'Course',
  first: 'First Name',
  last: 'Last Name',
  email: 'Email',
  questions: 'Questions or comments (optional)'
};

/** One-time setup: creates the form + response sheet + notification trigger,
 *  then logs the INQUIRY_FORM snippet to paste into index.html. */
function createInquiryForm() {
  const form = FormApp.create(INQUIRY_FORM_TITLE);
  form.setDescription(
    'Receives registration inquiries from the ICS course catalogue page. ' +
    'Each submission starts the registration process; the Registrar follows up with next steps. ' +
    'Responses arrive via the popout form on the catalogue — this form itself is not shared publicly.'
  );
  form.setCollectEmail(false);            // the form has its own Email question
  form.setLimitOneResponsePerUser(false); // must stay false — requiring sign-in would break the popout
  form.setShowLinkToRespondAgain(false);
  // Workspace accounts default new forms to "Restrict to users in <domain>",
  // which bounces anonymous visitors to a Google login — and the popout's
  // no-cors POST would then silently record nothing. Open it up.
  try { form.setRequireLogin(false); } catch (err) {
    // Consumer accounts don't have (or need) this setting.
  }

  const courseItem = form.addTextItem()
      .setTitle(INQUIRY_ITEMS.course)
      .setRequired(true)
      .setHelpText('Filled in automatically by the catalogue page.');
  const firstItem = form.addTextItem().setTitle(INQUIRY_ITEMS.first).setRequired(true);
  const lastItem = form.addTextItem().setTitle(INQUIRY_ITEMS.last).setRequired(true);
  const emailItem = form.addTextItem().setTitle(INQUIRY_ITEMS.email).setRequired(true);
  emailItem.setValidation(
    FormApp.createTextValidation()
      .setHelpText('Please enter a valid email address.')
      .requireTextIsEmail()
      .build()
  );
  const questionsItem = form.addParagraphTextItem()
      .setTitle(INQUIRY_ITEMS.questions)
      .setRequired(false);

  // Collect responses in a spreadsheet
  const ss = SpreadsheetApp.create(INQUIRY_FORM_TITLE + ' (Responses)');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // Email the registrar on every submission
  ScriptApp.newTrigger('onInquirySubmit').forForm(form).onFormSubmit().create();

  // The static page posts to entry.<N> field ids, which FormApp doesn't
  // expose directly — but a prefilled URL contains them. Build one with
  // sentinel answers and read the ids back out.
  const sentinels = {
    course: 'SENTINELCOURSE',
    first: 'SENTINELFIRST',
    last: 'SENTINELLAST',
    email: 'sentinel@example.com',
    questions: 'SENTINELQUESTIONS'
  };
  const prefilled = decodeURIComponent(
    form.createResponse()
      .withItemResponse(courseItem.createResponse(sentinels.course))
      .withItemResponse(firstItem.createResponse(sentinels.first))
      .withItemResponse(lastItem.createResponse(sentinels.last))
      .withItemResponse(emailItem.createResponse(sentinels.email))
      .withItemResponse(questionsItem.createResponse(sentinels.questions))
      .toPrefilledUrl()
  );
  const idFor = function (sentinel) {
    const m = prefilled.match(new RegExp('entry\\.(\\d+)=' + sentinel.replace('@', '.')));
    if (!m) throw new Error('Could not find the entry id for "' + sentinel + '" in: ' + prefilled);
    return 'entry.' + m[1];
  };

  const action = form.getPublishedUrl().replace(/viewform.*$/, 'formResponse');

  Logger.log(
    '\n──────────────────────────────────────────────────────────\n' +
    'Form created. Paste this over the empty INQUIRY_FORM constant\n' +
    'in index.html (near the top of the <script> block):\n\n' +
    'const INQUIRY_FORM = {\n' +
    '  action: "' + action + '",\n' +
    '  fields: {\n' +
    '    course:    "' + idFor(sentinels.course) + '",\n' +
    '    first:     "' + idFor(sentinels.first) + '",\n' +
    '    last:      "' + idFor(sentinels.last) + '",\n' +
    '    email:     "' + idFor(sentinels.email) + '",\n' +
    '    questions: "' + idFor(sentinels.questions) + '"\n' +
    '  }\n' +
    '};\n' +
    '──────────────────────────────────────────────────────────\n' +
    'Edit the form:          ' + form.getEditUrl() + '\n' +
    'Responses spreadsheet:  ' + ss.getUrl() + '\n' +
    'Notifications go to:    ' + INQUIRY_NOTIFY_EMAIL
  );
}

/** One-off repair for a form created before setRequireLogin(false) was added
 *  to createInquiryForm: lifts the "Restrict to users in <domain>" setting so
 *  anonymous catalogue visitors can submit. Run once; entry ids are unchanged. */
function makeInquiryFormPublic() {
  const FORM_ID = '1AkvWXZlM_Puje4K25J477RBE3RfFjbM3rAwyH9xjBDI';
  const form = FormApp.openById(FORM_ID);
  form.setRequireLogin(false);
  Logger.log('Done — the form no longer requires sign-in: ' + form.getPublishedUrl());
}

/** Trigger: emails the registrar for each submission, Reply-To the inquirer. */
function onInquirySubmit(e) {
  const answers = {};
  e.response.getItemResponses().forEach(function (ir) {
    answers[ir.getItem().getTitle()] = ir.getResponse();
  });

  const course = String(answers[INQUIRY_ITEMS.course] || '(course not given)').trim();
  const name = [answers[INQUIRY_ITEMS.first], answers[INQUIRY_ITEMS.last]]
    .map(function (s) { return String(s || '').trim(); })
    .filter(Boolean).join(' ');
  const email = String(answers[INQUIRY_ITEMS.email] || '').trim();
  const questions = String(answers[INQUIRY_ITEMS.questions] || '').trim();

  const mailOptions = {
    to: INQUIRY_NOTIFY_EMAIL,
    subject: 'Course registration inquiry — ' + course,
    body: [
      'A new registration inquiry arrived from the course catalogue:',
      '',
      'Course:    ' + course,
      'Name:      ' + (name || '(not given)'),
      'Email:     ' + (email || '(not given)'),
      'Questions: ' + (questions || '(none)'),
      '',
      'Reply to this email to reach the inquirer directly.'
    ].join('\n')
  };
  if (email) mailOptions.replyTo = email;
  MailApp.sendEmail(mailOptions);
}
