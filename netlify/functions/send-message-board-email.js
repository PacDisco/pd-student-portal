// Webhook receiver: HubSpot calls this when a Portal record's
// message_board_posted_at changes. We email the new message-board post
// out to every contact associated with that portal *whose association
// label is Instructor, Parent, or Student* and who has an email address.
//
// This is the email sibling of send-message-board-push.js. Run both from
// the same HubSpot workflow (one "Send a webhook" action each) so people
// get a browser push *and* an email. This function does not touch push
// subscriptions and the push function does not send email — they are
// independent.
//
// Expected POST body (HubSpot workflow webhook). We accept the same
// portal-id shapes the push function does, plus optional message fields:
//   {
//     portalId:    "48837354252",   // required — Portal record id
//                                   //   (or objectId / hs_object_id /
//                                   //    properties.hs_object_id)
//     message:     "...",           // optional — the message-board text.
//                                   //   Also read as body.messageBody /
//                                   //   body.message_board_message.
//     author:      "Jane (Program Leader)", // optional — who posted
//     subject:     "...",           // optional — overrides email subject
//     url:         "https://portal.pacificdiscovery.org/index.html" // optional
//   }
//
// If the message text is NOT in the webhook body, we fall back to reading
// the `message_board` rich-text field off the Portal record itself (set
// MESSAGE_BOARD_PROPERTY to override that property name). If we still can't
// find any text, we send a generic "there's a new update, log in to read
// it" email so the notification still goes out.
//
// HubSpot sends a verification GET when you first save the webhook action;
// we 200-OK any GET so that handshake succeeds.
//
// Required env vars:
//   HUBSPOT_API_KEY   — HubSpot private app token, read on contacts +
//                       the Portal custom object + associations.
//   SMTP_USER         — Gmail / Workspace mailbox we send AS
//                       (e.g. info@pacificdiscovery.org).
//   SMTP_PASS         — Google App Password for that mailbox.
//
// Optional env vars:
//   SMTP_FROM_NAME             — sender display name. Default "Pacific Discovery".
//   PORTAL_BASE_URL            — base URL for the "Open the portal" button.
//                                Default https://portal.pacificdiscovery.org
//   WEBHOOK_SHARED_SECRET      — if set, we require a matching
//                                X-Webhook-Secret header (add it in the
//                                HubSpot workflow HTTP-action headers).
//   ALLOWED_ASSOCIATION_LABELS — comma-separated association labels that
//                                should receive the email. Case-insensitive.
//                                Default "instructor,parent,student".
//   MESSAGE_BOARD_PROPERTY     — Portal property holding the latest post
//                                text, if not sent in the webhook body.
//
// Sending limits (same account as send-magic-link): Gmail free ~500/day,
// Workspace ~2000/day. A single trip's parent+student+instructor list is
// well under that. If you ever fan a message out to hundreds of contacts
// at once, move this to a transactional provider (Resend / Postmark /
// SendGrid) and send via their bulk API.

import nodemailer from "nodemailer";

const PORTAL_OBJECT_ID = "2-58411705";

// The program name lives on the associated "Pacific Discovery Programs"
// custom object, not on the Portal record. We follow the association from
// the Portal to that object and read its name.
//   PROGRAM_OBJECT_TYPE   — object type of the programs object. Either the
//                           numeric id ("2-XXXXXXX") or the fully-qualified
//                           name ("p<hubid>_pacific_discovery_programs").
//   PROGRAM_NAME_PROPERTY — property on that object holding the program name.
// Both are env-overridable; the candidates below are tried if the env var
// isn't set (or as fallbacks after it).
const PROGRAM_NAME_PROP_CANDIDATES = [
  "program_name",
  "name",
  "title",
  "program_title",
];

// Reuse the SMTP transport across warm invocations (mirrors send-magic-link).
let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // STARTTLS upgrade — Gmail rejects 465 with these settings
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return cachedTransporter;
}

