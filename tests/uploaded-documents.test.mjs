// Unit tests for the household-sharing logic in get-uploaded-documents.js.
// Run with:  node tests/uploaded-documents.test.mjs
//
// Must stay outside netlify/functions/ — see the note in payments.test.mjs.
//
// These cover the pure parts only: who counts as the audience for an
// enrolment, which submissions survive the filter, and who each document is
// attributed to. The HubSpot/Jotform I/O needs live credentials and is
// exercised against the deployed endpoint.

import assert from "node:assert/strict";
import {
  buildAudience,
  documentsFromSubmission
} from "../netlify/functions/get-uploaded-documents.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// --- fixtures ---------------------------------------------------------------

const STUDENT = { id: "1", email: "mia@example.com",  name: "Mia Reynolds",  label: "Student" };
const PARENT  = { id: "2", email: "dad@example.com",  name: "Peter Reynolds", label: "Parent" };
const PARENT2 = { id: "3", email: "mum@example.com",  name: "Anna Reynolds",  label: "Parent" };

// A submission shaped like the free-form document-upload form: an email
// field, a "Document Name" textbox, then a generic file upload.
function submission({ emails = [], docName = null, upload = null, label = "Upload", created = "2026-03-01 10:00:00" } = {}) {
  const answers = {};
  let order = 1;
  for (const e of emails) {
    answers[String(order)] = { type: "control_email", text: "Email", order: String(order), answer: e };
    order++;
  }
  if (docName) {
    answers[String(order)] = { type: "control_textbox", text: "Document Name", order: String(order), answer: docName };
    order++;
  }
  if (upload) {
    answers[String(order)] = { type: "control_fileupload", text: label, order: String(order), answer: upload };
  }
  return { id: "sub", created_at: created, answers };
}

const FILE = "https://www.jotform.com/uploads/pd/1/2/passport.pdf";

// --- buildAudience ----------------------------------------------------------

test("the logged-in user is always in the audience, even with no contacts", () => {
  const audience = buildAudience("MIA@Example.com ", []);
  assert.equal(audience.size, 1);
  assert.ok(audience.has("mia@example.com"), "email is lower-cased and trimmed");
  assert.equal(audience.get("mia@example.com").isSelf, true);
});

test("every contact on the deal joins the audience", () => {
  const audience = buildAudience("mia@example.com", [STUDENT, PARENT, PARENT2]);
  assert.deepEqual([...audience.keys()].sort(),
    ["dad@example.com", "mia@example.com", "mum@example.com"]);
  assert.equal(audience.get("dad@example.com").isSelf, false);
  assert.equal(audience.get("dad@example.com").name, "Peter Reynolds");
  assert.equal(audience.get("dad@example.com").label, "Parent");
});

test("the viewer is flagged isSelf even when HubSpot also returned them", () => {
  const audience = buildAudience("mia@example.com", [STUDENT, PARENT]);
  assert.equal(audience.get("mia@example.com").isSelf, true);
  assert.equal(audience.get("mia@example.com").name, "Mia Reynolds");
});

test("contacts with no email are skipped rather than matching everything", () => {
  const audience = buildAudience("mia@example.com", [{ id: "9", email: "", name: "No Email" }]);
  assert.equal(audience.size, 1);
  assert.ok(!audience.has(""));
});

// --- documentsFromSubmission: the bug this change fixes ---------------------

test("a student sees a document their parent uploaded", () => {
  const audience = buildAudience("mia@example.com", [STUDENT, PARENT]);
  const docs = documentsFromSubmission(
    submission({ emails: ["dad@example.com"], docName: "Consent letter", upload: [FILE] }),
    audience
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].fieldLabel, "Consent letter");
  assert.equal(docs[0].uploadedByName, "Peter Reynolds");
  assert.equal(docs[0].uploadedByLabel, "Parent");
  assert.equal(docs[0].uploadedByMe, false);
});

test("a parent sees a document their child uploaded", () => {
  const audience = buildAudience("dad@example.com", [STUDENT, PARENT]);
  const docs = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], docName: "Passport", upload: [FILE] }),
    audience
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].uploadedByName, "Mia Reynolds");
  assert.equal(docs[0].uploadedByMe, false);
});

test("your own uploads are marked as yours", () => {
  const audience = buildAudience("mia@example.com", [STUDENT, PARENT]);
  const docs = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], docName: "Passport", upload: [FILE] }),
    audience
  );
  assert.equal(docs[0].uploadedByMe, true);
});