export async function handler(event) {
  try {
    // HubSpot verification handshake.
    if (event.httpMethod === "GET") {
      return jsonResponse(200, { ok: true, message: "send-message-board-email listening" });
    }
    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    // Optional shared-secret check.
    if (process.env.WEBHOOK_SHARED_SECRET) {
      const got = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
      if (got !== process.env.WEBHOOK_SHARED_SECRET) {
        console.warn("[send-message-board-email] Refused — bad/no shared secret");
        return jsonResponse(403, { error: "Forbidden" });
      }
    }

    // Env validation up-front.
    const missing = [];
    if (!process.env.HUBSPOT_API_KEY) missing.push("HUBSPOT_API_KEY");
    if (!process.env.SMTP_USER)       missing.push("SMTP_USER");
    if (!process.env.SMTP_PASS)       missing.push("SMTP_PASS");
    if (missing.length) {
      console.error("[send-message-board-email] Missing env:", missing);
      return jsonResponse(500, { error: `Server is not configured (${missing.join(", ")}).` });
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (_) { return jsonResponse(400, { error: "Invalid JSON body" }); }

    // Accept the same portal-id shapes the push function does.
    const portalId = String(
      body.portalId ||
      body.objectId ||
      body.hs_object_id ||
      body?.properties?.hs_object_id ||
      ""
    ).trim();
    if (!portalId) {
      console.error("[send-message-board-email] no portalId in body:", JSON.stringify(body).slice(0, 400));
      return jsonResponse(400, { error: "Missing portalId / objectId / hs_object_id in webhook body" });
    }

    // Message text (optional) straight from the webhook body. This is a
    // rich-text field, so it may contain HTML (<p>…</p>, <a>, <br>, etc.).
    let messageHtml = String(
      body.message ||
      body.messageBody ||
      body.message_board ||
      body.message_board_message ||
      body?.properties?.message_board ||
      body?.properties?.message_board_message ||
      ""
    ).trim();
    const author = String(body.author || body.posted_by || "").trim();

    // Program name (optional) straight from the webhook body — lets the
    // caller map the associated program's name in directly if they prefer.
    let programName = String(
      body.program ||
      body.programName ||
      body.program_name ||
      ""
    ).trim();

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    };

    // Which association labels are allowed to receive this email.
    const allowedLabels = new Set(
      (process.env.ALLOWED_ASSOCIATION_LABELS || "instructor,parent,student")
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );

    // Read the Portal record for the program name (and the rich-text
    // message board field, if it wasn't passed in the body).
    //
    // IMPORTANT: HubSpot's v3 GET returns 400 for the WHOLE request if you
    // ask for a property that doesn't exist on the object. So we request
    // ONLY properties we know are real — the exact set portal.js /
    // send-message-board-push.js use — never speculative names. `message_board`
    // is the real rich-text field (see portal.js). MESSAGE_BOARD_PROPERTY /
    // PROGRAM_NAME_PROPERTY are only added if you set them, and you'd only
    // set them to real property names.
    try {
      const propList = [
        "program_name",
        "portal_title",
        "destination",
        "message_board",
        process.env.MESSAGE_BOARD_PROPERTY,
        process.env.PROGRAM_NAME_PROPERTY,
      ].filter(Boolean);
      const portalRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT_ID}/${encodeURIComponent(portalId)}?properties=${encodeURIComponent(propList.join(","))}`,
        { headers }
      );
      if (portalRes.ok) {
        const portal = await portalRes.json();
        const p = portal.properties || {};
        if (!programName) {
          const nameKey = process.env.PROGRAM_NAME_PROPERTY;
          programName =
            (nameKey && p[nameKey]) ||
            p.program_name ||
            p.portal_title ||
            p.destination ||
            "";
        }
        if (!messageHtml) {
          const msgKey = process.env.MESSAGE_BOARD_PROPERTY;
          messageHtml = String(
            (msgKey && p[msgKey]) || p.message_board || ""
          ).trim();
        }
      } else {
        const text = await portalRes.text().catch(() => "");
        console.warn(`[send-message-board-email] portal read ${portalRes.status}: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      console.warn("[send-message-board-email] portal read failed (non-fatal):", e?.message || e);
    }

    // Follow the association from the Portal to the "Pacific Discovery
    // Programs" object and read its name — this is where the real program
    // name lives. Skipped if we already have a name from the webhook body,
    // or if PROGRAM_OBJECT_TYPE isn't configured.
    const programObjectType = process.env.PROGRAM_OBJECT_TYPE;
    if (!programName && programObjectType) {
      try {
        const progAssocRes = await fetch(
          `https://api.hubapi.com/crm/v4/objects/${PORTAL_OBJECT_ID}/${encodeURIComponent(portalId)}/associations/${encodeURIComponent(programObjectType)}?limit=1`,
          { headers }
        );
        if (progAssocRes.ok) {
          const progAssoc = await progAssocRes.json();
          const programId = progAssoc.results?.[0]?.toObjectId;
          if (programId) {
            const nameProps = [process.env.PROGRAM_NAME_PROPERTY, ...PROGRAM_NAME_PROP_CANDIDATES].filter(Boolean);
            const progRes = await fetch(
              `https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(programObjectType)}/${encodeURIComponent(programId)}?properties=${encodeURIComponent(nameProps.join(","))}`,
              { headers }
            );
            if (progRes.ok) {
              const prog = await progRes.json();
              const pp = prog.properties || {};
              for (const np of nameProps) {
                if (pp[np] && String(pp[np]).trim()) { programName = String(pp[np]).trim(); break; }
              }
            } else {
              const text = await progRes.text().catch(() => "");
              console.warn(`[send-message-board-email] program read ${progRes.status}: ${text.slice(0, 200)}`);
            }
          }
        } else {
          const text = await progAssocRes.text().catch(() => "");
          console.warn(`[send-message-board-email] program assoc ${progAssocRes.status}: ${text.slice(0, 200)}`);
        }
      } catch (e) {
        console.warn("[send-message-board-email] program lookup failed (non-fatal):", e?.message || e);
      }
    }

    const tripTitle = programName || "your expedition";

    // 1. List every contact associated to this portal, keeping the
    //    association labels so we can filter by role.
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${PORTAL_OBJECT_ID}/${encodeURIComponent(portalId)}/associations/contacts?limit=500`,
      { headers }
    );
    if (!assocRes.ok) {
      const text = await assocRes.text().catch(() => "");
      console.error(`[send-message-board-email] association ${assocRes.status}: ${text.slice(0, 200)}`);
      return jsonResponse(502, { error: "Could not list associated contacts." });
    }
    const assocData = await assocRes.json();

    // Keep only contacts whose association carries one of the allowed
    // labels (Instructor / Parent / Student). Contacts with no matching
    // label are skipped. Track each kept contact's matched role so we can
    // personalize + report.
    const roleByContactId = new Map();
    for (const r of (assocData.results || [])) {
      const id = r.toObjectId;
      if (!id) continue;
      const labels = (r.associationTypes || [])
        .map(t => (t.label || "").trim())
        .filter(Boolean);
      const matched = labels.find(l => allowedLabels.has(l.toLowerCase()));
      if (matched) roleByContactId.set(String(id), matched);
    }

    const contactIds = [...roleByContactId.keys()];
    const totalAssociated = (assocData.results || []).length;
    if (contactIds.length === 0) {
      console.log(`[send-message-board-email] portal=${portalId}: 0 of ${totalAssociated} associated contacts matched labels [${[...allowedLabels].join(", ")}]`);
      return jsonResponse(200, { sent: 0, attempted: 0, associated: totalAssociated, matched: 0 });
    }

    // 2. Batch-read the matched contacts' email + first name.
    const readRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: contactIds.map(id => ({ id: String(id) })),
          properties: ["email", "firstname"],
        }),
      }
    );
    if (!readRes.ok) {
      const text = await readRes.text().catch(() => "");
      console.error(`[send-message-board-email] batch read ${readRes.status}: ${text.slice(0, 200)}`);
      return jsonResponse(502, { error: "Could not read contact details." });
    }
    const readData = await readRes.json();
    const recipients = (readData.results || [])
      .map(c => ({
        id: c.id,
        email: String(c.properties?.email || "").trim(),
        firstName: c.properties?.firstname || "there",
        role: roleByContactId.get(String(c.id)) || "",
      }))
      .filter(c => c.email && /.+@.+\..+/.test(c.email));

    if (recipients.length === 0) {
      console.log(`[send-message-board-email] portal=${portalId}: ${contactIds.length} matched contacts, none with a valid email`);
      return jsonResponse(200, { sent: 0, attempted: 0, associated: totalAssociated, matched: contactIds.length });
    }

    // 3. Build + send one email per recipient.
    const baseUrl  = (process.env.PORTAL_BASE_URL || "https://portal.pacificdiscovery.org").replace(/\/+$/, "");
    const link     = body.url || `${baseUrl}/index.html`;
    const fromName = process.env.SMTP_FROM_NAME || "Pacific Discovery";
    const subject  = body.subject || `${tripTitle} · New message board post`;

    const results = await Promise.allSettled(
      recipients.map(r =>
        getTransporter().sendMail({
          from: `"${fromName}" <${process.env.SMTP_USER}>`,
          to: r.email,
          subject,
          text: buildPlainText({ firstName: r.firstName, tripTitle, messageHtml, author, link }),
          html: buildHtml({ firstName: r.firstName, tripTitle, messageHtml, author, link }),
        })
      )
    );

    let sent = 0, failed = 0;
    results.forEach((res, i) => {
      if (res.status === "fulfilled") { sent++; return; }
      failed++;
      const err = res.reason || {};
      console.warn(`[send-message-board-email] send failed for ${recipients[i].email}: ${err?.message || err}`);
    });

    console.log(`[send-message-board-email] portal=${portalId} associated=${totalAssociated} matched=${contactIds.length} sent=${sent} failed=${failed}`);
    return jsonResponse(200, {
      sent,
      failed,
      attempted: recipients.length,
      associated: totalAssociated,
      matched: contactIds.length,
    });

  } catch (err) {
    console.error("[send-message-board-email] Unhandled:", err?.stack || err?.message || err);
    return jsonResponse(500, { error: err?.message || "Server error" });
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

// ---------- email body builders ----------

function buildPlainText({ firstName, tripTitle, messageHtml, author, link }) {
  const lines = [
    `Hi ${firstName},`,
    ``,
    `There's a new post on the ${tripTitle} Message Board.`,
    ``,
  ];
  const plain = htmlToText(messageHtml);
  if (plain) {
    if (author) lines.push(`${author} wrote:`);
    lines.push(plain, ``);
  } else {
    lines.push(`Log in to the portal to read it.`, ``);
  }
  lines.push(`Open the portal: ${link}`, ``, `— Pacific Discovery`);
  return lines.join("\n");
}

function buildHtml({ firstName, tripTitle, messageHtml, author, link }) {
  // Inline styles only — renders consistently across Gmail, Apple Mail,
  // Outlook web, and mobile clients. Mirrors send-magic-link's layout.
  const safeName  = escapeHtml(firstName);
  const safeTrip  = escapeHtml(tripTitle);
  const safeLink  = escapeHtml(link);
  const safeAuthor = author ? escapeHtml(author) : "";
  // The message board is a RICH-TEXT field — its value is already HTML
  // (<p>…</p>, <a>, <br>, etc.), so we render it as-is rather than escaping
  // it. sanitizeRichText() strips anything unsafe (scripts, event handlers,
  // etc.) but keeps the formatting. If the value happens to be plain text
  // (no tags), we escape it and convert newlines so it still looks right.
  const looksLikeHtml = /<[a-z!/][\s\S]*>/i.test(messageHtml || "");
  const safeMsg = messageHtml
    ? (looksLikeHtml
        ? sanitizeRichText(messageHtml)
        : escapeHtml(messageHtml).replace(/\r?\n/g, "<br>"))
    : "";

  const messageBlock = safeMsg
    ? `
        <tr><td style="padding:8px 32px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8; border:1px solid #e5e7eb; border-radius:6px;">
            <tr><td style="padding:16px 20px; font-size:14px; line-height:1.6; color:#333;">
              ${safeAuthor ? `<div style="font-size:12px; color:#888; margin:0 0 8px;">${safeAuthor} wrote:</div>` : ""}
              ${safeMsg}
            </td></tr>
          </table>
        </td></tr>`
    : `
        <tr><td style="padding:8px 32px 8px; font-size:14px; line-height:1.6; color:#444;">
          <p style="margin:0;">Log in to the portal to read it.</p>
        </td></tr>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0; padding:0; background:#f8f8f8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; color:#212121;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f8;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border:1px solid #e5e7eb;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-size:11px; letter-spacing:1.5px; color:#999; font-weight:600;">PACIFIC DISCOVERY</div>
          <h1 style="margin:12px 0 0; font-size:22px; font-weight:600; color:#212121;">New message board post</h1>
          <p style="margin:6px 0 0; font-size:14px; color:#666;">${safeTrip}</p>
        </td></tr>
        <tr><td style="padding:16px 32px 4px; font-size:14px; line-height:1.6; color:#444;">
          <p style="margin:0;">Hi ${safeName},</p>
        </td></tr>
        ${messageBlock}
        <tr><td align="center" style="padding:16px 32px 24px;">
          <a href="${safeLink}" style="display:inline-block; padding:14px 28px; background:#3B5998; color:#ffffff; text-decoration:none; font-size:13px; font-weight:600; letter-spacing:1.5px; border-radius:4px;">OPEN THE PORTAL</a>
        </td></tr>
        <tr><td style="padding:0 32px 28px; font-size:12px; line-height:1.6; color:#888; border-top:1px solid #e5e7eb; padding-top:16px;">
          <p style="margin:14px 0 0;">You're receiving this because you're linked to this trip in the Pacific Discovery portal.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Light sanitizer for the rich-text message body. HubSpot rich-text is
// trusted-ish (staff-authored), but we still strip the things that have no
// business in an email and could be dangerous or break rendering:
//   - <script>/<style>/<iframe>/<object>/<embed> blocks (content and all)
//   - on* event-handler attributes
//   - javascript: URLs
// Everything else (p, br, a, strong, em, ul/li, headings, etc.) passes
// through so the formatting the author intended is preserved.
function sanitizeRichText(html) {
  let out = String(html);
  // Drop dangerous element blocks entirely, including their inner content.
  out = out.replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, "");
  // Drop any stray self-closing / unclosed versions of those tags.
  out = out.replace(/<\/?(script|style|iframe|object|embed)\b[^>]*>/gi, "");
  // Strip inline event handlers: on*="..."  on*='...'  on*=value
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*[^\s">]+/gi, "");
  // Neutralize javascript: URLs in href/src.
  out = out.replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
  return out;
}

// Convert rich-text HTML to a readable plain-text fallback for the text/
// part of the email. Block tags become line breaks; entities are decoded;
// tags are stripped. Good enough for a notification email — not a full
// HTML-to-text engine.
function htmlToText(html) {
  if (!html) return "";
  let t = String(html);
  t = t.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  t = t.replace(/<\s*br\s*\/?>/gi, "\n");
  t = t.replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n");
  t = t.replace(/<\s*li[^>]*>/gi, "• ");
  t = t.replace(/<[^>]+>/g, "");            // strip remaining tags
  t = t.replace(/&nbsp;/gi, " ")
       .replace(/&amp;/gi, "&")
       .replace(/&lt;/gi, "<")
       .replace(/&gt;/gi, ">")
       .replace(/&quot;/gi, '"')
       .replace(/&#39;/gi, "'");
  t = t.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n"); // tidy whitespace
  return t.trim();
}