test("a second parent on the same deal is included", () => {
  const audience = buildAudience("mia@example.com", [STUDENT, PARENT, PARENT2]);
  const docs = documentsFromSubmission(
    submission({ emails: ["mum@example.com"], docName: "Insurance", upload: [FILE] }),
    audience
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].uploadedByName, "Anna Reynolds");
});

// --- documentsFromSubmission: what must NOT leak ----------------------------

test("a submission from outside the enrolment is still excluded", () => {
  const audience = buildAudience("mia@example.com", [STUDENT, PARENT]);
  const docs = documentsFromSubmission(
    submission({ emails: ["someone.else@example.com"], docName: "Passport", upload: [FILE] }),
    audience
  );
  assert.equal(docs.length, 0, "pooling is per-enrolment, not global");
});

test("a submission with no email at all is excluded", () => {
  const audience = buildAudience("mia@example.com", [STUDENT, PARENT]);
  const docs = documentsFromSubmission(
    submission({ emails: [], docName: "Passport", upload: [FILE] }),
    audience
  );
  assert.equal(docs.length, 0);
});

test("no email address is ever returned to the browser", () => {
  const audience = buildAudience("mia@example.com", [STUDENT, PARENT]);
  const [doc] = documentsFromSubmission(
    submission({ emails: ["dad@example.com"], docName: "Passport", upload: [FILE] }),
    audience
  );
  assert.ok(!JSON.stringify(doc).includes("@"), "cards carry names, not addresses");
});

test("submission ids are still not exposed", () => {
  const audience = buildAudience("mia@example.com", [STUDENT]);
  const [doc] = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], docName: "Passport", upload: [FILE] }),
    audience
  );
  assert.equal(doc.id, undefined);
  assert.equal(doc.submissionId, undefined);
});

// --- multi-email forms ------------------------------------------------------

test("a form carrying both parent and student emails matches on either", () => {
  // The old code kept only the LAST email field, so a form that asked for the
  // student's email after the parent's attributed the upload to the student.
  const audience = buildAudience("dad@example.com", [PARENT]);
  const docs = documentsFromSubmission(
    submission({ emails: ["dad@example.com", "mia@example.com"], docName: "Passport", upload: [FILE] }),
    audience
  );
  assert.equal(docs.length, 1, "the parent's own submission must not be filtered out");
  assert.equal(docs[0].uploadedByMe, true);
});

test("the first matching email is the one credited", () => {
  const audience = buildAudience("mia@example.com", [STUDENT, PARENT]);
  const docs = documentsFromSubmission(
    submission({ emails: ["dad@example.com", "mia@example.com"], docName: "Passport", upload: [FILE] }),
    audience
  );
  assert.equal(docs[0].uploadedByName, "Peter Reynolds",
    "the form asks the submitter for their own address first");
});

// --- existing behaviour must survive the refactor ---------------------------

test("a specific upload-field label is kept as the heading", () => {
  const audience = buildAudience("mia@example.com", [STUDENT]);
  const docs = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], upload: [FILE], label: "Passport" }),
    audience
  );
  assert.equal(docs[0].fieldLabel, "Passport");
});

test("a generic label with nothing typed leaves the heading off", () => {
  const audience = buildAudience("mia@example.com", [STUDENT]);
  const docs = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], upload: [FILE], label: "Additional File Upload" }),
    audience
  );
  assert.equal(docs[0].fieldLabel, null);
});

test("multiple files in one upload field each become a document", () => {
  const audience = buildAudience("mia@example.com", [STUDENT]);
  const docs = documentsFromSubmission(
    submission({
      emails: ["mia@example.com"],
      docName: "Visa docs",
      upload: [FILE, "https://www.jotform.com/uploads/pd/1/2/visa%20letter.pdf"]
    }),
    audience
  );
  assert.equal(docs.length, 2);
  assert.equal(docs[0].filename, "passport.pdf");
  assert.equal(docs[1].filename, "visa letter.pdf", "filenames stay URL-decoded");
});

test("a submission with no files contributes nothing", () => {
  const audience = buildAudience("mia@example.com", [STUDENT]);
  const docs = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], docName: "Passport" }),
    audience
  );
  assert.equal(docs.length, 0);
});

test("the upload date is carried through for the card", () => {
  const audience = buildAudience("mia@example.com", [STUDENT]);
  const [doc] = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], upload: [FILE], created: "2026-02-14 09:30:00" }),
    audience
  );
  assert.equal(doc.uploadedAt, "2026-02-14 09:30:00");
});

if (!process.exitCode) console.log(`uploaded-documents.test.mjs — ${passed} passed`);
